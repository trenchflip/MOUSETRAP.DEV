import { useEffect, useState } from "react";

const SERVER_URL =
  (import.meta.env?.VITE_SERVER_URL as string | undefined) ??
  "http://localhost:8787";

type RoundSummary = {
  id: string;
  startTime: string;
  winner: null | {
    player: string;
    payoutSol: number;
  };
  potSol: number;
  entriesCount: number;
  payoutSig?: string | null;
};

function shortKey(key: string) {
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export default function RoundHistory() {
  const [rounds, setRounds] = useState<RoundSummary[]>([]);

  const load = async () => {
    try {
      const resp = await fetch(`${SERVER_URL}/round/history?limit=8`);
      if (!resp.ok) return;
      const data = (await resp.json()) as { history: RoundSummary[] };
      setRounds((data.history ?? []).slice(0, 8));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="card">
      <h3>Recent Spins</h3>
      <div className="round-history">
        {rounds.length === 0 ? (
          <div className="round-item">No spins yet.</div>
        ) : (
          rounds.map((round) => (
            <div className="round-item" key={round.id}>
              <div>Pot: {round.potSol?.toFixed(4) ?? "0.0000"} SOL</div>
              <div>Entries: {round.entriesCount ?? 0}</div>
              <div>
                Winner: {round.winner ? shortKey(round.winner.player) : "—"}
              </div>
              {round.payoutSig && (
                <a
                  href={`https://solscan.io/tx/${round.payoutSig}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Tx: {shortKey(round.payoutSig)}
                </a>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
