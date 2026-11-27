// What a tool server may do with its database. It can share one database with the facilitator, and then this is what stands between a
// fault in the tool server's code and the facilitator's keys: the stored kill switch, the daily caps, the queue, the relayer's lock.
//
// It lets through a short list and refuses everything else, before anything reaches the database:
//   - GET of a key under this server's own prefix;
//   - SET of such a key, with an expiry, of a limited size, and the one fixed marker;
//   - the two scripts a tool server runs, given exactly their number of keys, each under the prefix. Both name keys through KEYS alone,
//     which is checked.
// So FLUSHALL, FLUSHDB, CONFIG, KEYS, SCAN, DEL, EVAL by name and every other command or script are refused.
//
// This holds in the code and nowhere else. The database token can do anything: code that goes round this, or a token that leaks, is not
// stopped by it. Separate databases are the stronger setup.
import { RATE_SCRIPT, RELEASE_SCRIPT, RedisError, TOOLS_KEY_PREFIX, TOOLS_MARKER_KEY, TOOLS_MARKER_VALUE } from "./redis";
import type { RedisClient } from "./redis";

/** A request the guard did not let through. Nothing was sent to the database. */
export class RedisRefused extends RedisError {
  constructor(why: string) {
    super(`refused: ${why}`);
    this.name = "RedisRefused";
  }
}

/** The most a tool server may keep under one key, and the longest it may keep it. */
export const TOOL_MAX_VALUE_BYTES = 256 * 1024;
export const TOOL_MAX_TTL_MS = 24 * 3_600 * 1_000;

/** The scripts a tool server runs, and the number of keys each is given. */
export const TOOL_SCRIPTS: ReadonlyArray<{ script: string; keys: number }> = [
  { script: RATE_SCRIPT, keys: 1 },
  { script: RELEASE_SCRIPT, keys: 1 },
];

/** The commands a checked script may call, and which of their arguments are keys. */
const SCRIPT_COMMANDS: Readonly<Record<string, "first" | "all">> = { GET: "first", INCR: "first", PEXPIRE: "first", PTTL: "first", DEL: "all" };

/**
 * True when every key a script touches is one it was given: the word `redis` appears only in calls of a short list of commands, named in
 * quotes, and each argument that names a key is `KEYS[n]`. A script that builds a key name, takes one from ARGV, picks its command at
 * run time or keeps `redis.call` under another name is refused.
 */
export function namesOnlyGivenKeys(script: string): boolean {
  const mentions = script.match(/\bredis\b/g)?.length ?? 0;
  const calls = [...script.matchAll(/\bredis\.p?call\(\s*'([A-Z]+)'\s*((?:,[^()]*(?:\([^()]*\))?[^()]*?)?)\)/g)];
  if (mentions === 0 || calls.length !== mentions) return false;
  return calls.every((call) => {
    const takes = SCRIPT_COMMANDS[call[1] as string];
    const given = (call[2] ?? "").split(",").slice(1).map((a) => a.trim());
    if (!takes || given.length === 0) return false;
    return (takes === "all" ? given : given.slice(0, 1)).every((a) => /^KEYS\[[1-9]\d*\]$/.test(a));
  });
}

const word = (value: unknown): string => {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) throw new RedisRefused("an argument that is not text or a number");
  return String(value);
};

export class ToolServerRedis implements RedisClient {
  readonly #inner: RedisClient;
  readonly #prefix: string;
  readonly #scripts = new Map<string, number>();

  /** `prefix` is this server's own, under the tool servers' fixed prefix: for one network and router. */
  constructor(inner: RedisClient, prefix: string) {
    if (!prefix.startsWith(TOOLS_KEY_PREFIX) || prefix.length <= TOOLS_KEY_PREFIX.length || !prefix.endsWith(":")) {
      throw new RedisRefused(`a tool server's prefix starts with ${TOOLS_KEY_PREFIX}, names more, and ends with a colon`);
    }
    for (const { script, keys } of TOOL_SCRIPTS) {
      if (!namesOnlyGivenKeys(script)) throw new RedisRefused("a script of this server names a key it is not given");
      this.#scripts.set(script, keys);
    }
    this.#inner = inner;
    this.#prefix = prefix;
  }

  #own(key: string): void {
    if (!key.startsWith(this.#prefix) || key.length <= this.#prefix.length) throw new RedisRefused("a key outside this server's own prefix");
  }

  async command(args: ReadonlyArray<string | number>): Promise<unknown> {
    // Copied before it is looked at, and the copy is what is sent: nothing can change it in between.
    const words = Array.from(args, word);
    const [name, key, ...rest] = words;
    if (name === "GET" && words.length === 2) {
      this.#own(key as string);
    } else if (name === "SET" && words.length >= 3) {
      this.#checkSet(key as string, rest);
    } else {
      throw new RedisRefused("a command this server does not use");
    }
    return this.#inner.command(words);
  }

  #checkSet(key: string, [value, ...options]: string[]): void {
    if (key === TOOLS_MARKER_KEY) {
      if (value !== TOOLS_MARKER_VALUE || options.length !== 0) throw new RedisRefused("the marker is written with its own value and nothing else");
      return;
    }
    this.#own(key);
    if (Buffer.byteLength(value as string, "utf8") > TOOL_MAX_VALUE_BYTES) throw new RedisRefused("a value larger than a tool server may keep");
    let onlyNew = false;
    let lasts: number | undefined;
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      if (option === "NX" && !onlyNew) onlyNew = true;
      else if ((option === "PX" || option === "EX") && lasts === undefined) {
        const given = options[++i] ?? "";
        if (!/^[1-9]\d*$/.test(given)) throw new RedisRefused("an expiry that is not a positive whole number");
        lasts = Number(given) * (option === "EX" ? 1_000 : 1);
      } else throw new RedisRefused("an option this server does not use");
    }
    if (lasts === undefined || lasts > TOOL_MAX_TTL_MS) throw new RedisRefused("every key of a tool server expires, within a day");
  }

  async eval(script: string, keys: readonly string[], args: ReadonlyArray<string | number>): Promise<unknown> {
    const wanted = this.#scripts.get(script);
    if (wanted === undefined) throw new RedisRefused("a script this server does not know");
    const given = Array.from(keys, (k) => {
      if (typeof k !== "string") throw new RedisRefused("a key that is not text");
      return k;
    });
    if (given.length !== wanted) throw new RedisRefused("a script given the wrong number of keys");
    for (const key of given) this.#own(key);
    return this.#inner.eval(script, given, Array.from(args, word));
  }
}
