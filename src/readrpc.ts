// A JSON-RPC client that can only read, over several endpoints. The recorder and the pre-flight check use it with different lists of
// allowed methods; the list is the whole of what they can ask a node, so nothing built on it can send, sign or change anything.
import { NetworkError } from "./evidence";
import type { Rpc } from "./evidence";

/** The node answered with an error of its own (a call that reverted, state it no longer has). Another node may answer differently. */
export class RpcRefused extends Error {}

/**
 * A call goes to the endpoint that last answered and, if that fails or refuses, to the others in order; it fails only when every
 * endpoint has. A transport failure is a NetworkError, a refusal is an RpcRefused. A method that is not on the list is refused before
 * any request leaves.
 */
export function readOnlyRpc(urls: readonly string[], allowed: ReadonlySet<string>, fetchImpl: typeof fetch = fetch): Rpc {
  if (urls.length === 0) throw new Error("no RPC endpoint");
  let counter = 0;
  let current = 0;
  return async (method, params) => {
    if (!allowed.has(method)) throw new Error(`method not allowed: ${method}`);
    let refused = false;
    for (let attempt = 0; attempt < urls.length; attempt++) {
      const url = urls[(current + attempt) % urls.length] as string;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        counter += 1;
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: counter, method, params }),
          signal: controller.signal,
        });
        if (res.status === 429 || res.status >= 500) continue;
        const body = (await res.json()) as { result?: unknown; error?: unknown };
        if (body.error) {
          refused = true;
          continue;
        }
        current = (current + attempt) % urls.length;
        return body.result ?? null;
      } catch {
        // an unreachable or unreadable endpoint: try the next one
      } finally {
        clearTimeout(timer);
      }
    }
    if (refused) throw new RpcRefused("the node refused the request");
    throw new NetworkError("no RPC endpoint could be reached");
  };
}
