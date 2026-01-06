import { useEffect, useMemo, useState } from "react";
import "./App.css";

const BASE_SIZE = 9;
const GROW_EVERY = 250;
const STEP_INTERVAL_MS = 900;
const MOUSE_IMAGE = "/mouse-logo.png";
const METRICS_URL =
  (import.meta.env?.VITE_METRICS_URL as string | undefined) ?? "/metrics";

type Cell = {
  row: number;
  col: number;
  walls: { t: boolean; r: boolean; b: boolean; l: boolean };
};

type Metrics = {
  holders: number;
  treasurySol: number;
  lastWinner: string;
};

type CheeseEvent = {
  id: string;
  wallet: string;
  payout: number;
  time: string;
};

type BurnEvent = {
  id: string;
  amount: number;
  signature: string;
  time: string;
  dryRun: boolean;
};

function formatSol(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function makeOdd(value: number) {
  return value % 2 === 0 ? value + 1 : value;
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickHolderCells(grid: Cell[][], count: number, seed: number) {
  const rand = mulberry32(seed);
  const size = grid.length;
  const picks = new Set<string>();
  const max = size * size;
  const target = Math.min(count, max);
  while (picks.size < target) {
    const row = Math.floor(rand() * size);
    const col = Math.floor(rand() * size);
    picks.add(`${row}-${col}`);
  }
  return picks;
}

function generateMaze(size: number, seed: number) {
  const rand = mulberry32(seed);
  const grid: Cell[][] = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => ({
      row,
      col,
      walls: { t: true, r: true, b: true, l: true },
    }))
  );
  const visited = Array.from({ length: size }, () => Array(size).fill(false));
  const stack: Cell[] = [];

  let current = grid[0][0];
  visited[0][0] = true;
  stack.push(current);

  const directions = [
    { dr: -1, dc: 0, wall: "t", opp: "b" },
    { dr: 0, dc: 1, wall: "r", opp: "l" },
    { dr: 1, dc: 0, wall: "b", opp: "t" },
    { dr: 0, dc: -1, wall: "l", opp: "r" },
  ] as const;

  while (stack.length) {
    current = stack[stack.length - 1];
    const neighbors = directions
      .map((dir) => {
        const nr = current.row + dir.dr;
        const nc = current.col + dir.dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) return null;
        if (visited[nr][nc]) return null;
        return { cell: grid[nr][nc], dir };
      })
      .filter(Boolean) as Array<{ cell: Cell; dir: (typeof directions)[number] }>;

    if (!neighbors.length) {
      stack.pop();
      continue;
    }

    const pick = neighbors[Math.floor(rand() * neighbors.length)];
    const next = pick.cell;
    current.walls[pick.dir.wall] = false;
    next.walls[pick.dir.opp] = false;
    visited[next.row][next.col] = true;
    stack.push(next);
  }

  return grid;
}

function findPath(grid: Cell[][]) {
  const size = grid.length;
  const queue: Array<[number, number]> = [[0, 0]];
  const prev: Array<Array<[number, number] | null>> = Array.from({ length: size }, () =>
    Array(size).fill(null)
  );
  prev[0][0] = [-1, -1];

  while (queue.length) {
    const [r, c] = queue.shift()!;
    if (r === size - 1 && c === size - 1) break;
    const cell = grid[r][c];
    const moves: Array<[number, number, boolean]> = [
      [r - 1, c, !cell.walls.t],
      [r, c + 1, !cell.walls.r],
      [r + 1, c, !cell.walls.b],
      [r, c - 1, !cell.walls.l],
    ];
    for (const [nr, nc, open] of moves) {
      if (!open) continue;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      if (prev[nr][nc]) continue;
      prev[nr][nc] = [r, c];
      queue.push([nr, nc]);
    }
  }

  const path: Array<[number, number]> = [];
  let cur: [number, number] | null = [size - 1, size - 1];
  while (cur) {
    path.push(cur);
    const prevCell = prev[cur[0]][cur[1]];
    if (!prevCell) break;
    const pr: number = prevCell[0];
    const pc: number = prevCell[1];
    if (pr === -1 && pc === -1) break;
    cur = [pr, pc];
  }
  return path.reverse();
}

