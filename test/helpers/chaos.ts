// Making the network and the disk misbehave on purpose, for the durability tests. Everything here is local: a wrapped provider
// for the in-process facilitator, a temporary folder for its journal. No key leaves this machine.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, hexlify, randomBytes } from "ethers";
import { Facilitator } from "@sluice/facilitator";
import type { Caps, KillSwitch, Logger, Store } from "@sluice/facilitator";
import { setQie } from "./stack";
import type { Stack } from "./stack";

/** What happens to the next `broadcastTransaction`. */
export type ChaosMode =
  | "off"
  /** The node never sees the transaction and the call fails. */
  | "drop"
  /** The node gets the transaction (and, with automine on, mines it), then the answer is lost: the call fails. */
  | "forward-then-throw"
  /** The node gets the transaction, then the call never returns, as if the process stopped there. */
  | "forward-then-hang";

export type Chaos = { mode: ChaosMode; sent: number };

/** A provider that behaves as `real` does, except for `broadcastTransaction`, which follows `chaos.mode`. */
export function chaosProvider(real: JsonRpcProvider, chaos: Chaos): JsonRpcProvider {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "broadcastTransaction") {
        return async (raw: string) => {
          chaos.sent += 1;
          if (chaos.mode === "drop") throw Object.assign(new Error("connection reset"), { code: "NETWORK_ERROR" });
          const sent = await target.broadcastTransaction(raw);
          if (chaos.mode === "forward-then-throw") throw Object.assign(new Error("connection reset"), { code: "NETWORK_ERROR" });
          if (chaos.mode === "forward-then-hang") return new Promise(() => undefined);
          return sent;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export type Temp = { dir: string; journal: string; cleanup: () => void };

export function tempState(): Temp {
  const dir = mkdtempSync(join(tmpdir(), "sluice-state-"));
  return { dir, journal: join(dir, "queue.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export type Made = { facilitator: Facilitator; relayerKey: string; relayerAddress: string };

/** A second facilitator on the stack's router, with its own funded relayer and the store and provider given. */
export async function makeFacilitator(
  s: Stack,
  o: { store: Store; provider?: JsonRpcProvider; relayerKey?: string; caps?: Partial<Caps>; killSwitch?: KillSwitch; logger?: Logger; lowBalanceWei?: bigint },
): Promise<Made> {
  const relayerKey = o.relayerKey ?? hexlify(randomBytes(32));
  const relayerAddress = new Wallet(relayerKey).address;
  if (!o.relayerKey) await setQie(relayerAddress, 10n ** 18n);
  const facilitator = await Facilitator.create({
    provider: o.provider ?? s.provider,
    router: s.routerAddress,
    relayerKey,
    caps: o.caps,
    store: o.store,
    now: s.clock,
    killSwitch: o.killSwitch,
    logger: o.logger,
    lowBalanceWei: o.lowBalanceWei,
  });
  return { facilitator, relayerKey, relayerAddress };
}

// ------------------------------------------------------------------------------------------ a node that fails on purpose

import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { ROOT, inheritedEnv, tsCommand } from "./spawn";

/**
 * What the proxy does when the facilitator sends a transaction:
 *   pass             forwards everything
 *   drop-send        never forwards the transaction and never answers: the node does not see it
 *   hold-after-send  forwards the transaction (so the node mines it) and never answers
 *   hold-receipts    forwards the transaction normally, then never answers a question about a receipt
 */
export type ProxyMode = "pass" | "drop-send" | "hold-after-send" | "hold-receipts";

export type ChaosProxy = {
  url: string;
  mode: ProxyMode;
  /** Resolves when a transaction has been seen (and, for hold-after-send, forwarded). */
  sendSeen: Promise<void>;
  /** Resolves when a receipt request has been held. */
  receiptHeld: Promise<void>;
  /** Starts waiting for the next send again. */
  rearm: () => void;
  /** Every JSON-RPC method that went through, in order. */
  seen: string[];
  close: () => Promise<void>;
};

const readAll = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

export async function startChaosProxy(target: string, mode: ProxyMode = "pass"): Promise<ChaosProxy> {
  let seen!: () => void;
  let held!: () => void;
  const proxy = { mode, seen: [] as string[] } as ChaosProxy;
  const arm = () => {
    proxy.sendSeen = new Promise<void>((r) => (seen = r));
    proxy.receiptHeld = new Promise<void>((r) => (held = r));
  };
  arm();
  proxy.rearm = arm;
  let sent = false;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const text = await readAll(req);
      let calls: Array<{ method?: string }> = [];
      try {
        const parsed = JSON.parse(text) as unknown;
        calls = Array.isArray(parsed) ? (parsed as Array<{ method?: string }>) : [parsed as { method?: string }];
      } catch {
        // forwarded as it is
      }
      for (const c of calls) if (c.method) proxy.seen.push(c.method);
      const hasSend = calls.some((c) => c.method === "eth_sendRawTransaction");
      const hasReceipt = calls.some((c) => c.method === "eth_getTransactionReceipt");
      if (hasSend && proxy.mode === "drop-send") {
        seen();
        return; // never answered
      }
      if (hasReceipt && proxy.mode === "hold-receipts" && sent) {
        held();
        return; // never answered
      }
      const answer = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      const body = await answer.text();
      if (hasSend) {
        sent = true;
        if (proxy.mode === "hold-after-send") {
          seen();
          return; // forwarded, and never answered
        }
        seen();
      }
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(body);
    })().catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  proxy.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return proxy;
}

export type Spawned = {
  child: ChildProcess;
  port: number;
  /** Every line the process wrote to standard output. */
  lines: string[];
  /** Kills it as an operating system would when it runs out of memory or the host loses power: no handler runs. */
  kill: () => Promise<void>;
  exited: Promise<number | null>;
};

/** Starts the facilitator's command-line program as a separate process and waits for its "started" line. */
export async function spawnFacilitator(env: Record<string, string>): Promise<Spawned> {
  const { command, args } = tsCommand("packages/facilitator/src/cli.ts");
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...inheritedEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const errors: string[] = [];
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  let buffer = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the facilitator did not start: ${errors.join(" ")} ${lines.slice(-3).join(" ")}`)), 90_000);
    child.stdout?.on("data", (chunk: Buffer) => {
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
          // not a log line
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString("utf8").trim()));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the facilitator exited (${code}) before it started: ${errors.join(" ")}`));
    });
  });
  const kill = async () => {
    child.kill("SIGKILL");
    await exited;
  };
  return { child, port, lines, kill, exited };
}

/** The router's Settled events for one payer, read from the chain. */
export async function settledEvents(router: Stack["router"], payer: string): Promise<Array<{ transactionHash: string; blockNumber: number }>> {
  const filters = router.filters as unknown as Record<string, (p: string) => unknown>;
  const make = filters.Settled as (p: string) => unknown;
  return (await router.queryFilter(make(payer) as never)) as unknown as Array<{ transactionHash: string; blockNumber: number }>;
}
