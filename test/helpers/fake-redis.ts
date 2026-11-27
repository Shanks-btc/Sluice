// A stand-in for Redis, in memory, for the tests: the commands the ledger and the tool server use, and EVAL, which runs the real Lua
// scripts in a Lua engine (fengari) with `redis.call` bound to the same commands. A script runs from start to end with nothing between,
// as in Redis. It is not Redis: it runs Lua 5.3 where Redis runs 5.1, and it knows only what is listed here.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { RedisError } from "@sluice/sdk";
import type { RedisClient } from "@sluice/sdk";
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from "fengari";

export type Reply = null | string | number | Reply[];

type Value =
  | { type: "string"; value: string }
  | { type: "hash"; value: Map<string, string> }
  | { type: "set"; value: Set<string> }
  | { type: "zset"; value: Map<string, number> }
  | { type: "list"; value: string[] };
type Entry = Value & { expiresAt?: number };

const WHOLE = /^-?\d+$/;

export class FakeRedis implements RedisClient {
  private readonly data = new Map<string, Entry>();
  /** Every command and script that reached the database, newest last. */
  readonly log: string[] = [];
  /** While true, every request fails, as when the database cannot be reached. */
  down = false;

  constructor(public now: () => number = () => Date.now()) {}

  private seen?: Set<string>;

  /**
   * A client of this database that notes in `into` every key its requests touch: the keys of each command, and of each command a
   * script calls, whether or not the script was given them. A request runs from start to end before anything else does.
   */
  watched(into: Set<string>): RedisClient {
    const noting = <T>(run: () => T): T => {
      this.seen = into;
      try {
        return run();
      } finally {
        this.seen = undefined;
      }
    };
    return {
      command: (args) => noting(() => this.command(args)),
      eval: (script, keys, args) => noting(() => this.eval(script, keys, args)),
    };
  }

