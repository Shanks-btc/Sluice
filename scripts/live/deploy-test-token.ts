// Deploys a token with no value to QIE's TESTNET, for rehearsing the whole flow there (docs/REHEARSAL.md).
//
// THE FOUNDER RUNS THIS. It has not been run by anyone, and nothing in this repository runs it automatically.
//
//   SLUICE_NETWORK=testnet SLUICE_APPROVE=deploy-test-token SLUICE_KEY=... pnpm live:test-token
//
// It REFUSES mainnet, twice: SLUICE_NETWORK must be testnet, and the node it connects to must report chain 1983, so a mainnet RPC address
// given by mistake is refused too. The router's deploy script still refuses any token but QUSDC on mainnet. The token is worth nothing and
// anyone can mint it. This script also refuses to run without SLUICE_APPROVE=deploy-test-token and stops at its spending caps.
import { writeFileSync } from "node:fs";
import { Wallet } from "ethers";
import { chooseRpc, providerFor } from "../../src/rpc-use";
import { GuardError, MAX_GAS_PRICE_WEI, formatQie, redact, requireApproval, SpendMeter } from "../../src/guard";
import { TESTNET_CHAIN_ID, deployTestToken, testTokenPlan } from "../../src/test-token";
import type { Env } from "../../src/live";

export async function main(env: Env = process.env, log: (line: string) => void = console.log): Promise<void> {
  // Mainnet is refused before the key is read and before any connection is opened.
  const network = env.SLUICE_NETWORK?.trim();
  if (network === "mainnet") throw new GuardError("refusing to run deploy-test-token on mainnet: the test token is for the testnet only");
  const approval = requireApproval("deploy-test-token", env, testTokenPlan(MAX_GAS_PRICE_WEI));
  if (approval.network !== "testnet") throw new GuardError("refusing to run deploy-test-token: SLUICE_NETWORK must be testnet");

  const provider = providerFor(await chooseRpc(approval.network, env.SLUICE_RPC_URL, log), approval.chainId);
  const reported = BigInt(String(await provider.send("eth_chainId", [])));
  if (reported !== BigInt(TESTNET_CHAIN_ID)) throw new GuardError(`refusing to run deploy-test-token: the RPC is on chain ${reported}, not the testnet's ${TESTNET_CHAIN_ID}`);
  const signer = new Wallet(approval.privateKey(), provider);
  log(`network testnet (chain ${TESTNET_CHAIN_ID})`);
  log(`deployer ${signer.address} (holds ${formatQie(await provider.getBalance(signer.address))} QIE)`);
  log(`caps: ${formatQie(approval.caps.maxQieWei)} QIE of gas`);

  const meter = new SpendMeter(approval.caps);
  const deployed = await deployTestToken({ signer, provider, meter, log }, TESTNET_CHAIN_ID);
  writeFileSync("testnet-token.json", JSON.stringify({ network: "testnet", chainId: TESTNET_CHAIN_ID, ...deployed, deployer: signer.address }, null, 2));
  log("wrote testnet-token.json (addresses only; it is git-ignored). This token has no value.");
  log(`next: set SLUICE_TOKEN=${deployed.token} and run scripts/live/deploy.ts on the testnet. See docs/REHEARSAL.md.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : "deploy-test-token failed", process.env));
    process.exitCode = 1;
  });
}
