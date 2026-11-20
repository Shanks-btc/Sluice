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
