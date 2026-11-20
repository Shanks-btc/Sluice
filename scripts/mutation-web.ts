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

const W = "apps/web/src";
const m = (id: string, file: string, find: string, replace: string, why: string, tests: string[]): Mutation => ({ id, file: `${W}/${file}`, find, replace, why, tests });

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
