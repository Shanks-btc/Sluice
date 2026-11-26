// Time limits for reads from a node. ethers' own request timeout does not stop a node that accepts the connection and then never
// answers (a stalled load balancer does exactly this), so a program that must not hang puts its own limit on each request.
import { JsonRpcProvider } from "ethers";
import type { JsonRpcApiProviderOptions, JsonRpcPayload, JsonRpcResult, Networkish } from "ethers";

/** Thrown when a limit runs out. It carries the code ethers uses for the same thing, so callers that tell a failed connection from a refusal treat it alike. */
export class TimeoutError extends Error {
  readonly code = "TIMEOUT";
  constructor(message = "the node did not answer in time") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** The result of `work`, or a TimeoutError if it has not finished in `ms`. No timer is left running. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A JSON-RPC provider that gives up on any request the node has not answered within `timeoutMs`. */
export class TimedJsonRpcProvider extends JsonRpcProvider {
  constructor(
    url: string,
    network: Networkish,
    options: JsonRpcApiProviderOptions,
    private readonly timeoutMs: number,
  ) {
    super(url, network, options);
  }

  override _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    return within(super._send(payload), this.timeoutMs);
  }
}

/** Methods that only read the chain. A request made of these may be asked of another endpoint if the first does not answer. */
const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "eth_call",
  "eth_estimateGas",
]);

const isRead = (payload: JsonRpcPayload | Array<JsonRpcPayload>): boolean => (Array.isArray(payload) ? payload : [payload]).every((p) => READ_METHODS.has(p.method));

/**
 * A provider that asks its first endpoint, and for a request that only reads asks the next endpoint when the first does not answer in
 * time or cannot be reached. A request that sends or signs is never tried on another endpoint: if it failed, the caller decides what to do,
 * because a transaction that may have been accepted is not something to resend blindly. Every endpoint has the same time limit.
 */
export class FailoverJsonRpcProvider extends TimedJsonRpcProvider {
  private readonly backups: TimedJsonRpcProvider[];

  constructor(urls: readonly string[], network: Networkish, options: JsonRpcApiProviderOptions, timeoutMs: number) {
    if (urls.length === 0) throw new Error("no RPC endpoint");
    super(urls[0] as string, network, options, timeoutMs);
    this.backups = urls.slice(1).map((u) => new TimedJsonRpcProvider(u, network, options, timeoutMs));
  }

  override async _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    try {
      return await super._send(payload);
    } catch (err) {
      if (!isRead(payload)) throw err;
      for (const backup of this.backups) {
        try {
          return await backup._send(payload);
        } catch {
          // try the next endpoint
        }
      }
      throw err;
    }
  }

  override destroy(): void {
    for (const b of this.backups) b.destroy();
    super.destroy();
  }
}
