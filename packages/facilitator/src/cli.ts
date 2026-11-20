#!/usr/bin/env node
// Starts the facilitator. Configuration is read from the environment (names in .env.example); the relayer key
// is never printed. Against mainnet or testnet it refuses to start without an approval, a QIE budget and a queue file.
// SIGTERM and SIGINT stop it in order: it stops listening, lets a batch in progress finish, and closes its queue.
import { EnvError, readEnv } from "./env";
import { startFacilitator } from "./runtime";
import { StoreError } from "./store";

async function main(): Promise<void> {
  const env = readEnv(process.env);
  const running = await startFacilitator(env);
  let stopping = false;
  const stop = (reason: string, code: number): void => {
    if (stopping) return;
    stopping = true;
    running
      .shutdown(reason)
      .then((r) => process.exit(r.finished ? code : 1))
      .catch(() => process.exit(1));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGBREAK"] as const) process.on(signal, () => stop(signal, 0));
  // Fixed text only: an exception's own text could hold a URL or a key fragment.
  process.on("uncaughtException", () => {
    running.logger.error("an unexpected error stopped the service");
    stop("uncaughtException", 1);
  });
  process.on("unhandledRejection", () => {
    running.logger.error("an unexpected rejection stopped the service");
    stop("unhandledRejection", 1);
  });
}

main().catch((err: unknown) => {
  // Only messages this package wrote are printed. An unexpected error prints a fixed line, never its text.
  const message = err instanceof EnvError || err instanceof StoreError ? err.message : "the facilitator failed to start";
  process.stderr.write(`${message}\n`, () => process.exit(1));
});
