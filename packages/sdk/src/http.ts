// Hosting an MCP server over Streamable HTTP, statelessly: each POST gets a fresh McpServer built by the caller,
// so no session is kept between requests. Payment state lives in the Paywall (which the caller shares across
// requests) and at the facilitator, not in the MCP session.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type McpFactory = () => Promise<McpServer> | McpServer;

export class BodyTooLarge extends Error {}
export class BodyNotJson extends Error {}

/**
 * The JSON of a request's body, size-limited, whether it is still to be read or a host has read it already (a serverless platform may hand
 * a function the body as `req.body`, parsed or not). Throws BodyTooLarge or BodyNotJson.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let given: unknown;
  try {
    given = (req as IncomingMessage & { body?: unknown }).body; // a host's parser may run, and fail, at the moment this is read
  } catch {
    throw new BodyNotJson("the body is not JSON");
  }
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new BodyNotJson("the body is not JSON");
    }
  };
  if (given !== undefined) {
    const text = Buffer.isBuffer(given) ? given.toString("utf8") : typeof given === "string" ? given : (JSON.stringify(given) ?? "");
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new BodyTooLarge("the body is too large");
    return Buffer.isBuffer(given) || typeof given === "string" ? parse(text) : given;
  }
  // Read by someone else, who handed nothing on: waiting for it would wait for ever.
  if (req.readableEnded) throw new BodyNotJson("the body is not JSON");
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLarge("the body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new BodyNotJson("the request failed")));
  });
  return parse(text);
}

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
