# Deploying the web app

This guide is for the founder to follow. Nothing in this repository deploys the web app, and no step below has been run: the app was built and tested on this machine, against a local chain and a local copy of QIE mainnet. The steps are written from Vercel's documented settings and have not been tried on Vercel.

## What gets deployed

`apps/web` is one Next.js 16 app. Every page is rendered when it is asked for, because the Content Security Policy carries a new nonce on each request (`apps/web/src/proxy.ts`), so it needs a host that runs Node.js, which Vercel does. The facilitator is a separate program (`packages/facilitator`). It is written as a long-running process with a timer, so run it on a host that keeps a process alive, and not as a Vercel function.

## Project settings

| Setting | Value | Why |
| --- | --- | --- |
| Framework preset | Next.js | The app is a Next.js app. |
| Root Directory | `apps/web` | The app lives there. |
| Include source files outside of the Root Directory in the Build Step | Enabled | The build reads `docs/`, `DECISIONS.md`, `packages/`, `examples/` and `src/` from the repository root, so the site renders the repository's own files. |
| Install Command | `pnpm install --frozen-lockfile` | pnpm 11 finds the workspace at the repository root and installs it. |
| Build Command | `pnpm run build` | Runs `apps/web`'s build: it writes `src/generated/content.json` from the repository's documents, copies the fonts, and runs `next build --webpack`. |
| Output Directory | the default (`.next`) | Leave it empty. |
| Node.js version | 24.x | The version the suite was run on. The repository says Node 20 or later. |

Do not set a framework override, and do not turn on static export: the pages and the `/api/risk` route need a server.

## Environment variables

Set them in the Vercel project's settings, for Production and for Preview. The app reads them when the server starts, so changing one needs a redeploy and no rebuild of the code.

**Public.** Every `NEXT_PUBLIC_` value is sent to the browser, so none of them is ever a secret. A test fails the build if one of these names sounds like a secret.

| Name | What it is for | Example |
| --- | --- | --- |
| `NEXT_PUBLIC_ROUTER_ADDRESS` | The deployed router. Without it, `/builder` and `/wallet` say "Contracts not configured". | the address from `scripts/live/deploy.ts` (none exists yet) |
| `NEXT_PUBLIC_VAULT_ADDRESS` | The router's vault. The app checks it against `router.vault()` and refuses a mismatch. | the vault address from the same deployment |
| `NEXT_PUBLIC_CHAIN_ID` | The chain the pages read and send on. Default 1990. | `1990` |
| `NEXT_PUBLIC_RPC_URL` | The RPC the pages read through. Default: QIE's public RPC for the chain id. | `https://rpc1mainnet.qie.digital/` |
| `NEXT_PUBLIC_FACILITATOR_URL` | The facilitator offered to a wallet with no QIE. It must allow this site's origin. | `https://facilitator.example` |
| `NEXT_PUBLIC_FROM_BLOCK` | The block the router was deployed at, where scans for events stop. | the block of the deployment |
| `NEXT_PUBLIC_GITHUB_URL` | The repository, for the footer's GitHub link and for links from the documents to files. Without it, neither link is shown. | `https://github.com/your-name/sluice` |
| `NEXT_PUBLIC_SITE_URL` | Where the site is served, so link previews carry an absolute address. | `https://sluice.example` |

**Server only.** These stay on the server. The browser never receives them.

| Name | What it is for |
| --- | --- |
| `SLUICE_RPC_URL` | The RPC the `/api/risk` route and the evidence counts read through. Default: QIE's public RPC. https only. |
| `SLUICE_EXPLORER_URL` | The explorer the risk check reads for role holders. Default: QIE's public explorer. https only. |
| `SLUICE_FROM_BLOCK` | Where the evidence page starts counting. Falls back to `NEXT_PUBLIC_FROM_BLOCK`. |

**Never set in the web project.** `SLUICE_KEY`, `SLUICE_RELAYER_KEY`, `SLUICE_AGENT_KEY` and `SLUICE_APPROVE` belong to the live scripts and the facilitator, on the machine that runs them. The web app does not read them, and a test fails the build if its code names one.

## The facilitator

Run the facilitator on its own host with the variables in the README, and add this site's origin to `SLUICE_FACILITATOR_CORS_ORIGINS` (for example `https://sluice.example`, no path, no wildcard). Without that, a browser on this site cannot read the facilitator's answers, and the wallet page cannot use it. The facilitator's own limits (gas, gas price, a daily QIE budget, a destination allowlist) are in code and are described in `packages/facilitator/README.md`.

## After the deploy

Work down this list on the deployed address. Items 1 to 5 need no contracts.

1. Open `/` and read the statement at the top. It must be the founder's wording, word for word.
2. Request any page with `curl -I` and check the headers: `content-security-policy` with a `nonce-` value that differs between two requests, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, and a `permissions-policy`. There must be no `unsafe-inline` or `unsafe-eval` in the policy.
3. Open `/evidence`. While `docs/EVIDENCE.md` has no row, both tables say they are empty, and the counts say no router is configured. A zero is not shown.
4. Open `/` and check that no status badge says Live. A badge says Live only when the evidence file holds a verified mainnet row for it.
5. Open `/demo` and run the walkthrough. The banner "Simulated — no real funds, no chain" stays on screen.
6. Send `POST /api/risk` with `{"address": "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5"}` and a JSON content type. Check that a seventh request within a minute from one address is refused with a 429. The limiter keeps its counts in memory, per server instance, so it is a guard against a runaway client and not a hard quota.
7. After the contracts are deployed and the router and vault addresses are set, open `/builder` and `/wallet` with a wallet on QIE and check that the router's `solvency()`, the fee and the balances shown match the explorer.
8. Try every wallet flow once with a small amount on testnet before mainnet. The browser tests used a mock wallet, so no real wallet has run these flows. Whether QIE Wallet can sign a transaction without sending it, which the start with no QIE needs, is not known.
9. Add the verified transactions to `docs/EVIDENCE.md`, run `pnpm evidence:check`, and rebuild, so the proof strip shows them with explorer links.
10. Fill in `docs/FOUNDER-LOG.md` and `docs/founder-wallets.json` before quoting any count from `/evidence`.

## What this guide cannot confirm

That Vercel's current settings match the names above, that the build finds the repository's files outside the Root Directory in your project, and how many requests the in-memory rate limit sees across instances. Check those in the project's settings and the initial deploy's build log.
