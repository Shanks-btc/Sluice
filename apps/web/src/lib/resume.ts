// Payments that were sent and not yet seen settled, kept in this browser so that a refresh in the middle of a live flow can pick them up
// again. The record is only what is needed to ask the facilitator and the chain where the payment stands: the intent's id, the tool, the
// amount, the payer and the nonce. No key, no signature and no tool answer is kept. The chain and the facilitator are the truth: a
// record here never says a payment settled, it only says "look this one up".
export type Inflight = { id: string; tool: string; amount: string; payer: string; nonce: string; createdAt: number };

export const INFLIGHT_KEY = "sluice.inflight.v1";
export const INFLIGHT_MAX = 20;
export const INFLIGHT_MAX_AGE_SECONDS = 24 * 3600;

export type KeyValueStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const ID = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A record read back from storage, checked field by field. Anything that does not fit is dropped, so a changed value cannot make the page do something odd. */
export function parseInflight(value: unknown): Inflight | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID.test(v.id)) return undefined;
  if (typeof v.tool !== "string" || !/^[a-z0-9_]{1,64}$/.test(v.tool)) return undefined;
  if (typeof v.amount !== "string" || !/^\d{1,18}$/.test(v.amount)) return undefined;
  if (typeof v.payer !== "string" || !ADDRESS.test(v.payer)) return undefined;
  if (typeof v.nonce !== "string" || !ID.test(v.nonce)) return undefined;
  if (typeof v.createdAt !== "number" || !Number.isSafeInteger(v.createdAt) || v.createdAt <= 0) return undefined;
  return { id: v.id.toLowerCase(), tool: v.tool, amount: v.amount, payer: v.payer, nonce: v.nonce, createdAt: v.createdAt };
}

/** The records still worth looking up (not older than a day), newest first. A store that cannot be read gives none. */
export function loadInflight(store: KeyValueStore | undefined, nowSeconds: number, payer?: string): Inflight[] {
  if (!store) return [];
  let raw: string | null;
  try {
    raw = store.getItem(INFLIGHT_KEY);
  } catch {
    return [];
  }
  if (!raw || raw.length > 20_000) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Inflight[] = [];
  for (const item of parsed.slice(0, INFLIGHT_MAX)) {
    const rec = parseInflight(item);
    if (!rec) continue;
    if (nowSeconds - rec.createdAt > INFLIGHT_MAX_AGE_SECONDS) continue;
    if (payer && rec.payer.toLowerCase() !== payer.toLowerCase()) continue;
    out.push(rec);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function save(store: KeyValueStore, records: Inflight[]): void {
  try {
    store.setItem(INFLIGHT_KEY, JSON.stringify(records.slice(0, INFLIGHT_MAX)));
  } catch {
    // Storage can be full or blocked. The page works without it.
  }
}

/** Adds a payment that was just sent. The same id is kept once. */
export function addInflight(store: KeyValueStore | undefined, record: Inflight, nowSeconds: number): void {
  if (!store) return;
  // Only the six fields are written, whatever the caller passed: a record that carried a signature or an answer would not keep it.
  const clean = parseInflight(record);
  if (!clean) return;
  const kept = loadInflight(store, nowSeconds).filter((r) => r.id !== clean.id);
  save(store, [clean, ...kept]);
}

/** Forgets a payment once it has been seen settled, or refused for good. */
export function removeInflight(store: KeyValueStore | undefined, id: string, nowSeconds: number): void {
  if (!store) return;
  save(store, loadInflight(store, nowSeconds).filter((r) => r.id !== id.toLowerCase()));
}

/** True when this tool already has an unsettled payment from this payer that is younger than `withinSeconds`: a second press may be a double submission. */
export function looksDuplicate(records: readonly Inflight[], tool: string, payer: string, nowSeconds: number, withinSeconds = 60): boolean {
  return records.some((r) => r.tool === tool && r.payer.toLowerCase() === payer.toLowerCase() && nowSeconds - r.createdAt <= withinSeconds);
}
