// pnpm mutation:check
//
// Changes one condition at a time in the code that decides what is accepted, what is charged and what a budget allows, runs
// the tests meant to catch each change, and reports which changes the tests noticed. It edits files in place and puts each
// one back (see src/mutation.ts), so run it on a copy of the work you care about. It sends nothing anywhere: the tests it runs
// are the local ones in test/unit.
//
// Exit code 0: every change was caught. 1: a change survived or could not be applied. 2: the tests failed before any change.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { MutationError, runMutations, summarizeResults } from "../src/mutation";
import type { Mutation, Runner } from "../src/mutation";

const V = "test/unit/spec/vectors.test.ts";
const FS = "test/unit/facilitator/service.test.ts";
const FH = "test/unit/facilitator/http-onboard.test.ts";
const PT = "test/unit/sdk/paid-tool.test.ts";
const PX = "test/unit/proxy/proxy.test.ts";
const WL = "test/unit/wallet-mcp/wallet.test.ts";
const SM = "test/unit/summary.test.ts";

const PROTOCOL = "packages/sdk/src/protocol.ts";
const SERVICE = "packages/facilitator/src/service.ts";
const RELAYER = "packages/facilitator/src/relayer.ts";
const POLICY = "packages/proxy/src/policy.ts";
const PROXY = "packages/proxy/src/proxy.ts";
const PAID = "packages/sdk/src/paid-tool.ts";
const WALLET = "packages/wallet-mcp/src/server.ts";
const SUMMARY = "src/summary.ts";

const m = (id: string, file: string, find: string, replace: string, why: string, tests: string[]): Mutation => ({ id, file, find, replace, why, tests });

