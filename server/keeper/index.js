import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey(process.env.BURNFLIP_PROGRAM_ID || "11111111111111111111111111111111");
const MINT = new PublicKey(process.env.BURNFLIP_MINT || "8R5GEZbit9caGoqWq2bwZt2SJykQYPfZL9Rwe3enpump");
const BURN_ADDRESS = new PublicKey(
  process.env.BURN_ADDRESS || "1nc1nerator11111111111111111111111111111111"
);
const KEEPER_KEYPAIR = process.env.KEEPER_KEYPAIR || "./server/keeper/keeper.json";
const JUPITER_QUOTE_API = process.env.JUPITER_QUOTE_API || "https://quote-api.jup.ag";
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 100);
const BURNFLIP_DECIMALS = Number(process.env.BURNFLIP_DECIMALS || 9);
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DRY_RUN = process.env.DRY_RUN === "1";
const DRY_RUN_OUT_AMOUNT = BigInt(process.env.DRY_RUN_OUT_AMOUNT || "0");
const DRY_RUN_MIN_PROFIT_LAMPORTS = BigInt(process.env.DRY_RUN_MIN_PROFIT_LAMPORTS || "5000000");
const DRY_RUN_MAX_PROFIT_LAMPORTS = BigInt(process.env.DRY_RUN_MAX_PROFIT_LAMPORTS || "50000000");
const DRY_RUN_MIN_OUT_AMOUNT = BigInt(process.env.DRY_RUN_MIN_OUT_AMOUNT || "100000000");
const DRY_RUN_MAX_OUT_AMOUNT = BigInt(process.env.DRY_RUN_MAX_OUT_AMOUNT || "5000000000");

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BURNS_PATH = path.join(BASE_DIR, "..", "burns.json");
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

const connection = new Connection(RPC_URL, "confirmed");

function loadKeypair(path) {
  const raw = fs.readFileSync(path, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function encodeCrank(jupiterIxData) {
  const data = Buffer.from(jupiterIxData);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  return Buffer.concat([discriminator("crank"), len, data]);
}

async function appendBurnEntry(entry) {
  if (pool) {
    await pool.query(
      `create table if not exists burns (
        signature text primary key,
        timestamp timestamptz not null,
        mint text,
        burn_amount_raw text,
        burn_amount_ui text,
        profit_lamports text,
        profit_sol text,
        out_amount_raw text,
        out_amount_ui text,
        dry_run boolean default false
      )`
    );
    await pool.query(
      `insert into burns (
        signature, timestamp, mint, burn_amount_raw, burn_amount_ui,
        profit_lamports, profit_sol, out_amount_raw, out_amount_ui, dry_run
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (signature) do nothing`,
      [
        entry.signature,
        entry.timestamp,
        entry.mint,
        entry.burnAmountRaw ?? null,
        entry.burnAmountUi ?? null,
        entry.profitLamports ?? null,
        entry.profitSol ?? null,
        entry.outAmountRaw ?? null,
        entry.outAmountUi ?? null,
        entry.dryRun ?? false,
      ]
    );
    return;
  }
  try {
    const raw = fs.readFileSync(BURNS_PATH, "utf8");
    const data = JSON.parse(raw);
    const items = Array.isArray(data) ? data : [];
    items.push(entry);
    const trimmed = items.slice(-50);
    fs.writeFileSync(BURNS_PATH, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    fs.writeFileSync(BURNS_PATH, JSON.stringify([entry], null, 2));
  }
}

function formatTokenAmount(raw, decimals) {
  const value = BigInt(raw);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole.toString()}.${fracStr}`;
}

async function fetchJson(url, body) {
  const resp = await fetch(url, body);
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${msg}`);
  }
  return resp.json();
}

function decodeState(data) {
  let o = 8; // skip anchor discriminator
  const authority = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const mint = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const burn = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const starting = data.readBigUInt64LE(o); o += 8;
  const lastCrank = data.readBigInt64LE(o); o += 8;
  const unlock = data.readBigInt64LE(o); o += 8;
  const bump = data.readUInt8(o); o += 1;
  const vaultBump = data.readUInt8(o); o += 1;
  const timelockBump = data.readUInt8(o);
  return {
    authority,
    mint,
    burn,
    starting_balance_lamports: starting,
    last_crank_ts: Number(lastCrank),
    timelock_unlock_ts: Number(unlock),
    bump,
    vaultBump,
    timelockBump,
  };
}

function randomBigInt(min, max) {
  if (max <= min) return min;
  const range = max - min;
  const rand = BigInt(Math.floor(Math.random() * Number(range)));
  return min + rand;
}

function formatSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

