// Runs before every page request: gives the request a fresh nonce and sets the Content Security Policy (Next.js 16 calls this
// file the proxy). Next.js reads the nonce from the request's CSP header and tags its own scripts with it.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildCsp, makeNonce, originOf } from "./lib/csp";

export function proxy(request: NextRequest) {
  const nonce = makeNonce();
  // The facilitator the deployer set may be reached from every page; one the person types in only from the demo and wallet pages.
  // The RPC the deployer set (a local node, or another provider) is reachable from every page too.
  // The hosted tool server the live demo and the builder's test call pay is reachable from every page too.
  const extra = [originOf(process.env["NEXT_PUBLIC_FACILITATOR_URL"]), originOf(process.env["NEXT_PUBLIC_RPC_URL"]), originOf(process.env["NEXT_PUBLIC_TOOLS_URL"])].filter((o): o is string => o !== undefined);
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === "development", path: request.nextUrl.pathname, extraConnect: extra });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|fonts|brand).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