export const MUTATIONS: Mutation[] = [
  // The scheme's verification (the SDK's pure checks, which the facilitator repeats)
  m("P01", PROTOCOL, "if (intent.amount < BigInt(requirements.amount)) {", "if (intent.amount <= BigInt(requirements.amount)) {", "refuse a payment equal to the price", [V]),
  m("P02", PROTOCOL, "if (intent.amount < BigInt(requirements.amount)) {", "if (intent.amount > BigInt(requirements.amount)) {", "refuse a payment above the price instead of below it", [V]),
  m("P03", PROTOCOL, "if (!sameAddress(intent.payee, requirements.payTo)) return fail(", "if (false) return fail(", "accept any payee", [V]),
  m("P04", PROTOCOL, "if (intent.toolId !== String(requirements.extra.toolId).toLowerCase()) {", "if (false) {", "accept a payment bound to another tool", [V]),
  m("P05", PROTOCOL, "if (deadline < now + BigInt(MIN_REMAINING_SECONDS)) return fail(", "if (deadline < now) return fail(", "accept an intent about to expire", [V]),
  m("P06", PROTOCOL, "if (deadline > latest) return fail(", "if (deadline > latest + 1_000_000n) return fail(", "accept a deadline far in the future", [V]),
  m("P07", PROTOCOL, "if (requirements.network !== network || payload.accepted.network !== network) {", "if (requirements.network !== network) {", "stop checking the network the client claims", [V]),
  m("P08", PROTOCOL, "    a.amount === b.amount &&\n", "", "stop comparing the price in the client's copy of the terms", [V]),
  m("P09", PROTOCOL, "if (!sameAddress(requirements.extra.router, ctx.router) || !sameAddress(payload.accepted.extra.router, ctx.router)) {", "if (!sameAddress(requirements.extra.router, ctx.router)) {", "stop checking the router the client claims", [V]),
  m("P10", PROTOCOL, "  if (v !== 27 && v !== 28) return undefined;", "  if (v !== 27 && v !== 28 && v !== 0 && v !== 1) return undefined;", "accept a signature whose v is 0 or 1", [V]),

  // The facilitator
  m("F01", SERVICE, "    if (used) return ERRORS.nonceUsed;", "    if (false) return ERRORS.nonceUsed;", "ignore a nonce already used on the chain", [FS]),
  m("F02", SERVICE, "    if (balance < pending.forPayer + intent.amount) return ERRORS.insufficientFunds;", "    if (balance < intent.amount) return ERRORS.insufficientFunds;", "ignore what is already queued against a payer's balance", [FS]),
  m("F03", SERVICE, "      if (s.id === 0n) return ERRORS.sessionNotFound;", "      if (false) return ERRORS.sessionNotFound;", "accept a signer with no session", [FS]),
  m("F04", SERVICE, "      if (intent.amount > s.perCallCap) return ERRORS.perCallCap;", "      if (false) return ERRORS.perCallCap;", "ignore an agent's per-call cap", [FS]),
  m("F05", SERVICE, "s.spent + pending.forAgent + intent.amount > s.budget", "s.spent + intent.amount > s.budget", "ignore an agent's queued spend against its budget", [FS]),
  m("F06", SERVICE, "      if (!allowed) return ERRORS.toolNotAllowed;", "      if (false) return ERRORS.toolNotAllowed;", "accept a tool the owner did not allow", [FS]),
  m("F07", SERVICE, "      if (await this.ledger.get(check.digest)) return invalid(ERRORS.intentReplayed);\n", "", "verify an intent that is already queued", [FS]),
  m("F08", SERVICE, "      if (existing) return this.view(existing); // idempotent: the same intent is one record, however often it is sent\n", "", "queue the same intent again", [FS]),
  m("F09", SERVICE, "maxCount: this.caps.payerDailyIntents,", "maxCount: this.caps.payerDailyIntents + 1000,", "raise the per-payer daily count limit", [FS]),
  m("F10", SERVICE, "maxCount: this.caps.globalDailyIntents,", "maxCount: this.caps.globalDailyIntents + 1000,", "raise the global daily count limit", [FS]),
  m("F11", SERVICE, "maxAmount: this.caps.payerDailyAmount }", "maxAmount: this.caps.payerDailyAmount * 100n }", "raise the per-payer daily amount limit", [FS]),
  m("F12", SERVICE, "if (getAddress(String(a.args[0])) !== this.routerAddress) return refuse(", "if (false) return refuse(", "accept an approval for a spender that is not the router", [FH]),
  m("F13", SERVICE, "amount > this.caps.maxOnboardAmount) return refuse(", "amount > this.caps.maxOnboardAmount * 100n) return refuse(", "raise the cap on a zero-QIE start", [FH]),
  m("F14", SERVICE, "amount, 0n, text(\"nonce\")", "amount, 10n, text(\"nonce\")", "take a relayer fee in QUSDC on a relayed exit", [FH]),

  // The relayer's hard limits
  m("R01", RELAYER, "    if (!this.#allow.has(to)) throw new CapError(\"destination_not_allowed\"", "    if (false) throw new CapError(\"destination_not_allowed\"", "call any contract, not just the router and the vault", [FS]),
  m("R02", RELAYER, "call.gasLimit <= 0n || call.gasLimit > this.#caps.gasLimitPerTx", "call.gasLimit <= 0n || call.gasLimit > this.#caps.gasLimitPerTx * 2n", "double the gas limit cap", [FS]),
  m("R03", RELAYER, "reserveBudget(day, worst, this.#caps.dailyBudgetWei);", "reserveBudget(day, worst, this.#caps.dailyBudgetWei * 100n);", "raise the daily QIE budget a hundredfold", [FS]),
  m("R04", RELAYER, "if (used * 2n >= budget) await this.raise(\"budget_50\"", "if (used >= budget) await this.raise(\"budget_50\"", "raise the half-budget alert only when the budget is gone", [FS]),
  m("R05", RELAYER, "valueWei <= 0n || valueWei > this.#caps.maxTopUpWei", "valueWei <= 0n || valueWei > this.#caps.maxTopUpWei * 100n", "raise the top-up cap", [FS]),
  m("R06", RELAYER, "if (this.#allow.has(dest) || dest === this.address) throw", "if (false) throw", "allow a top-up to a contract on the allowlist or to itself", [FS]),
  m("R07", RELAYER, "if (price > this.#caps.maxGasPriceWei) {", "if (price > this.#caps.maxGasPriceWei * 100n) {", "pay any gas price", [FS]),

  // The proxy's budget
  m("X01", POLICY, "    if (amount > c.budget.perCallCap) {", "    if (amount > c.budget.perCallCap * 100n) {", "raise the per-call cap", [PX]),
  m("X02", POLICY, "    if (this.spent + amount > c.budget.totalCap) {", "    if (this.spent + amount > c.budget.totalCap * 100n) {", "raise the total cap", [PX]),
  m("X03", POLICY, "    if (this.now() >= c.budget.expiresAt) return no(", "    if (false) return no(", "ignore the expiry", [PX]),
  m("X04", POLICY, "    if (allowed.length === 0) return no(", "    if (false) return no(", "pay for a tool that is not on the list", [PX]),
  m("X05", POLICY, "    if (!allowed.some((t) => sameAddress(t.payee, r.payTo))) return no(", "    if (false) return no(", "pay a payee the owner did not name", [PX]),
  m("X06", POLICY, "    if (String(r.extra.toolId).toLowerCase() !== toolIdOf(tool)) return no(", "    if (false) return no(", "pay for a tool id that is not the tool called", [PX]),
  m("X07", POLICY, "    if (!sameAddress(r.extra?.router, c.router)) return no(", "    if (false) return no(", "sign for any router the server names", [PX]),
  m("X08", POLICY, "        this.spent = config.budget.totalCap;", "        this.spent = 0n;", "reset the budget when the state file is unreadable", [PX]),
  m("X09", PROXY, "      this.policy.commit(decision.amount); // committed before the signature exists, and written to disk\n", "", "forget to count a payment against the budget", [PX]),
  m("X10", PROXY, "    if (getAddress(o.signer.address) === getAddress(o.config.payer)) {", "    if (false) {", "start with the owner's own key", [PX]),

  // paidTool: idempotency and charging
  m("S01", PAID, 'if (prior && prior.state !== "held" && prior.argsHash !== argsHash) {', "if (false) {", "let a used intent pay for a different call", [PT]),
  m("S02", PAID, "        if (running.argsHash !== argsHash) {", "        if (false) {", "let an intent in flight pay for a different call", [PT]),
  m("S03", PAID, 'if (result.isError) {\n          emit({ type: "tool_failed", tool, id });\n          return result; // a failed call is not charged', 'if (false) {\n          emit({ type: "tool_failed", tool, id });\n          return result; // a failed call is not charged', "charge for a tool that returns an error", [PT]),
  m("S04", PAID, "          if (!verdict.isValid) return required(", "          if (false) return required(", "run the tool whatever the facilitator says", [PT]),
  m("S05", PAID, "      if (!settlement.success) {", "      if (false) {", "treat a declined settlement as paid", [PT]),

  // The wallet MCP and the summary
  m("W01", WALLET, "  if (a === getAddress(config.payer)) throw new WalletStartError(", "  if (false) throw new WalletStartError(", "load the owner's own key", [WL]),
  m("W02", WALLET, "  if (a === owner) throw new WalletStartError(", "  if (false) throw new WalletStartError(", "load the router owner's key", [WL]),
  m("W03", WALLET, "  if (a === feeRecipient) throw new WalletStartError(", "  if (false) throw new WalletStartError(", "load the fee recipient's key", [WL]),
  m("M01", SUMMARY, "    if (byPayer || byPayee || bySigner) {", "    if (byPayer || bySigner) {", "count a payment made to a founder wallet", [SM]),
  m("M02", SUMMARY, "    if (byPayer || byPayee || bySigner) {", "    if (byPayer || byPayee) {", "count a payment a founder key signed for someone else", [SM]),
  m("M03", SUMMARY, "    const byPayer = founders.has(e.payer.toLowerCase());", "    const byPayer = founders.has(e.payer);", "match founder wallets by exact letter case", [SM]),
];

