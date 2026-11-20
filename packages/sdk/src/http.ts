// Hosting an MCP server over Streamable HTTP, statelessly: each POST gets a fresh McpServer built by the caller,
// so no session is kept between requests. Payment state lives in the Paywall (which the caller shares across
// requests) and at the facilitator, not in the MCP session.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type McpFactory = () => Promise<McpServer> | McpServer;

/**
 * A request listener for POST /mcp. Any other method or path is refused. A host that has already read the request's body (to count
 * it, size-limit it, or tell a paid call from an unpaid one) passes the parsed JSON as the third argument, and the transport uses
 * it instead of reading the stream again.
 */
export function mcpRequestListener(build: McpFactory, path = "/mcp") {
  return async (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null }),
      );
      return;
    }
    try {
      const server = await build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }),
        );
      }
    }
  };
}

/** Starts an HTTP server for the factory. Resolves with the server and the port in use. */
export function serveMcpHttp(build: McpFactory, port = 0, host = "127.0.0.1", path = "/mcp"): Promise<{ server: Server; port: number }> {
  const listener = mcpRequestListener(build, path);
  const server = createServer((req, res) => void listener(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : port });
    });
  });
}
