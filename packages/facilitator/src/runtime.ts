// Starts a facilitator from its environment and shuts it down in order. The CLI is a thin wrapper around this, and the tests start
// the same thing, so what runs in a container is what was tested.
import { Network } from "ethers";
import type { Provider } from "ethers";
import type { Server } from "node:http";
import type { FacilitatorEnv } from "./env";
import { KillSwitch } from "./killswitch";
import { TimedJsonRpcProvider, createLogger } from "@sluice/sdk";
import type { Logger } from "@sluice/sdk";
import { createServer, listen } from "./server";
import { Facilitator } from "./service";
import { FileStore, MemoryStore } from "./store";
import type { Store } from "./store";

export type Running = {
  facilitator: Facilitator;
  server: Server;
  store: Store;
  logger: Logger;
  port: number;
  /** Stops listening, lets a batch in progress finish (up to SLUICE_FACILITATOR_SHUTDOWN_MS), closes the store. Safe to call twice. */
  shutdown(reason: string): Promise<{ finished: boolean }>;
};

export type StartOptions = {
  /** A provider to use instead of the one the RPC URL would make. For tests. */
  provider?: Provider;
  /** Where log lines go. Standard output by default. */
  write?: (line: string) => void;
};

export async function startFacilitator(env: FacilitatorEnv, options: StartOptions = {}): Promise<Running> {
  const key = env.relayerKey();
  const logger = createLogger({ write: options.write, level: env.logLevel, secrets: [key], base: { service: "sluice-facilitator" } });
  let made: TimedJsonRpcProvider | undefined;
  if (!options.provider) {
    const network = Network.from(env.chainId);
    // cacheTimeout -1: the relayer sends in sequence and must always read its current nonce, never a 250 ms old one.
    // Every request has a time limit, so a node that stops answering cannot hold a batch (and the queue behind it) for ever.
    made = new TimedJsonRpcProvider(env.rpcUrl, network, { staticNetwork: network, cacheTimeout: -1 }, env.rpcTimeoutMs);
    made.pollingInterval = 1_000;
  }
  const provider: Provider = options.provider ?? (made as TimedJsonRpcProvider);
  // Opened before anything else that costs money: a store that cannot be read stops the start here.
  const store: Store = env.statePath ? new FileStore(env.statePath) : new MemoryStore();
  let facilitator: Facilitator;
  try {
    facilitator = await Facilitator.create({
      provider,
      router: env.router,
      relayerKey: key,
      caps: env.caps,
      chainId: env.chainId,
      store,
      publicUrl: env.publicUrl,
      killSwitch: new KillSwitch(env.killSwitch, env.killFile),
      logger,
      lowBalanceWei: env.lowBalanceWei,
      onAlert: (alert) => logger.warn("alert", { kind: alert.kind, message: alert.message }),
    });
  } catch (err) {
    store.close();
    throw err;
  }
  const server = createServer(facilitator, {
    origins: env.corsOrigins,
    maxBodyBytes: env.maxBodyBytes,
    ipLimit: { max: env.ipPerMinute, windowMs: 60_000 },
    payerLimit: { max: env.payerPerMinute, windowMs: 60_000 },
    trustedProxyHops: env.trustedProxyHops,
    logger,
  });
  const port = await listen(server, env.port, env.host);
  facilitator.start(env.flushMs);
  logger.info("started", {
    network: env.network,
    chainId: env.chainId,
    router: facilitator.routerAddress,
    relayer: facilitator.relayer.address,
    host: env.host,
    port,
    dailyBudgetWei: env.caps.dailyBudgetWei,
    store: env.statePath ? "journal" : "memory",
    killSwitch: env.killSwitch || env.killFile !== undefined ? "armed" : "off",
  });

  let closing: Promise<{ finished: boolean }> | undefined;
  const shutdown = (reason: string): Promise<{ finished: boolean }> => {
    closing ??= (async () => {
      logger.info("shutting down", { reason });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // A connection that is still busy gets the drain's time, then is dropped.
        setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, env.shutdownMs).unref();
      });
      const result = await facilitator.drain(env.shutdownMs);
      store.close();
      made?.destroy(); // a provider the caller handed in is the caller's to close
      logger.info("stopped", { finished: result.finished });
      return result;
    })();
    return closing;
  };
  return { facilitator, server, store, logger, port, shutdown };
}
