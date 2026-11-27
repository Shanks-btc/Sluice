// What each payment was used for, kept where every copy of a tool server can see it. Without this, two copies given the same payment at
// the same moment would each run the tool. A copy takes the payment before it looks at anything (SET NX), and lets go when it is done. A
// copy that dies keeps it until the claim expires. When the database cannot be asked, nothing runs.
import { randomBytes } from "node:crypto";
import type { IdempotencyEntry, IdempotencyStore } from "./paid-tool";
import { MAX_INTENT_LIFETIME_SECONDS } from "./protocol";
import { RELEASE_SCRIPT } from "./redis";
import type { RedisClient } from "./redis";

export type RedisIdempotencyOptions = {
  /** How long a claim lasts if it is never let go. Longer than one request may run. */
  claimMs?: number;
  /** How long a result is kept. Past a payment's longest life it is refused anyway. */
  entrySeconds?: number;
};

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly claimMs: number;
  private readonly entrySeconds: number;
  private readonly held = new Map<string, string>();

  constructor(
    private readonly client: RedisClient,
    private readonly prefix: string,
    options: RedisIdempotencyOptions = {},
  ) {
    this.claimMs = options.claimMs ?? 120_000;
    this.entrySeconds = options.entrySeconds ?? MAX_INTENT_LIFETIME_SECONDS + 3_600;
  }

  async get(id: string): Promise<IdempotencyEntry | undefined> {
    const text = await this.client.command(["GET", `${this.prefix}entry:${id}`]);
    return typeof text === "string" ? (JSON.parse(text) as IdempotencyEntry) : undefined;
  }

  async set(id: string, entry: IdempotencyEntry): Promise<void> {
    await this.client.command(["SET", `${this.prefix}entry:${id}`, JSON.stringify(entry), "EX", this.entrySeconds]);
  }

  async claim(id: string): Promise<boolean> {
    const token = randomBytes(16).toString("hex");
    const answer = await this.client.command(["SET", `${this.prefix}claim:${id}`, token, "NX", "PX", this.claimMs]);
    if (answer !== "OK") return false;
    this.held.set(id, token);
    return true;
  }

  async release(id: string): Promise<void> {
    const token = this.held.get(id);
    if (token === undefined) return;
    this.held.delete(id);
    await this.client.eval(RELEASE_SCRIPT, [`${this.prefix}claim:${id}`], [token]);
  }
}
