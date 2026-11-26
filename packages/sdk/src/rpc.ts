// Choosing a QIE RPC endpoint that works. QIE publishes five public endpoints for each network (rpc1 to rpc5), and at times some of them
// do not answer. A program that was pointed at rpc1 stops when rpc1 is down. These helpers probe the five with a short time limit, keep
// the first one that answers with the right chain id, and hand the rest on as fallbacks for read calls.
//
// Probing sends one read-only request, `eth_chainId`, to each endpoint. It sends nothing else and holds no key. A setting that names an
// endpoint (SLUICE_RPC_URL) overrides all of this: it is used as given, with no probe and no fallback.

export type QieNetwork = "mainnet" | "testnet";

export const QIE_CHAIN_ID: Readonly<Record<QieNetwork, number>> = { mainnet: 1990, testnet: 1983 };

/** QIE's public endpoints, rpc1 to rpc5, for each network. */
export const QIE_ENDPOINTS: Readonly<Record<QieNetwork, readonly string[]>> = {
  mainnet: [1, 2, 3, 4, 5].map((n) => `https://rpc${n}mainnet.qie.digital/`),
  testnet: [1, 2, 3, 4, 5].map((n) => `https://rpc${n}testnet.qie.digital/`),
};

export type ProbeReason = "unreachable" | "timeout" | "wrong_chain" | "bad_answer";

export type Probe = { url: string; ok: boolean; chainId?: number; ms: number; reason?: ProbeReason };

export type ProbeOptions = {
  fetchImpl?: typeof fetch;
  /** How long one endpoint gets to answer. Default 4 seconds. */
  timeoutMs?: number;
};

/** Asks one endpoint for its chain id. Never throws: what went wrong is in the result. */
export async function probeEndpoint(url: string, chainId: number, options: ProbeOptions = {}): Promise<Probe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    const body = (await res.json()) as { result?: unknown };
    const ms = Date.now() - started;
    if (res.status >= 500 || typeof body?.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) return { url, ok: false, ms, reason: "bad_answer" };
    const reported = Number(BigInt(body.result));
    return reported === chainId ? { url, ok: true, chainId: reported, ms } : { url, ok: false, chainId: reported, ms, reason: "wrong_chain" };
  } catch {
    return { url, ok: false, ms: Date.now() - started, reason: timedOut ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes every endpoint at the same time, so a dead one costs one time limit, not one each. Results are in the order given. */
export function probeEndpoints(urls: readonly string[], chainId: number, options: ProbeOptions = {}): Promise<Probe[]> {
  return Promise.all(urls.map((u) => probeEndpoint(u, chainId, options)));
}

export class NoHealthyEndpoint extends Error {
  constructor(
    readonly probes: Probe[],
    readonly chainId: number,
  ) {
    super(`none of ${probes.length} RPC endpoints answered with chain ${chainId}: ${probes.map((p) => `${hostOf(p.url)} ${p.reason ?? "ok"}`).join(", ")}`);
    this.name = "NoHealthyEndpoint";
  }
}

export type Selected = {
  /** The first healthy endpoint, in the order given. */
  url: string;
  /** The other healthy endpoints, in order: fallbacks for read calls. */
  fallbacks: string[];
  /** What each endpoint did, in the order given. Empty when the endpoint was named by a setting and not probed. */
  probes: Probe[];
  /** True when a setting named the endpoint, so nothing was probed. */
  overridden: boolean;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "an endpoint";
  }
};

/** The first endpoint that answers with `chainId`. Throws NoHealthyEndpoint if none does. */
export async function selectEndpoint(urls: readonly string[], chainId: number, options: ProbeOptions = {}): Promise<Selected> {
  const probes = await probeEndpoints(urls, chainId, options);
  const healthy = probes.filter((p) => p.ok).map((p) => p.url);
  if (healthy.length === 0) throw new NoHealthyEndpoint(probes, chainId);
  return { url: healthy[0] as string, fallbacks: healthy.slice(1), probes, overridden: false };
}

/**
 * The endpoint to use for a network. A named one (SLUICE_RPC_URL) is used exactly as given. Otherwise QIE's five are probed and the first
 * healthy one is chosen. `candidates` replaces the five, for a caller that already has its own list.
 */
export async function resolveEndpoint(network: QieNetwork, named: string | undefined, options: ProbeOptions & { candidates?: readonly string[] } = {}): Promise<Selected> {
  const override = named?.trim();
  if (override) return { url: override, fallbacks: [], probes: [], overridden: true };
  return selectEndpoint(options.candidates ?? QIE_ENDPOINTS[network], QIE_CHAIN_ID[network], options);
}

/** One line saying which endpoint was chosen and what happened to the others. */
export function describeSelection(sel: Selected): string {
  if (sel.overridden) return `RPC endpoint ${hostOf(sel.url)} (named by SLUICE_RPC_URL, not probed)`;
  const skipped = sel.probes.filter((p) => !p.ok).map((p) => `${hostOf(p.url).split(".")[0]} ${p.reason === "wrong_chain" ? `chain ${p.chainId}` : p.reason}`);
  const ok = sel.probes.find((p) => p.url === sel.url);
  return `RPC endpoint ${hostOf(sel.url)} (chain ${ok?.chainId ?? "?"}, ${ok?.ms ?? "?"} ms)${sel.fallbacks.length ? `; ${sel.fallbacks.length} fallback${sel.fallbacks.length === 1 ? "" : "s"}` : ""}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}`;
}

/** The chosen endpoint first, then its fallbacks: the list to hand to a client that tries them in turn. */
export const orderedUrls = (sel: Selected): string[] => [sel.url, ...sel.fallbacks];

/**
 * Throws unless the node behind `provider` says it is chain `chainId`. A provider made with a fixed network never asks the node which
 * chain it is on, so a program that was pointed at the wrong node would not find out until a call failed. This asks it directly, before
 * anything is read or sent. `label` is how the message names the chain the run is for ("mainnet").
 */
export async function requireNodeChain(provider: { send(method: string, params: unknown[]): Promise<unknown> }, chainId: number, label: string): Promise<void> {
  let reported: bigint;
  try {
    reported = BigInt(String(await provider.send("eth_chainId", [])));
  } catch {
    throw new Error(`the RPC did not answer eth_chainId, so its chain could not be checked: ${label} is chain ${chainId}`);
  }
  if (reported !== BigInt(chainId)) throw new Error(`the RPC is on chain ${reported}, but ${label} is chain ${chainId}`);
}
