// Helpers for the tests that run against a fork of QIE mainnet (FORK=1).
//
// Everything here happens on a local copy of the chain held in memory. Impersonation and balance changes are
// local to that copy: nothing is sent to QIE, and no key is used.
import { ethers, network } from "hardhat";
import { attach, deploy, USDC } from "./index";
import type { Dyn, Signer } from "./index";

export const QUSDC = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5";
/** The contract that holds QUSDC's VAULT_ROLE and so can mint and burn. */
export const QUSDC_VAULT = "0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45";
/** The account that holds DEFAULT_ADMIN_ROLE and so can grant VAULT_ROLE. */
export const QUSDC_ADMIN = "0xe1acec6312eb701D4A14De700CCec8DeE17a8D28";

/** Every address the brief says QIE does not have code at. */
export const MISSING_ON_QIE: Array<[string, string]> = [
  ["Multicall3", "0xcA11bde05977b3631167028862bE2a173976CA11"],
  ["CREATE2 deployer (Arachnid)", "0x4e59b44847b379578588920cA78FbF26c0B4956C"],
  ["ERC-4337 EntryPoint v0.6", "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"],
  ["ERC-4337 EntryPoint v0.7", "0x0000000071727De22E5E9d8BAf0edAc6f37da032"],
  ["Permit2", "0x000000000022D473030F116dDEE9F6B43aC78BA3"],
];

const QUSDC_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)",
  "function VAULT_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function mint(address,uint256)",
  "function burn(address,uint256)",
];

export async function realQusdc(): Promise<Dyn> {
  return (await ethers.getContractAt(QUSDC_ABI, QUSDC)) as unknown as Dyn;
}

/** Runs `fn` as `address` on the local fork, giving it a little QIE for gas, then stops impersonating. */
export async function asAccount<T>(address: string, fn: (signer: Signer) => Promise<T>): Promise<T> {
  await network.provider.send("hardhat_setBalance", [address, "0x56bc75e2d63100000"]); // 100 QIE, local only
  await network.provider.send("hardhat_impersonateAccount", [address]);
  try {
    return await fn(await ethers.getSigner(address));
  } finally {
    await network.provider.send("hardhat_stopImpersonatingAccount", [address]);
  }
}

/** Funds an account with QUSDC by minting as the QUSDC vault, on the local fork only. */
export async function mintQusdc(to: string, amount: bigint): Promise<void> {
  const token = await realQusdc();
  await asAccount(QUSDC_VAULT, async (vault) => {
    await (await token.connect(vault).mint(to, amount)).wait();
  });
}

/** The world of the unit tests, but with the real QUSDC on the fork as the token. */
export async function deployOnFork(feeBps = 100) {
  const token = await realQusdc();
  return deploy({ feeBps, token, mint: mintQusdc });
}

export { attach, USDC };
