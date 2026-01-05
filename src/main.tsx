import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

const endpoint =
  (import.meta.env?.VITE_RPC_URL as string | undefined) ??
  clusterApiUrl("mainnet-beta");
const wsEndpoint =
  (import.meta.env?.VITE_RPC_WS_URL as string | undefined) ??
  (endpoint.startsWith("http")
    ? endpoint.replace("https://", "wss://").replace("http://", "ws://")
    : "wss://api.mainnet-beta.solana.com");
const wallets = [new PhantomWalletAdapter()];

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectionProvider endpoint={endpoint} config={{ wsEndpoint }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </React.StrictMode>
);
