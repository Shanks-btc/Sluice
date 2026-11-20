// Structured logs: one JSON object per line, written to a function the caller gives (standard output by default).
//
// What may never appear in a log line:
//   - a private key. A field whose name says key, secret, password, token or mnemonic is replaced, and any literal the caller
//     lists in `secrets` (the relayer's key) is cut out of every string, wherever it turns up;
//   - a full signature or a raw signed transaction. Any 0x value longer than a hash is shortened to its first bytes and its length;
//   - a URL's credentials or query. A URL is reduced to its origin.
// A transaction hash and an address are kept whole: they are public, and they are what an operator searches for.

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export type LoggerOptions = {
  write?: (line: string) => void;
  level?: LogLevel;
  now?: () => number;
  /** Literal values to cut out of every line, such as the relayer's key. */
  secrets?: readonly string[];
  /** Added to every line (for example the service's name). */
  base?: LogFields;
};

const SENSITIVE_NAME = /key|secret|password|passwd|mnemonic|seed|token|authorization|cookie|bearer/i;
/** A hash is 66 characters with its 0x. Anything longer is a signature or a raw transaction. */
const LONG_HEX = /0x[0-9a-fA-F]{67,}/g;
const MAX_STRING = 400;
const MAX_DEPTH = 4;

/** Cuts each literal out of a string. The same key without its 0x prefix, or in another case, is still the key. */
export function cutSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 8) continue;
    const forms = new Set([s, s.toLowerCase(), s.toUpperCase()]);
    if (s.startsWith("0x")) for (const f of [...forms]) forms.add(f.slice(2));
    for (const f of forms) out = out.split(f).join("[redacted]");
  }
  return out;
}

/** Cuts the given literals and shortens long hex values and URLs in one string. */
export function scrubText(text: string, secrets: readonly string[] = []): string {
  let out = cutSecrets(text, secrets);
  out = out.replace(LONG_HEX, (m) => `${m.slice(0, 10)}…(${(m.length - 2) / 2} bytes)`);
  out = out.replace(/\b(https?:\/\/)([^\s/@]+@)?([^\s/?#]+)[^\s]*/gi, (_m, scheme: string, _auth: string | undefined, host: string) => `${scheme}${host}`);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

function scrubValue(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (typeof value === "string") return scrubText(value, secrets);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (value instanceof Error) return scrubText(value.name === "Error" ? "error" : value.name, secrets); // an error's text can hold anything: only its kind is kept
  if (depth >= MAX_DEPTH) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubValue(v, secrets, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_NAME.test(k) ? "[redacted]" : scrubValue(v, secrets, depth + 1);
    }
    return out;
  }
  return String(typeof value);
}

/** The scrubbed form of a set of fields. Exported so a test can hold every field to the same rule. */
export function scrubFields(fields: LogFields, secrets: readonly string[] = []): LogFields {
  return scrubValue(fields, secrets, 0) as LogFields;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const min = ORDER[options.level ?? "info"];
  const now = options.now ?? (() => Date.now());
  const secrets = options.secrets ?? [];
  const base = options.base ?? {};
  const emit = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (ORDER[level] < min) return;
    const line = JSON.stringify({
      t: new Date(now()).toISOString(),
      level,
      msg: scrubText(msg, secrets),
      ...scrubFields({ ...base, ...fields }, secrets),
    });
    // A last pass over the finished line: a secret that slipped through under a field name nobody thought of is still cut out.
    write(cutSecrets(line, secrets));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/** A logger that writes nothing. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
