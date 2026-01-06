import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOLDERS_PATH = process.env.HOLDERS_PATH || path.join(BASE_DIR, "holders.json");
const PAYOUTS_PATH = process.env.PAYOUTS_PATH || path.join(BASE_DIR, "payouts.json");
const METRICS_PATH = process.env.METRICS_PATH || path.join(BASE_DIR, "metrics.json");
const RPC_URL = process.env.RPC_URL || "";
const HOUSE_KEYPAIR_PATH = process.env.HOUSE_KEYPAIR_PATH || "";
const TREASURY_KEYPAIR_PATH = process.env.TREASURY_KEYPAIR_PATH || path.join(BASE_DIR, "treasury.json");
const PAYOUT_INTERVAL_SECONDS = Number(process.env.PAYOUT_INTERVAL_SECONDS || 60);
const PAYOUT_PERCENT = Number(process.env.PAYOUT_PERCENT || 0.1);
const MIN_TREASURY_SOL = Number(process.env.MIN_TREASURY_SOL || 0.1);
const MIN_PAYOUT_SOL = Number(process.env.MIN_PAYOUT_SOL || 0.01);
const MAX_PAYOUT_SOL = Number(process.env.MAX_PAYOUT_SOL || 0);
const DRY_RUN = process.env.DRY_RUN === "1";
const LOOP = process.env.PAYOUT_LOOP === "1";
const UPDATE_METRICS = process.env.UPDATE_METRICS !== "0";

function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadKeypair(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function normalizeHolders(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        return { address: entry, weight: 1 };
      }
      if (!entry || typeof entry.address !== "string") return null;
      const weight = Number(entry.weight ?? entry.amount ?? 1);
      return { address: entry.address, weight: Number.isFinite(weight) ? Math.max(weight, 0) : 0 };
    })
    .filter((entry) => entry && entry.weight > 0);
}

function pickWeighted(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1] || null;
}

async function getTreasuryBalance(connection, treasuryPubkey) {
  const lamports = await connection.getBalance(treasuryPubkey);
  return lamports / LAMPORTS_PER_SOL;
}

async function sendPayout(connection, treasuryKeypair, winner, payoutLamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasuryKeypair.publicKey,
      toPubkey: new PublicKey(winner),
      lamports: payoutLamports,
    })
  );
  return await sendAndConfirmTransaction(connection, tx, [treasuryKeypair], {
    commitment: "confirmed",
  });
}

async function runOnce() {
  const holdersRaw = loadJson(HOLDERS_PATH, []);
  const holders = normalizeHolders(holdersRaw);
  if (!holders.length) {
    console.log("No holders available, skipping payout.");
    return null;
  }

  if (!RPC_URL) {
    console.log("Missing RPC_URL, skipping payout.");
    return null;
  }

  const keypairPath = HOUSE_KEYPAIR_PATH || TREASURY_KEYPAIR_PATH;
  const treasuryKeypair = loadKeypair(keypairPath);
  const connection = new Connection(RPC_URL, "confirmed");
  const treasurySol = await getTreasuryBalance(connection, treasuryKeypair.publicKey);

  if (treasurySol <= MIN_TREASURY_SOL) {
    console.log(`Treasury balance ${treasurySol.toFixed(4)} SOL below minimum.`);
    return null;
  }

  let payoutSol = treasurySol * PAYOUT_PERCENT;
  const maxSpendable = Math.max(treasurySol - MIN_TREASURY_SOL, 0);
  if (payoutSol > maxSpendable) payoutSol = maxSpendable;
  if (MAX_PAYOUT_SOL > 0) payoutSol = Math.min(payoutSol, MAX_PAYOUT_SOL);

  if (payoutSol < MIN_PAYOUT_SOL) {
    console.log(`Payout ${payoutSol.toFixed(4)} SOL below minimum.`);
    return null;
  }

  const winner = pickWeighted(holders);
  if (!winner) {
    console.log("No valid winner selected.");
    return null;
  }

  let signature = null;
  if (DRY_RUN) {
    signature = `dryrun-${Date.now()}`;
    console.log(`Dry run payout ${payoutSol.toFixed(4)} SOL to ${winner.address}`);
  } else {
    signature = await sendPayout(
      connection,
      treasuryKeypair,
      winner.address,
      Math.round(payoutSol * LAMPORTS_PER_SOL)
    );
    console.log(`Payout sent ${payoutSol.toFixed(4)} SOL to ${winner.address} (${signature})`);
  }

  const payouts = loadJson(PAYOUTS_PATH, []);
  const event = {
    id: `${Date.now()}-${winner.address}`,
    timestamp: new Date().toISOString(),
    winner: winner.address,
    payoutSol: Number(payoutSol.toFixed(4)),
    treasurySol: Number(treasurySol.toFixed(4)),
    signature,
    dryRun: DRY_RUN,
  };
  const nextPayouts = [event, ...(Array.isArray(payouts) ? payouts : [])].slice(0, 200);
  writeJson(PAYOUTS_PATH, nextPayouts);

  if (UPDATE_METRICS) {
    const metrics = loadJson(METRICS_PATH, {});
    metrics.lastWinner = winner.address;
    if (typeof metrics.holders !== "number") metrics.holders = holders.length;
    writeJson(METRICS_PATH, metrics);
  }

  return event;
}

async function main() {
  await runOnce();
  if (!LOOP) return;
  const intervalMs = Math.max(PAYOUT_INTERVAL_SECONDS, 5) * 1000;
  setInterval(runOnce, intervalMs);
}

main();
