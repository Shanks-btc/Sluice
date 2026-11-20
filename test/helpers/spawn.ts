// Starting the packages' command-line programs from TypeScript source for the end-to-end tests, the way a user starts
// them from the built output. ts-node and tsconfig-paths let the workspace packages resolve with no build step.
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const ROOT = join(__dirname, "..", "..");

/** The node command line for running `entry` (a path from the repository root) with the given arguments. */
export function tsCommand(entry: string, args: string[] = []): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-r", "ts-node/register/transpile-only", "-r", "tsconfig-paths/register", join(ROOT, entry), ...args],
  };
}

/** Starts a program as an MCP stdio server and connects a client to it. `env` is added to a minimal safe environment. */
export async function connectStdio(entry: string, args: string[], env: Record<string, string>): Promise<Client> {
  const { command, args: commandArgs } = tsCommand(entry, args);
  const client = new Client({ name: "e2e-agent", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command, args: commandArgs, env, cwd: ROOT, stderr: "ignore" }));
  return client;
}

/** The few variables a child process needs to start on this machine (where to find programs, the system folder, a temp folder), and nothing else from this one. */
export function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
