import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

const app = express();
app.use(cors());

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const METRICS_PATH = process.env.METRICS_PATH || path.join(BASE_DIR, "metrics.json");
const PAYOUTS_PATH = process.env.PAYOUTS_PATH || path.join(BASE_DIR, "payouts.json");
const RPC_URL = process.env.RPC_URL || "";
const HOUSE_PUBKEY = process.env.HOUSE_PUBKEY || "";
const HOUSE_KEYPAIR_PATH = process.env.HOUSE_KEYPAIR_PATH || "";
const TREASURY_PUBKEY = process.env.TREASURY_PUBKEY || "";
const TREASURY_KEYPAIR_PATH = process.env.TREASURY_KEYPAIR_PATH || "";
const METRICS_CACHE_MS = Number(process.env.METRICS_CACHE_MS || 5000);

let cachedTreasurySol = null;
let lastTreasuryFetch = 0;

function loadKeypair(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function resolveTreasuryPubkey() {
  if (HOUSE_PUBKEY) return new PublicKey(HOUSE_PUBKEY);
  if (HOUSE_KEYPAIR_PATH) return loadKeypair(HOUSE_KEYPAIR_PATH).publicKey;
  if (TREASURY_PUBKEY) return new PublicKey(TREASURY_PUBKEY);
  if (TREASURY_KEYPAIR_PATH) return loadKeypair(TREASURY_KEYPAIR_PATH).publicKey;
  return null;
}

async function getTreasuryBalanceSol() {
  const treasuryPubkey = resolveTreasuryPubkey();
  if (!RPC_URL || !treasuryPubkey) return null;
  const now = Date.now();
  if (cachedTreasurySol != null && now - lastTreasuryFetch < METRICS_CACHE_MS) {
    return cachedTreasurySol;
  }
  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const lamports = await connection.getBalance(treasuryPubkey);
    cachedTreasurySol = lamports / LAMPORTS_PER_SOL;
    lastTreasuryFetch = now;
    return cachedTreasurySol;
  } catch {
    return null;
  }
}

async function loadMetrics() {
  try {
    const raw = fs.readFileSync(METRICS_PATH, "utf8");
    const data = JSON.parse(raw);
    const metrics = {
      holders: Number(data.holders) || 0,
      treasurySol: Number(data.treasurySol) || 0,
      lastWinner: typeof data.lastWinner === "string" ? data.lastWinner : "—",
    };
    const liveTreasury = await getTreasuryBalanceSol();
    if (typeof liveTreasury === "number") metrics.treasurySol = liveTreasury;
    return metrics;
  } catch {
    return { holders: 0, treasurySol: 0, lastWinner: "—" };
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/metrics", async (req, res) => {
  return res.json(await loadMetrics());
});

app.get("/payouts", (req, res) => {
  const limit = Math.max(Number(req.query.limit) || 6, 1);
  const payouts = loadJson(PAYOUTS_PATH, []);
  const list = Array.isArray(payouts) ? payouts.slice(0, limit) : [];
  return res.json({ payouts: list });
});

const PORT = Number(process.env.METRICS_PORT || 8788);
const HOST = process.env.METRICS_HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Metrics server running on http://${HOST}:${PORT}`);
});
