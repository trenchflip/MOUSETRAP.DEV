import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import "dotenv/config";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getMint,
} from "@solana/spl-token";

const app = express();
app.use(cors());
app.use(express.json());

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_PATH = process.env.HOUSE_PATH
  ? path.resolve(process.env.HOUSE_PATH)
  : path.join(BASE_DIR, "house.json");
const ROUNDS_PATH = path.join(BASE_DIR, "rounds.json");
const PROCESSED_PATH = path.join(BASE_DIR, "processed.json");

const ROUND_INTERVAL_MS = 5 * 60 * 1000;
const MIN_PLAYERS = 10;
const HOUSE_PAYOUT_SHARE = 0.5;
const BURN_MINT = process.env.BURN_MINT || "";
const BURN_ADDRESS = process.env.BURN_ADDRESS || "1nc1nerator11111111111111111111111111111111";
const BUYBACK_SLIPPAGE_BPS = Number(process.env.BUYBACK_SLIPPAGE_BPS || 20000);
const MAX_BUYBACK_LAMPORTS = process.env.MAX_BUYBACK_LAMPORTS
  ? Number(process.env.MAX_BUYBACK_LAMPORTS)
  : null;
const JUPITER_API_URL = process.env.JUPITER_API_URL || "https://quote-api.jup.ag/v6";
const MIN_HOUSE_RESERVE_LAMPORTS = Number(process.env.MIN_HOUSE_RESERVE_LAMPORTS || 0);
const BURN_BOT_LIVE = process.env.BURN_BOT_LIVE === "1";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MARKETCAP_CACHE_MS = Number(process.env.MARKETCAP_CACHE_MS || 5000);
let lastMarketCap = null;
let lastMarketCapAt = 0;

if (!fs.existsSync(HOUSE_PATH)) {
  throw new Error(`HOUSE keypair missing. Set HOUSE_PATH or provide ${HOUSE_PATH}.`);
}
const secret = Uint8Array.from(JSON.parse(fs.readFileSync(HOUSE_PATH, "utf8")));
const HOUSE = Keypair.fromSecretKey(secret);

console.log("HOUSE pubkey:", HOUSE.publicKey.toBase58());

const processedSigs = new Set();
try {
  const raw = fs.readFileSync(PROCESSED_PATH, "utf8");
  const items = JSON.parse(raw);
  if (Array.isArray(items)) {
    for (const sig of items) processedSigs.add(sig);
  }
} catch {
  // start empty
}

