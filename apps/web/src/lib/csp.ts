// The Content Security Policy, built per request with a fresh nonce (src/proxy.ts calls this).
//
//  - Scripts: this site's own files and scripts that carry the request's nonce. No 'unsafe-inline', no 'unsafe-eval'
//    in production (React needs eval in development only).
//  - Styles: this site's own files and nonce-tagged tags. The app uses no style attributes.
//  - Network: a page that reads QIE may reach QIE's RPC. Only the demo and the wallet page may reach a facilitator the person
//    types in, which can be any https address or a local one.
//  - Nothing may frame the app, and nothing may load a plug-in.
// QIE publishes five endpoints for each network. The pages read through the first that answers and fall back to the others (src/lib/rpc-endpoints.ts).
export const QIE_RPC_ORIGINS: readonly string[] = ["mainnet", "testnet"].flatMap((net) => [1, 2, 3, 4, 5].map((n) => `https://rpc${n}${net}.qie.digital`));

/** Pages that talk to a facilitator whose address the person chooses. */
export const FACILITATOR_PATHS = ["/demo", "/wallet"] as const;

export type CspInput = { nonce: string; dev?: boolean; path?: string; extraConnect?: readonly string[] };

/** The origin of a configured address (https, or http on this machine), for the connect list. Undefined for anything else. */
export function originOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const url = new URL(text.trim());
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && local) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function allowsAnyFacilitator(path: string | undefined): boolean {
  if (!path) return false;
  return FACILITATOR_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

export function buildCsp({ nonce, dev = false, path, extraConnect = [] }: CspInput): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new Error("the nonce must be at least 16 base64 characters");
  const connect = ["'self'", ...QIE_RPC_ORIGINS, ...extraConnect];
  if (allowsAnyFacilitator(path)) connect.push("https:", "http://localhost:*", "http://127.0.0.1:*");
  if (dev) connect.push("ws://localhost:*", "ws://127.0.0.1:*", "http://localhost:*", "http://127.0.0.1:*");
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-inline'"] : [])]],
    ["img-src", ["'self'"]],
    ["font-src", ["'self'"]],
    ["connect-src", [...new Set(connect)]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["worker-src", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  const parts = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** A nonce: 128 random bits, base64. `random` is injected so a test can pin it. */
export function makeNonce(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
