import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUYBACKS_PATH = process.env.BUYBACKS_PATH || path.join(BASE_DIR, "buybacks.json");
const RPC_URL = process.env.RPC_URL || "";
const HOUSE_KEYPAIR_PATH = process.env.HOUSE_KEYPAIR_PATH || "";
const BUYBACK_MINT = process.env.BUYBACK_MINT || "";
const BUYBACK_INTERVAL_SECONDS = Number(process.env.BUYBACK_INTERVAL_SECONDS || 180);
const BUYBACK_PERCENT = Number(process.env.BUYBACK_PERCENT || 0.5);
const MIN_HOUSE_SOL = Number(process.env.MIN_HOUSE_SOL || 0.1);
const MAX_BUY_SOL = Number(process.env.MAX_BUY_SOL || 0);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 2000);
const JUPITER_API_URL = process.env.JUPITER_API_URL || "https://quote-api.jup.ag/v6";
const DRY_RUN = process.env.DRY_RUN === "1";
const LOOP = process.env.BUYBACK_LOOP === "1";

const SOL_MINT = "So11111111111111111111111111111111111111112";

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

async function getHouseBalance(connection, pubkey) {
  const lamports = await connection.getBalance(pubkey);
  return lamports / LAMPORTS_PER_SOL;
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Request failed ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function runOnce() {
  if (!RPC_URL || !HOUSE_KEYPAIR_PATH || !BUYBACK_MINT) {
    console.log("Missing RPC_URL, HOUSE_KEYPAIR_PATH, or BUYBACK_MINT.");
    return null;
  }

  const keypair = loadKeypair(HOUSE_KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, "confirmed");
  const houseSol = await getHouseBalance(connection, keypair.publicKey);

  if (houseSol <= MIN_HOUSE_SOL) {
    console.log(`House balance ${houseSol.toFixed(4)} SOL below minimum.`);
    return null;
  }

  let buySol = houseSol * BUYBACK_PERCENT;
  const maxSpendable = Math.max(houseSol - MIN_HOUSE_SOL, 0);
  if (buySol > maxSpendable) buySol = maxSpendable;
  if (MAX_BUY_SOL > 0) buySol = Math.min(buySol, MAX_BUY_SOL);
  if (buySol <= 0) {
    console.log("Buy amount is zero.");
    return null;
  }

  const buyLamports = Math.round(buySol * LAMPORTS_PER_SOL);

  let signature = null;
  let outAmount = null;

  if (DRY_RUN) {
    signature = `dryrun-${Date.now()}`;
    outAmount = 0;
    console.log(`Dry run buyback ${buySol.toFixed(4)} SOL for ${BUYBACK_MINT}`);
  } else {
    const quote = await fetchJson(
      `${JUPITER_API_URL}/quote?inputMint=${SOL_MINT}&outputMint=${BUYBACK_MINT}` +
        `&amount=${buyLamports}&slippageBps=${SLIPPAGE_BPS}`,
      {}
    );
    const swap = await fetchJson(`${JUPITER_API_URL}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });

    if (!swap.swapTransaction) {
      throw new Error("Jupiter swap transaction missing.");
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
    tx.sign([keypair]);
    const txid = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(txid, "confirmed");
    signature = txid;
    outAmount = Number(quote.outAmount || 0);
    console.log(`Buyback sent ${buySol.toFixed(4)} SOL (${txid})`);
  }

  const buybacks = loadJson(BUYBACKS_PATH, []);
  const event = {
    id: `${Date.now()}-${keypair.publicKey.toBase58()}`,
    timestamp: new Date().toISOString(),
    signature,
    buySol: Number(buySol.toFixed(4)),
    outAmountRaw: outAmount,
    mint: BUYBACK_MINT,
    dryRun: DRY_RUN,
  };
  const next = [event, ...(Array.isArray(buybacks) ? buybacks : [])].slice(0, 200);
  writeJson(BUYBACKS_PATH, next);
  return event;
}

async function main() {
  await runOnce();
  if (!LOOP) return;
  const intervalMs = Math.max(BUYBACK_INTERVAL_SECONDS, 30) * 1000;
  setInterval(runOnce, intervalMs);
}

main();
