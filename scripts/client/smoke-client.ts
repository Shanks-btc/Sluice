// A scripted MCP client: the official MCP SDK client starts the payment proxy as a child process, lists the tools, makes one paid call, and
// prints every step. Use it to see the whole path work, from a client through the proxy to a tool server and a facilitator, before a person
// tries it from an MCP application.
//
//   SLUICE_AGENT_KEY=0x... pnpm client:smoke --config sluice.config.json --tool contract_lookup --arg address=0x...
//   SLUICE_AGENT_KEY=0x... pnpm client:smoke --config sluice.config.json --list-only
//
// This is a script, and it is the only thing that has run this path. It is not an MCP application, so a run of it says nothing about how an
// MCP application behaves. The session key is read from the environment, handed to the proxy and never printed.
//
//   --config     the proxy's config file (or SLUICE_CONFIG)
//   --tool       the tool to call; with no --tool the script only lists the tools
//   --arg        one argument of the tool as name=value, text only; repeat it for each. The form to use in PowerShell.
//   --args       the tool's arguments, as JSON (default {}). Windows PowerShell 5 strips the double quotes out of such an argument on
//                its way to the program, so there it has to be written with \" for each quote, or given with --arg instead.
//   --list-only  list the tools and stop
//   --proxy      the proxy program (default packages/proxy/dist/cli.js, which pnpm build makes)
//
// Exit code 0: it ran, and a paid call, if asked for, was paid and answered. 1: the call was refused or failed, or the proxy could not
// start. 2: the command was wrong.
import { exitWith } from "../../src/exit";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PAYMENT_RESPONSE_META_KEY, PRICING_META_KEY, cutSecrets, describeSelection, resolveEndpoint } from "@sluice/sdk";

export type Env = Record<string, string | undefined>;
export type SmokeIo = {
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** The program to start as the proxy. Defaults to the built one. */
  command?: { command: string; args: string[]; cwd?: string };
};

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--config", "--tool", "--args", "--proxy"]);
const ROOT = join(__dirname, "..", "..");