async function crankOnce() {
  if (DRY_RUN) {
    const profitLamports = randomBigInt(
      DRY_RUN_MIN_PROFIT_LAMPORTS,
      DRY_RUN_MAX_PROFIT_LAMPORTS
    );
    const outAmount =
      DRY_RUN_OUT_AMOUNT > 0n
        ? DRY_RUN_OUT_AMOUNT
        : randomBigInt(DRY_RUN_MIN_OUT_AMOUNT, DRY_RUN_MAX_OUT_AMOUNT);
    const burnRaw = (outAmount * 80n) / 100n;
    const sig = `dryrun-${Date.now()}`;
    await appendBurnEntry({
      signature: sig,
      timestamp: new Date().toISOString(),
      mint: MINT.toBase58(),
      profitLamports: profitLamports.toString(),
      profitSol: formatSol(profitLamports),
      outAmountRaw: outAmount.toString(),
      outAmountUi: formatTokenAmount(outAmount, BURNFLIP_DECIMALS),
      burnAmountRaw: burnRaw.toString(),
      burnAmountUi: formatTokenAmount(burnRaw, BURNFLIP_DECIMALS),
      dryRun: true,
    });
    console.log(
      `Dry run burn recorded: ${sig} (profit ${formatSol(profitLamports)} SOL, ` +
        `out ${formatTokenAmount(outAmount, BURNFLIP_DECIMALS)} tokens)`
    );
    return;
  }
  const keeper = loadKeypair(KEEPER_KEYPAIR);
  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("state"), MINT.toBuffer()],
    PROGRAM_ID
  );
  const stateInfo = await connection.getAccountInfo(statePda);
  if (!stateInfo) throw new Error("State PDA not found");
  const state = decodeState(stateInfo.data);

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), statePda.toBuffer()],
    PROGRAM_ID
  );
  const [timelockPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("timelock"), statePda.toBuffer()],
    PROGRAM_ID
  );

  const now = Math.floor(Date.now() / 1000);
  if (now - state.last_crank_ts < 150) {
    console.log("Crank skipped: too soon");
    return;
  }

  const vaultBalance = await connection.getBalance(vaultPda, "confirmed");
  if (vaultBalance <= Number(state.starting_balance_lamports)) {
    console.log("Crank skipped: no profit");
    return;
  }
  const profitLamports = vaultBalance - Number(state.starting_balance_lamports);

  const vaultWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, vaultPda, true);
  const vaultTokenAta = await getAssociatedTokenAddress(MINT, statePda, true);
  const burnTokenAta = await getAssociatedTokenAddress(MINT, BURN_ADDRESS, true);
  const timelockTokenAta = await getAssociatedTokenAddress(MINT, timelockPda, true);

  const preIxs = [];
  const burnAtaInfo = await connection.getAccountInfo(burnTokenAta);
  if (!burnAtaInfo) {
    preIxs.push(
      createAssociatedTokenAccountInstruction(
        keeper.publicKey,
        burnTokenAta,
        BURN_ADDRESS,
        MINT
      )
    );
  }
  const timelockAtaInfo = await connection.getAccountInfo(timelockTokenAta);
  if (!timelockAtaInfo) {
    preIxs.push(
      createAssociatedTokenAccountInstruction(
        keeper.publicKey,
        timelockTokenAta,
        timelockPda,
        MINT
      )
    );
  }

  const quote = await fetchJson(
    `${JUPITER_QUOTE_API}/v6/quote?inputMint=${NATIVE_MINT}&outputMint=${MINT}` +
      `&amount=${profitLamports}&slippageBps=${SLIPPAGE_BPS}`
  );

  const swapIx = await fetchJson(`${JUPITER_QUOTE_API}/v6/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: vaultPda.toBase58(),
      wrapAndUnwrapSol: false,
      computeUnitPriceMicroLamports: 200_000,
    }),
  });

  const jup = swapIx.swapInstruction;
  const jupProgram = new PublicKey(jup.programId);
  const jupData = Buffer.from(jup.data, "base64");

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
      { pubkey: statePda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: vaultWsolAta, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAta, isSigner: false, isWritable: true },
      { pubkey: burnTokenAta, isSigner: false, isWritable: true },
      { pubkey: timelockTokenAta, isSigner: false, isWritable: true },
      { pubkey: BURN_ADDRESS, isSigner: false, isWritable: false },
      { pubkey: timelockPda, isSigner: false, isWritable: false },
      { pubkey: jupProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...jup.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
    ],
    data: encodeCrank(jupData),
  });

  const tx = new Transaction();
  for (const pre of preIxs) tx.add(pre);
  tx.add(ix);
  const sig = await connection.sendTransaction(tx, [keeper], { skipPreflight: false });
  console.log("crank tx:", sig);

  const outAmount = BigInt(quote.outAmount || 0);
  const burnRaw = (outAmount * 80n) / 100n;
  await appendBurnEntry({
    signature: sig,
    timestamp: new Date().toISOString(),
    mint: MINT.toBase58(),
    burnAmountRaw: burnRaw.toString(),
    burnAmountUi: formatTokenAmount(burnRaw, BURNFLIP_DECIMALS),
  });
}

async function main() {
  const loop = process.env.KEEPER_LOOP === "1";
  if (!loop) {
    await crankOnce();
    return;
  }
  await crankOnce();
  setInterval(crankOnce, 150_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
