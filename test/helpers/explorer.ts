// A stand-in for the QIE explorer's read API that answers from the local chain, for the tests of the example tools.
// It serves the same paths, in the same shapes, that the tools ask the real explorer for.
import type { Provider } from "ethers";
import type { ExplorerGet } from "../../examples/paid-tools/src/rpc";

export type FakeExplorerData = {
  /** token address (lower case) -> the holders the explorer would list */
  holders?: Record<string, Array<{ address: string; value: string }>>;
  /** contract address (lower case) -> the /api/v2/smart-contracts body, or 404 for unverified */
  contracts?: Record<string, Record<string, unknown> | 404>;
  addresses?: Record<string, Record<string, unknown>>;
};

export function fakeExplorer(provider: Provider, data: FakeExplorerData = {}): ExplorerGet & { requests: string[] } {
  const requests: string[] = [];
  const get = (async (path: string) => {
    requests.push(path);
    const url = new URL(path, "http://explorer.test");
    const lower = (s: string) => s.toLowerCase();
    if (url.pathname === "/api" && url.searchParams.get("module") === "logs") {
      const logs = await provider.getLogs({
        address: url.searchParams.get("address") as string,
        topics: [url.searchParams.get("topic0") as string],
        fromBlock: 0,
        toBlock: "latest",
      });
      return {
        status: 200,
        json: {
          message: "OK",
          status: "1",
          result: logs.map((l) => ({ address: lower(l.address), blockNumber: `0x${l.blockNumber.toString(16)}`, topics: [...l.topics], data: l.data })),
        },
      };
    }
    let m = /^\/api\/v2\/tokens\/(0x[0-9a-fA-F]{40})\/holders$/.exec(url.pathname);
    if (m) {
      const items = (data.holders?.[lower(m[1] as string)] ?? []).map((h) => ({ address: { hash: h.address }, value: h.value }));
      return { status: 200, json: { items } };
    }
    m = /^\/api\/v2\/smart-contracts\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
    if (m) {
      const entry = data.contracts?.[lower(m[1] as string)];
      return entry && entry !== 404 ? { status: 200, json: entry } : { status: 404, json: { message: "Not found" } };
    }
    m = /^\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
    if (m) {
      const entry = data.addresses?.[lower(m[1] as string)];
      return entry ? { status: 200, json: entry } : { status: 404, json: { message: "Not found" } };
    }
    return { status: 404, json: { message: "Not found" } };
  }) as ExplorerGet & { requests: string[] };
  get.requests = requests;
  return get;
}

/** Serves an explorer stand-in over HTTP on this machine, for a program that runs as its own process and reads an explorer URL. */
export async function serveExplorer(get: ExplorerGet): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    void get(req.url ?? "/").then(
      (r) => res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json)),
      () => res.writeHead(500).end("{}"),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
