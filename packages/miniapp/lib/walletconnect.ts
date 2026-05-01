// wagmi config — wallet connector list. SPEC §10.2.
//
// Inside the Telegram Mini App webview, only walletConnect() is functional
// (the webview does not expose browser extensions). When the same URL is
// opened in a regular browser tab, the injected() connector auto-detects
// MetaMask, Rabby, Brave Wallet, Phantom, etc. coinbaseWallet() handles
// Coinbase's extension + mobile wallet via their own SDK. The /connect and
// /sign pages render a button per connector — let the runtime decide what
// works.

import { createConfig, http, type Config } from "wagmi";
import { sepolia } from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";

export const SEPOLIA_CHAIN_ID = 11155111 as const;

const projectId = process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"] ?? "";

// Sepolia RPC for wagmi's transport. wagmi/viem call this URL for chain-id
// reads, nonce fetches, and gas estimation BEFORE handing the tx to the
// wallet — so it has to be reliable. `http()` with no URL falls back to
// viem's hard-coded public Sepolia, which rate-limits and surfaces as
// "Network or RPC error" the moment the user taps Confirm. Bake the same
// paid endpoint the agents use (NEXT_PUBLIC_ prefix because client-side).
const sepoliaRpcUrl = process.env["NEXT_PUBLIC_SEPOLIA_RPC_URL"];

export const wagmiConfig: Config = createConfig({
  chains: [sepolia],
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: "Parley" }),
    walletConnect({
      projectId,
      metadata: {
        name: "Parley",
        description: "Parley — peer DeFi negotiation",
        url: "https://parley.example",
        icons: [],
      },
      showQrModal: true,
    }),
  ],
  transports: {
    [sepolia.id]: sepoliaRpcUrl ? http(sepoliaRpcUrl) : http(),
  },
});
