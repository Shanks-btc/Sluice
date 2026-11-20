// A stdio MCP server used only by the tests. Its one tool reports which environment variable NAMES this process was
// started with, so a test can check that the proxy did not hand its session key to the upstream process.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "env-echo", version: "0.0.1" });
server.registerTool("env_names", { description: "Lists environment variable names.", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: JSON.stringify(Object.keys(process.env).sort()) }],
}));
void server.connect(new StdioServerTransport());
