// The proxy's configuration: which upstream paid server to put payment in front of, whose prepaid balance pays,
// and the owner's budget for the agent. Read from a JSON file. The agent's session key is NOT in the file: it is read
// from an environment variable, so the file can be committed or shared.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAddress } from "ethers";
import { CHAIN_ID, QUSDC_ADDRESS, parseQusdc } from "@sluice/sdk";

export class ConfigError extends Error {}

export type Upstream =
  | { url: string }
  | { command: string; args: string[]; env?: Record<string, string>; cwd?: string };

export type AllowedTool = { tool: string; payee: string };

export type ProxyConfig = {
  upstream: Upstream;
  router: string;
  /** The owner's address, whose prepaid router balance pays. Never the agent's own address. */
  payer: string;
  chainId: number;
  asset: string;
  budget: {
    /** QUSDC units. */
    perCallCap: bigint;
    totalCap: bigint;
    /** Unix seconds. */
    expiresAt: number;
    allowedTools: AllowedTool[];
  };
  /** The environment variable that holds the session key. Never the key itself. */
  sessionKeyEnv: string;
  logFile: string;
  stateFile: string;
  /** Optional: an RPC for tools (such as the wallet MCP) that read the chain. The proxy itself never needs one. */
  rpcUrl?: string;
};

const obj = (v: unknown, where: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  return v as Record<string, unknown>;
};
const str = (v: unknown, where: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${where} must be a non-empty string`);
  return v.trim();
};
const addr = (v: unknown, where: string): string => {
  try {
    return getAddress(str(v, where));
  } catch {
    throw new ConfigError(`${where} must be an address`);
  }
};
const amount = (v: unknown, where: string): bigint => {
  try {
    return parseQusdc(str(v, where));
  } catch {
    throw new ConfigError(`${where} must be a QUSDC amount above zero with at most six decimals, like "0.05"`);
  }
};

/** Validates a parsed config. `now` is unix seconds; a budget that has already expired is refused at start-up. */
export function parseConfig(raw: unknown, now: number = Math.floor(Date.now() / 1000), baseDir = "."): ProxyConfig {
  const c = obj(raw, "the config");
  const up = obj(c.upstream, "upstream");
  let upstream: Upstream;
  if (typeof up.url === "string") {
    let u: URL;
    try {
      u = new URL(up.url);
    } catch {
      throw new ConfigError("upstream.url must be a URL");
    }
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
      throw new ConfigError("upstream.url must be https (plain http is allowed only for the local machine)");
    }
    upstream = { url: u.toString() };
  } else if (typeof up.command === "string") {
    const args = up.args === undefined ? [] : up.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new ConfigError("upstream.args must be a list of strings");
    const env = up.env === undefined ? undefined : obj(up.env, "upstream.env");
    if (env && Object.values(env).some((v) => typeof v !== "string")) throw new ConfigError("upstream.env values must be strings");
    upstream = {
      command: up.command,
      args: args as string[],
      ...(env ? { env: env as Record<string, string> } : {}),
      ...(typeof up.cwd === "string" ? { cwd: up.cwd } : {}),
    };
  } else {
    throw new ConfigError("upstream needs a url, or a command and args");
  }

  const b = obj(c.budget, "budget");
  const perCallCap = amount(b.perCallCap, "budget.perCallCap");
  const totalCap = amount(b.totalCap, "budget.totalCap");
  if (perCallCap > totalCap) throw new ConfigError("budget.perCallCap cannot be above budget.totalCap");
  const expires = Date.parse(str(b.expiresAt, "budget.expiresAt"));
  if (Number.isNaN(expires)) throw new ConfigError("budget.expiresAt must be a date and time, like 2026-12-31T00:00:00Z");
  const expiresAt = Math.floor(expires / 1000);
  if (expiresAt <= now) throw new ConfigError("budget.expiresAt is in the past: the budget has expired");
  const tools = b.allowedTools;
  if (!Array.isArray(tools) || tools.length === 0) throw new ConfigError("budget.allowedTools must list at least one tool");
  const allowedTools = tools.map((t, i) => {
    const o = obj(t, `budget.allowedTools[${i}]`);
    return { tool: str(o.tool, `budget.allowedTools[${i}].tool`), payee: addr(o.payee, `budget.allowedTools[${i}].payee`) };
  });

  const payer = addr(c.payer, "payer");
  const chainId = c.chainId === undefined ? CHAIN_ID : Number(c.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new ConfigError("chainId must be a whole number");
  const sessionKeyEnv = c.sessionKeyEnv === undefined ? "SLUICE_AGENT_KEY" : str(c.sessionKeyEnv, "sessionKeyEnv");
  if (!/^[A-Z][A-Z0-9_]*$/.test(sessionKeyEnv)) throw new ConfigError("sessionKeyEnv must be an environment variable name, not a key");
  const resolveFile = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  const join = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  return {
    upstream,
    router: addr(c.router, "router"),
    payer,
    chainId,
    asset: c.asset === undefined ? getAddress(QUSDC_ADDRESS) : addr(c.asset, "asset"),
    budget: { perCallCap, totalCap, expiresAt, allowedTools },
    sessionKeyEnv,
    logFile: join(resolveFile(c.logFile, "sluice-payments.jsonl")),
    stateFile: join(resolveFile(c.stateFile, "sluice-budget.json")),
    ...(typeof c.rpcUrl === "string" && c.rpcUrl.trim() ? { rpcUrl: c.rpcUrl.trim() } : {}),
  };
}

export function loadConfig(path: string, now?: number): ProxyConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`cannot read the config file ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`the config file ${path} is not valid JSON`);
  }
  return parseConfig(raw, now, dirname(resolve(path)));
}
