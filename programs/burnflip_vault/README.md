# BurnFlip Vault Program

Anchor program skeleton for the on-chain buyback vault.

## Notes
- Program ID in `Anchor.toml` is a placeholder; replace after deployment.
- `crank` uses a Jupiter CPI placeholder and expects the swap instruction data via `jupiter_ix_data`.
- Vault SOL is held in a dedicated PDA account and used for buyback calculations.
- Burn token account is the ATA for the burn authority (e.g., Incinerator address).
- Timelock token account is the ATA for the timelock PDA.
- Timelock PDA seeds: `["timelock", state]`.

## Jupiter CPI notes
The `crank` instruction expects:
- `jupiter_ix_data`: the serialized Jupiter swap instruction (WSOL -> BurnFlip).
- `remaining_accounts`: the full account list returned by Jupiter's quote/swap API.

The client/keeper should:
1) Build a Jupiter swap instruction off-chain.
2) Pass its `data` into `crank` and include all accounts in `remaining_accounts`.

The program does **not** validate the quote path yet; it only invokes the CPI.
- Timelock is a single unlock time updated on each crank; this is a simple model.

## Next steps
- Implement WSOL wrapping and a concrete Jupiter CPI path.
- Add explicit accounts for WSOL and token accounts in `crank`.
- Decide on the timelock token account PDA and initialize it on-chain.
