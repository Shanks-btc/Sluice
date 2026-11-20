// The zero-QIE start, client side. A wallet that holds QUSDC and no QIE cannot send the two transactions a first
// deposit needs (QUSDC has no permit and no EIP-3009). It can still SIGN them offline. This module builds those
// two signed transactions; a facilitator checks them, tops the wallet up with exactly the gas they can use, and
// broadcasts them. See docs/SPEC.md, "Starting with no QIE".
//
// The owner's key signs here, in the owner's own process. No Sluice package that an agent runs ever calls this.
import { Transaction, getAddress, parseUnits } from "ethers";
import type { Wallet } from "ethers";
import { erc20Interface, routerInterface } from "./abi";
import { CHAIN_ID, QUSDC_ADDRESS } from "./protocol";

/** The gas limits a payer signs. Measured on the fork: approve 46,961; the first deposit into a router 112,937. */
export const ONBOARD_APPROVE_GAS = 60_000n;
export const ONBOARD_DEPOSIT_GAS = 130_000n;

export type OnboardingParams = {
  router: string;
  /** Amount to deposit, in QUSDC units. The approval is for exactly this amount. */
  amount: bigint;
  /** The wallet's current transaction count (`eth_getTransactionCount`, "pending"). */
  nonce: number;
  /** Gas price in wei. A facilitator refuses one above its ceiling. */
  gasPrice: bigint;
  chainId?: number;
  asset?: string;
};

export type OnboardingTxs = { approveTx: string; depositTx: string; gasWei: bigint };

/** Signs `approve(router, amount)` and `deposit(amount)` as two legacy, chain-bound transactions. */
export async function signOnboarding(wallet: Wallet, params: OnboardingParams): Promise<OnboardingTxs> {
  const chainId = params.chainId ?? CHAIN_ID;
  const router = getAddress(params.router);
  const approve = Transaction.from({
    type: 0,
    chainId,
    nonce: params.nonce,
    gasPrice: params.gasPrice,
    gasLimit: ONBOARD_APPROVE_GAS,
    to: getAddress(params.asset ?? QUSDC_ADDRESS),
    value: 0n,
    data: erc20Interface.encodeFunctionData("approve", [router, params.amount]),
  });
  const deposit = Transaction.from({
    type: 0,
    chainId,
    nonce: params.nonce + 1,
    gasPrice: params.gasPrice,
    gasLimit: ONBOARD_DEPOSIT_GAS,
    to: router,
    value: 0n,
    data: routerInterface.encodeFunctionData("deposit", [params.amount]),
  });
  return {
    approveTx: await wallet.signTransaction(approve),
    depositTx: await wallet.signTransaction(deposit),
    gasWei: (ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS) * params.gasPrice,
  };
}

/** "5" or "5.25" QUSDC -> units. */
export const usdc = (amount: string): bigint => parseUnits(amount, 6);
