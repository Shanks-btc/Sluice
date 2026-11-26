// The app's settings, read from NEXT_PUBLIC_* variables. Every value is public: it reaches the browser. Nothing secret is read here,
// and a test fails if a secret-looking value appears in a NEXT_PUBLIC_* variable or if client code names a server-only secret.
//
// A bad value never crashes a page. It is left out and listed in `problems`, and a page that needs it shows an honest
// "not configured" state.
import { getAddress } from "ethers";
import { MAINNET, isLocalUrl, networkFor } from "./networks";
import type { NetworkInfo } from "./networks";

export type AppConfig = {
  chainId: number;
  /** Where the pages read the chain from. */
  rpcUrl: string;
  network: NetworkInfo;
  router: string | null;
  vault: string | null;
  /** True only when both contract addresses are valid. */
  contractsConfigured: boolean;
  facilitatorUrl: string | null;
  /** The hosted tool server the live demo and the builder's test call pay. */
  toolsUrl: string | null;
  /** The most QUSDC, in units (six places), one live session may deposit. Default 1 QUSDC, never above 10. A plain number so it crosses to the browser. */
  sessionCapUnits: number;
  /** The project's repository on GitHub, when the deployer sets it. The footer and the documents link to it only then. */
  repoUrl: string | null;
  /** The block the router was deployed at, where a scan for events can stop. */
  fromBlock: number | null;
  /** Where the site is served, for absolute links in previews. */
  siteUrl: string | null;
  problems: string[];
};

/** The default and the ceiling for what one live session may deposit, in QUSDC units: 1 QUSDC and 10 QUSDC. */
export const DEFAULT_SESSION_CAP_UNITS = 1_000_000;
export const MAX_SESSION_CAP_UNITS = 10_000_000;
/** What the live demo suggests depositing: 0.10 QUSDC. */
export const DEFAULT_DEPOSIT_UNITS = 100_000;

/** What the live pages still need before they can run, in words. Empty when they can. */
export function liveMissing(config: Pick<AppConfig, "router" | "vault" | "facilitatorUrl" | "toolsUrl">): string[] {
  const out: string[] = [];
  if (!config.router || !config.vault) out.push("the router and vault addresses (NEXT_PUBLIC_ROUTER_ADDRESS and NEXT_PUBLIC_VAULT_ADDRESS)");
  if (!config.facilitatorUrl) out.push("a facilitator (NEXT_PUBLIC_FACILITATOR_URL)");
  if (!config.toolsUrl) out.push("a hosted tool server (NEXT_PUBLIC_TOOLS_URL)");
  return out;
}

/** The names the app reads. The deployment guide and a test both read this list. */
export const PUBLIC_ENV_NAMES = [
  "NEXT_PUBLIC_ROUTER_ADDRESS",
  "NEXT_PUBLIC_VAULT_ADDRESS",
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_RPC_URL",
  "NEXT_PUBLIC_FACILITATOR_URL",
  "NEXT_PUBLIC_TOOLS_URL",
  "NEXT_PUBLIC_SESSION_CAP_QUSDC",
  "NEXT_PUBLIC_FROM_BLOCK",
  "NEXT_PUBLIC_GITHUB_URL",
  "NEXT_PUBLIC_SITE_URL",
] as const;
export type PublicEnvName = (typeof PUBLIC_ENV_NAMES)[number];

const blank = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

function address(name: string, value: string | undefined, problems: string[]): string | null {
  const v = blank(value);
  if (!v) return null;
  try {
    return getAddress(v);
  } catch {
    problems.push(`${name} is not a valid address`);
    return null;
  }
}

/** https, or http on this machine. Anything else is refused. */
export function parseWebUrl(text: string | undefined): URL | undefined {
  const v = blank(text);
  if (!v) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalUrl(v)) return url;
  return undefined;
}

