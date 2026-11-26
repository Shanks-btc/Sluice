// One small round trip against a deployed router on QIE mainnet or testnet: approve, deposit, a payer-signed
// settle, an agent session with its own signed settle, revoke, withdraw and refund.
//
// THE FOUNDER RUNS THIS. Nothing in this repository runs it automatically.
//
//   SLUICE_NETWORK=mainnet SLUICE_APPROVE=smoke SLUICE_KEY=... SLUICE_ROUTER=0x... \
//   pnpm exec ts-node scripts/live/smoke.ts
//
// Add --dry-run to see each transaction it would send (where, what data, what cost) without sending any. It refuses to start without SLUICE_APPROVE=smoke and refuses to exceed its spending caps
// (SLUICE_MAX_QUSDC, default 10, and SLUICE_MAX_QIE, default 5). The amounts it moves are small and fixed in
// src/live.ts (0.3 QUSDC in, nearly all of it back out). Afterwards it prints the `pnpm evidence:record`
// commands that record each transaction; the recorder verifies it against the chain before it writes a row.
import { writeFileSync } from "node:fs";
import { Wallet } from "ethers";
import { requireNodeChain } from "@sluice/sdk";
import { chooseRpc, providerFor } from "../../src/rpc-use";
import { GuardError, formatQie, redact, requireApproval, SpendMeter } from "../../src/guard";
import { dryRunSmoke, formatDryRun } from "../../src/dryrun";
import { DEFAULT_SMOKE_AMOUNTS, readSmokeParams, recorderCommands, runSmoke, smokePlan } from "../../src/live";
import type { Env } from "../../src/live";
import { formatQusdc } from "../../src/units";

export async function main(env: Env = process.env, log: (line: string) => void = console.log, argv: string[] = process.argv.slice(2)): Promise<void> {
  // The gate comes first. Nothing below runs, and no connection is opened, unless it passes.
  const approval = requireApproval("smoke", env, smokePlan());
  const params = readSmokeParams(env);
  // The only option is --dry-run, and anything else is refused: a mistyped --dry-run must never become a real run.
  for (const flag of argv) if (flag !== "--dry-run") throw new GuardError(`refusing to run smoke: unknown option ${flag.slice(0, 40)} (the option is --dry-run)`);

  const provider = providerFor(await chooseRpc(approval.network, env.SLUICE_RPC_URL, log), approval.chainId);
  await requireNodeChain(provider, approval.chainId, approval.network);
  const signer = new Wallet(approval.privateKey(), provider);
  log(`network ${approval.network} (chain ${approval.chainId})`);
  log(`signer ${signer.address} (holds ${formatQie(await provider.getBalance(signer.address))} QIE)`);
  log(`router ${params.router}`);
  log(`caps: ${formatQusdc(approval.caps.maxQusdc)} QUSDC, ${formatQie(approval.caps.maxQieWei)} QIE of gas`);

  if (argv.includes("--dry-run")) {
    // Nothing is sent: each step is built, decoded and costed, and the node is asked only to estimate gas.
    for (const line of formatDryRun(await dryRunSmoke(provider, signer.address, params, DEFAULT_SMOKE_AMOUNTS), approval.caps.maxQieWei)) log(line);
    return;
  }

  const meter = new SpendMeter(approval.caps);
  const { rows, stillOwed } = await runSmoke({ signer, provider, meter, network: approval.network, log }, params);

  log("");
  log("Record what this run did. The recorder reads each transaction back from the chain and writes a row only if the chain agrees;");
  log("nothing is pasted into docs/EVIDENCE.md by hand:");
  for (const line of recorderCommands(rows, params.router, approval.network)) log(line);
  writeFileSync("evidence-draft.json", JSON.stringify(rows, null, 2));
  log("wrote evidence-draft.json (git-ignored)");
  log(`the router still owes ${formatQusdc(stillOwed)} QUSDC, which belongs to the fee recipient (and the payee, if it is another address)`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : "smoke failed", process.env));
    process.exitCode = 1;
  });
}
