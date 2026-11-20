// Shared helpers for the tests: EIP-712 typed data, deployment, funding and signing.
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { TypedDataDomain } from "ethers";
import { ethers } from "hardhat";
import { dyn } from "../../src/dyn";
import type { Dyn } from "../../src/dyn";

export type { Dyn };

export const CHAIN_ID = 1990;
export const MAX_FEE_BPS = 200;

/** QUSDC units: USDC("0.01") is 10000n. */
export const USDC = (amount: string | number): bigint => ethers.parseUnits(String(amount), 6);

export type Intent = {
  payer: string;
  payee: string;
  amount: bigint;
  toolId: string;
  nonce: string;
  deadline: bigint;
};
export type Tool = { payee: string; toolId: string };
export type Grant = { agent: string; budget: bigint; perCallCap: bigint; expiry: bigint };

/** Anything that can sign EIP-712 typed data: a Hardhat signer or an ethers Wallet. */
export type TypedSigner = {
  address: string;
  signTypedData: (
    domain: TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ) => Promise<string>;
};

export const paymentTypes = {
  Payment: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "toolId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};
export const withdrawTypes = {
  Withdraw: [
    { name: "account", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};
export const refundTypes = {
  Refund: [
    { name: "payer", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};
export const authorizeTypes = {
  Authorize: [
    { name: "payer", type: "address" },
    { name: "agent", type: "address" },
    { name: "budget", type: "uint256" },
    { name: "perCallCap", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "tools", type: "Tool[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Tool: [
    { name: "payee", type: "address" },
    { name: "toolId", type: "bytes32" },
  ],
};
export const revokeTypes = {
  Revoke: [
    { name: "payer", type: "address" },
    { name: "agent", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export const routerDomain = (verifyingContract: string, chainId = CHAIN_ID): TypedDataDomain => ({
  name: "SluiceRouter",
  version: "1",
  chainId,
  verifyingContract,
});
export const vaultDomain = (verifyingContract: string, chainId = CHAIN_ID): TypedDataDomain => ({
  name: "SluiceAgentVault",
  version: "1",
  chainId,
  verifyingContract,
});

export const randomNonce = (): string => ethers.hexlify(ethers.randomBytes(32));
/** A tool id is the keccak256 of the tool's name. */
export const toolId = (name: string): string => ethers.id(name);

export type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/** Deploys a contract by name. The result is a Dyn, so any method of its ABI can be called by name. */
export async function deployContract(name: string, args: unknown[] = []): Promise<Dyn> {
  const factory = await ethers.getContractFactory(name);
  const instance = await factory.deploy(...args);
  await instance.waitForDeployment();
  return dyn(instance);
}

/** An already deployed contract, by name and address. */
export async function attach(name: string, address: string): Promise<Dyn> {
  return dyn(await ethers.getContractAt(name, address));
}

/**
 * Deploys the router (and so its vault). By default the token is a fresh MockQUSDC. A fork test passes the
 * real QUSDC and a `mint` that funds accounts the way the fork allows.
 */
export async function deploy(
  opts: { feeBps?: number; token?: Dyn; mint?: (to: string, amount: bigint) => Promise<void> } = {},
) {
  const all = (await ethers.getSigners()) as [Signer, Signer, Signer, Signer, Signer, Signer, Signer, ...Signer[]];
  const [owner, feeRecipient, payer, builder, relayer, stranger, other] = all;
  const token = opts.token ?? (await deployContract("MockQUSDC"));
  const mint = opts.mint ?? (async (to: string, amount: bigint) => void (await token.mint(to, amount)));
  const tokenAddress = await token.getAddress();
  const router = await deployContract("PaymentRouter", [
    tokenAddress,
    owner.address,
    feeRecipient.address,
    opts.feeBps ?? 100,
  ]);
  const routerAddress = await router.getAddress();
  const vault = await attach("AgentVault", await router.vault());
  const vaultAddress = await vault.getAddress();
  return {
    all,
    owner,
    feeRecipient,
    payer,
    builder,
    relayer,
    stranger,
    other,
    token,
    mint,
    tokenAddress,
    router,
    routerAddress,
    vault,
    vaultAddress,
  };
}
export type World = Awaited<ReturnType<typeof deploy>>;

/** Mints tokens to the account, approves the router and deposits them. */
export async function fundBalance(w: Pick<World, "token" | "mint" | "router" | "routerAddress">, who: Signer, amount: bigint) {
  await w.mint(who.address, amount);
  await w.token.connect(who).approve(w.routerAddress, amount);
  await w.router.connect(who).deposit(amount);
}

export async function newIntent(
  payer: string,
  payee: string,
  amount: bigint,
  over: Partial<Intent> = {},
): Promise<Intent> {
  return {
    payer,
    payee,
    amount,
    toolId: toolId("tool"),
    nonce: randomNonce(),
    deadline: BigInt(await time.latest()) + 3600n,
    ...over,
  };
}

export async function signIntent(
  signer: TypedSigner,
  routerAddress: string,
  intent: Intent,
  chainId = CHAIN_ID,
): Promise<string> {
  return signer.signTypedData(routerDomain(routerAddress, chainId), paymentTypes, intent);
}

/** An intent and its signature in one step, signed by `signer` (the payer, or an agent key). */
export async function signedIntent(
  w: Pick<World, "routerAddress">,
  signer: TypedSigner,
  payer: string,
  payee: string,
  amount: bigint,
  over: Partial<Intent> = {},
) {
  const intent = await newIntent(payer, payee, amount, over);
  return { intent, signature: await signIntent(signer, w.routerAddress, intent) };
}

export async function balances(router: Dyn, token: Dyn, account: string) {
  return {
    prepaid: (await router.payerBalance(account)) as bigint,
    earned: (await router.earnings(account)) as bigint,
    wallet: (await token.balanceOf(account)) as bigint,
  };
}

export async function nowSeconds(): Promise<bigint> {
  return BigInt(await time.latest());
}

/** Flips one hex digit of a signature's `r`, giving a well-formed signature by nobody in particular. */
export function tamper(signature: string): string {
  const flipped = signature.slice(2, 4) === "00" ? "01" : "00";
  return `0x${flipped}${signature.slice(4)}`;
}

/** The secp256k1 group order, to build the high-s twin of a signature. */
export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The malleable twin of a signature: same signer, s replaced by N - s, v flipped. */
export function malleate(signature: string): string {
  const sig = ethers.Signature.from(signature);
  const s = SECP_N - BigInt(sig.s);
  const v = sig.v === 27 ? 28 : 27;
  return ethers.concat([sig.r, ethers.zeroPadValue(ethers.toBeHex(s), 32), ethers.toBeHex(v, 1)]);
}
