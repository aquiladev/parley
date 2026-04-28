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
    [sepolia.id]: http(),
  },
});
