// WalletConnect v2 + wagmi config. SPEC §10.2.

import { createConfig, http, type Config } from "wagmi";
import { sepolia } from "wagmi/chains";
import { walletConnect } from "wagmi/connectors";

export const SEPOLIA_CHAIN_ID = 11155111 as const;

const projectId = process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"] ?? "";

export const wagmiConfig: Config = createConfig({
  chains: [sepolia],
  connectors: [
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
