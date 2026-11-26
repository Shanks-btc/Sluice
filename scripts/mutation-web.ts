// pnpm mutation:web
//
// The same check as `pnpm mutation:check`, for the web app's own logic: it changes one condition at a time in the status badges, the
// evidence view, amount parsing, the network check, the confirm gate, input validation, the Content Security Policy, the rate limiter, the
// Markdown renderer and the contrast maths, runs the tests meant to catch that change, and reports whether they failed. It edits files in
// place and puts each one back (see src/mutation.ts), so run it on a copy. It sends nothing anywhere.
//
// Exit code 0: every change was caught. 1: a change survived or could not be applied. 2: the tests failed before any change.
import { join } from "node:path";
import { MutationError, runMutations, summarizeResults } from "../src/mutation";
import type { Mutation } from "../src/mutation";
import { hardhatRunner } from "./mutation-check";

const LIB = "test/unit/web/lib.test.ts";
const FLOWS = "test/unit/web/flows.test.ts";
const COMP = "test/unit/web/components.test.ts";
const CONTENT = "test/unit/web/content.test.ts";
const DESIGN = "test/unit/web/design.test.ts";
const ROUTES = "test/unit/web/routes.test.ts";

// The live-first slice's tests: the web logic with a mocked wallet and services (fast), the shared operations helpers, and the two services'
// own request handling against a local chain.
const LIVE = "test/unit/web/live-logic.test.ts";
const OPS = "test/unit/ops.test.ts";
const TOOLS_OPS = "test/unit/examples/tools-ops.test.ts";
const FAC_OPS = "test/unit/facilitator/service-ops.test.ts";

const W = "apps/web/src";
const m = (id: string, file: string, find: string, replace: string, why: string, tests: string[]): Mutation => ({ id, file: `${W}/${file}`, find, replace, why, tests });
/** The same, for a file outside the web app, named from the repository root. */
const r = (id: string, file: string, find: string, replace: string, why: string, tests: string[]): Mutation => ({ id, file, find, replace, why, tests });

