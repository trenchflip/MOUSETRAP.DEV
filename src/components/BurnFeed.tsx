import { useEffect, useState } from "react";

const SERVER_URL =
  (import.meta.env?.VITE_SERVER_URL as string | undefined) ??
  "http://localhost:8787";

type BurnEntry = {
  signature: string;
  timestamp: string;
  burnAmountUi?: string;
  dryRun?: boolean;
};

function shortSig(sig: string) {
  return `${sig.slice(0, 6)}...${sig.slice(-4)}`;
}

export default function BurnFeed() {
  const [burns, setBurns] = useState<BurnEntry[]>([]);

  const load = async () => {
    try {
      const resp = await fetch(`${SERVER_URL}/burns?limit=8`);
      if (!resp.ok) return;
      const data = (await resp.json()) as { burns?: BurnEntry[] };
      if (Array.isArray(data.burns)) setBurns(data.burns.slice(0, 8));
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
      <h3>Recent Burns</h3>
      <div className="round-history burn-history">
        {burns.length === 0 ? (
          <div className="round-item">No burns yet.</div>
        ) : (
          burns.map((burn) => (
            <div className="round-item" key={burn.signature}>
              <div>
                🔥 {burn.burnAmountUi ?? "—"} BURN
                {burn.dryRun && <span className="burn-badge">Dry run</span>}
              </div>
              <div>{shortSig(burn.signature)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