  private entry(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (e && e.expiresAt !== undefined && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private typed<T extends Value["type"]>(key: string, type: T): Extract<Entry, { type: T }> | undefined {
    const e = this.entry(key);
    if (e && e.type !== type) throw new RedisError(`WRONGTYPE: ${key} holds a ${e.type}`);
    return e as Extract<Entry, { type: T }> | undefined;
  }

  private make<T extends Value["type"]>(key: string, type: T, value: Extract<Value, { type: T }>["value"]): Extract<Entry, { type: T }> {
    const found = this.typed(key, type);
    if (found) return found;
    const made = { type, value } as unknown as Extract<Entry, { type: T }>;
    this.data.set(key, made as Entry);
    return made;
  }

  private add(current: string | undefined, by: string): string {
    if ((current !== undefined && !WHOLE.test(current)) || !WHOLE.test(by)) throw new RedisError("ERR value is not an integer");
    return (BigInt(current ?? "0") + BigInt(by)).toString();
  }

  /** One command, applied at once. */
  run(args: string[]): Reply {
    const [name, key, ...rest] = args as [string, string, ...string[]];
    if (this.seen && key !== undefined) for (const k of ["MGET", "DEL", "EXISTS"].includes(name.toUpperCase()) ? [key, ...rest] : [key]) this.seen.add(k);
    switch (name.toUpperCase()) {
      case "PING":
        return "PONG";
      case "GET":
        return this.typed(key, "string")?.value ?? null;
      case "MGET":
        return [key, ...rest].map((k) => this.typed(k, "string")?.value ?? null);
      case "SET": {
        const [value, ...options] = rest as [string, ...string[]];
        let expiresAt: number | undefined;
        let onlyNew = false;
        for (let i = 0; i < options.length; i++) {
          const o = (options[i] as string).toUpperCase();
          if (o === "NX") onlyNew = true;
          else if (o === "PX") expiresAt = this.now() + Number(options[++i]);
          else if (o === "EX") expiresAt = this.now() + Number(options[++i]) * 1000;
          else throw new RedisError(`ERR unknown option ${o}`);
        }
        if (onlyNew && this.entry(key)) return null;
        this.data.set(key, { type: "string", value, ...(expiresAt !== undefined ? { expiresAt } : {}) });
        return "OK";
      }
      case "DEL":
        return [key, ...rest].filter((k) => this.entry(k) !== undefined && this.data.delete(k)).length;
      case "EXISTS":
        return [key, ...rest].filter((k) => this.entry(k) !== undefined).length;
      case "INCR":
      case "INCRBY":
      case "DECRBY": {
        const by = name.toUpperCase() === "INCR" ? "1" : name.toUpperCase() === "DECRBY" ? (-BigInt(rest[0] as string)).toString() : (rest[0] as string);
        const e = this.make(key, "string", "0");
        e.value = this.add(e.value, by);
        return Number(e.value);
      }
      case "EXPIRE":
      case "PEXPIRE": {
        const e = this.entry(key);
        if (!e) return 0;
        e.expiresAt = this.now() + Number(rest[0]) * (name.toUpperCase() === "EXPIRE" ? 1000 : 1);
        return 1;
      }
      case "PTTL": {
        const e = this.entry(key);
        if (!e) return -2;
        return e.expiresAt === undefined ? -1 : e.expiresAt - this.now();
      }
      case "HGET":
        return this.typed(key, "hash")?.value.get(rest[0] as string) ?? null;
      case "HMGET": {
        const h = this.typed(key, "hash")?.value;
        return rest.map((f) => h?.get(f) ?? null);
      }
      case "HSET": {
        const h = this.make(key, "hash", new Map<string, string>()).value;
        let added = 0;
        for (let i = 0; i + 1 < rest.length; i += 2) {
          if (!h.has(rest[i] as string)) added += 1;
          h.set(rest[i] as string, rest[i + 1] as string);
        }
        return added;
      }
      case "HINCRBY": {
        const h = this.make(key, "hash", new Map<string, string>()).value;
        const next = this.add(h.get(rest[0] as string), rest[1] as string);
        h.set(rest[0] as string, next);
        return Number(next);
      }
      case "SADD": {
        const s = this.make(key, "set", new Set<string>()).value;
        const before = s.size;
        for (const m of rest) s.add(m);
        return s.size - before;
      }
      case "SREM": {
        const s = this.typed(key, "set")?.value;
        return rest.filter((m) => s?.delete(m)).length;
      }
      case "SMEMBERS":
        return [...(this.typed(key, "set")?.value ?? [])];
      case "ZADD": {
        const z = this.make(key, "zset", new Map<string, number>()).value;
        const [score, member] = rest as [string, string];
        const isNew = !z.has(member);
        z.set(member, Number(score));
        return isNew ? 1 : 0;
      }
      case "ZREM": {
        const z = this.typed(key, "zset")?.value;
        return rest.filter((m) => z?.delete(m)).length;
      }
      case "ZCARD":
        return this.typed(key, "zset")?.value.size ?? 0;
      case "ZRANGE": {
        const sorted = [...(this.typed(key, "zset")?.value ?? [])].sort(([a, x], [b, y]) => x - y || (a < b ? -1 : a > b ? 1 : 0)).map(([m]) => m);
        const [start, stop] = [Number(rest[0]), Number(rest[1])];
        return sorted.slice(start, stop === -1 ? undefined : stop + 1);
      }
      case "LPUSH": {
        const l = this.make(key, "list", [] as string[]).value;
        for (const v of rest) l.unshift(v);
        return l.length;
      }
      case "LTRIM": {
        const l = this.typed(key, "list");
        if (l) l.value = l.value.slice(Number(rest[0]), Number(rest[1]) + 1);
        return "OK";
      }
      case "LRANGE": {
        const l = this.typed(key, "list")?.value ?? [];
        return l.slice(Number(rest[0]), Number(rest[1]) + 1);
      }
      default:
        throw new RedisError(`ERR the stand-in does not know ${name}`);
    }
  }

  /** A script, run to its end with nothing between. */
  script(source: string, keys: readonly string[], args: readonly string[]): Reply {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    // Redis runs Lua 5.1, where every number is a double. This engine's whole numbers are 32 bits and wrap, so numbers read from text are
    // made doubles, and a reply too large for 32 bits is given as a double.
    lauxlib.luaL_dostring(L, to_luastring("local read = tonumber; tonumber = function(v) local n = read(v); if n == nil then return nil end; return n + 0.0 end"));
    const push = (value: Reply): void => {
      if (value === null) lua.lua_pushboolean(L, false);
      else if (typeof value === "string") lua.lua_pushstring(L, to_luastring(value));
      else if (typeof value === "number") {
        if (Number.isInteger(value) && Math.abs(value) < 2 ** 31) lua.lua_pushinteger(L, value);
        else lua.lua_pushnumber(L, value);
      } else {
        lua.lua_createtable(L, value.length, 0);
        value.forEach((v, i) => {
          push(v);
          lua.lua_rawseti(L, -2, i + 1);
        });
      }
    };
    const text = (i: number): string => {
      if (lua.lua_type(L, i) === lua.LUA_TNUMBER) return String(lua.lua_tonumber(L, i));
      if (lua.lua_type(L, i) !== lua.LUA_TSTRING) throw new RedisError("ERR redis.call takes strings and numbers");
      return to_jsstring(lua.lua_tostring(L, i));
    };
    for (const [name, list] of [["KEYS", keys], ["ARGV", args]] as const) {
      push([...list]);
      lua.lua_setglobal(L, to_luastring(name));
    }
    let failure: Error | undefined;
    lua.lua_createtable(L, 0, 1);
    lua.lua_pushjsfunction(L, () => {
      const given: string[] = [];
      try {
        for (let i = 1; i <= lua.lua_gettop(L); i++) given.push(text(i));
        push(this.run(given));
      } catch (err) {
        failure = err as Error;
        return lauxlib.luaL_error(L, to_luastring("a command failed"));
      }
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring("call"));
    lua.lua_setglobal(L, to_luastring("redis"));
    const read = (index: number): Reply => {
      switch (lua.lua_type(L, index)) {
        case lua.LUA_TSTRING:
          return to_jsstring(lua.lua_tostring(L, index));
        case lua.LUA_TNUMBER:
          return Math.trunc(lua.lua_tonumber(L, index)); // a number leaves a script as a whole number, as in Redis
        case lua.LUA_TBOOLEAN:
          return lua.lua_toboolean(L, index) ? 1 : null;
        case lua.LUA_TTABLE: {
          const at = lua.lua_absindex(L, index);
          const out: Reply[] = [];
          for (let i = 1; ; i++) {
            lua.lua_rawgeti(L, at, i);
            if (lua.lua_type(L, -1) === lua.LUA_TNIL) {
              lua.lua_pop(L, 1);
              return out;
            }
            out.push(read(-1));
            lua.lua_pop(L, 1);
          }
        }
        default:
          return null;
      }
    };
    if (lauxlib.luaL_loadstring(L, to_luastring(source)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      throw failure ?? new RedisError(`ERR script: ${to_jsstring(lua.lua_tostring(L, -1))}`);
    }
    return read(-1);
  }

  async command(args: ReadonlyArray<string | number>): Promise<Reply> {
    if (this.down) throw new RedisError("the database could not be reached");
    this.log.push(String(args[0]));
    return this.run(args.map(String));
  }

  async eval(source: string, keys: readonly string[], args: ReadonlyArray<string | number>): Promise<Reply> {
    if (this.down) throw new RedisError("the database could not be reached");
    this.log.push("EVAL");
    return this.script(source, keys, args.map(String));
  }
}

/** The same database behind a client that waits a moment, chosen by `pause`, before each request: to make copies interleave. */
export function slowed(client: RedisClient, pause: () => Promise<void>): RedisClient {
  return {
    command: async (args) => {
      await pause();
      return client.command(args);
    },
    eval: async (script, keys, args) => {
      await pause();
      return client.eval(script, keys, args);
    },
  };
}

/** The stand-in behind Upstash's REST interface on this machine, so that the real client can be tried against it. */
export async function serveRest(redis: FakeRedis, token: string): Promise<{ url: string; bodies: string[]; close: () => Promise<void> }> {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        if (req.method !== "POST") return reply(405, { error: "method not allowed" });
        if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "unauthorized" });
        const text = Buffer.concat(chunks).toString("utf8");
        bodies.push(text);
        try {
          const args = JSON.parse(text) as string[];
          if (args[0] === "EVAL") {
            const count = Number(args[2]);
            return reply(200, { result: await redis.eval(args[1] as string, args.slice(3, 3 + count), args.slice(3 + count)) });
          }
          return reply(200, { result: await redis.command(args) });
        } catch (err) {
          return reply(400, { error: (err as Error).message });
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
