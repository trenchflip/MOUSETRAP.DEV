import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import BurnFeed from "./components/BurnFeed";
import WheelCard from "./components/WheelCard";
import RoundHistory from "./components/RoundHistory";
import "./App.css";

export default function App() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [balance, setBalance] = useState<string>("—");

  const loadBalance = async () => {
    if (!publicKey) {
      setBalance("—");
      return;
    }
    try {
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setBalance((lamports / LAMPORTS_PER_SOL).toFixed(4));
    } catch {
      setBalance("—");
    }
  };

  useEffect(() => {
    loadBalance();
  }, [publicKey]);

  useEffect(() => {
    const id = setInterval(() => {
      if (publicKey) loadBalance();
    }, 5000);
    return () => clearInterval(id);
  }, [publicKey]);

  return (
    <div className="app-shell">
      <div className="top-banner">
        <img src="/wheelspin-logo.png" alt="Wheel Spin logo" />
      </div>

      <div className="wallet-row">
        <WalletMultiButton />
        <div className="wallet-balance">
          <span>Wallet Balance</span>
          <b>{balance} SOL</b>
        </div>
      </div>

      <div className="content-grid">
        <BurnFeed />
        <WheelCard />
        <RoundHistory />
      </div>
    </div>
  );
}
