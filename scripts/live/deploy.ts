// Deploys one PaymentRouter (it creates its own AgentVault) to QIE mainnet or testnet.
//
// THE FOUNDER RUNS THIS. Nothing in this repository runs it automatically.
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
import { Wallet, getAddress, keccak256 } from "ethers";
import { requireNodeChain } from "@sluice/sdk";
import { dryRunDeploy, formatDryRun } from "../../src/dryrun";
import { GuardError, formatQie, redact, requireApproval, SpendMeter } from "../../src/guard";
import { DEFAULT_FEE_BPS, checkDeployRoles, checkDeployToken, deployPlan, deployRecorderCommands, deployRouter, readDeployParams } from "../../src/live";
import { chooseRpc, providerFor } from "../../src/rpc-use";
import type { Env } from "../../src/live";

/** `--dry-run` and `--relayer <address>`. Anything else is refused: a mistyped `--dry-run` must never become a real deployment. */
export function parseDeployArgs(argv: string[]): { dryRun: boolean; relayer?: string } {
  const out: { dryRun: boolean; relayer?: string } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--dry-run") {
      out.dryRun = true;
    } else if (flag === "--relayer") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new GuardError("--relayer needs the relayer's address");
      out.relayer = value;
    } else {
      throw new GuardError(`refusing to run deploy: unknown option ${flag.slice(0, 40)} (the options are --dry-run and --relayer <address>)`);
    }
  }
  return out;
}

export async function main(env: Env = process.env, log: (line: string) => void = console.log, argv: string[] = process.argv.slice(2)): Promise<void> {
  // The gate comes first. Nothing below runs, and no connection is opened, unless it passes.
  const approval = requireApproval("deploy", env, deployPlan());
  const params = readDeployParams(env, approval.network);
  const args = parseDeployArgs(argv);
  const dryRun = args.dryRun;
  const relayerText = args.relayer ?? env.SLUICE_RELAYER?.trim();
  let relayer: string | undefined;
  try {
    relayer = relayerText ? getAddress(relayerText) : undefined;
  } catch {
    throw new GuardError("the relayer's address (SLUICE_RELAYER or --relayer) is not a valid address");
  }
  // The roles are checked from the key's own address, before any connection is made: the deployer, the relayer, the owner and the fee
  // recipient must be kept apart, and on mainnet the relayer's address must be given for that check to be possible.
  const deployerAddress = new Wallet(approval.privateKey()).address;
  checkDeployRoles(params, { deployer: deployerAddress, ...(relayer ? { relayer } : {}) }, approval.network);

  // The first of QIE's public endpoints that answers with this chain's id (or the one SLUICE_RPC_URL names), with the rest as fallbacks.
  const provider = providerFor(await chooseRpc(approval.network, env.SLUICE_RPC_URL, log), approval.chainId);
  await requireNodeChain(provider, approval.chainId, approval.network);
  const signer = new Wallet(approval.privateKey(), provider);
  // What is on chain at the token's address must be a contract with six decimals; on mainnet the address is QUSDC's, checked above.
  await checkDeployToken(provider, params.token);
  log(`network ${approval.network} (chain ${approval.chainId})`);
  log(`deployer ${signer.address} (holds ${formatQie(await provider.getBalance(signer.address))} QIE)`);
  log(`relayer ${relayer ?? "(not given)"}; owner and fee recipient are not the deployer${relayer ? " or the relayer" : ""}`);
  log(`token ${params.token} (has code and 6 decimals), owner ${params.owner}, fee recipient ${params.feeRecipient}, fee ${params.feeBps} bps${env.SLUICE_FEE_BPS?.trim() ? "" : ` (the default of ${DEFAULT_FEE_BPS}; SLUICE_FEE_BPS was not set)`}`);
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
