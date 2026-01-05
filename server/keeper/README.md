# BurnFlip Keeper (Stub)

This keeper triggers the on-chain `crank` every 150s.

## Responsibilities
- Read the vault state PDA
- Check `last_crank_ts`
- Fetch a Jupiter quote (WSOL -> BurnFlip mint)
- Build the Jupiter swap instruction
- Call `crank` with `jupiter_ix_data` and remaining accounts

## Inputs
- Program ID
- Vault state PDA
- Vault PDA
- Burn address
- Timelock PDA
- BurnFlip mint

## Env vars
- `RPC_URL`
- `BURNFLIP_PROGRAM_ID`
- `BURNFLIP_MINT`
- `BURN_ADDRESS`
- `KEEPER_KEYPAIR`
- `AUTHORITY_KEYPAIR` (used by init script)
- `DEPOSIT_LAMPORTS` (optional)
- `JUPITER_QUOTE_API`
- `SLIPPAGE_BPS`
- `KEEPER_LOOP` (set to `1` for interval loop)

## Init flow
1) Build IDL: `anchor build` (from repo root)
2) Deploy: `anchor deploy` (update program ID)
3) Initialize:
   `npm --prefix server run keeper:init`

## One-command helpers
- Deploy: `anchor run deploy`
- Keeper loop: `npm --prefix server run keeper:run`

Dry run (no on-chain tx):
- `DRY_RUN=1 DRY_RUN_OUT_AMOUNT=1000000000 npm --prefix server run keeper:run`

Database (shared burns):
- Set `DATABASE_URL` for both the API and keeper to persist burns in Postgres.

## Notes
- This is a stub; full implementation depends on finalized Jupiter swap v6.
