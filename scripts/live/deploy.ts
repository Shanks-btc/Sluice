// Deploys one PaymentRouter (it creates its own AgentVault) to QIE mainnet or testnet.
//
// THE FOUNDER RUNS THIS. It has not been run by anyone, and nothing in this repository runs it automatically.
//
//   SLUICE_NETWORK=mainnet SLUICE_APPROVE=deploy SLUICE_KEY=... SLUICE_OWNER=... \
//   SLUICE_FEE_RECIPIENT=... SLUICE_FEE_BPS=100 pnpm exec ts-node scripts/live/deploy.ts
//
// It refuses to start without SLUICE_APPROVE=deploy and refuses to exceed its spending caps
// (SLUICE_MAX_QUSDC, default 10, and SLUICE_MAX_QIE, default 5). See src/guard.ts.
//
// Add --dry-run to see what it would send, to whom, with what data and at what cost, without sending anything. A dry run asks the node to
// estimate the gas (which runs the transaction on the node and discards the result) and broadcasts nothing.
import { writeFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, keccak256 } from "ethers";
import { dryRunDeploy, formatDryRun } from "../../src/dryrun";
import { formatQie, redact, requireApproval, SpendMeter } from "../../src/guard";
import { deployPlan, deployRecorderCommands, deployRouter, readDeployParams } from "../../src/live";
import type { Env } from "../../src/live";

export async function main(env: Env = process.env, log: (line: string) => void = console.log, argv: string[] = process.argv.slice(2)): Promise<void> {
  // The gate comes first. Nothing below runs, and no connection is opened, unless it passes.
  const approval = requireApproval("deploy", env, deployPlan());
  const params = readDeployParams(env, approval.network);
  const dryRun = argv.includes("--dry-run");

  const provider = new JsonRpcProvider(approval.rpcUrl, approval.chainId);
  const reported = BigInt(String(await provider.send("eth_chainId", [])));
  if (reported !== BigInt(approval.chainId)) {
    throw new Error(`the RPC is on chain ${reported}, but ${approval.network} is chain ${approval.chainId}`);
  }
  const signer = new Wallet(approval.privateKey(), provider);
  log(`network ${approval.network} (chain ${approval.chainId})`);
  log(`deployer ${signer.address} (holds ${formatQie(await provider.getBalance(signer.address))} QIE)`);
  log(`token ${params.token}, owner ${params.owner}, fee recipient ${params.feeRecipient}, fee ${params.feeBps} bps`);
  log(`caps: ${formatQie(approval.caps.maxQieWei)} QIE of gas`);

  if (dryRun) {
    for (const line of formatDryRun(await dryRunDeploy(provider, signer.address, params), approval.caps.maxQieWei)) log(line);
    return;
  }

  const meter = new SpendMeter(approval.caps);
  const deployed = await deployRouter({ signer, provider, meter, network: approval.network, log }, params);
  // The hash of the code on the chain, recorded now, so that the pre-flight check can tell later that SLUICE_ROUTER still names this code.
  const [routerCodeHash, vaultCodeHash] = await Promise.all([
    provider.getCode(deployed.router).then((c) => keccak256(c)),
    provider.getCode(deployed.vault).then((c) => keccak256(c)),
  ]);
  writeFileSync(
    "deployment.json",
    JSON.stringify({ network: approval.network, chainId: approval.chainId, ...deployed, ...params, routerCodeHash, vaultCodeHash }, null, 2),
  );
  log("wrote deployment.json (addresses and code hashes only, no secrets; it is git-ignored)");
  log(`next: set SLUICE_ROUTER=${deployed.router} and run pnpm live:preflight, then scripts/live/smoke.ts`);
  log("record the deployment (the recorder reads it back from the chain; nothing is pasted into docs/EVIDENCE.md by hand):");
  for (const line of deployRecorderCommands(deployed.hash, approval.network)) log(line);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : "deploy failed", process.env));
    process.exitCode = 1;
  });
}
