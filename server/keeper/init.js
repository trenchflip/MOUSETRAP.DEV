import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey(process.env.BURNFLIP_PROGRAM_ID || "11111111111111111111111111111111");
const MINT = new PublicKey(process.env.BURNFLIP_MINT || "8R5GEZbit9caGoqWq2bwZt2SJykQYPfZL9Rwe3enpump");
const BURN_ADDRESS = new PublicKey(
  process.env.BURN_ADDRESS || "1nc1nerator11111111111111111111111111111111"
);
const AUTHORITY_KEYPAIR = process.env.AUTHORITY_KEYPAIR || process.env.KEEPER_KEYPAIR;
const DEPOSIT_LAMPORTS = Number(process.env.DEPOSIT_LAMPORTS || 0);
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));

if (!AUTHORITY_KEYPAIR) {
  throw new Error("Missing AUTHORITY_KEYPAIR or KEEPER_KEYPAIR");
}

function loadKeypair(p) {
  const raw = fs.readFileSync(p, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

async function main() {
  const keypair = loadKeypair(AUTHORITY_KEYPAIR);
  const connection = new Connection(RPC_URL, "confirmed");
  const balance = await connection.getBalance(keypair.publicKey, "confirmed");
  console.log("RPC:", RPC_URL);
  console.log("Authority:", keypair.publicKey.toBase58());
  console.log("Authority balance:", balance / 1e9, "SOL");
  if (balance === 0) {
    throw new Error("Authority has 0 SOL on this RPC. Fund it before init.");
  }

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("state"), MINT.toBuffer()],
    PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), statePda.toBuffer()],
    PROGRAM_ID
  );
  const [timelockPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("timelock"), statePda.toBuffer()],
    PROGRAM_ID
  );

  console.log("State PDA:", statePda.toBase58());
  console.log("Vault PDA:", vaultPda.toBase58());
  console.log("Timelock PDA:", timelockPda.toBase58());

  const startingBalanceLamports = DEPOSIT_LAMPORTS;

  const discriminator = (name) =>
    crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
  const encodeU64 = (value) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(value), 0);
    return b;
  };

  const initData = Buffer.concat([
    discriminator("initialize"),
    encodeU64(startingBalanceLamports),
    BURN_ADDRESS.toBuffer(),
  ]);

  const initIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: statePda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: timelockPda, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  const initTx = new Transaction().add(initIx);
  initTx.feePayer = keypair.publicKey;
  initTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  initTx.sign(keypair);
  const initSig = await connection.sendRawTransaction(initTx.serialize());
  await connection.confirmTransaction(initSig, "confirmed");

  if (DEPOSIT_LAMPORTS > 0) {
    const depositData = Buffer.concat([
      discriminator("deposit"),
      encodeU64(DEPOSIT_LAMPORTS),
    ]);
    const depositIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: statePda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: depositData,
    });
    const depTx = new Transaction().add(depositIx);
    depTx.feePayer = keypair.publicKey;
    depTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    depTx.sign(keypair);
    const depSig = await connection.sendRawTransaction(depTx.serialize());
    await connection.confirmTransaction(depSig, "confirmed");
  }

  console.log("Initialize complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
