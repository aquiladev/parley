// Pre-populate gas params for wallet prompts.
//
// MetaMask Mobile (via WalletConnect) defaults to an aggressive gas
// estimator when the dApp doesn't supply explicit `gas` /
// `maxFeePerGas` / `maxPriorityFeePerGas`. On Sepolia this surfaces in the
// wallet UI as a fee that's an order of magnitude higher than necessary —
// users see a $0.10+ "gas" estimate for a sub-$0.001 tx, panic, and bail.
//
// Fix: estimate ourselves before opening the wallet. Sepolia has live
// EIP-1559 base fees that viem's `estimateFeesPerGas` reads from
// `eth_feeHistory`; combined with `estimateContractGas` we get a sane upper
// bound on `gas` and a market-rate fee. The wallet just shows what we
// passed in.
//
// All helpers fail open: if the estimate read errors, the caller can fall
// back to letting the wallet decide. (We log and rethrow — callers can
// catch and decide whether to retry without overrides.)

import { type Abi, type Address, type Hex, type PublicClient } from "viem";

export interface FeeOverrides {
  /** EIP-1559 max fee. Caps total per-gas cost the user can be charged. */
  maxFeePerGas: bigint;
  /** Tip to validators on top of base fee. */
  maxPriorityFeePerGas: bigint;
}

export interface GasOverrides extends FeeOverrides {
  /** Gas limit. Comes from `estimateContractGas` (or `estimateGas`) plus a
   *  10% buffer to absorb chain-state drift between estimate and submission. */
  gas: bigint;
}

const GAS_BUFFER_NUM = 110n;
const GAS_BUFFER_DEN = 100n;

/** Read EIP-1559 fees only. Cheap; one `eth_feeHistory` call. Use when
 *  the gas-limit estimate has to come from somewhere else (e.g. the
 *  caller is composing a raw tx). */
export async function estimateFees(
  publicClient: PublicClient,
): Promise<FeeOverrides> {
  const f = await publicClient.estimateFeesPerGas();
  return {
    maxFeePerGas: f.maxFeePerGas,
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
  };
}

/** Estimate gas + fees for a contract call. Spreads the result into a
 *  wagmi `writeContract` call:
 *
 *    const overrides = await estimateContractOverrides(publicClient, {...});
 *    await writeContractAsync({ ...args, ...overrides });
 *
 *  If the call would revert, viem throws here with the revert reason —
 *  catch it in the caller and surface a friendly error before the user
 *  signs anything. */
export async function estimateContractOverrides(
  publicClient: PublicClient,
  args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    account: Address;
    value?: bigint;
  },
): Promise<GasOverrides> {
  const [gas, fees] = await Promise.all([
    publicClient.estimateContractGas({
      address: args.address,
      abi: args.abi,
      functionName: args.functionName,
      args: args.args,
      account: args.account,
      ...(args.value !== undefined ? { value: args.value } : {}),
    }),
    publicClient.estimateFeesPerGas(),
  ]);
  return {
    gas: (gas * GAS_BUFFER_NUM) / GAS_BUFFER_DEN,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
}

/** Estimate gas + fees for a raw `sendTransaction` call (no ABI / no
 *  function name — typically Uniswap calldata produced upstream). */
export async function estimateSendOverrides(
  publicClient: PublicClient,
  args: {
    account: Address;
    to: Address;
    data: Hex;
    value?: bigint;
  },
): Promise<GasOverrides> {
  const [gas, fees] = await Promise.all([
    publicClient.estimateGas({
      account: args.account,
      to: args.to,
      data: args.data,
      ...(args.value !== undefined ? { value: args.value } : {}),
    }),
    publicClient.estimateFeesPerGas(),
  ]);
  return {
    gas: (gas * GAS_BUFFER_NUM) / GAS_BUFFER_DEN,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
}