function inherited(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const short = (text: string, n = 300): string => (text.length > n ? `${text.slice(0, n)}…` : text);

export async function main(argv: string[], env: Env = process.env, io: SmokeIo = {}): Promise<number> {
  const key = env.SLUICE_AGENT_KEY?.trim();
  const say = (line: string) => (io.log ?? console.log)(key ? cutSecrets(line, [key]) : line);
  let client: Client | undefined;
  try {
    const args: Record<string, string | boolean> = {};
    const named: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i] as string;
      if (flag === "--list-only") args["list-only"] = true;
      else if (flag === "--arg") {
        const m = /^([A-Za-z_][A-Za-z0-9_]{0,63})=(.*)$/.exec(argv[++i] ?? "");
        if (!m) throw new UsageError("--arg is name=value, like --arg address=0x...");
        const name = m[1] as string;
        if (Object.prototype.hasOwnProperty.call(named, name)) throw new UsageError(`--arg ${name} was given twice`);
        named[name] = m[2] as string;
      } else if (VALUE_FLAGS.has(flag)) {
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
        args[flag.slice(2)] = value;
      } else throw new UsageError(`unknown option ${flag.slice(0, 40)}`);
    }
    const config = (typeof args.config === "string" ? args.config : undefined) ?? env.SLUICE_CONFIG?.trim();
    if (!config) throw new UsageError("give the proxy's config file with --config (or set SLUICE_CONFIG)");
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new UsageError("set SLUICE_AGENT_KEY to the agent's session key (a 0x-prefixed 32-byte hex key)");
    const tool = typeof args.tool === "string" ? args.tool : undefined;
    if (!tool && !args["list-only"]) throw new UsageError("give --tool to make a paid call, or --list-only to list the tools");
    let toolArgs: Record<string, unknown> = { ...named };
    if (typeof args.args === "string") {
      if (Object.keys(named).length > 0) throw new UsageError("give the arguments with --arg or with --args, not both");
      try {
        const parsed = JSON.parse(args.args) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        toolArgs = parsed as Record<string, unknown>;
      } catch {
        throw new UsageError("--args must be a JSON object, like '{\"address\":\"0x...\"}' (in PowerShell 5 use --arg name=value instead, which it does not alter)");
      }
    }
    const command = io.command ?? { command: process.execPath, args: [resolve(typeof args.proxy === "string" ? args.proxy : join(ROOT, "packages", "proxy", "dist", "cli.js")), "--config", resolve(config)], cwd: ROOT };
    if (!io.command && !existsSync(command.args[0] as string)) throw new UsageError("the proxy program was not found: run pnpm build first, or give --proxy");

    say("scripted MCP client run (the official MCP SDK client). It is a script, not an MCP application.");
    // Neither this client nor the proxy reads the chain to make a call, but a program the proxy runs next to it may. When a QIE network is
    // named, probe its endpoints, say which one answers, and hand that one to the child as SLUICE_RPC_URL.
    let rpcForChild = env.SLUICE_RPC_URL?.trim() || undefined;
    const net = env.SLUICE_NETWORK?.trim();
    if (net === "mainnet" || net === "testnet") {
      try {
        const sel = await resolveEndpoint(net, env.SLUICE_RPC_URL, { fetchImpl: io.fetchImpl });
        say(describeSelection(sel));
        rpcForChild = sel.url;
      } catch {
        say(`no RPC endpoint answered for ${net}; the call itself does not need one, so the run goes on`);
      }
    }
    say(`step 1: start the payment proxy as a child process: ${command.command === process.execPath ? "node" : command.command} ${short(command.args.map((a) => (a.length > 60 ? "…" + a.slice(-40) : a)).join(" "), 200)}`);
    client = new Client({ name: "sluice-scripted-client", version: "0.1.0" });
    // The child gets a small environment: where to find programs, and the one variable that holds the session key.
    await client.connect(new StdioClientTransport({ command: command.command, args: command.args, cwd: command.cwd ?? ROOT, env: { ...inherited(), SLUICE_AGENT_KEY: key, ...(rpcForChild ? { SLUICE_RPC_URL: rpcForChild } : {}) }, stderr: "ignore" }));
    say("step 2: connected over stdio");

    const listed = await client.listTools();
    say(`step 3: tools/list returned ${listed.tools.length} tool${listed.tools.length === 1 ? "" : "s"}`);
    for (const t of listed.tools) {
      const price = (t._meta as Record<string, { amount?: string; payTo?: string }> | undefined)?.[PRICING_META_KEY];
      say(`  ${t.name}${price?.amount ? `  price ${price.amount} units` : "  (no price advertised)"}`);
    }
    if (args["list-only"] || !tool) return 0;
    if (!listed.tools.some((t) => t.name === tool)) {
      say(`the tool "${short(tool, 60)}" is not in that list, so nothing was called`);
      return 1;
    }

    say(`step 4: tools/call ${tool} ${short(JSON.stringify(toolArgs), 200)}`);
    say("  the proxy asks the server, reads the price, checks it against the owner's budget, signs an intent with the session key and retries");
    const result = (await client.callTool({ name: tool, arguments: toolArgs })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type: string; text?: string }>;
      _meta?: Record<string, unknown>;
    };
    if (result.isError) {
      const sc = result.structuredContent as { error?: string; reason?: string } | undefined;
      say(`step 5: the call did not go through: ${sc?.error ?? "an error"}${sc?.reason ? ` (${sc.reason})` : ""}`);
      say(`  ${short(result.content?.[0]?.text ?? "", 240)}`);
      return 1;
    }
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    say(`step 5: the tool answered: ${short(text.replace(/\s+/g, " "), 240)}`);
    const settlement = result._meta?.[PAYMENT_RESPONSE_META_KEY] as { success?: boolean; payer?: string; network?: string; amount?: string; extensions?: { sluice?: { id?: string; status?: string; statusUrl?: string } } } | undefined;
    if (!settlement) {
      say("step 6: the reply carries no payment response, so there is nothing to say about what was paid");
      return 1;
    }
    say(`step 6: payment response: success ${String(settlement.success)}, payer ${settlement.payer ?? "?"}, network ${settlement.network ?? "?"}, amount ${settlement.amount ?? "?"} units`);
    const s = settlement.extensions?.sluice;
    say(`  intent ${s?.id ?? "?"} is ${s?.status ?? "?"}${s?.statusUrl ? `; follow it at ${s.statusUrl}` : ""}`);
    say("  queued means the facilitator has it and has not yet sent the batch to the chain; check the intent's status later, and see the recorder for what the chain can show");
    return settlement.success === true ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) {
      say(`refused: ${err.message}`);
      return 2;
    }
    say("the scripted client stopped: the proxy could not be started or did not answer.");
    return 1;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("client:smoke failed");
      exitWith(1);
    },
  );
}
