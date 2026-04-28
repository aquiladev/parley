// viem clients for the MM Agent. Public client for chain reads (event watching,
// receipts); wallet client for direct submission of `lockMMSide`.

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export interface MmWallet {
  publicClient: PublicClient;
  walletClient: WalletClient;
  address: Hex;
}

export function buildWallet(privateKey: Hex, rpcUrl: string): MmWallet {
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);

  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ chain: sepolia, transport, account });

  return { publicClient, walletClient, address: account.address };
}
