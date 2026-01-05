import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

const SERVER_URL =
  (import.meta.env?.VITE_SERVER_URL as string | undefined) ??
  "http://localhost:8787";

type Config = {
  housePubkey: string;
  minPlayers: number;
  roundIntervalMs: number;
};

type Entry = {
  player: string;
  amountLamports: number;
  timestamp: string;
  signature: string;
};

type Round = {
  id: string;
  startTime: string;
  nextSpinAt: string;
  status: string;
  entries: Entry[];
  entriesCount: number;
  uniquePlayers: number;
  potLamports: number;
  potSol: number;
  winner: null | {
    player: string;
    payoutSol: number;
  };
};

type Slice = {
  player: string;
  amountLamports: number;
  startAngle: number;
  endAngle: number;
  midAngle: number;
  color: string;
};

const SLICE_COLORS = ["#3aa0ff", "#6ec1ff", "#8fd3ff", "#1f6bff", "#2b73c9", "#5aa8ff"];

function shortKey(key: string) {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const angle = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  };
}

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
}

function pickWeighted(entries: Entry[]) {
  const total = entries.reduce((sum, e) => sum + e.amountLamports, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= entry.amountLamports;
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1] ?? null;
}

export default function WheelCard() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [config, setConfig] = useState<Config | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [bet, setBet] = useState("0.1");
  const [message, setMessage] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [countdown, setCountdown] = useState("—");
  const [lastRound, setLastRound] = useState<Round | null>(null);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const lastSpinId = useRef<string | null>(null);
  const [hoveredSlice, setHoveredSlice] = useState<number | null>(null);
  const lastCountdownSpinId = useRef<string | null>(null);
  const [winnerBanner, setWinnerBanner] = useState<string | null>(null);
  const [winnerKey, setWinnerKey] = useState<string | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const [marketCapUsd, setMarketCapUsd] = useState<number | null>(null);

  const betSol = useMemo(() => {
    const n = Number(bet);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [bet]);

  const loadConfig = async () => {
    try {
      const resp = await fetch(`${SERVER_URL}/config`);
      if (!resp.ok) return;
      const data = (await resp.json()) as Config;
      setConfig(data);
    } catch {
      // ignore
    }
  };

  const loadRound = async () => {
    try {
      const resp = await fetch(`${SERVER_URL}/round`);
      if (!resp.ok) return;
      const data = (await resp.json()) as { current: Round };
      setRound(data.current);
    } catch {
      // ignore
    }
  };

  const loadHistory = async () => {
    try {
      const resp = await fetch(`${SERVER_URL}/round/history?limit=1`);
      if (!resp.ok) return;
      const data = (await resp.json()) as { history: Round[] };
      const latest = data.history?.[0];
      if (!latest || latest.id === lastSpinId.current) return;
      lastSpinId.current = latest.id;
      setLastRound(latest);
      triggerSpin(latest);
    } catch {
      // ignore
    }
  };

  const loadMarketCap = async () => {
    try {
      const resp = await fetch(`${SERVER_URL}/marketcap`);
      if (!resp.ok) return;
      const data = (await resp.json()) as { marketCapUsd?: number | null };
      setMarketCapUsd(typeof data.marketCapUsd === "number" ? data.marketCapUsd : null);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadConfig();
    loadRound();
    loadHistory();
    loadMarketCap();
    const id = setInterval(loadRound, 5000);
    const historyId = setInterval(loadHistory, 7000);
    const capId = setInterval(loadMarketCap, 5000);
    return () => {
      clearInterval(id);
      clearInterval(historyId);
      clearInterval(capId);
    };
  }, []);

  useEffect(() => {
    if (!round?.nextSpinAt) return;
    const update = () => {
      const diff = new Date(round.nextSpinAt).getTime() - Date.now();
      const clamped = Math.max(0, Math.floor(diff / 1000));
      const mins = Math.floor(clamped / 60);
      const secs = clamped % 60;
      setCountdown(`${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [round?.nextSpinAt]);

  useEffect(() => {
    if (!round || spinning) return;
    if (countdown !== "00:00") return;
    const minPlayers = config?.minPlayers ?? 10;
    if (round.uniquePlayers < minPlayers) return;
    if (lastCountdownSpinId.current === round.id) return;
    lastCountdownSpinId.current = round.id;
    const winner = pickWeighted(round.entries);
    if (winner) {
      spinToWinner(round.entries, winner.player);
    }
  }, [countdown, round, config, spinning]);

  const aggregatedEntries = useMemo(() => {
    const source = spinning && lastRound?.entries ? lastRound.entries : round?.entries ?? [];
    const totals = new Map<string, number>();
    let totalRaw = 0;
    for (const entry of source) {
      const next = (totals.get(entry.player) ?? 0) + entry.amountLamports;
      totals.set(entry.player, next);
      totalRaw += entry.amountLamports;
    }
    const cap = totalRaw * 0.25;
    return Array.from(totals.entries()).map(([player, amountLamports]) => ({
      player,
      amountLamports: cap > 0 ? Math.min(amountLamports, cap) : amountLamports,
    }));
  }, [round?.entries, lastRound?.entries, spinning]);

  const slices = useMemo(() => {
    const total = aggregatedEntries.reduce((sum, e) => sum + e.amountLamports, 0);
    if (total <= 0) return [] as Slice[];
    let angle = 0;
    return aggregatedEntries.map((entry, index) => {
      const sliceAngle = (entry.amountLamports / total) * 360;
      const startAngle = angle;
      const endAngle = angle + sliceAngle;
      const midAngle = (startAngle + endAngle) / 2;
      angle = endAngle;
      return {
        player: entry.player,
        amountLamports: entry.amountLamports,
        startAngle,
        endAngle,
        midAngle,
        color: SLICE_COLORS[index % SLICE_COLORS.length],
      };
    });
  }, [aggregatedEntries]);

  const spinToWinner = (entries: Entry[], winnerPlayer: string) => {
    const total = entries.reduce((sum, e) => sum + e.amountLamports, 0);
    if (total <= 0) return;
    const map = new Map<string, number>();
    for (const entry of entries) {
      map.set(entry.player, (map.get(entry.player) ?? 0) + entry.amountLamports);
    }
    let angle = 0;
    let winnerMid = 0;
    for (const [player, amountLamports] of map.entries()) {
      const sliceAngle = (amountLamports / total) * 360;
      const startAngle = angle;
      const endAngle = angle + sliceAngle;
      if (player === winnerPlayer) {
        winnerMid = (startAngle + endAngle) / 2;
        break;
      }
      angle = endAngle;
    }
    const spins = 4 + Math.floor(Math.random() * 3);
    setSpinning(true);
    setWinnerKey(winnerPlayer);
    setRotation((prev) => prev + spins * 360 - winnerMid);
    setTimeout(() => {
      setSpinning(false);
      setWinnerBanner(shortKey(winnerPlayer));
      setTimeout(() => setWinnerBanner(null), 10_000);
    }, 3200);

    const ctx = audioRef.current ?? new AudioContext();
    audioRef.current = ctx;
    const playTick = (freq: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.value = 0.02;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.03);
    };
    const fast = setInterval(() => playTick(780), 90);
    setTimeout(() => {
      clearInterval(fast);
      const slow = setInterval(() => playTick(520), 140);
      setTimeout(() => clearInterval(slow), 800);
    }, 2300);
  };

  const triggerSpin = (finishedRound: Round) => {
    if (!finishedRound?.winner?.player) return;
    spinToWinner(finishedRound.entries, finishedRound.winner.player);
  };

  const enterWheel = async () => {
    if (!publicKey) {
      setMessage("Connect your wallet first.");
      return;
    }
    if (!config) {
      setMessage("Loading config...");
      return;
    }
    if (betSol <= 0) {
      setMessage("Enter a valid amount.");
      return;
    }

    setSubmitting(true);
    setMessage("Awaiting wallet approval...");

    try {
      const expectedLamports = Math.round(betSol * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        feePayer: publicKey,
        recentBlockhash: latest.blockhash,
      }).add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(config.housePubkey),
          lamports: expectedLamports,
        })
      );

      const signature = await sendTransaction(tx, connection, {
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: 3,
      });

      setMessage("Payment sent. Verifying...");
      const resp = await fetch(`${SERVER_URL}/enter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature, expectedLamports }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error ?? "Entry failed.");
      }
      setRound(data.current);
      setMessage("Entry confirmed!");
    } catch (e: any) {
      setMessage(e?.message ?? "Entry failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card wheel-card">
      <div className="wheel-ticker">
        Burn Coin MKT&nbsp;—&nbsp;
        <b>{marketCapUsd ? `$${marketCapUsd.toFixed(2)}` : "—"}</b>
      </div>
      <h3>50/50 Wheel</h3>
      <div className="stats-row">
        <div className="stat-pill">
          <span>Pot</span>
          <b>{round?.potSol?.toFixed(4) ?? "0.0000"} SOL</b>
        </div>
        <div className="stat-pill">
          <span>Entries</span>
          <b>{round?.entriesCount ?? 0}</b>
        </div>
        <div className="stat-pill">
          <span>Players</span>
          <b>{round?.uniquePlayers ?? 0} / {config?.minPlayers ?? "—"}</b>
        </div>
        <div className="stat-pill">
          <span>Next Spin</span>
          <b>{countdown}</b>
        </div>
      </div>

      <details className="how-it-works">
        <summary>How it works</summary>
        <div className="how-it-works-body">
          <p>Buy entries before the timer hits zero. Each wallet's slice size scales with its total entry, capped at 25% of the wheel.</p>
          <p>When the round ends with at least {config?.minPlayers ?? 10} unique wallets, the wheel spins and picks a winner.</p>
          <p>Winner gets 50% of the pot. The other 50% is reserved for the burn buyback flow.</p>
        </div>
      </details>

      <div className={`wheel-wrap ${spinning ? "spinning" : ""}`}>
        <div className="wheel-pointer" />
        <svg
          viewBox="0 0 300 300"
          className={`wheel ${spinning ? "spinning" : ""}`}
          style={{ transform: `rotate(${rotation}deg)` }}
        >
          <defs>
            {slices.map((slice, index) => (
              <linearGradient id={`slice-grad-${index}`} key={slice.player} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#e6f5ff" />
                <stop offset="100%" stopColor={slice.color} />
              </linearGradient>
            ))}
          </defs>
          {slices.length === 0 && (
            <circle cx="150" cy="150" r="120" fill="#10253f" stroke="#1f3b63" strokeWidth="2" />
          )}
          <circle cx="150" cy="150" r="128" className="wheel-rim" />
          {slices.map((slice, index) => {
            const isUser = publicKey && slice.player === publicKey.toBase58();
            return (
            <path
              key={`${slice.player}-${index}`}
              d={arcPath(150, 150, 120, slice.startAngle, slice.endAngle)}
              fill={slice.color}
              stroke={isUser ? "#cfe7ff" : "#0f2036"}
              strokeWidth="1"
              onMouseEnter={() => setHoveredSlice(index)}
              onMouseLeave={() => setHoveredSlice(null)}
              className={winnerKey === slice.player ? "wheel-slice winner" : "wheel-slice"}
            />
          )})}
          {slices.map((slice, index) => {
            const isUser = publicKey && slice.player === publicKey.toBase58();
            const showLabel = hoveredSlice === index || isUser;
            const labelPos = polarToCartesian(150, 150, 80, slice.midAngle);
            return (
              <text
                key={`${slice.player}-label-${index}`}
                x={labelPos.x}
                y={labelPos.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#f3f9ff"
                fontSize="10"
                opacity={showLabel ? 1 : 0}
              >
                {isUser ? "You" : shortKey(slice.player)}
              </text>
            );
          })}
          <circle cx="150" cy="150" r="0" className="wheel-cap" />
          <circle cx="150" cy="150" r="0" className="wheel-cap-core" />
        </svg>
      </div>

      {winnerBanner && (
        <div className="winner-banner">
          Winner: {winnerBanner}
        </div>
      )}

      <div className="entry-row">
        <input
          type="number"
          min="0"
          step="0.01"
          value={bet}
          onChange={(e) => setBet(e.target.value)}
          placeholder="Entry amount (SOL)"
        />
        <button onClick={enterWheel} disabled={submitting}>
          {submitting ? "Submitting..." : "Enter"}
        </button>
      </div>

      {message && <div style={{ marginTop: 10 }}>{message}</div>}

      <div className="entries-list">
        {(round?.entries ?? []).slice(0, 10).map((entry) => (
          <div className="entry-item" key={entry.signature}>
            <span>{entry.player.slice(0, 6)}...{entry.player.slice(-4)}</span>
            <span>{(entry.amountLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL</span>
          </div>
        ))}
        {(round?.entries?.length ?? 0) === 0 && (
          <div className="entry-item">No entries yet.</div>
        )}
      </div>
    </div>
  );
}
