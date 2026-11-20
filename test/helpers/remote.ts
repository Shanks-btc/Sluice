// A whole Sluice deployment as separate processes on this machine, the way it runs when it is hosted:
//
//   an MCP client  ->  the payment proxy (stdio)  ->  the tool server (HTTP, its own process)  ->  the facilitator (HTTP, its own process)
//
// All of it talks to one chain: the in-process Hardhat network served over HTTP (or its fork of QIE mainnet). Keys are made for the run
// and nothing leaves this machine.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, hexlify, randomBytes, parseEther } from "ethers";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FacilitatorClient, signAuthorize, signOnboarding, toolIdOf } from "@sluice/sdk";
import { USDC } from "./index";
import { connectStdio, ROOT, inheritedEnv, tsCommand } from "./spawn";
import { spawnFacilitator } from "./chaos";
import type { Spawned } from "./chaos";
import { fundWallet, setQie, throwawayWallet } from "./stack";
import type { Stack } from "./stack";

export type ToolServerProcess = {
  child: ChildProcess;
  port: number;
  url: string;
  /** What the process wrote to standard error: JSON log lines. */
  lines: string[];
  stop: () => Promise<void>;
};

/** Starts the example tools' command-line program with --http as a separate process and waits for its "started" line. */
export async function spawnToolServer(env: Record<string, string>): Promise<ToolServerProcess> {
  const { command, args } = tsCommand("examples/paid-tools/src/cli.ts", ["--http", "0"]);
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...inheritedEnv(), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const lines: string[] = [];
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let buffer = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the tool server did not start: ${lines.slice(-3).join(" ")}`)), 90_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        lines.push(line);
        try {
          const parsed = JSON.parse(line) as { msg?: string; port?: number };
          if (parsed.msg === "started" && typeof parsed.port === "number") {
            clearTimeout(timer);
            resolve(parsed.port);
          }
        } catch {
          // a plain message: kept for the error above
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the tool server exited (${code}) before it started: ${lines.join(" ")}`));
    });
  });
  return {
    child,
    port,
    url: `http://127.0.0.1:${port}`,
    lines,
    stop: async () => {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

export type Deployment = {
  stack: Stack;
  facilitator: Spawned;
  tools: ToolServerProcess;
  owner: Wallet;
  agent: Wallet;
  builder: Wallet;
  facilitatorUrl: string;
  /** The proxy, connected as an MCP client over stdio. */
  agentClient: Client;
  configPath: string;
  dir: string;
  expiry: number;
  stop: () => Promise<void>;
};

export type DeploymentOptions = {
  /** Environment for the tool server on top of the defaults. */
  tools?: Record<string, string>;
  /** The explorer the tool server reads, if it needs a stand-in. */
  explorerUrl?: string;
  /** Extra proxy budget settings. */
  budget?: { perCallCap?: string; totalCap?: string; allowed?: string[] };
};

/**
 * Starts the facilitator and the tool server as their own processes, funds an owner who holds QUSDC and no QIE, authorises an agent by
 * signature through the facilitator, and connects the payment proxy (also its own process) to the tool server's HTTP address.
 * The stack must be on a chain whose clock is the wall clock (see freshChain), because the processes read the wall clock.
 */
export async function startDeployment(stack: Stack, options: DeploymentOptions = {}): Promise<Deployment> {
  const owner = throwawayWallet();
  const agent = throwawayWallet();
  const builder = throwawayWallet();
  const relayerKey = hexlify(randomBytes(32));
  await setQie(new Wallet(relayerKey).address, parseEther("1"));
  const dir = mkdtempSync(join(tmpdir(), "sluice-remote-"));

  const facilitator = await spawnFacilitator({
    SLUICE_NETWORK: "local",
    SLUICE_RPC_URL: stack.rpcUrl,
    SLUICE_ROUTER: stack.routerAddress,
    SLUICE_RELAYER_KEY: relayerKey,
    SLUICE_FACILITATOR_PORT: "0",
    SLUICE_FACILITATOR_STATE: join(dir, "queue.jsonl"),
    SLUICE_FACILITATOR_FLUSH_MS: "500",
  });
  const facilitatorUrl = `http://127.0.0.1:${facilitator.port}`;

  const tools = await spawnToolServer({
    SLUICE_NETWORK: "local",
    SLUICE_ROUTER: stack.routerAddress,
    SLUICE_FACILITATOR_URL: facilitatorUrl,
    SLUICE_PAYEE: builder.address,
    SLUICE_RPC_URL: stack.rpcUrl,
    ...(options.explorerUrl ? { SLUICE_EXPLORER_URL: options.explorerUrl } : {}),
    ...options.tools,
  });

  // The owner holds QUSDC and no QIE. Everything below is signed by the owner and sent by the facilitator.
  await fundWallet(stack, owner, USDC("20"));
  const client = new FacilitatorClient({ url: facilitatorUrl });
  const gasPrice = (await stack.provider.getFeeData()).gasPrice as bigint;
  const { approveTx, depositTx } = await signOnboarding(owner, { router: stack.routerAddress, asset: stack.tokenAddress, amount: USDC("5"), nonce: 0, gasPrice });
  const started = await client.onboard({ payer: owner.address, approveTx, depositTx });
  if (!started.ok) throw new Error(`the zero-QIE start failed: ${started.detail}`);

  const expiry = stack.clock() + 86_400;
  const budget = options.budget ?? {};
  const allowed = budget.allowed ?? ["token_risk_check", "contract_lookup", "dex_quote"];
  const grant = { agent: agent.address, budget: USDC(budget.totalCap ?? "0.5"), perCallCap: USDC(budget.perCallCap ?? "0.02"), expiry: BigInt(expiry) };
  const toolList = allowed.map((name) => ({ payee: builder.address, toolId: toolIdOf(name) }));
  const deadline = BigInt(stack.clock() + 600);
  const signature = await signAuthorize(owner, stack.vaultAddress, { payer: owner.address, grant, tools: toolList, nonce: 0n, deadline });
  const authorised = await client.relay({
    kind: "authorize", payer: owner.address, tools: toolList, deadline: deadline.toString(), signature,
    grant: { agent: agent.address, budget: grant.budget.toString(), perCallCap: grant.perCallCap.toString(), expiry: grant.expiry.toString() },
  });
  if (!authorised.ok) throw new Error(`authorising the agent failed: ${authorised.detail}`);

  const configPath = join(dir, "sluice.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      upstream: { url: `${tools.url}/mcp` },
      router: stack.routerAddress,
      payer: owner.address,
      asset: stack.tokenAddress,
      rpcUrl: stack.rpcUrl,
      budget: {
        perCallCap: budget.perCallCap ?? "0.02",
        totalCap: budget.totalCap ?? "0.5",
        expiresAt: new Date(expiry * 1000).toISOString(),
        allowedTools: allowed.map((tool) => ({ tool, payee: builder.address })),
      },
      logFile: "payments.jsonl",
      stateFile: "budget.json",
    }),
  );
  const agentClient = await connectStdio("packages/proxy/src/cli.ts", ["--config", configPath], { SLUICE_AGENT_KEY: agent.privateKey });

  return {
    stack, facilitator, tools, owner, agent, builder, facilitatorUrl, agentClient, configPath, dir, expiry,
    stop: async () => {
      await agentClient.close().catch(() => undefined);
      await tools.stop();
      await facilitator.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