/** Runs the named Hardhat test files in a child process, without compiling. */
export function hardhatRunner(root: string): Runner {
  return (files) => {
    const run = spawnSync(process.execPath, [require.resolve("hardhat/internal/cli/bootstrap.js"), "test", ...files, "--no-compile"], {
      cwd: root,
      encoding: "utf8",
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const failing = /(\d+) failing/.exec(output);
    return { passed: run.status === 0, failing: failing ? Number(failing[1]) : run.status === 0 ? 0 : 1, output };
  };
}

function main(): number {
  const root = join(__dirname, "..");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const chosen = only.length ? MUTATIONS.filter((x) => only.includes(x.id)) : MUTATIONS;
  console.log(`${chosen.length} mutation${chosen.length === 1 ? "" : "s"}. Each runs the tests meant to catch it; this takes a while.`);
  let results;
  try {
    results = runMutations(root, chosen, hardhatRunner(root), console.log);
  } catch (err) {
    console.error(err instanceof MutationError ? err.message : "the mutation run failed");
    return 2;
  }
  const s = summarizeResults(results);
  console.log("");
  for (const r of results) {
    const mu = MUTATIONS.find((x) => x.id === r.id)!;
    console.log(`${r.status.padEnd(8)} ${r.id}  ${mu.why}`);
  }
  console.log(`\n${s.killed} killed, ${s.survived} survived, ${s.broken} broken, of ${results.length}`);
  return s.survived + s.broken > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main());
