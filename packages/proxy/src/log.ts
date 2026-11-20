// The local payment log: one JSON object per line, for every payment the proxy made, refused or failed to complete.
// It never holds a key, a signature or the arguments of a call. It does hold the tool name, the payee, the price and
// the intent's id, which is enough to find the payment on the facilitator and on the chain.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type LogEntry = {
  ts: string;
  event: "paid" | "refused" | "failed";
  tool: string;
  payee?: string;
  /** QUSDC, six decimals. */
  amount?: string;
  /** The intent's EIP-712 digest. */
  id?: string;
  /** The settlement status the server reported, for a paid call. */
  status?: string;
  /** A refusal code or the reason a paid call did not complete. */
  reason?: string;
  detail?: string;
};

export class PaymentLog {
  constructor(private readonly path: string) {}

  append(entry: Omit<LogEntry, "ts">, now: () => Date = () => new Date()): void {
    appendFileSync(this.path, `${JSON.stringify({ ts: now().toISOString(), ...entry })}\n`);
  }

  /** The newest `limit` entries, oldest first. Lines that are not valid JSON are skipped. */
  read(limit = 50): LogEntry[] {
    return readEntries(this.path, limit);
  }
}

export function readEntries(path: string, limit = 50): LogEntry[] {
  if (!existsSync(path)) return [];
  const out: LogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEntry);
    } catch {
      // skip a damaged line
    }
  }
  return out.slice(-limit);
}