export function readConfig(env: Partial<Record<PublicEnvName, string | undefined>>): AppConfig {
  const problems: string[] = [];

  let chainId: number = MAINNET.chainId;
  const rawChain = blank(env.NEXT_PUBLIC_CHAIN_ID);
  if (rawChain !== undefined) {
    if (/^[1-9]\d{0,9}$/.test(rawChain) && Number(rawChain) <= 2_147_483_647) chainId = Number(rawChain);
    else problems.push("NEXT_PUBLIC_CHAIN_ID is not a chain id");
  }

  let rpcUrl = networkFor(chainId).rpcUrl;
  const rawRpc = blank(env.NEXT_PUBLIC_RPC_URL);
  if (rawRpc !== undefined) {
    const url = parseWebUrl(rawRpc);
    if (url) rpcUrl = url.toString();
    else problems.push("NEXT_PUBLIC_RPC_URL must be an https address, or an http address on this machine");
  }
  if (!rpcUrl) problems.push("no RPC address is known for this chain id; set NEXT_PUBLIC_RPC_URL");

  const router = address("NEXT_PUBLIC_ROUTER_ADDRESS", env.NEXT_PUBLIC_ROUTER_ADDRESS, problems);
  const vault = address("NEXT_PUBLIC_VAULT_ADDRESS", env.NEXT_PUBLIC_VAULT_ADDRESS, problems);

  let facilitatorUrl: string | null = null;
  const rawFacilitator = blank(env.NEXT_PUBLIC_FACILITATOR_URL);
  if (rawFacilitator !== undefined) {
    const url = parseWebUrl(rawFacilitator);
    if (url) facilitatorUrl = url.toString().replace(/\/+$/, "");
    else problems.push("NEXT_PUBLIC_FACILITATOR_URL must be an https address, or an http address on this machine");
  }

  let toolsUrl: string | null = null;
  const rawTools = blank(env.NEXT_PUBLIC_TOOLS_URL);
  if (rawTools !== undefined) {
    const url = parseWebUrl(rawTools);
    if (url) toolsUrl = url.toString().replace(/\/+$/, "");
    else problems.push("NEXT_PUBLIC_TOOLS_URL must be an https address, or an http address on this machine");
  }

  let sessionCapUnits = DEFAULT_SESSION_CAP_UNITS;
  const rawCap = blank(env.NEXT_PUBLIC_SESSION_CAP_QUSDC);
  if (rawCap !== undefined) {
    const m = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(rawCap);
    const units = m ? Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0") || "0") : 0;
    if (units > 0 && units <= MAX_SESSION_CAP_UNITS) sessionCapUnits = units;
    else problems.push(`NEXT_PUBLIC_SESSION_CAP_QUSDC must be a number above 0 and at most 10, so ${DEFAULT_SESSION_CAP_UNITS / 1_000_000} is used`);
  }

  let repoUrl: string | null = null;
  const rawRepo = blank(env.NEXT_PUBLIC_GITHUB_URL);
  if (rawRepo !== undefined) {
    const url = parseWebUrl(rawRepo);
    if (url && url.protocol === "https:" && url.hostname === "github.com") repoUrl = url.toString().replace(/\/+$/, "");
    else problems.push("NEXT_PUBLIC_GITHUB_URL must be an https://github.com address");
  }

  let fromBlock: number | null = null;
  const rawFrom = blank(env.NEXT_PUBLIC_FROM_BLOCK);
  if (rawFrom !== undefined) {
    if (/^\d{1,12}$/.test(rawFrom)) fromBlock = Number(rawFrom);
    else problems.push("NEXT_PUBLIC_FROM_BLOCK is not a block number");
  }

  let siteUrl: string | null = null;
  const rawSite = blank(env.NEXT_PUBLIC_SITE_URL);
  if (rawSite !== undefined) {
    const url = parseWebUrl(rawSite);
    if (url) siteUrl = url.origin;
    else problems.push("NEXT_PUBLIC_SITE_URL must be an https address, or an http address on this machine");
  }

  return {
    chainId,
    rpcUrl,
    network: networkFor(chainId, rpcUrl),
    router,
    vault,
    contractsConfigured: router !== null && vault !== null,
    facilitatorUrl,
    toolsUrl,
    sessionCapUnits,
    repoUrl,
    fromBlock,
    siteUrl,
    problems,
  };
}

/**
 * The settings, read from the running server's environment. The names are looked up through a variable so the build does not bake the
 * values in: the same build can run against a different router after a change of environment. Server code only.
 */
export function loadConfigFromProcess(): AppConfig {
  const env: Partial<Record<PublicEnvName, string | undefined>> = {};
  for (const name of PUBLIC_ENV_NAMES) env[name] = process.env[name];
  return readConfig(env);
}
