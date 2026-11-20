// Next.js settings for the Sluice web app. The Content Security Policy is set per request in src/proxy.ts (it needs a
// nonce); the headers below are the ones that do not change from one request to the next.
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // The workspace packages are TypeScript source; the app imports them by deep path (see tsconfig paths).
  transpilePackages: ["@sluice/sdk", "@sluice/paid-tools"],
  experimental: { externalDir: true },
  outputFileTracingRoot: root,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};
export default config;