function persistProcessedSigs() {
  const items = Array.from(processedSigs).slice(-5000);
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify(items, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function loadRounds() {
  try {
    const raw = fs.readFileSync(ROUNDS_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch {
    // ignore
  }
  return null;
}

function saveRounds(data) {
  fs.writeFileSync(ROUNDS_PATH, JSON.stringify(data, null, 2));
}

function newRound() {
  const start = Date.now();
  return {
    id: crypto.randomUUID(),
    startTime: nowIso(),
    nextSpinAt: new Date(start + ROUND_INTERVAL_MS).toISOString(),
    status: "open",
    entries: [],
    winner: null,
    payoutSig: null,
    buybackLamports: 0,
  };
}

let roundsState = loadRounds();
if (!roundsState) {
  roundsState = { current: newRound(), history: [] };
  saveRounds(roundsState);
}
const BURNS_PATH = path.join(BASE_DIR, "burns.json");
let burnFeed = [];
try {
  const raw = fs.readFileSync(BURNS_PATH, "utf8");
  const data = JSON.parse(raw);
  if (Array.isArray(data)) burnFeed = data;
} catch {
  burnFeed = [];
}

burnFeed = burnFeed.filter(
  (entry) => !entry?.dryRun && !String(entry?.signature ?? "").startsWith("demo-")
);
if (roundsState?.current?.entries) {
  roundsState.current.entries = roundsState.current.entries.filter((e) => !e?.demo);
}
if (Array.isArray(roundsState?.history)) {
  roundsState.history = roundsState.history.filter((round) => {
    if (Array.isArray(round?.entries) && round.entries.some((e) => e?.demo)) return false;
    return true;
  });
}
saveRounds(roundsState);
fs.writeFileSync(BURNS_PATH, JSON.stringify(burnFeed.slice(0, 50), null, 2));

function persistBurns() {
  fs.writeFileSync(BURNS_PATH, JSON.stringify(burnFeed.slice(0, 50), null, 2));
}

function recordBurn(entry) {
  burnFeed.unshift(entry);
  burnFeed = burnFeed.slice(0, 50);
  persistBurns();
}

function summarizeRound(round) {
  const potLamports = round.entries.reduce((sum, e) => sum + e.amountLamports, 0);
  const uniquePlayers = new Set(round.entries.map((e) => e.player)).size;
  return {
    ...round,
    potLamports,
    potSol: potLamports / LAMPORTS_PER_SOL,
    entriesCount: round.entries.length,
    uniquePlayers,
  };
}

function weightedWinner(entries) {
  const totalRaw = entries.reduce((sum, e) => sum + e.amountLamports, 0);
  if (totalRaw <= 0) return null;
  const cap = totalRaw * 0.25;
  const weights = new Map();
  for (const entry of entries) {
    weights.set(entry.player, Math.min(cap, (weights.get(entry.player) ?? 0) + entry.amountLamports));
  }
  const total = Array.from(weights.values()).reduce((sum, v) => sum + v, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (const [player, weight] of weights.entries()) {
    if (weight <= 0) continue;
    roll -= weight;
    if (roll <= 0) {
      const pick = entries.find((e) => e.player === player);
      return pick ?? entries[entries.length - 1] ?? null;
    }
  }
  return entries[entries.length - 1] ?? null;
}

let spinning = false;
async function spinIfReady() {
  if (spinning) return;
  const current = roundsState.current;
  const now = Date.now();
  if (new Date(roundsState.current.nextSpinAt).getTime() > now) return;

  const summary = summarizeRound(current);
  if (summary.uniquePlayers < MIN_PLAYERS) {
    const nextSpin = new Date(now + ROUND_INTERVAL_MS).toISOString();
    roundsState.current.nextSpinAt = nextSpin;
    saveRounds(roundsState);
    return;
  }

  spinning = true;
  try {
    const winnerEntry = weightedWinner(current.entries);
    if (!winnerEntry) {
      roundsState.current.nextSpinAt = new Date(now + ROUND_INTERVAL_MS).toISOString();
      saveRounds(roundsState);
      return;
    }

    const potLamports = summary.potLamports;
    const payoutLamports = Math.floor(potLamports * HOUSE_PAYOUT_SHARE);
    const buybackLamports = potLamports - payoutLamports;

    const houseBal = await connection.getBalance(HOUSE.publicKey, "confirmed");
    const feeBuffer = 5000;
    if (houseBal - payoutLamports < MIN_HOUSE_RESERVE_LAMPORTS + feeBuffer) {
      roundsState.current.nextSpinAt = new Date(now + 60_000).toISOString();
      saveRounds(roundsState);
      return;
    }

    const latest = await connection.getLatestBlockhash("confirmed");
    const payoutTx = new Transaction({
      feePayer: HOUSE.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: HOUSE.publicKey,
        toPubkey: new PublicKey(winnerEntry.player),
        lamports: payoutLamports,
      })
    );

    payoutTx.sign(HOUSE);
    const payoutSig = await connection.sendRawTransaction(payoutTx.serialize(), {
      skipPreflight: false,
    });

    roundsState.current = {
      ...current,
      status: "complete",
      winner: {
        player: winnerEntry.player,
        amountLamports: winnerEntry.amountLamports,
        amountSol: winnerEntry.amountLamports / LAMPORTS_PER_SOL,
        payoutLamports,
        payoutSol: payoutLamports / LAMPORTS_PER_SOL,
      },
      payoutSig,
      buybackLamports,
    };

    if (buybackLamports > 0) {
      await executeBuyback(buybackLamports);
    }

    roundsState.history.unshift(roundsState.current);
    roundsState.history = roundsState.history.slice(0, 20);
    roundsState.current = newRound();
    saveRounds(roundsState);
  } finally {
    spinning = false;
  }
}

setInterval(spinIfReady, 10_000);


async function executeBuyback(buybackLamports) {
  const amountLamports = MAX_BUYBACK_LAMPORTS
    ? Math.min(buybackLamports, MAX_BUYBACK_LAMPORTS)
    : buybackLamports;

  if (process.env.DRY_RUN === "1") {
    const outTokens = (amountLamports / LAMPORTS_PER_SOL) * 100;
    recordBurn({
      signature: `dryrun-buyback-${Date.now()}`,
      timestamp: nowIso(),
      mint: BURN_MINT || "TBD",
      burnAmountUi: outTokens.toFixed(4),
      buybackLamports: amountLamports,
      dryRun: true,
    });
    return;
  }

  if (!BURN_MINT) {
    console.warn("Buyback skipped: BURN_MINT not set.");
    return;
  }

  const mintKey = new PublicKey(BURN_MINT);
  const burnKey = new PublicKey(BURN_ADDRESS);
  const mintInfo = await connection.getAccountInfo(mintKey);
  if (!mintInfo) {
    console.warn("Buyback skipped: mint not found on RPC.");
    return;
  }
  const tokenProgramId =
    mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const burnAta = await getAssociatedTokenAddress(mintKey, burnKey, true, tokenProgramId);
  const burnAtaInfo = await connection.getAccountInfo(burnAta);
  if (!burnAtaInfo) {
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        HOUSE.publicKey,
        burnAta,
        burnKey,
        mintKey,
        tokenProgramId
      )
    );
    ataTx.feePayer = HOUSE.publicKey;
    ataTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    ataTx.sign(HOUSE);
    await connection.sendRawTransaction(ataTx.serialize(), { skipPreflight: false });
  }

  const quoteUrl = new URL(`${JUPITER_API_URL}/quote`);
  quoteUrl.searchParams.set("inputMint", SOL_MINT);
  quoteUrl.searchParams.set("outputMint", BURN_MINT);
  quoteUrl.searchParams.set("amount", String(amountLamports));
  quoteUrl.searchParams.set("slippageBps", String(BUYBACK_SLIPPAGE_BPS));
  quoteUrl.searchParams.set("swapMode", "ExactIn");

  const quoteResp = await fetch(quoteUrl.toString());
  if (!quoteResp.ok) {
    const body = await quoteResp.text();
    console.warn("Buyback quote failed:", quoteResp.status, body.slice(0, 200));
    return;
  }
  const quoteJson = await quoteResp.json();
  const quote = Array.isArray(quoteJson?.data) ? quoteJson.data[0] : quoteJson;
  if (!quote) {
    console.warn("Buyback quote empty.");
    return;
  }

  const swapResp = await fetch(`${JUPITER_API_URL}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: HOUSE.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      destinationTokenAccount: burnAta.toBase58(),
    }),
  });

  if (!swapResp.ok) {
    const body = await swapResp.text();
    console.warn("Buyback swap failed:", swapResp.status, body.slice(0, 200));
    return;
  }

  const swapJson = await swapResp.json();
  const swapTx = swapJson?.swapTransaction;
  if (!swapTx) {
    console.warn("Buyback swap missing transaction.");
    return;
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
  tx.sign([HOUSE]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });

  const mintData = await getMint(connection, mintKey, "confirmed", tokenProgramId);
  const decimals = mintData.decimals ?? 0;
  const outAmountRaw = BigInt(quote.outAmount ?? "0");
  const burnAmountUi =
    decimals > 0
      ? (Number(outAmountRaw) / 10 ** decimals).toFixed(6)
      : outAmountRaw.toString();

  recordBurn({
    signature: sig,
    timestamp: nowIso(),
    mint: BURN_MINT,
    burnAmountUi,
    buybackLamports: amountLamports,
    dryRun: false,
  });
}

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/config", (req, res) => {
  return res.json({
    housePubkey: HOUSE.publicKey.toBase58(),
    minPlayers: MIN_PLAYERS,
    roundIntervalMs: ROUND_INTERVAL_MS,
    burnBotLive: BURN_BOT_LIVE,
  });
});

app.get("/round", (req, res) => {
  return res.json({ current: summarizeRound(roundsState.current) });
});

app.get("/burns", (req, res) => {
  return res.json({ burns: burnFeed });
});

app.get("/marketcap", async (req, res) => {
  if (!BURN_MINT) {
    return res.json({ marketCapUsd: null });
  }

  const now = Date.now();
  if (lastMarketCap != null && now - lastMarketCapAt < MARKETCAP_CACHE_MS) {
    return res.json({ marketCapUsd: lastMarketCap });
  }

  try {
    const supply = await connection.getTokenSupply(new PublicKey(BURN_MINT), "confirmed");
    const uiSupply = Number(supply.value.uiAmountString ?? supply.value.uiAmount ?? 0);
    if (!Number.isFinite(uiSupply) || uiSupply <= 0) {
      return res.json({ marketCapUsd: null });
    }

    const priceResp = await fetch(`https://price.jup.ag/v4/price?ids=${BURN_MINT}`);
    if (!priceResp.ok) {
      return res.json({ marketCapUsd: null });
    }
    const priceJson = await priceResp.json();
    const price = priceJson?.data?.[BURN_MINT]?.price;
    if (!Number.isFinite(price)) {
      return res.json({ marketCapUsd: null });
    }

    const marketCapUsd = uiSupply * price;
    lastMarketCap = marketCapUsd;
    lastMarketCapAt = now;
    return res.json({ marketCapUsd });
  } catch {
    return res.json({ marketCapUsd: null });
  }
});

app.get("/round/history", (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
  return res.json({ history: roundsState.history.slice(0, limit).map(summarizeRound) });
});

app.post("/enter", async (req, res) => {
  try {
    if (!BURN_BOT_LIVE) {
      return res.status(403).json({ error: "Entries are paused until burn bot is live." });
    }
    const { signature, expectedLamports } = req.body || {};
    if (!signature || typeof signature !== "string") {
      return res.status(400).json({ error: "Missing signature" });
    }
    if (
      expectedLamports == null ||
      typeof expectedLamports !== "number" ||
      expectedLamports <= 0
    ) {
      return res.status(400).json({ error: "Invalid expectedLamports" });
    }
    if (processedSigs.has(signature)) {
      return res.status(409).json({ error: "Signature already processed" });
    }

    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) {
      return res.status(400).json({ error: "Transaction not found / not confirmed yet" });
    }
    if (tx.meta?.err) {
      return res.status(400).json({ error: "Transaction failed on-chain" });
    }

    let foundLamports = 0;
    let player = null;
    for (const ix of tx.transaction.message.instructions) {
      if (ix.program === "system" && ix.parsed?.type === "transfer") {
        const info = ix.parsed.info;
        if (info.destination === HOUSE.publicKey.toBase58()) {
          foundLamports += Number(info.lamports);
          player = info.source;
        }
      }
    }

    if (!player) {
      return res.status(400).json({ error: "No transfer to house found" });
    }
    if (foundLamports !== expectedLamports) {
      return res.status(400).json({
        error: `Incorrect amount. Found ${foundLamports} lamports, expected ${expectedLamports}`,
      });
    }

    roundsState.current.entries.push({
      signature,
      player,
      amountLamports: expectedLamports,
      timestamp: nowIso(),
    });

    processedSigs.add(signature);
    persistProcessedSigs();
    saveRounds(roundsState);

    return res.json({ current: summarizeRound(roundsState.current) });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
});

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
