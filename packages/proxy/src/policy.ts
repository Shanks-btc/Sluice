// The owner's budget, applied to every payment the proxy is asked to make. The proxy signs only if ALL of these hold:
//
//   - the requirements are for the scheme, network, asset, router and tool this proxy is configured for;
//   - the tool the agent called is on the owner's allowed list, and the payee is the one the owner named for it;
//   - the price is at most the per-call cap;
//   - what has been committed so far plus this price is at most the total cap;
//   - the budget has not expired.
//
// The spent total is committed (and written to disk) BEFORE the signed payment leaves the proxy, so a crash or a failed
// retry can only make the proxy think it spent more than it did, never less. The chain enforces the same limits in the
// AgentVault; this is the early, local refusal.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAddress } from "ethers";
import { DOMAIN_NAME, DOMAIN_VERSION, SCHEME, formatQusdc, toolIdOf } from "@sluice/sdk";
import type { PaymentRequirements } from "@sluice/sdk";
import type { ProxyConfig } from "./config";

export type RefusalCode =
  | "unsupported_requirements"
  | "unknown_tool"
  | "payee_not_allowed"
  | "tool_id_mismatch"
  | "invalid_amount"
  | "over_per_call_cap"
  | "over_total_cap"
  | "budget_expired";

export type Decision = { ok: true; amount: bigint } | { ok: false; code: RefusalCode; detail: string };

const no = (code: RefusalCode, detail: string): Decision => ({ ok: false, code, detail });

export class BudgetPolicy {
  private spent = 0n;
  private count = 0;

  constructor(
    private readonly config: ProxyConfig,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    if (existsSync(config.stateFile)) {
      try {
        const s = JSON.parse(readFileSync(config.stateFile, "utf8")) as { spent?: string; count?: number };
        this.spent = BigInt(s.spent ?? "0");
        this.count = Number(s.count ?? 0);
      } catch {
        // An unreadable state file must not reset the budget to zero. Treat the whole cap as spent.
        this.spent = config.budget.totalCap;
      }
    }
  }

  get spentUnits(): bigint {
    return this.spent;
  }
  get remainingUnits(): bigint {
    return this.config.budget.totalCap > this.spent ? this.config.budget.totalCap - this.spent : 0n;
  }
  get payments(): number {
    return this.count;
  }

  /** Whether a payment for `tool` on these requirements is allowed. Changes nothing. */
  evaluate(tool: string, r: PaymentRequirements): Decision {
    const c = this.config;
    if (r.scheme !== SCHEME) return no("unsupported_requirements", `the scheme is ${r.scheme}, not ${SCHEME}`);
    if (r.network !== `eip155:${c.chainId}`) return no("unsupported_requirements", `the network is ${r.network}`);
    if (!sameAddress(r.asset, c.asset)) return no("unsupported_requirements", "the asset is not the configured one");
    if (!sameAddress(r.extra?.router, c.router)) return no("unsupported_requirements", "the router is not the configured one");
    if (r.extra?.name !== DOMAIN_NAME || r.extra?.version !== DOMAIN_VERSION) return no("unsupported_requirements", "the signing domain is not SluiceRouter v1");

    const allowed = c.budget.allowedTools.filter((t) => t.tool === tool);
    if (allowed.length === 0) return no("unknown_tool", `${tool} is not on the owner's list of tools the agent may pay for`);
    if (!allowed.some((t) => sameAddress(t.payee, r.payTo))) return no("payee_not_allowed", `the owner did not name ${r.payTo} as a payee for ${tool}`);
    if (String(r.extra.toolId).toLowerCase() !== toolIdOf(tool)) return no("tool_id_mismatch", "the offered tool id is not the id of the tool that was called");

    let amount: bigint;
    try {
      amount = BigInt(r.amount);
    } catch {
      return no("invalid_amount", "the price is not a whole number");
    }
    if (amount <= 0n) return no("invalid_amount", "the price must be above zero");
    if (amount > c.budget.perCallCap) {
      return no("over_per_call_cap", `${formatQusdc(amount)} QUSDC is above the per-call cap of ${formatQusdc(c.budget.perCallCap)} QUSDC`);
    }
    if (this.now() >= c.budget.expiresAt) return no("budget_expired", "the owner's budget has expired");
    if (this.spent + amount > c.budget.totalCap) {
      return no("over_total_cap", `${formatQusdc(amount)} QUSDC would pass the total cap of ${formatQusdc(c.budget.totalCap)} QUSDC (${formatQusdc(this.spent)} already committed)`);
    }
    return { ok: true, amount };
  }

  /** Records a payment as committed and writes it to disk. Call before the signed payment is sent. */
  commit(amount: bigint): void {
    this.spent += amount;
    this.count += 1;
    const tmp = `${this.config.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ spent: this.spent.toString(), count: this.count }));
    renameSync(tmp, this.config.stateFile);
  }
}

function sameAddress(a: unknown, b: unknown): boolean {
  try {
    return typeof a === "string" && typeof b === "string" && getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}
