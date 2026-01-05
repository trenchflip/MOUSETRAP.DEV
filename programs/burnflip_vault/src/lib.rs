use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke, system_instruction};
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("5mCQoqpbQAZa7KVP2VvjnisTT8yPuv28d3545g1Tiaib");

const CRANK_INTERVAL_SECS: i64 = 150;
const TIMELOCK_SECS: i64 = 7 * 24 * 60 * 60;
const BURN_BPS: u64 = 8000;
const LOCK_BPS: u64 = 2000;

#[program]
pub mod burnflip_vault {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        starting_balance_lamports: u64,
        burn_address: Pubkey,
    ) -> Result<()> {
        let state_key = ctx.accounts.state.key();
        let vault_key = ctx.accounts.vault.key();
        let authority_key = ctx.accounts.authority.key();
        let system_key = ctx.accounts.system_program.key();
        let state = &mut ctx.accounts.state;
        state.authority = ctx.accounts.authority.key();
        state.mint = ctx.accounts.mint.key();
        state.burn_address = burn_address;
        state.starting_balance_lamports = starting_balance_lamports;
        state.last_crank_ts = 0;
        state.timelock_unlock_ts = 0;
        state.bump = ctx.bumps.state;
        state.vault_bump = ctx.bumps.vault;
        state.timelock_bump = ctx.bumps.timelock_authority;

        if ctx.accounts.vault.lamports() == 0 {
            let rent = Rent::get()?;
            let lamports = rent.minimum_balance(0);
            let ix = system_instruction::create_account(
                &authority_key,
                &vault_key,
                lamports,
                0,
                &system_key,
            );
            let seeds = &[b"vault".as_ref(), state_key.as_ref(), &[state.vault_bump]];
            anchor_lang::solana_program::program::invoke_signed(
                &ix,
                &[
                    ctx.accounts.authority.to_account_info(),
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[seeds],
            )?;
        }
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.vault.key(),
            lamports,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    pub fn crank(ctx: Context<Crank>, jupiter_ix_data: Vec<u8>) -> Result<()> {
        let clock = Clock::get()?;
        let state_key = ctx.accounts.state.key();
        let mint_key = ctx.accounts.mint.key();
        let state_bump = ctx.accounts.state.bump;
        let vault_bump = ctx.accounts.state.vault_bump;
        let timelock_bump = ctx.accounts.state.timelock_bump;
        let state_account = ctx.accounts.state.to_account_info();
        let state = &mut ctx.accounts.state;

        require!(
            clock.unix_timestamp - state.last_crank_ts >= CRANK_INTERVAL_SECS,
            VaultError::CrankTooSoon
        );

        let vault_balance = ctx.accounts.vault.to_account_info().lamports();
        require!(
            vault_balance > state.starting_balance_lamports,
            VaultError::NoProfit
        );
        let profit_lamports = vault_balance - state.starting_balance_lamports;
        require!(profit_lamports > 0, VaultError::NoProfit);

        // Wrap SOL into WSOL (profit amount) in the vault WSOL ATA.
        let wsol_ata = &ctx.accounts.vault_wsol_ata;
        let wrap_ix = system_instruction::transfer(
            &ctx.accounts.vault.key(),
            &wsol_ata.key(),
            profit_lamports,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &wrap_ix,
            &[
                ctx.accounts.vault.to_account_info(),
                wsol_ata.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[
                b"vault",
                state_key.as_ref(),
                &[vault_bump],
            ]],
        )?;

        // Sync native WSOL balance.
        let sync_ix = anchor_spl::token::spl_token::instruction::sync_native(
            &ctx.accounts.token_program.key(),
            &wsol_ata.key(),
        )?;
        invoke(
            &sync_ix,
            &[
                ctx.accounts.token_program.to_account_info(),
                wsol_ata.to_account_info(),
            ],
        )?;

        // Jupiter CPI swap (WSOL -> BurnFlip token)
        let ix = Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: ctx
                .remaining_accounts
                .iter()
                .flat_map(|a| a.to_account_metas(None))
                .collect(),
            data: jupiter_ix_data,
        };
        invoke(&ix, &ctx.remaining_accounts)?;

        let vault_amount = ctx.accounts.vault_token_account.amount;
        require!(vault_amount > 0, VaultError::NoTokens);
        let burn_amount = vault_amount * BURN_BPS / 10_000;
        let lock_amount = vault_amount * LOCK_BPS / 10_000;

        let state_seeds = &[
            b"state".as_ref(),
            mint_key.as_ref(),
            &[state_bump],
        ];
        let state_signer = &[&state_seeds[..]];

        let cpi_ctx_burn = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.burn_token_account.to_account_info(),
                authority: state_account.clone(),
            },
            state_signer,
        );
        token::transfer(cpi_ctx_burn, burn_amount)?;

        let cpi_ctx_lock = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.timelock_token_account.to_account_info(),
                authority: state_account,
            },
            state_signer,
        );
        token::transfer(cpi_ctx_lock, lock_amount)?;

        // Close WSOL ATA back to vault to reclaim rent + remaining SOL.
        let cpi_close = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_wsol_ata.to_account_info(),
                destination: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            state_signer,
        );
        token::close_account(cpi_close)?;

        state.last_crank_ts = clock.unix_timestamp;
        state.timelock_unlock_ts = clock.unix_timestamp + TIMELOCK_SECS;

        emit!(BuybackEvent {
            profit_lamports,
            burn_amount,
            lock_amount,
            burn_address: ctx.accounts.burn_token_account.key(),
            timelock_account: ctx.accounts.timelock_token_account.key(),
        });

        Ok(())
    }

    pub fn unlock(ctx: Context<Unlock>) -> Result<()> {
        let clock = Clock::get()?;
        let state = &ctx.accounts.state;
        require!(
            clock.unix_timestamp >= state.timelock_unlock_ts,
            VaultError::TimelockActive
        );

        let state_key = ctx.accounts.state.key();
        let seeds = &[
            b"timelock".as_ref(),
            state_key.as_ref(),
            &[state.timelock_bump],
        ];
        let signer = &[&seeds[..]];

        let amount = ctx.accounts.timelock_token_account.amount;
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.timelock_token_account.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.timelock_authority.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(starting_balance_lamports: u64, burn_address: Pubkey)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::SIZE,
        seeds = [b"state", mint.key().as_ref()],
        bump
    )]
    pub state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault", state.key().as_ref()],
        bump
    )]
    /// CHECK: Vault PDA is owned by the system program and holds SOL only.
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Timelock PDA authority
    #[account(
        seeds = [b"timelock", state.key().as_ref()],
        bump
    )]
    pub timelock_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"state", mint.key().as_ref()],
        bump = state.bump
    )]
    pub state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault", state.key().as_ref()],
        bump = state.vault_bump
    )]
    /// CHECK: Vault PDA is owned by the system program and holds SOL only.
    pub vault: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Crank<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault", state.key().as_ref()],
        bump = state.vault_bump
    )]
    /// CHECK: Vault PDA is owned by the system program and holds SOL only.
    pub vault: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = vault
    )]
    pub vault_wsol_ata: Account<'info, TokenAccount>,
    pub wsol_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = state
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = burn_authority
    )]
    pub burn_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = timelock_authority
    )]
    pub timelock_token_account: Account<'info, TokenAccount>,
    /// CHECK: Burn address is a known public key (e.g., Incinerator)
    pub burn_authority: UncheckedAccount<'info>,
    /// CHECK: Timelock PDA that can later unlock
    #[account(
        seeds = [b"timelock", state.key().as_ref()],
        bump = state.timelock_bump
    )]
    pub timelock_authority: UncheckedAccount<'info>,
    /// CHECK: Jupiter program is invoked via CPI.
    pub jupiter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unlock<'info> {
    #[account(mut)]
    pub state: Account<'info, VaultState>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub timelock_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,
    /// CHECK: Timelock PDA signer
    #[account(
        seeds = [b"timelock", state.key().as_ref()],
        bump = state.timelock_bump
    )]
    pub timelock_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct VaultState {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub burn_address: Pubkey,
    pub starting_balance_lamports: u64,
    pub last_crank_ts: i64,
    pub timelock_unlock_ts: i64,
    pub bump: u8,
    pub vault_bump: u8,
    pub timelock_bump: u8,
}

impl VaultState {
    pub const SIZE: usize = 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1;
}

#[event]
pub struct BuybackEvent {
    pub profit_lamports: u64,
    pub burn_amount: u64,
    pub lock_amount: u64,
    pub burn_address: Pubkey,
    pub timelock_account: Pubkey,
}

#[error_code]
pub enum VaultError {
    #[msg("Crank is too soon.")]
    CrankTooSoon,
    #[msg("No profit available.")]
    NoProfit,
    #[msg("No tokens to distribute.")]
    NoTokens,
    #[msg("Timelock is still active.")]
    TimelockActive,
}
