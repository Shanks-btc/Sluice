// Deploying the testnet rehearsal token (contracts/test/TestnetToken.sol): a six-decimal token with no value that anyone can mint, for
// rehearsing the whole flow on QIE's testnet without a faucet or a purchase.
//
// This is for the testnet only. Two guards keep it off mainnet: the script refuses any network but testnet before it reads a key, and this
// function refuses to send anything unless the node reports the chain id it was told to expect (the script passes 1983). A mainnet node
// reports 1990 and is refused. The router's own deploy script already refuses any token but QUSDC on mainnet, so a router built on this
// token cannot be put on mainnet either.
import { ContractFactory, Contract } from "ethers";
import type { Provider, Signer } from "ethers";
import { GuardError } from "./guard";
import type { Plan, SpendMeter } from "./guard";
import { loadArtifact } from "./live";
import { formatQusdc } from "./units";

export const TESTNET_CHAIN_ID = 1983;
export const MAINNET_CHAIN_ID = 1990;
/** What the token's deployer is minted to start with: 1,000 test tokens. */
export const TEST_TOKEN_MINT = 1_000_000_000n;
const GAS_LIMIT = 1_500_000n;
const MINT_GAS_LIMIT = 100_000n;

export function testTokenPlan(maxGasPriceWei: bigint): Plan {
  return {
    qusdc: 0n,
    qieWei: (GAS_LIMIT + MINT_GAS_LIMIT) * maxGasPriceWei,
    summary: "deploy a testnet token with no value and mint 1,000 of it to the deployer; no QUSDC moves",
  };
}

export type TestTokenContext = { signer: Signer; provider: Provider; meter: SpendMeter; log: (line: string) => void };

/**
 * Deploys the token and mints the deployer's starting balance. `requiredChainId` is the chain the node must report; the script passes
 * the testnet's. A node on any other chain, mainnet above all, is refused before anything is sent.
 */
export async function deployTestToken(ctx: TestTokenContext, requiredChainId: number): Promise<{ token: string; hash: string; block: number }> {
  const chainId = Number((await ctx.provider.getNetwork()).chainId);
  if (chainId === MAINNET_CHAIN_ID && requiredChainId === TESTNET_CHAIN_ID) throw new GuardError("this node is on QIE mainnet (chain 1990): the test token is never deployed there");
  if (chainId !== requiredChainId) throw new GuardError(`this node is on chain ${chainId}, not the ${requiredChainId} this was asked to use`);

  const { abi, bytecode } = loadArtifact("TestnetToken", "test");
  const factory = new ContractFactory(abi as never, bytecode, ctx.signer);
  const tx = await factory.getDeployTransaction();
  const price = (await ctx.provider.getFeeData()).gasPrice;
  if (price === null || price === undefined || price <= 0n) throw new Error("the node did not give a gas price");
  const estimate = await ctx.signer.estimateGas(tx);
  const gasLimit = (estimate * 12n) / 10n;
  if (gasLimit > GAS_LIMIT) throw new GuardError("the token's deployment needs more gas than allowed");
  ctx.meter.beforeSend(gasLimit, price);
  const sent = await ctx.signer.sendTransaction({ ...tx, gasLimit, gasPrice: price });
  const receipt = await sent.wait();
  if (!receipt || receipt.status !== 1 || !receipt.contractAddress) throw new Error(`the token's deployment failed (${sent.hash})`);
  ctx.meter.afterSend(gasLimit, price, receipt.gasUsed, receipt.gasPrice);
  ctx.log(`test token ${receipt.contractAddress} (${receipt.hash}, block ${receipt.blockNumber})`);

  const token = new Contract(receipt.contractAddress, abi as never, ctx.signer);
  const me = await ctx.signer.getAddress();
  const mintEstimate = await token.getFunction("mint").estimateGas(me, TEST_TOKEN_MINT);
  const mintLimit = (mintEstimate * 12n) / 10n;
  if (mintLimit > MINT_GAS_LIMIT) throw new GuardError("the mint needs more gas than allowed");
  ctx.meter.beforeSend(mintLimit, price);
  const minted = await token.getFunction("mint")(me, TEST_TOKEN_MINT, { gasLimit: mintLimit, gasPrice: price });
  const mintReceipt = await minted.wait();
  if (!mintReceipt || mintReceipt.status !== 1) throw new Error("minting the deployer's tokens failed");
  ctx.meter.afterSend(mintLimit, price, mintReceipt.gasUsed, mintReceipt.gasPrice);
  ctx.log(`minted ${formatQusdc(TEST_TOKEN_MINT)} test tokens to ${me}`);
  return { token: receipt.contractAddress, hash: receipt.hash, block: receipt.blockNumber };
}