export default function App() {
  const [holders, setHolders] = useState(842);
  const [treasury, setTreasury] = useState(482.32);
  const [lastWinner, setLastWinner] = useState("9VhE...2pQk");
  const [step, setStep] = useState(0);
  const [nextPayout, setNextPayout] = useState(60);
  const [cheeseFeed, setCheeseFeed] = useState<CheeseEvent[]>([]);
  const [burnFeed, setBurnFeed] = useState<BurnEvent[]>([]);

  useEffect(() => {
    const tick = setInterval(() => {
      setStep((prev) => prev + 1);
    }, STEP_INTERVAL_MS);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const countdown = setInterval(() => {
      setNextPayout((prev) => (prev <= 1 ? 60 : prev - 1));
    }, 1000);
    return () => clearInterval(countdown);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const resp = await fetch(METRICS_URL, { cache: "no-store" });
        if (!resp.ok) return;
        const data = (await resp.json()) as Partial<Metrics>;
        if (typeof data.holders === "number") setHolders(data.holders);
        if (typeof data.treasurySol === "number") setTreasury(data.treasurySol);
        if (typeof data.lastWinner === "string") setLastWinner(data.lastWinner);
      } catch {
        // ignore
      }
    };
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const resp = await fetch(`${METRICS_URL.replace(/\/metrics$/, "")}/payouts?limit=6`, {
          cache: "no-store",
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { payouts?: Array<any> };
        if (!Array.isArray(data.payouts)) return;
        const mapped = data.payouts.map((entry) => ({
          id: entry.id || `${entry.timestamp}-${entry.winner}`,
          wallet: entry.winner ? `${entry.winner.slice(0, 6)}...${entry.winner.slice(-4)}` : "—",
          payout: Number(entry.payoutSol) || 0,
          time: entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "—",
        }));
        setCheeseFeed(mapped);
      } catch {
        // ignore
      }
    };
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const resp = await fetch(`${METRICS_URL.replace(/\/metrics$/, "")}/buybacks?limit=6`, {
          cache: "no-store",
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { buybacks?: Array<any> };
        if (!Array.isArray(data.buybacks)) return;
        const mapped = data.buybacks.map((entry) => ({
          id: entry.id || `${entry.timestamp}-${entry.signature}`,
          amount: Number(entry.buySol) || 0,
          signature: entry.signature || "—",
          time: entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "—",
          dryRun: Boolean(entry.dryRun),
        }));
        setBurnFeed(mapped);
      } catch {
        // ignore
      }
    };
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  const mazeSize = useMemo(() => {
    const growth = Math.floor(holders / GROW_EVERY);
    return makeOdd(BASE_SIZE + growth * 2);
  }, [holders]);

  const mazeGrid = useMemo(() => generateMaze(mazeSize, 12345 + mazeSize * 97), [mazeSize]);
  const mazePath = useMemo(() => findPath(mazeGrid), [mazeGrid]);
  const mouseIndex = step % mazePath.length;
  const mouse = mazePath[mouseIndex];
  const holderCount = Math.min(holders, 120);
  const holderCells = useMemo(
    () => pickHolderCells(mazeGrid, holderCount, 1000 + holders),
    [mazeGrid, holderCount, holders]
  );

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="logo-banner">
          <img src={MOUSE_IMAGE} alt="Mouse Trap Rewards logo" />
        </div>
        <div className="hero-content">
          <div className="title-block">
            <p className="overline">Mouse Trap</p>
            <h1>Maze Rewards</h1>
            <p className="subtitle">
              Holders are placed in the maze. The mouse never escapes — the maze grows with the crowd.
            </p>
          </div>
        </div>
      </header>

      <section className="maze-wrap">
        <div className="maze-header">
          <h2>Live Maze</h2>
          <div className="maze-pill">Size {mazeSize} x {mazeSize}</div>
        </div>
        <div
          className="maze-grid"
          style={{ gridTemplateColumns: `repeat(${mazeSize}, minmax(0, 1fr))` }}
        >
          {mazeGrid.flat().map((cell) => {
            const isMouse = mouse && mouse[0] === cell.row && mouse[1] === cell.col;
            const isExit = cell.row === mazeSize - 1 && cell.col === mazeSize - 1;
            const hasHolder = holderCells.has(`${cell.row}-${cell.col}`);
            return (
              <div
                key={`${cell.row}-${cell.col}`}
                className={`maze-cell ${isMouse ? "mouse" : ""} ${isExit ? "exit" : ""}`}
                style={{
                  borderTop: cell.walls.t ? "3px solid var(--maze-edge)" : "3px solid transparent",
                  borderRight: cell.walls.r ? "3px solid var(--maze-edge)" : "3px solid transparent",
                  borderBottom: cell.walls.b ? "3px solid var(--maze-edge)" : "3px solid transparent",
                  borderLeft: cell.walls.l ? "3px solid var(--maze-edge)" : "3px solid transparent",
                }}
              >
                {!isMouse && hasHolder ? <span className="holder-dot" /> : null}
                {isMouse ? <img src={MOUSE_IMAGE} alt="Mouse" className="mouse-token" /> : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="maze-metrics">
        <div className="hero-panel">
          <div>
            <span>Next Payout</span>
            <strong>{nextPayout}s</strong>
          </div>
          <div>
            <span>Last Winner</span>
            <strong>{lastWinner}</strong>
          </div>
          <div>
            <span>Treasury</span>
            <strong>{formatSol(treasury)} SOL</strong>
          </div>
          <div>
            <span>Holders</span>
            <strong>{holders.toLocaleString()}</strong>
          </div>
        </div>
        <div className="cheese-feed">
          <h4>Mouse Found Cheese</h4>
          {cheeseFeed.length === 0 ? (
            <p>No finds yet.</p>
          ) : (
            <ul>
              {cheeseFeed.map((event) => (
                <li key={event.id}>
                  <span>{event.wallet}</span>
                  <strong>{formatSol(event.payout)} SOL</strong>
                  <em>{event.time}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="burn-feed-wrap">
        <div className="card burn-card">
          <h3>Burn Feed</h3>
          {burnFeed.length === 0 ? (
            <p>No burns yet.</p>
          ) : (
            <ul className="burn-list">
              {burnFeed.map((burn) => (
                <li key={burn.id}>
                  <span>{burn.signature.slice(0, 6)}...{burn.signature.slice(-4)}</span>
                  <strong>{formatSol(burn.amount)} SOL</strong>
                  <em>{burn.time}{burn.dryRun ? " (dry run)" : ""}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="story">
        <div className="card">
          <h3>How rewards work</h3>
          <p>
            Every minute the mouse advances. When it finds a wallet, 10% of the treasury pays that holder in SOL.
            Larger holdings mean more maze positions.
          </p>
        </div>
        <div className="card">
          <h3>Token launch (pump.fun)</h3>
          <p>
            This is the live viewer. Snapshot data will replace placeholders once the mint is live.
          </p>
        </div>
      </section>
    </div>
  );
}