export const WEB_MUTATIONS: Mutation[] = [
  // The status badges: Live only with evidence
  m("X01", "status.ts", `if (component.status !== "Live") return { status: component.status };`, `if (true) return { status: component.status };`, "show Live whatever the evidence says", [LIB, COMP]),
  m("X02", "status.ts", `if (component.evidenceEvents.length === 0 || missing.length > 0) {`, `if (missing.length > 1) {`, "show Live with one event still missing", [LIB, COMP]),
  m("X03", "status.ts", `const mainnet = new Set(rows.filter((r) => r.network === "mainnet").map((r) => r.event));`, `const mainnet = new Set(rows.map((r) => r.event));`, "count a testnet row as mainnet evidence", [LIB, COMP]),

  // Amounts
  m("X04", "lib/format.ts", `if (!/^\\d{1,12}(\\.\\d{1,6})?$/.test(t)) {`, `if (!/^\\d{1,12}(\\.\\d{1,7})?$/.test(t)) {`, "accept seven decimal places in a QUSDC amount", [LIB]),
  m("X05", "lib/format.ts", `if (max !== undefined && units > max)`, `if (max !== undefined && units >= max)`, "refuse an amount equal to the balance", [LIB]),

  // The network check and the confirm gate
  m("X06", "lib/eip1193.ts", `return walletChainId === expected ? "ok" : "wrong";`, `return "ok";`, "call every network the right one", [FLOWS, LIB]),
  m("X07", "lib/flows.ts", `if (this.current !== "confirmed") throw new NotConfirmedError();`, `if (false) throw new NotConfirmedError();`, "send without a confirm", [FLOWS]),
  m("X08", "lib/flows.ts", `if (this.current !== "planned") throw new Error(\`cannot confirm a plan that is \${this.current}\`);`, `if (false) throw new Error(\`cannot confirm a plan that is \${this.current}\`);`, "confirm a cancelled or confirmed plan", [FLOWS]),
  m("X09", "lib/flows.ts", `if (this.current === "planned" || this.current === "confirmed") this.current = "cancelled";`, `if (this.current === "planned") this.current = "cancelled";`, "refuse to cancel after a confirm", [FLOWS]),
  m("X10", "lib/flows.ts", `if (wrongNetwork(deps, current)) throw new WalletError("wrong_network"`, `if (false) throw new WalletError("wrong_network"`, "send on the wrong network", [FLOWS]),
  m("X11", "lib/flows.ts", `if (getAddress(signer) !== getAddress(deps.account)) throw new WalletError("failed", "the wallet signed with a different account`, `if (false) throw new WalletError("failed", "the wallet signed with a different account`, "relay a signature from another account", [FLOWS]),
  m("X12", "lib/flows.ts", `if (!same) throw new WalletError("failed", "the wallet signed something different`, `if (false) throw new WalletError("failed", "the wallet signed something different`, "send a transaction the wallet changed", [FLOWS]),
  m("X13", "lib/flows.ts", `? { account, to: input.to, amount: input.amount.toString(), relayerFee: "0", nonce, deadline: String(deadline) }`, `? { account, to: input.to, amount: input.amount.toString(), relayerFee: "1", nonce, deadline: String(deadline) }`, "sign a withdrawal with a relayer fee", [FLOWS]),
  m("X14", "lib/flows.ts", `if (req.perCallCap > req.budget) return "The cap per call cannot be more than the budget.";`, `if (false) return "The cap per call cannot be more than the budget.";`, "accept a cap per call above the budget", [FLOWS]),
  m("X15", "lib/flows.ts", `hashes.push(await sendAndWait(deps, { to: reader.tokenAddress, data: erc20Interface.encodeFunctionData("approve", [reader.routerAddress, input.amount]) }));`, `hashes.push(await sendAndWait(deps, { to: reader.tokenAddress, data: erc20Interface.encodeFunctionData("approve", [reader.routerAddress, input.amount * 2n]) }));`, "approve twice the amount", [FLOWS]),
  m("X16", "lib/reads.ts", `if (getAddress(routerVault) !== vaultAddress) throw new ConfigMismatch(`, `if (false) throw new ConfigMismatch(`, "trust a vault address that is not the router's", [FLOWS]),

  // Input validation and the security headers
  m("X17", "lib/config.ts", `if (url.protocol === "https:") return url;`, `if (url.protocol === "https:" || url.protocol === "http:") return url;`, "accept an http address anywhere", [LIB]),
  m("X18", "lib/csp.ts", `if (allowsAnyFacilitator(path)) connect.push(`, `if (true) connect.push(`, "let every page reach any https address", [LIB]),
  m("X19", "lib/csp.ts", `["script-src", ["'self'", \`'nonce-\${nonce}'\`, ...(dev ? ["'unsafe-eval'"] : [])]],`, `["script-src", ["'self'", \`'nonce-\${nonce}'\`, ...["'unsafe-eval'"]]],`, "allow eval in production", [LIB]),
  m("X20", "lib/risk-handler.ts", `if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return`, `if (typeof address !== "string") return`, "accept anything as a token address", [ROUTES]),
  m("X21", "lib/risk-handler.ts", `if (text.length > MAX_BODY_CHARS) return { ok: false, status: 413, error: "request_too_large" };`, `if (false) return { ok: false, status: 413, error: "request_too_large" };`, "read a body of any size", [ROUTES]),
  m("X22", "lib/rate-limit.ts", `if (entry.count >= this.options.limit) {`, `if (entry.count > this.options.limit) {`, "allow one request more than the limit", [LIB, ROUTES]),

  // The Markdown renderer and the contrast maths
  m("X23", "lib/markdown.ts", `if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return undefined;`, `if (false) return undefined;`, "keep a javascript: link", [CONTENT]),
  m("X24", "lib/markdown.ts", `.replace(/</g, "&lt;")`, ``, "leave < unescaped in a document", [CONTENT]),
  m("X25", "lib/contrast.ts", `return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);`, `return (Math.max(la, lb) + 0.05) / (Math.max(la, lb) + 0.05);`, "call every pair of colours the same", [DESIGN]),

  // The live paid call: nothing is signed before a confirm, and a price is checked field by field before it is shown
  m("Y01", "lib/paid-call.ts", `if (this.current !== "confirmed") throw new NotConfirmedError();`, `if (false) throw new NotConfirmedError();`, "sign a payment that was never confirmed", [LIVE]),
  m("Y02", "lib/paid-call.ts", `if (this.current !== "planned") throw new Error(\`cannot confirm a payment that is \${this.current}\`);`, `if (false) throw new Error(\`cannot confirm a payment that is \${this.current}\`);`, "confirm a payment that was cancelled or already sent", [LIVE]),
  m("Y03", "lib/paid-call.ts", `if (this.current === "planned" || this.current === "confirmed") this.current = "cancelled";`, `if (this.current === "planned") this.current = "cancelled";`, "refuse to cancel a payment that was confirmed but not yet signed", [LIVE]),
  m("Y04", "lib/paid-call.ts", `if (networkState(current, deps.chainId) === "wrong") throw new WalletError("wrong_network", "wrong network");`, `if (false) throw new WalletError("wrong_network", "wrong network");`, "sign a payment while the wallet is on another network", [LIVE]),
  m("Y05", "lib/paid-call.ts", `if (BigInt(deps.now()) >= intent.deadline) throw new SluiceCallError("sluice_intent_expired"`, `if (false) throw new SluiceCallError("sluice_intent_expired"`, "sign a quote that has run out of time", [LIVE]),
  m("Y06", "lib/paid-call.ts", `if (prepaid < quote.amount) {`, `if (false) {`, "plan a payment the prepaid balance cannot cover", [LIVE]),
  m("Y07", "lib/paid-call.ts", `if (result.isError === true) {`, `if (false) {`, "show a refused payment as a paid one", [LIVE]),
  m("Y08", "lib/paid-call.ts", `if (r.network !== \`eip155:\${deps.chainId}\`) return`, `if (false) return`, "accept a price for another network", [LIVE]),
  m("Y09", "lib/paid-call.ts", `if (BigInt(r.amount) > BigInt(deps.sessionCapUnits)) return`, `if (false) return`, "accept a price above the page's cap", [LIVE]),
  m("Y10", "lib/paid-call.ts", `getAddress(r.asset) !== getAddress(deps.reader.tokenAddress)`, `false`, "accept a price in another token", [LIVE]),
  m("Y11", "lib/paid-call.ts", `getAddress(r.extra.router) !== getAddress(deps.reader.routerAddress)`, `false`, "accept a price that names another router", [LIVE]),
  m("Y12", "lib/paid-call.ts", `if (r.extra.toolId !== toolIdOf(tool)) return`, `if (false) return`, "accept a price for a different tool", [LIVE]),
  m("Y13", "lib/paid-call.ts", `getAddress(r.payTo) !== getAddress(server.payee)`, `false`, "accept a payee the tool server did not declare", [LIVE]),
  m("Y14", "lib/paid-call.ts", `r.maxTimeoutSeconds < 20`, `r.maxTimeoutSeconds < 0`, "accept a price that leaves no time to pay", [LIVE]),
  m("Y15", "lib/paid-call.ts", `if (info.router !== getAddress(expected.router)) return`, `if (false) return`, "trust a tool server that settles through another router", [LIVE]),
  m("Y16", "lib/paid-call.ts", `if (info.chainId !== expected.chainId) return`, `if (false) return`, "trust a tool server on another chain", [LIVE]),
  m("Y17", "lib/paid-call.ts", `BigInt(r.amount) <= 0n)`, `BigInt(r.amount) < 0n)`, "accept a price of nothing", [LIVE]),

  // The deposit cap and what is kept across a reload
  m("Y18", "lib/live.ts", `if (amount > cap) return`, `if (false) return`, "let one deposit pass the page's cap", [LIVE]),
  m("Y19", "lib/live.ts", `if (prepaid + amount > cap) {`, `if (false) {`, "let the prepaid balance pass the cap by deposits in turn", [LIVE]),
  m("Y20", "lib/resume.ts", `if (nowSeconds - rec.createdAt > INFLIGHT_MAX_AGE_SECONDS) continue;`, `if (false) continue;`, "pick up a payment from days ago as if it were in flight", [LIVE]),
  m("Y21", "lib/resume.ts", `if (payer && rec.payer.toLowerCase() !== payer.toLowerCase()) continue;`, `if (false) continue;`, "show one wallet's payments to another", [LIVE]),
  m("Y22", "lib/resume.ts", `nowSeconds - r.createdAt <= withinSeconds`, `true`, "warn of a duplicate for any earlier payment of the same tool", [LIVE]),
  m("Y23", "lib/resume.ts", `if (typeof v.id !== "string" || !ID.test(v.id)) return undefined;`, `if (false) return undefined;`, "keep a saved record whose id is not an intent id", [LIVE]),

  // The activity list and its file
  m("Y24", "lib/history.ts", `if (size > 100) {`, `if (false) {`, "give up at once when the node refuses a block range", [LIVE]),
  m("Y25", "lib/history.ts", `windows < maxWindows && rows.size < want`, `windows < maxWindows`, "keep scanning after enough rows were found", [LIVE]),
  m("Y26", "lib/history.ts", `const reachedStart = low <= floor;`, `const reachedStart = low < floor;`, "say the start was not reached when it was", [LIVE]),
  m("Y27", "lib/history.ts", `if (/^[=+\\-@\\t\\r]/.test(v)) v =`, `if (false) v =`, "write a cell that a spreadsheet would run as a formula", [LIVE]),
  m("Y28", "lib/history.ts", `Math.min(Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1)), pages)`, `Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1))`, "let a page number run past the last page", [LIVE]),

  // The status page's verdicts and its route's limit
  m("Y29", "lib/service-status.ts", `if (!f.chainMatches) problems.push("The facilitator is on a different chain than this site.");`, `if (false) problems.push("The facilitator is on a different chain than this site.");`, "say nothing when the facilitator is on another chain", [LIVE]),
  m("Y30", "lib/service-status.ts", `if (f.killSwitch) problems.push(`, `if (false) problems.push(`, "hide that the kill switch is on", [LIVE]),
  m("Y31", "lib/service-status.ts", `if (f.lowBalance) problems.push(`, `if (false) problems.push(`, "hide that the relayer is low on QIE", [LIVE]),
  m("Y32", "lib/service-status.ts", `if (f.oldestInFlightAgeSeconds > 600) problems.push`, `if (f.oldestInFlightAgeSeconds > 6000) problems.push`, "wait ten times as long before saying a batch is stuck", [LIVE]),
  m("Y33", "lib/service-status.ts", `if (s.rpc.healthy === 0) {`, `if (false) {`, "say all is well when no QIE endpoint answers", [LIVE]),
  m("Y34", "lib/service-status.ts", `new RateLimiter({ limit: 30, windowMs: 60_000 })`, `new RateLimiter({ limit: 3000, windowMs: 60_000 })`, "let one caller read the status route a hundred times as often", [LIVE]),

  // The shared operations helpers, and the two services' own doors
  r("Y35", "packages/sdk/src/ops.ts", `return given.length === wanted.length && timingSafeEqual(given, wanted);`, `return given.length === wanted.length;`, "accept any token of the right length on the private metrics path", [OPS]),
  r("Y36", "packages/sdk/src/ops.ts", `if (!token || typeof header !== "string") return false;`, `if (typeof header !== "string") return false;`, "open the private path when no token is set", [OPS]),
  r("Y37", "packages/sdk/src/ops.ts", `{8,64}$/`, `{8,640}$/`, "accept a caller's request id of any length into the logs", [OPS]),
  r("Y38", "packages/sdk/src/ops.ts", `return path.startsWith("/status/") && known.includes("/status") ? "/status" : "other";`, `return path;`, "let a caller grow the counters by inventing paths", [OPS]),
  r("Y39", "examples/paid-tools/src/host.ts", `const allowed = origin !== undefined && env.corsOrigins.includes(origin);`, `const allowed = origin !== undefined;`, "let any website read the tool server's answers", [TOOLS_OPS]),
  r("Y40", "examples/paid-tools/src/host.ts", `if (!bearerMatches(req.headers.authorization, metricsToken)) return reply(res, 401`, `if (false) return reply(res, 401`, "serve the tool server's metrics without the token", [TOOLS_OPS]),
  r("Y41", "packages/facilitator/src/server.ts", `if (!bearerMatches(req.headers.authorization, options.metricsToken)) return send(res, 401`, `if (false) return send(res, 401`, "serve the facilitator's metrics without the token", [FAC_OPS]),
];

function main(): number {
  const root = join(__dirname, "..");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const chosen = only.length ? WEB_MUTATIONS.filter((x) => only.includes(x.id)) : WEB_MUTATIONS;
  console.log(`${chosen.length} mutation${chosen.length === 1 ? "" : "s"} in the web app's logic. Each runs the tests meant to catch it.`);
  let results;
  try {
    results = runMutations(root, chosen, hardhatRunner(root), console.log);
  } catch (err) {
    console.error(err instanceof MutationError ? err.message : "the mutation run failed");
    return 2;
  }
  const s = summarizeResults(results);
  console.log("");
  for (const r of results) console.log(`${r.status.padEnd(8)} ${r.id}  ${WEB_MUTATIONS.find((x) => x.id === r.id)!.why}`);
  console.log(`\n${s.killed} killed, ${s.survived} survived, ${s.broken} broken, of ${results.length}`);
  return s.survived + s.broken > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main());
