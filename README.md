# Sluice

<p align="center"><img src="design/screenshots/sluice-landing.png" alt="The Sluice landing page" width="100%"></p>

Payment middleware that lets MCP builders get paid, with an MCP-compatible wallet so AI agents can pay for the tools and services they use. Agents pay per request on QIE using HTTP 402-style payments, in QUSDC, with no manual subscriptions or API keys. This repository holds an SDK for MCP servers, a facilitator, a payment proxy and a wallet MCP for agents, the contracts behind them, a web app, a written spec, and the tooling that checks every public claim against the chain. It has been tested on a local copy of QIE mainnet. It has not been deployed to any QIE network, and [the evidence file](docs/EVIDENCE.md) is empty because of that.

## Contents

- [The problem](#the-problem)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [The pay flow](#the-pay-flow)
- [For MCP builders](#for-mcp-builders)
- [For agents](#for-agents)
- [The example paid tools](#the-example-paid-tools)
- [Web app](#web-app)
- [What the owner can and cannot do](#what-the-owner-can-and-cannot-do)
- [What QIE provides](#what-qie-provides)
- [How this differs](#how-this-differs)
- [Current status](#current-status)
- [Evidence](#evidence)
- [Safety and tests](#safety-and-tests)
- [Quick start](#quick-start)
- [Going live](#going-live)
- [Environment variables](#environment-variables)
- [Repository layout](#repository-layout)
- [Built for the QIE Hackathon](#built-for-the-qie-hackathon)
- [License](#license)

## The problem

An AI agent that needs a tool at run time has no good way to pay for it, and an MCP builder has no good way to charge.

- A monthly plan and an API key need a human to sign up first.
- A card payment has minimums and fees that make a price of a fraction of a cent impossible.
- One on-chain transfer per call means a wallet signature and a transaction for every call.
- An agent holding a wallet key with no limit can spend everything it can reach.
- The MCP specification has no payment step, so each builder has to invent one.
- The usual x402 payment on an EVM chain needs a token that supports EIP-3009 or Permit2. QUSDC supports neither, and QIE has no Permit2 contract. [docs/SPEC.md](docs/SPEC.md) explains the scheme Sluice uses instead.

## What it does

A builder puts a price on an MCP tool. An agent's call without payment is answered with the price, in the x402-over-MCP message format. The agent's payment proxy checks the price against a budget the owner set, signs an intent, and retries. The builder's server verifies it, runs the tool and queues the payment. A facilitator settles many payments in one transaction.

| Principle | What it means |
| --- | --- |
| Per-call prices | A tool has a price in QUSDC and a payee. A call without payment gets the price and nothing else. |
| Prepaid | The payer deposits QUSDC into the router once. The balance belongs to the payer until a signed call spends it, and the payer can take back the unspent part at any time. |
| Signed intents | A payment is an EIP-712 message with payer, payee, amount, tool, nonce and deadline. It is bound to the chain and the contract, it expires, and it works once. |
| Idempotent | The same intent never charges twice or runs a tool twice. A tool that fails is not charged. |
| Anyone can settle | The signature authorises the payment, not the person who submits it. A facilitator pays the gas for a batch. |
| Capped fee | The fee comes out of the builder's side and can never be set above 2%. The payer always pays exactly the signed amount. |
| Limits for agents | The owner gives an agent key a budget, a cap per call, an expiry and a list of allowed tools. The proxy refuses early, and the AgentVault enforces the same limits on chain. An agent cannot raise its own budget. |
| No admin over funds | The owner can change the fee (within the cap) and the fee recipient, and nothing else. There is no proxy contract and no pause. |
| Start without QIE | A wallet that holds QUSDC and no QIE can deposit and authorise an agent by signing. The facilitator sends the gas. |
| Leave without QIE | A builder or payer with no QIE can withdraw or refund by signing a request that a relayer submits. |

## How it works

An agent reaches a paid tool through its proxy. The server answers with a price, the proxy signs inside the owner's budget, and the payment is settled in a batch. Money sits in the router and moves between two numbers inside it. QUSDC leaves only when a builder withdraws or a payer refunds.

```mermaid
flowchart LR
  A["AI agent"] -->|"MCP call"| X["Payment proxy"]
  X -->|"call, then retry with a signed intent"| S["Paid MCP server with the SDK"]
  S -->|"verify, then settle"| F["Facilitator"]
  F -->|"settle or batchSettle"| R["PaymentRouter"]
  O["Owner"] -->|"deposit QUSDC, authorize the agent"| R
  R --- V["AgentVault: session policy"]
  R -->|"price minus fee"| B["Builder earnings"]
  B -->|"withdraw or withdrawBySig"| BW["Builder wallet"]
  R -->|"refund or refundBySig"| O
```

A call made by an agent key is checked against the owner's policy inside the same transaction that settles it.

```mermaid
sequenceDiagram
  participant Owner
  participant Agent as Agent and proxy
  participant Srv as Paid MCP server
  participant Fac as Facilitator
  participant Router as PaymentRouter
  participant Vault as AgentVault
  Owner->>Vault: authorize(agent, budget, per-call cap, expiry, tools)
  Agent->>Srv: tools/call
  Srv-->>Agent: payment required with price, payee and router
  Agent->>Srv: tools/call with a signed intent in _meta
  Srv->>Fac: verify the intent
  Fac->>Router: read balance and nonce
  Srv->>Fac: settle, queued after the tool runs
  Fac->>Router: batchSettle(intents)
  Router->>Vault: consume(payer, agent, payee, tool, amount)
  Vault-->>Router: allowed, or the reason it is refused
  Router-->>Fac: Settled event
```

## Architecture

| Part | Path | What it does |
| --- | --- | --- |
| Public spec | `docs/SPEC.md`, `docs/spec-vectors.json` | The Sluice payment scheme for MCP on QIE, written to be implemented by someone else, with test vectors from throwaway keys. |
| SDK | `packages/sdk/src/paid-tool.ts`, `packages/sdk/src/protocol.ts`, `packages/sdk/src/x402.ts` | `paidTool` middleware, the EIP-712 intent and its checks, and the x402-over-MCP messages. |
| SDK client side | `packages/sdk/src/facilitator-client.ts`, `packages/sdk/src/onboarding.ts`, `packages/sdk/src/authorize.ts` | The facilitator's HTTP client, and signing for the start with no QIE and for agent sessions. |
| Facilitator | `packages/facilitator/src/service.ts`, `packages/facilitator/src/server.ts` | The verify, settle, status, onboard and relay endpoints, queueing, and `batchSettle` with `SettleSkipped` handling. |
| Relayer and caps | `packages/facilitator/src/relayer.ts`, `packages/facilitator/src/caps.ts` | The one hot key behind hard limits in code: gas, gas price, a daily QIE budget, a destination allowlist and per-day limits. |
| Payment proxy | `packages/proxy/src/proxy.ts`, `packages/proxy/src/policy.ts` | A stdio MCP proxy that pays inside the owner's budget, refuses the rest, and logs every payment locally. |
| Wallet MCP | `packages/wallet-mcp/src/server.ts`, `packages/wallet-mcp/src/chain.ts` | Five tools for an agent: balance, deposit instructions, price check, pay history and budget status. It cannot sign or change a budget. |
| Example paid tools | `examples/paid-tools/src/server.ts`, `examples/paid-tools/src/tokenRisk.ts`, `examples/paid-tools/src/dexQuote.ts`, `examples/paid-tools/src/contractLookup.ts` | A token risk check, a QIEDEX quote with slippage and a verified-contract lookup, from read-only data on the chain. |
| Web app | `apps/web/src/app/page.tsx`, `apps/web/src/app/demo/page.tsx`, `apps/web/src/app/builder/page.tsx`, `apps/web/src/app/wallet/page.tsx`, `apps/web/src/app/docs/[slug]/page.tsx`, `apps/web/src/app/evidence/page.tsx` | The landing page, the simulated demo, the builder dashboard, the payer and agent budget screen, the documents and the evidence, in one Next.js app. |
| Web app logic | `apps/web/src/lib/flows.ts`, `apps/web/src/lib/reads.ts`, `apps/web/src/lib/simulation.ts`, `apps/web/src/lib/csp.ts`, `apps/web/src/status.ts` | The review-then-confirm flows, the read paths, the simulated walkthrough, the Content Security Policy, and the status badges held to the evidence file. |
| Web app tests | `test/unit/web`, `test/fork/web.fork.test.ts`, `scripts/web-e2e.ts`, `scripts/mutation-web.ts` | Unit and component tests, the honesty guards, a fork test with the real QUSDC, a browser run on a local chain, and a mutation check. |
| PaymentRouter | `contracts/PaymentRouter.sol` | The ledger: deposit, settle, batch settle, withdraw, refund, fee, and the signed versions of withdraw and refund. |
| AgentVault | `contracts/AgentVault.sol` | Session keys: budget, per-call cap, expiry, allowed tools, revoke. Created by the router, spendable only by the router. |
| EIP-712 base | `contracts/base/Eip712.sol` | The domain separator, bound to the chain id and the contract address. |
| Signature checks | `contracts/libraries/SignatureLib.sol` | Recovers a signer and refuses malleable signatures. |
| Safe transfers | `contracts/libraries/SafeTransfer.sol` | Token calls that fail loudly. |
| Errors and token interface | `contracts/interfaces/ISluiceErrors.sol`, `contracts/interfaces/IERC20.sol` | Shared error names and the minimal token interface. |
| Test contracts | `contracts/test/MockQUSDC.sol`, `contracts/test/FeeOnTransferToken.sol`, `contracts/test/ReentrantToken.sol`, `contracts/test/RoleToken.sol`, `contracts/test/SlotProxy.sol`, `contracts/test/MockDex.sol` | Used by the tests only. Never deployed. |
| Evidence checker | `src/evidence.ts`, `src/events.ts`, `scripts/evidence-check.ts` | Reads `docs/EVIDENCE.md` and checks every row against QIE's public RPC with read-only calls. |
| Paid-call summary | `src/summary.ts`, `scripts/evidence-summary.ts`, `docs/founder-wallets.json` | Counts paid calls from `Settled` events, leaves out the founder's wallets from a versioned list, and prints distinct payers and builders. |
| Mutation check | `src/mutation.ts`, `scripts/mutation-check.ts` | Changes one condition at a time in the verification, budget and cap code and checks that a test notices. |
| Spend guard | `src/guard.ts` | Refuses to run a live script without approval and a spending cap. |
| Live scripts | `scripts/live/deploy.ts`, `scripts/live/smoke.ts`, `src/live.ts` | Deploy and a small round trip. Written for the founder to run. Not run against any QIE network. |
| Gas report | `src/gas.ts`, `docs/GAS.md` | Measured gas and cost, generated from the fork tests. |
| Tests | `test/unit`, `test/fork`, `test/helpers` | Unit and end-to-end tests on a local chain, and fork tests against QIE mainnet's QUSDC and QIEDEX. |

## The pay flow

1. **Fund.** QUSDC has no permit function, so the owner sends two transactions: `approve` on QUSDC, then `deposit` on the router. An owner with QUSDC and no QIE signs both and the facilitator sends them, topping up exactly the gas they can use.
2. **Authorise an agent.** The owner authorises the agent's session key on the vault with a budget, a cap per call, an expiry and the tools it may pay for. An owner with no QIE signs this and a relayer submits it.
3. **Price a tool.** A builder registers a tool with `paidTool` or `registerPaidTool`, with a price in QUSDC and a payee.
4. **Ask.** The agent calls the tool. The server answers with the price, the payee and the router as an MCP error result.
5. **Sign.** The agent's proxy checks the price against the owner's budget, signs an EIP-712 intent with the session key, and retries the call with the payment in `params._meta`.
6. **Verify, run, settle.** The server checks the intent, asks the facilitator about the payer's balance, the nonce and the session, runs the tool and queues the payment. The facilitator submits queued intents with `batchSettle`; an intent that cannot settle is skipped and reported, and the rest settle.
7. **Split and leave.** The payer's balance goes down by the amount and the builder's earnings go up by the amount minus the fee, which is credited to the fee recipient. Settling moves no QUSDC. The builder withdraws, and the payer refunds what is unspent, each with or without QIE.

## For MCP builders

Add `@sluice/sdk` to an MCP server and register a tool through the paywall.

```ts
import { createPaywall } from "@sluice/sdk";

const paywall = createPaywall({ facilitator: "https://your-facilitator.example", router: "0x..." });
await paywall.registerPaidTool(
  server,
  { name: "summarise", price: "0.01", payee: "0xYourAddress", inputSchema: { url: z.string().url() } },
  async ({ url }) => ({ content: [{ type: "text", text: "..." }] }),
);
```

A call without payment gets the price. A call with a valid payment runs the tool and queues the payment, and the result carries the settlement in `_meta["x402/payment-response"]`. A `payee` is an address; a `.qie` name needs a resolver you supply, because no documented on-chain read for QIE ID names was found. See [packages/sdk/README.md](packages/sdk/README.md), and [packages/facilitator/README.md](packages/facilitator/README.md) for the service the server talks to.

## For agents

An agent runs two programs beside its client. The payment proxy sits in front of a paid server and pays inside the owner's budget. The wallet MCP lets the agent read its balance, its budget and its history, check a price, and tell its owner how to fund it.

- The owner deposits QUSDC and authorises the agent's session key on the vault, which sets the budget on chain.
- The proxy and the wallet MCP read one config file: the upstream server, the owner's address, the router, and the same budget in QUSDC. The file holds no key; the session key comes from an environment variable.
- The proxy refuses an unlisted tool, an unnamed payee, a price above the per-call cap, a purchase that would pass the total cap, and any payment after the expiry. It logs every payment, refusal and failure to a local file.
- Neither program holds an owner key. Both refuse to start with the owner's address as the session key.

[packages/proxy/README.md](packages/proxy/README.md) has the config and the static configuration for Claude Code and Cursor. Those two configurations were written from the clients' documented formats and were **not** run in either client. [packages/wallet-mcp/README.md](packages/wallet-mcp/README.md) lists the five tools.

## The example paid tools

[examples/paid-tools](examples/paid-tools/README.md) has three tools for QIE developers, each with a price and real output from read-only data.

| Tool | Price | What it returns |
| --- | --- | --- |
| `token_risk_check` | 0.010000 QUSDC | Whether a token is an upgradeable proxy, who owns it, its roles and holders, which burn, mint and pause functions it has, and who can call burn and mint now. |
| `dex_quote` | 0.002000 QUSDC | A QIEDEX quote for a given size with price impact, a slippage floor and a check against QIEDEX's own router. |
| `contract_lookup` | 0.005000 QUSDC | Whether a contract is verified on the explorer, its compiler, whether it is a proxy, and whether the explorer's bytecode matches the code on the chain. |

On the real QUSDC the risk check reports the finding in [docs/RISKS.md](docs/RISKS.md) from chain data alone: the `VAULT_ROLE` contract can burn a holder's balance, and the admin account can grant that role to itself. `test/fork/tools.fork.test.ts` checks it on a fork.

## Web app

[apps/web](apps/web) is a Next.js 16 app that shows what exists and lets a person use the contracts from a wallet. It follows the design system of the founder's other projects (the fonts, the type scale, the pill buttons, the footer's structure), written again from scratch, with its colours in one file, `apps/web/src/design/tokens.css`, in a light and a dark theme. The light palette was sampled from the reference screenshot `design/reference/palette-promptiq.png`, and only its colours were used. [design/PALETTE.md](design/PALETTE.md) lists every sampled value with the pixels it came from, the final colours for both themes, and each value that was adjusted to meet WCAG AA, with the contrast ratios before and after.

| Page | What it does |
| --- | --- |
| `/` | The idea, word for word, three steps from a priced tool to a settled payment, a proof strip, the mechanism, the safety model, how this differs, the risks including QUSDC's admin, and a status badge for the contracts, the facilitator, the proxy and the wallet MCP. |
| `/demo` | A simulated walkthrough with a banner that says "Simulated — no real funds, no chain"; a panel that reads a facilitator's health and status at an address you paste; and a read-only risk check for a token, with QUSDC as the default. |
| `/builder` | Earnings, the latest settlements and the fee in effect, read from the router, a withdrawal that is reviewed before the wallet opens, and the SDK call that puts a price on a tool. |
| `/wallet` | A wallet's QUSDC, its prepaid balance and its agent keys with their limits, and the flows to deposit, refund, authorise an agent key and revoke it. |
| `/docs` | The spec, the risks, the gas report, the decisions and the package documents, rendered from the repository's files when the site is built, and a page on connecting a real MCP client. |
| `/evidence` | The rows of `docs/EVIDENCE.md` with explorer links and the command that re-checks them, and the paid-call counts that `pnpm evidence:summary` prints. |

**What it shows and what it will not.** The proof strip lists a transaction only if `docs/EVIDENCE.md` has a row for it, with a link to the QIE explorer. With no mainnet row it says so, and it may show a sample from a local fork, labelled "Sample from a local fork — not mainnet", with no link. No page shows a number that did not come from the chain or the evidence file, and a status badge says Live only when the evidence file holds a verified mainnet row for every event the component rests on. A test fails the build if any of this stops being true.

**Simulated and real.** The demo's walkthrough runs entirely in the browser, on the messages in `docs/spec-vectors.json` (signed by throwaway keys that were discarded), and runs the SDK's own checks on them. It uses no chain and no funds. The facilitator panel is a real connection: it reads `/health` and `/status` from the address you paste, over https or on your own machine, and sends nothing. The network you are checking starts on "Local" and is never set to mainnet for you. The builder and wallet pages read the router through an RPC and send through your wallet, and only after a review step that lists what the wallet will be asked to approve; a wallet that holds no QIE is offered the facilitator route, in which the wallet signs and a facilitator pays the gas.

**Settings.** Names only are kept in `.env.example`; these are the values the app reads, with examples. Every `NEXT_PUBLIC_` value reaches the browser, so none is a secret. The pages read them when the server starts, so the same build can be pointed at another router.

| Name | What it is | Example |
| --- | --- | --- |
| `NEXT_PUBLIC_ROUTER_ADDRESS`, `NEXT_PUBLIC_VAULT_ADDRESS` | The deployed router and its vault. Without both, the builder and wallet pages say "Contracts not configured". | an address; none is deployed yet |
| `NEXT_PUBLIC_CHAIN_ID` | The chain the pages read and send on. | `1990` |
| `NEXT_PUBLIC_RPC_URL` | The RPC the pages read through. A local address makes the app call the network local, with no real funds. | `http://127.0.0.1:8545` |
| `NEXT_PUBLIC_FACILITATOR_URL` | The facilitator offered to a wallet with no QIE. It must name this site's origin in `SLUICE_FACILITATOR_CORS_ORIGINS`. | `https://facilitator.example` |
| `NEXT_PUBLIC_FROM_BLOCK` | The block the router was deployed at. | `0` on a local chain |
| `NEXT_PUBLIC_GITHUB_URL` | The project's repository. The footer and the documents link to it only when it is set. | `https://github.com/your-name/sluice` |
| `NEXT_PUBLIC_SITE_URL` | Where the site is served, for link previews. | `https://sluice.example` |

**Run it.** After `pnpm install` and `pnpm build`, `pnpm web:build` writes `apps/web/src/generated/content.json` from the repository's documents, copies the fonts and builds the app; `pnpm web:start` serves it, and `pnpm web:dev` runs it for development. [docs/DEPLOY-WEB.md](docs/DEPLOY-WEB.md) lists the steps for putting it on Vercel, which this repository does not do.

**Tested.** `test/unit/web` holds the unit and component tests, the contrast test (every text and background pair in both themes), the claims and secrets scans, and the wallet flows against a mocked wallet on a local chain with the real contracts and a facilitator. `test/fork/web.fork.test.ts` runs the read paths, a deposit and a withdrawal against the real QUSDC on the fork. `pnpm web:e2e` drives the built app in Edge on a local chain: every page at 390 and 1440 pixels, the empty states, the demo, the theme, the headers, and the wallet flows. `pnpm mutation:web` changes one condition at a time in the web logic. `pnpm web:shots` writes the screenshots in `design/screenshots/slice3`. No real wallet (QIE Wallet or MetaMask) was used: the browser tests use a mock wallet that signs with throwaway keys. Whether a real wallet can sign a transaction without sending it, which the start with no QIE needs, is unknown; the app says so and sends nothing if the wallet cannot.

## What the owner can and cannot do

| | Power | How it is limited |
| --- | --- | --- |
| Can | Change the fee | Never above 200 basis points (2%), and only for later settlements. |
| Can | Change who is credited the fee | Fees already credited stay with their holder. |
| Cannot | Move, freeze or take a payer's balance or a builder's earnings | No function does it. |
| Cannot | Pause, upgrade or replace the contracts | No proxy, no pause, no `delegatecall`, no `selfdestruct`. A test reads the bytecode. |
| Cannot | Change the token, the vault or the owner | They are fixed at deployment. |
| Cannot | Spend an agent's session | Only the router can. |

One power sits outside Sluice. QUSDC's own admin can give itself the right to burn the QUSDC held by any account, including the router's. [docs/RISKS.md](docs/RISKS.md) shows how this was measured and what it means. Keep prepaid balances small and withdraw to your own wallet often.

## What QIE provides

| Piece | How Sluice uses it | State |
| --- | --- | --- |
| QUSDC | The token that is deposited, settled and withdrawn. Token `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5`, 6 decimals, no permit. | Used in the fork tests. |
| QIE mainnet (chain 1990) | Where the contracts are meant to run. Shanghai EVM level. | Read-only queries only. Nothing deployed. |
| QIEDEX | The example `dex_quote` tool reads its pool and router. | Read in the fork tests. |
| Relayers | The facilitator is a relayer: it submits signed requests and pays the gas, inside caps. | Built and tested on a fork. No relayer is running. |
| QIE ID names | A `.qie` payee would show a name instead of an address. | Not used. No documented on-chain read was found, so names are not resolved. |
| QIE Wallet | The official QIE Wallet MCP is read-only and does not sign. Sluice's wallet MCP is a separate program. | Not integrated. |

## How this differs

This section uses only what [docs/PREBUILD-VERIFICATION.md](docs/PREBUILD-VERIFICATION.md) shows, read from the chain, the explorer and GitHub on 2026-11-19. Where that file shows nothing, this section says unknown. Per-call prices, prepaid balances and spending caps are shared ideas: others on QIE and in x402 have parts of them.

| Other work | What the pre-build check shows | How Sluice differs | Unknown |
| --- | --- | --- | --- |
| PayEndpoint suite on QIE mainnet (AgentRegistry, MandateVault, PayEndpoint, SettlementRouter and others) | Deployed 2026-09-16 and verified. Its own comments say price-per-call, pre-funded mandates, per-call and daily caps, and "the on-chain settlement leg of the x402-style HTTP flow". Usage seen: a one-day smoke test (PayEndpoint 8 transactions on 2026-09-17). | The check read contracts and comments. Sluice adds the parts around a contract: an SDK for MCP servers, a facilitator, a payment proxy, a wallet MCP, a written spec and tests against the real QUSDC. | Whether that suite has an SDK, a facilitator or an MCP layer. Not checked. |
| Meter402Policy and TurnpikeAllowance | Meter402Policy was deployed 2026-11-19 with 14 transactions, 12 of them QUSDC transfers. TurnpikeAllowance (setPolicy, revokeAgent, deposit, withdraw) followed hours later. | The check shows contract activity only. Sluice's contracts and packages are described above. | How either contract settles, and anything off-chain. Not read. |
| Semilla1 Guard | 5 transactions on QIE mainnet. Its README says it is a port of a NEAR project. | Sluice is written from scratch and says so in AGENTS.md. | What its guard enforces. Not read. |
| Leash (`arvindcr4/leash-qie`) | A spending vault with caps, expiry, allowlist and revoke, MIT licence, 2026-08-03. | The session limits overlap with Leash's: budget, per-call cap, expiry, allowed tools and revoke. Sluice adds the signed-intent payment, the batch settlement and the MCP packages. | Whether Leash has an MCP layer. Not checked. |
| QIE AgentPay | A read-only Telegram bot so far. | Sluice's wallet MCP and proxy are MCP programs. | Its plans. |
| QIE Wallet MCP (official) | Read-only, six tools, no sign-in, "does not sign or send transactions". | Sluice's proxy pays with a session key inside a budget. Sluice's wallet MCP has no signing tool either. | Whether QIE will add payment tooling. QIE has announced none. |
| x402 `batch-settlement` and `exact` | `batch-settlement` is a scheme seen in Coinbase's Bazaar with 312 accepts entries. None of the 49 networks listed there is QIE. x402's published contracts cannot run on QIE: QUSDC has no permit or EIP-3009 and QIE has no Permit2. | Sluice's scheme, `sluice-intent`, is an independent scheme, not an official x402 one. It uses a prepaid balance in a router and a signed intent, and it batches settlement. It follows the x402 MCP message format. | How `batch-settlement` works inside. Not examined. |
| Vercel `x402-mcp` and Cloudflare Agents SDK `paidTool` | A USD price per call, on Base. Adoption numbers: could not be checked. | Sluice's `paidTool` prices in QUSDC on QIE and uses the same wire shape. | Their usage. |

## Current status

| Surface | Status | Evidence |
| --- | --- | --- |
| PaymentRouter: deposit, settle, batch settle, withdraw, refund, fee | Tested on a fork | `test/fork/qusdc.fork.test.ts` |
| Withdraw and refund by signature, with no QIE | Tested on a fork | `test/fork/qusdc.fork.test.ts` |
| AgentVault: session keys and revoke | Tested on a fork | `test/fork/qusdc.fork.test.ts` |
| paidTool middleware in the SDK | Tested on a fork | `test/fork/mcp.fork.test.ts` |
| Facilitator: verify, settle and status | Tested on a fork | `test/fork/mcp.fork.test.ts` |
| Start with QUSDC and no QIE | Tested on a fork | `test/fork/mcp.fork.test.ts` |
| Relayed withdrawal and agent authorisation | Tested on a fork | `test/fork/mcp.fork.test.ts` |
| Payment proxy: paying a paid server inside the owner's budget | Tested on a fork | `test/fork/mcp.fork.test.ts` |
| Wallet MCP for agents | Tested on a fork | `test/fork/mcp.fork.test.ts` |
| Example paid tools | Tested on a fork | `test/fork/tools.fork.test.ts` |
| Paid-call summary with founder wallets left out | Tested on a fork | `test/fork/mcp.fork.test.ts` |
| Evidence checker | Tested on a fork | `test/fork/live.fork.test.ts` |
| Deploy and smoke scripts (never run on QIE) | Tested on a fork | `test/fork/live.fork.test.ts` |
| Use from Claude Code and Cursor | Coming soon | — |
| Deployment to QIE testnet | Coming soon | — |
| Deployment to QIE mainnet | Coming soon | — |
| Web app: builder and payer read paths, deposit, withdraw and agent keys, with the real QUSDC | Tested on a fork | `test/fork/web.fork.test.ts` |
| Web app: deployment to a host | Coming soon | — |
| QIE ID names | Coming soon | — |

A surface is marked Live only when `docs/EVIDENCE.md` holds a verified mainnet row for it. None does, so no surface is marked Live. "Tested on a fork" means a test ran it against a local copy of QIE mainnet. The proxy's and the wallet MCP's own programs were also run as separate processes on a local chain, and no real MCP client such as Claude Code or Cursor was used.

## Evidence

`docs/EVIDENCE.md` is the list of real transactions that back a public claim, with the date, event, transaction hash, block, contract, amount and address for each, and the network, the kind of claim and the command that checks it again. `pnpm evidence:record` writes every row: it reads the transaction back from QIE's public RPC (rpc1 to rpc5, in turn) with read-only calls, checks that it succeeded and shows what the claim says (a deploy, a verify-link, a deposit, a withdraw, a settle-batch, a paid-call-settlement or a relayed-start), and writes nothing if it does not. Each row names its network and must sit in that network's table, so a row from a test run on a fork, or from the testnet, cannot be read as mainnet proof.

`pnpm evidence:check` reads every row back from the chain again and fails if a transaction is missing or failed, is on a different contract, no longer shows what its claim says, or differs in event, block, date, amount or address. The explorer is asked only for a verify-link row. If the RPC cannot be reached the row is reported as skipped, never as passed.

`pnpm evidence:summary` counts paid calls from the router's `Settled` events and prints the distinct payers and builders behind them, and the recorded rows by claim type. It leaves out any payment where a wallet on the published, versioned list [docs/founder-wallets.json](docs/founder-wallets.json) is the payer, the payee or the signer, and a test pins that filter. The list is empty until the founder fills it in.

Verified rows in docs/EVIDENCE.md: mainnet 0, testnet 0.

A test keeps this section, the status table and the evidence file in agreement.

## Safety and tests

`pnpm test` runs **1285** tests on a local chain. `pnpm test:fork` runs **48** tests against a fork of QIE mainnet with the real QUSDC and the real QIEDEX pool. A test counts them without running them and fails if these numbers are out of date.

What they cover:

- Every function and every revert in the router and the vault.
- Replay, wrong chain or contract, expired intents, over-budget and over-cap agents, tampered prices, signature malleability, the fee cap, rounding, and reentrancy through a hostile token.
- The scheme: every check a verifier makes, the idempotency of `paidTool` (the same intent never charges twice or runs a tool twice), and a client written only from [docs/SPEC.md](docs/SPEC.md) completing a paid call against the SDK.
- The spec's test vectors, with every hash recomputed by hand and compared with what the compiled contracts compute.
- The facilitator: verify, settle and `SettleSkipped`, double settlement, the daily limits, and each hard cap on the relayer (destination, gas, gas price, daily budget, top-up, half-budget alert).
- The start with no QIE on the fork with the real QUSDC, and relayed exits and agent sessions.
- The proxy and the wallet MCP, in process and as separate processes: budget, refusals, concurrency against the total cap, the owner's key refused, and the session key kept from the upstream process.
- End to end on a local chain: an agent, the proxy, the example paid tools, the facilitator and the router, with an owner who holds QUSDC and no QIE.
- Property tests: random sequences of every operation against a shadow ledger, checking that tokens held equal what is owed, that the fee never exceeds 2% of an amount, and that a payer is debited exactly the amount.
- What the contracts do not have: a test reads the compiled code and fails on `delegatecall`, `selfdestruct`, contract creation or any opcode QIE does not support.
- The README itself: its test counts, its commands and paths, its claims, and that nothing is marked Live without a verified evidence row.
- The web app's colours: every text and background pair in the light theme, the dark theme and the system dark setting at WCAG AA (4.5:1 for text, 3:1 for the edges of controls), and no colour literal outside the tokens file.
- The web app's honesty: every word a visitor can read is scanned for banned claims, a Live status without a verified evidence row, an invented number, a testimonial or a claim about what the founder did; the idea's wording is held to the README's, word for word; and nothing in the app can hold a private key or a seed phrase, or names a server-only secret.
- The web app's flows, with a mocked wallet on a local chain with the real contracts and a facilitator: connect, a wrong network, a rejected signature, a wallet with no QIE, cancel, and confirm-then-send, and what a wallet returns is checked before it is used. The risk route's input checks, limits and timeouts, the evidence counts, and every document in the repository rendered.
- The facilitator's queue across a stop: the journal's rules (a half-written last line, a damaged line, a full disk, a second process), and a stop at each point of a batch's life, including a real SIGKILL of the facilitator as its own process behind a node that drops messages on purpose, after which every intent settles once and none is lost.
- The facilitator's operation: the kill switch, the caps on its own QIE, the low-balance flag, the limits on callers, logs that hold no key or signature, the settings that refuse to start, an orderly stop, and a time limit on every request to the node.
- The hosted tool server: its settings and refusals, telling a paid call from an unpaid one, the limits on callers, and a proxy, an HTTP tool server and a facilitator run as three separate processes, on a local chain and on a fork with the real QUSDC.
- The go-live tooling: the pre-flight check, the dry run (no transaction is sent, which a count of the methods that reached the node shows), the contract verification against a stand-in for the explorer, the testnet token that refuses mainnet, and the key maker.
- The evidence recorder: a genuine deposit, withdrawal, batch, paid call, zero-QIE start and deployment are accepted; a wrong event, a failed transaction, a wrong network, a duplicate, a payer settling their own payment and a start that was not from zero QIE are refused and write nothing; a row from a fork or the testnet cannot be read as mainnet proof; and founder wallets are left out of the distinct counts.
- The real-client kit and the two "try it" pages: the scripted client through the proxy, the tool server and the facilitator, and the pages' own code and commands, run as written.
- The go-live documents: every command is a real script, every setting named is declared, every number matches the code, every link goes somewhere, and the claims scanner finds nothing.

`pnpm mutation:web` changes one condition at a time in the web app's logic, 25 changes in all, in the status badges, amount parsing, the network check, the confirm gate, the checks on what a wallet returns, input validation, the Content Security Policy, the rate limiter, the Markdown renderer and the contrast maths. Run it on a copy for the same reason.

`pnpm mutation:live` changes one condition at a time in the go-live code, 30 changes in all, in the facilitator's journal and its recovery, its kill switch, caps and limits, its settings, and the evidence recorder and file. Run it on a copy for the same reason.

`pnpm mutation:check` changes one condition at a time in the verification, budget and cap code, 52 changes in all, and reports whether a test failed for each. It edits files in place and puts them back, so run it on a copy.

No outside security review has been done. The contracts cannot be changed after deployment. Read [docs/RISKS.md](docs/RISKS.md) before putting money in. Measured gas and cost are in [docs/GAS.md](docs/GAS.md). What could not be tested is listed in [docs/RISKS.md](docs/RISKS.md): real MCP clients, any QIE network, and the real behaviour of a public relayer.

## Quick start

Needs Node 20 or later and pnpm 11. Hardhat 2.17 prints a warning on the newest Node versions; the suite was run on Node 24 and passed.

```bash
pnpm install
pnpm compile
pnpm build
pnpm typecheck
pnpm test
pnpm test:fork
pnpm gas:report
pnpm evidence:check
pnpm evidence:summary
pnpm mutation:check
pnpm verify
```

The web app has its own commands. `pnpm web:build` needs `pnpm build` first.

```bash
pnpm lint
pnpm web:content
pnpm web:build
pnpm web:start
pnpm web:dev
pnpm web:e2e
pnpm web:shots
pnpm mutation:web
```

`pnpm web:e2e` and `pnpm web:shots` start a local chain and the built app on local ports and drive it in the Edge browser; they need `pnpm web:build` first, and they reach no network.

`pnpm build` compiles the packages to `dist/` so the programs can be run with node. `pnpm test:fork` and `pnpm gas:report` read QIE's public RPC to build a local copy of the chain, and the tool tests also read the public explorer with GET requests. They send nothing to QIE.

The programs, after `pnpm build`. Each reads its settings from the environment or a config file; see [Environment variables](#environment-variables).

```bash
pnpm start:facilitator
pnpm start:paid-tools
pnpm start:proxy -- --config sluice.config.json
pnpm start:wallet -- --config sluice.config.json
```

The scripts in `scripts/live/` are for the founder to run. Each refuses to start without `SLUICE_APPROVE` set to its own name and a network chosen, and each stops at a spending cap (10 QUSDC and 5 QIE by default, never above 100 QUSDC or 50 QIE). The facilitator holds to the same rule against mainnet or testnet.

```bash
pnpm exec ts-node scripts/live/deploy.ts
pnpm exec ts-node scripts/live/smoke.ts
```

## Going live

Everything the founder needs to put Sluice on a QIE network and to check what happened is here as scripts and documents. The code and the documents were written by Claude Code, an AI coding assistant. Nothing in them has been run on a QIE network, and no surface is Live: a surface is marked Live only when [docs/EVIDENCE.md](docs/EVIDENCE.md) holds a verified mainnet row for it.

| To do this | Read |
| --- | --- |
| Rehearse the whole flow on the testnet, with a token that has no value | [docs/REHEARSAL.md](docs/REHEARSAL.md) |
| Deploy to mainnet, with a funding plan from the measured gas, and the places to stop | [docs/MAINNET-RUNBOOK.md](docs/MAINNET-RUNBOOK.md) |
| Host the facilitator: a queue that survives a restart, a kill switch, caps and limits | [docs/DEPLOY-FACILITATOR.md](docs/DEPLOY-FACILITATOR.md) |
| Host the demo tool server over HTTP, with limits on callers | [docs/DEPLOY-TOOL-SERVER.md](docs/DEPLOY-TOOL-SERVER.md) |
| Try the proxy from Claude Code and Cursor | [docs/REAL-CLIENT-TEST.md](docs/REAL-CLIENT-TEST.md) |
| Try it as a tool builder, in about ten minutes | [docs/TRY-IT-BUILDER.md](docs/TRY-IT-BUILDER.md) |
| Try it as the owner of an agent, in about ten minutes | [docs/TRY-IT-AGENT.md](docs/TRY-IT-AGENT.md) |
| Draft messages to a builder, a payer and a developer community | [docs/OUTREACH.md](docs/OUTREACH.md) |

The commands, all of which read the chain with read-only methods unless they say otherwise:

```bash
pnpm live:preflight
pnpm live:verify
pnpm live:test-token
pnpm live:new-key
pnpm evidence:record
pnpm client:smoke
pnpm client:owner
pnpm mutation:live
```

- `pnpm live:preflight` asks QIE's public RPC (rpc1 to rpc5, in turn) whether the chain, QUSDC, the gas price, the balances and, after a deploy, the router are as they should be, and answers GO or NO-GO. It holds no key and sends nothing.
- `scripts/live/deploy.ts` and `scripts/live/smoke.ts` take `--dry-run`, which prints each transaction's destination, value, decoded call and estimated cost and sends nothing.
- `pnpm live:verify` submits the router's and the vault's source to the explorer and then asks the explorer whether it shows them as verified. It always writes the files for verifying by hand first.
- `pnpm live:test-token` deploys a token with no value, to the testnet only, and refuses mainnet.
- `pnpm evidence:record` writes every row in `docs/EVIDENCE.md`, and no one adds one by hand. It reads the transaction back from the chain, checks that it shows what the claim says, and refuses and writes nothing if it does not. A row carries its network, and a row from a test run or the testnet cannot be read as mainnet proof.
- `pnpm client:smoke` is a script that uses the official MCP client to make one paid call through the proxy and prints every step. It is a script, not an MCP application.
- `pnpm client:owner` lets an owner with QUSDC and no QIE put QUSDC in the router and authorise an agent key, by signing.
- `pnpm mutation:live` changes one condition at a time in the go-live code and reports whether a test failed for each.

What has not been tried: the Docker images were not built (the build steps were run one by one outside Docker), the explorer's verification endpoint was only tried against a stand-in, and no real MCP client such as Claude Code or Cursor has been used. [docs/FOUNDER-LOG.md](docs/FOUNDER-LOG.md) has blank checkboxes for each live step, for the founder to tick on the day each one is done.

## Environment variables

Names only. Values go in a local `.env` that is never committed. Copy `.env.example` to start.

| Name | Used by | What it is |
| --- | --- | --- |
| `SLUICE_NETWORK` | live scripts, facilitator, summary | `mainnet` or `testnet`; `local` for the facilitator on a local node. No default. |
| `SLUICE_RPC_URL` | live scripts, facilitator, paid tools, wallet MCP, web app server | RPC endpoint. Optional except for a local node. Must be https, or a local address. |
| `SLUICE_KEY` | live scripts | Secret. The signing key. Never printed. |
| `SLUICE_APPROVE` | live scripts, facilitator | The name of the program you approve: `deploy`, `smoke` or `facilitator`. |
| `SLUICE_MAX_QUSDC` | live scripts | Cap on QUSDC moved by one script. Default 10, ceiling 100. |
| `SLUICE_MAX_QIE` | live scripts, facilitator | Cap on QIE spent on gas by one script, or the facilitator's daily budget. Default 5 for scripts, ceiling 50. |
| `SLUICE_TOKEN` | deploy | The token. Leave empty on mainnet, where it is QUSDC. Required on testnet. |
| `SLUICE_OWNER` | deploy | The router owner. No default. |
| `SLUICE_FEE_RECIPIENT` | deploy | Who is credited the fee. No default. |
| `SLUICE_FEE_BPS` | deploy | The fee in basis points, 0 to 200. No default. |
| `SLUICE_ROUTER` | smoke, facilitator, paid tools, summary | The deployed router. |
| `SLUICE_PAYEE` | smoke, paid tools | The address that is paid. For smoke it is optional. |
| `SLUICE_RELAYER_KEY` | facilitator | Secret. The relayer's hot key. Never printed. |
| `SLUICE_FACILITATOR_PORT` | facilitator | Port to listen on. Default 8402. |
| `SLUICE_FACILITATOR_URL` | facilitator, paid tools | Where the facilitator is reached. |
| `SLUICE_FACILITATOR_STATE` | facilitator | A file where the queue is kept across restarts. Required against mainnet or testnet, optional on a local node. |
| `SLUICE_FACILITATOR_HOST` | facilitator | The address to listen on. Default 127.0.0.1; a container sets 0.0.0.0. |
| `SLUICE_FACILITATOR_TRUST_PROXY_HOPS` | facilitator | How many proxies in front append to X-Forwarded-For. Default 0, which ignores the header. |
| `SLUICE_FACILITATOR_KILL_SWITCH` | facilitator | 1 stops relaying, settling and top-ups from the start. Reads keep working. |
| `SLUICE_FACILITATOR_KILL_FILE` | facilitator | A path checked on every request: while the file exists the kill switch is on. |
| `SLUICE_FACILITATOR_MAX_BODY_BYTES` | facilitator | Largest request body. Default 65536, at most 1048576. |
| `SLUICE_FACILITATOR_RATE_LIMIT_IP` | facilitator | Requests per minute from one client address. Default 240. |
| `SLUICE_FACILITATOR_RATE_LIMIT_PAYER` | facilitator | Requests per minute that name one payer address. Default 60. |
| `SLUICE_FACILITATOR_MAX_TOPUP_QIE` | facilitator | The most QIE one top-up may send. Default 0.001, ceiling 0.0015. |
| `SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE` | facilitator | The most QIE all top-ups to one address may send in a UTC day. Default 0.001, ceiling 0.003. |
| `SLUICE_FACILITATOR_LOW_BALANCE_QIE` | facilitator | The relayer's balance below which /health says it is low. Default: one day's budget. |
| `SLUICE_FACILITATOR_SHUTDOWN_MS` | facilitator | How long a shutdown waits for a batch in progress. Default 30000. |
| `SLUICE_FACILITATOR_FLUSH_MS` | facilitator | How often queued intents are batched. Default 15000. |
| `SLUICE_FACILITATOR_LOG_LEVEL` | facilitator | `debug`, `info`, `warn` or `error`. Default `info`. |
| `SLUICE_FACILITATOR_RPC_TIMEOUT_MS` | facilitator | How long one request to the node may take. Default 20000. |
| `SLUICE_TOOLS_PRICES` | tool server | The price table, like `dex_quote=0.004`. A name that is not a tool stops the start. |
| `SLUICE_TOOLS_HOST` | tool server | The address to listen on. Default 127.0.0.1; a container sets 0.0.0.0. |
| `SLUICE_TOOLS_PORT` | tool server | The port to listen on. Default 8403. |
| `SLUICE_TOOLS_TRUST_PROXY_HOPS` | tool server | How many proxies in front append to X-Forwarded-For. Default 0. |
| `SLUICE_TOOLS_MAX_BODY_BYTES` | tool server | Largest request body. Default 32768, at most 1048576. |
| `SLUICE_TOOLS_RATE_LIMIT_IP` | tool server | Requests per minute from one address. Default 300. |
| `SLUICE_TOOLS_RATE_LIMIT_UNPAID` | tool server | Requests per minute from one address that carry no payment. Default 60. |
| `SLUICE_TOOLS_RPC_TIMEOUT_MS` | tool server | How long one read from the node or the explorer may take. Default 10000. |
| `SLUICE_TOOLS_LOG_LEVEL` | tool server | `debug`, `info`, `warn` or `error`. Default `info`. |
| `SLUICE_AGENT_KEY` | proxy, wallet MCP | Secret. The agent's session key. Never the owner's key. |
| `SLUICE_CONFIG` | proxy, wallet MCP | Path of the config file, if `--config` is not given. |
| `SLUICE_EXPLORER_URL` | paid tools, web app server | The explorer's read API. Optional; defaults to QIE's public explorer. |
| `SLUICE_FROM_BLOCK` | summary, web app server | The block the router was deployed at, where counting starts. |
| `EVIDENCE_RPC_URL` | evidence check, summary | Optional RPC override. |
| `SLUICE_FACILITATOR_CORS_ORIGINS` | facilitator | Exact origins (https, or http on this machine) that may call it from a web page, separated by commas. Empty means none. Never a wildcard. |
| `NEXT_PUBLIC_ROUTER_ADDRESS` | web app | The deployed router. Public. |
| `NEXT_PUBLIC_VAULT_ADDRESS` | web app | The router's vault. Public. |
| `NEXT_PUBLIC_CHAIN_ID` | web app | The chain the pages read and send on. Default 1990. |
| `NEXT_PUBLIC_RPC_URL` | web app | The RPC the pages read through. A local address makes the app call the network local. |
| `NEXT_PUBLIC_FACILITATOR_URL` | web app | The facilitator offered to a wallet with no QIE. |
| `NEXT_PUBLIC_FROM_BLOCK` | web app | The block the router was deployed at. |
| `NEXT_PUBLIC_GITHUB_URL` | web app | The project's repository, for the footer and the documents. |
| `NEXT_PUBLIC_SITE_URL` | web app | Where the site is served, for link previews. |
| `WRITE_FORK_SAMPLE` | fork test | Set to 1 with `pnpm test:fork` to write the landing page's fork sample. |
| `FORK` | tests | Set by `pnpm test:fork`. |
| `FORK_BLOCK` | tests | Optional block to fork at. |
| `SLUICE_FORK_RPC_URL` | tests | Optional RPC to fork from. |
| `SLUICE_COUNT_FILE` | docs test | Where the test runner writes counts when only counting. |
| `SLUICE_TEST_DIR` | docs test | Which test folder to count. |
| `GAS_REPORT` | gas report | Set by `pnpm gas:report`. |
| `GAS_PRICE_WEI` | gas report | Optional gas price override. |
| `QIE_PRICE_USD` | gas report | Optional QIE price override. |

## Repository layout

```text
AGENTS.md                         the working rules for this repository
DECISIONS.md                      the decisions made while building, with reasons
LICENSE                           MIT
README.md                         this file
hardhat.config.ts                 compiler and network setup
package.json                      scripts and pinned dependencies
pnpm-lock.yaml                    exact dependency versions
pnpm-workspace.yaml               the packages, and install scripts that are not approved to run
tsconfig.base.json                TypeScript settings the packages build with
tsconfig.json                     TypeScript settings for typechecking and the tests
.env.example                      environment variable names
.gitignore                        files kept out of git
eslint.config.mjs                 lint rules for the web app and its tests
.dockerignore                     what a Docker build may see: no keys, no queue files, no installed packages
.github/
  ISSUE_TEMPLATE/
    i-tried-sluice.yml            the form for reporting what happened when someone tried Sluice
apps/
  web/
    public/
      brand/
        mark.svg                  the Sluice mark
        wordmark.svg              the Sluice wordmark
      og.png                      the link-preview image, drawn by scripts/og.mjs
      theme-init.js               applies the saved theme before the page paints
    scripts/
      fonts.mjs                   copies the fonts into public/fonts
      og.mjs                      draws og.png from the tokens and the mark
    snippets/
      wrap-tool.ts                the SDK call in the builder's guide, type-checked by a test
    src/
      app/
        api/
          risk/
            route.ts              the read-only risk check route
        builder/
          page.tsx                the builder dashboard page
        demo/
          page.tsx                the demo page
        docs/
          [slug]/
            page.tsx              one rendered document
          page.tsx                the list of documents
        evidence/
          page.tsx                the evidence page
        wallet/
          page.tsx                the payer and agent budget page
        error.tsx                 the error page
        global-error.tsx          the last-resort error page
        icon.svg                  the favicon
        layout.tsx                the page frame, the metadata and the nonce
        not-found.tsx             the 404 page
        page.tsx                  the landing page
      components/
        art.tsx                   the channel drawing and the mechanism diagram
        brand.tsx                 the mark and the wordmark
        builder-dashboard.tsx     earnings, settlements and withdraw
        demo-facilitator.tsx      the panel that reads a facilitator
        demo-simulation.tsx       the simulated walkthrough
        doc-view.tsx              the documents' sidebar, contents and text
        evidence-view.tsx         the evidence tables and the counts
        flow-dialog.tsx           the review step before a wallet opens
        footer.tsx                the footer
        nav.tsx                   the navigation and the theme toggle
        page-head.tsx             the heading of a page
        payer-dashboard.tsx       balances, agent keys and their flows
        proof-strip.tsx           real transactions from the evidence file
        providers.tsx             the settings, the wallet and the chain reader
        risk-panel.tsx            the token risk check
        status-badge.tsx          the status badges
        use-flow.ts               what a flow needs from the connected wallet
        wallet-bar.tsx            connect, network and wrong-network state
      content/
        copy.ts                   the idea's wording and text used on more than one page
        fork-sample.json          a sample written by the fork test, shown labelled as not mainnet
      design/
        fonts.css                 the font faces
        pairs.ts                  every text and background pair the contrast test checks
        tokens.css                every colour, in a light and a dark theme
      lib/
        config.ts                 the app's settings and their checks
        content-types.ts          the shape of the generated content
        content.ts                the generated content, typed
        contrast.ts               WCAG contrast from the tokens
        csp.ts                    the Content Security Policy
        eip1193.ts                talking to an injected wallet
        facilitator.ts            reading a facilitator's health and status
        flows.ts                  plan, confirm and send: deposit, withdraw, refund, authorise, revoke
        format.ts                 amounts, addresses and times
        markdown.ts               the Markdown renderer
        networks.ts               QIE networks and chain parameters
        rate-limit.ts             the rate limiter
        reads.ts                  reading the router and the vault
        risk-handler.ts           the risk route's logic and its limits
        simulation.ts             the simulated walkthrough, from the spec's vectors
        summary-handler.ts        the evidence counts
        theme.ts                  the theme choice
      styles/
        base.css                  reset, type and focus
        site.css                  the layout of the pages
        ui.css                    buttons, cards, fields, tables and prose
      proxy.ts                    sets the Content Security Policy for each request
      status.ts                   the status list, held to the README and the evidence
    test-support/
      render.tsx                  renders components to HTML for the tests
    AGENTS.md                     written by Next.js: points at the framework's bundled documents
    next.config.mjs               Next.js settings and the headers that do not change
    package.json                  package manifest
    tsconfig.json                 TypeScript settings for the app
contracts/
  base/
    Eip712.sol                    domain separator
  interfaces/
    IERC20.sol                    minimal token interface
    ISluiceErrors.sol             error names
  libraries/
    SafeTransfer.sol              token calls that fail loudly
    SignatureLib.sol              signature recovery
  test/
    FeeOnTransferToken.sol        test token that takes a cut
    MockDex.sol                   test tokens, a pool and a router for the quote tool
    MockQUSDC.sol                 test token with 6 decimals
    ReentrantToken.sol            test token that calls back
    RoleToken.sol                 test token with roles, an owner and a burn
    SlotProxy.sol                 test proxy that keeps its logic in the ERC-1967 slots
    TestnetToken.sol              a token with no value that anyone can mint, for rehearsing on the testnet
  AgentVault.sol                  session keys
  PaymentRouter.sol               the ledger
design/
  reference/
    palette-promptiq.png          the reference screenshot; only its colours are used
  screenshots/
    slice3/                       screenshots of every page at 390 and 1440 pixels, in both themes
    sluice-landing.png            the image at the top of the README
  PALETTE.md                      every sampled colour and where it came from, the tokens, and each contrast adjustment
  derive-palette.py               prints each adjusted colour with its contrast before and after
  sample-palette.py               samples the reference screenshot's colours
docs/
  DEPLOY-FACILITATOR.md           hosting the facilitator: settings, caps, a VPS or Railway, rotation, backups, a checklist
  DEPLOY-TOOL-SERVER.md           hosting the demo tool server: settings, limits, a VPS or Railway, a checklist
  DEPLOY-WEB.md                   the steps to deploy the web app, for the founder to follow
  EVIDENCE.md                     verified transactions
  FOUNDER-LOG.md                  a template for the founder to fill in
  GAS.md                          measured gas and cost
  MAINNET-RUNBOOK.md              the mainnet steps in PowerShell, with a funding plan and the places to stop
  OUTREACH.md                     three draft messages, and the facts each must keep true
  PREBUILD-VERIFICATION.md        what was checked before building, with dates
  REAL-CLIENT-TEST.md             trying the proxy from Claude Code and Cursor, and what is unverified until then
  REHEARSAL.md                    the same steps on the testnet, with a token that has no value
  RISKS.md                        risks and what backs each statement
  SPEC.md                         the Sluice payment scheme for MCP on QIE
  TRY-IT-AGENT.md                 ten minutes as the owner of an agent
  TRY-IT-BUILDER.md               ten minutes as a tool builder
  founder-wallets.json            the versioned list of founder wallets the summary leaves out
  spec-vectors.json               test vectors for the spec, from throwaway keys
examples/
  paid-tools/
    src/
      bytecode.ts                 selectors, proxy slots and compiler metadata
      cli.ts                      starts the server over stdio or HTTP
      contractLookup.ts           the contract_lookup tool
      dexQuote.ts                 the dex_quote tool
      host.ts                     the hosted tool server: its settings, limits and HTTP server
      index.ts                    exports
      rpc.ts                      read-only RPC and explorer access
      server.ts                   registers the three tools with prices
      tokenRisk.ts                the token_risk_check tool
    Dockerfile                    the hosted tool server as a container image
    README.md                     the three example paid tools
    package.json                  package manifest
    tsconfig.json                 build settings
packages/
  facilitator/
    src/
      caps.ts                     the hard caps, as constants
      cli.ts                      starts the service
      env.ts                      settings from the environment, and when it refuses to start
      index.ts                    exports
      killswitch.ts               the kill switch: an environment flag or a file
      relayer.ts                  the hot key behind the caps
      runtime.ts                  starting the facilitator from its settings and stopping it in order
      server.ts                   the HTTP endpoints
      service.ts                  verify, settle, flush, onboard and relay
      store.ts                    the record of accepted intents
    Dockerfile                    the facilitator as a container image
    README.md                     the facilitator and its limits
    package.json                  package manifest
    tsconfig.json                 build settings
  proxy/
    src/
      cli.ts                      starts the proxy
      config.ts                   the config file
      index.ts                    exports
      log.ts                      the local payment log
      policy.ts                   the owner's budget
      proxy.ts                    forward, pay inside the budget, retry
    README.md                     the proxy, its config and the Claude Code and Cursor setup
    package.json                  package manifest
    tsconfig.json                 build settings
  sdk/
    src/
      abi.ts                      the contract interfaces the packages call
      authorize.ts                signing an agent session
      facilitator-client.ts       the facilitator's HTTP client
      http.ts                     hosting an MCP server over HTTP
      index.ts                    exports
      logger.ts                   structured logs with keys, signatures and URLs left out
      names.ts                    .qie names and the resolver
      onboarding.ts               signing the start with no QIE
      paid-tool.ts                the paidTool middleware
      protocol.ts                 the intent, its hashing and its checks
      ratelimit.ts                a rate limiter, and which address a request came from
      timeout.ts                  time limits for reads from a node
      util.ts                     small shared helpers
      x402.ts                     the x402-over-MCP messages
    README.md                     the SDK
    package.json                  package manifest
    tsconfig.json                 build settings
  wallet-mcp/
    src/
      chain.ts                    read-only access to the chain
      cli.ts                      starts the wallet MCP
      index.ts                    exports
      server.ts                   the five tools
    README.md                     the wallet MCP
    package.json                  package manifest
    tsconfig.json                 build settings
scripts/
  client/
    owner-setup.ts                pnpm client:owner: put QUSDC in the router and authorise an agent, by signing
    smoke-client.ts               pnpm client:smoke: a scripted MCP client making one paid call
  evidence/
    record.ts                     pnpm evidence:record: verify a transaction and write its row
  live/
    deploy-test-token.ts          pnpm live:test-token: the testnet token, never on mainnet
    deploy.ts                     deploy, for the founder to run
    new-key.ts                    pnpm live:new-key: make a key, print only its address
    preflight.ts                  pnpm live:preflight: read-only checks and GO or NO-GO
    smoke.ts                      small round trip, for the founder to run
    verify-contracts.ts           pnpm live:verify: get the source verified on the explorer
  evidence-check.ts               pnpm evidence:check
  evidence-summary.ts             pnpm evidence:summary
  mutation-check.ts               pnpm mutation:check, and the list of changes
  mutation-live.ts                pnpm mutation:live, and the list of changes
  mutation-web.ts                 pnpm mutation:web, and the list of changes
  spec-vectors.ts                 writes docs/spec-vectors.json
  web-content.ts                  pnpm web:content
  web-e2e.ts                      pnpm web:e2e
  web-shots.ts                    pnpm web:shots
src/
  claims.ts                       the rules the docs tests apply
  dryrun.ts                       what a live script would send, without sending it
  dyn.ts                          a type for contracts looked up by name
  events.ts                       the events an evidence row can name
  evidence.ts                     the evidence checker
  gas-figures.ts                  the measured gas the funding plan and the checks budget from
  gas.ts                          gas report writer and reader
  guard.ts                        approval and spending caps
  live.ts                         what the live scripts do
  mutation.ts                     the mutation check's engine
  preflight.ts                    the pre-flight checks and their verdict
  readrpc.ts                      a read-only JSON-RPC client over several endpoints
  recorder.ts                     the evidence recorder: claims, verification and the file
  summary.ts                      the paid-call summary and its filter
  test-token.ts                   deploying the testnet token, refusing mainnet
  units.ts                        QUSDC amounts
  verify-contracts.ts             the standard input, the flat file and the explorer's endpoint
  web-content.ts                  builds the content the web app renders
test/
  fork/
    gas.fork.test.ts              measures gas
    live.fork.test.ts             the live library on a fork
    mcp.fork.test.ts              the MCP layer with the real QUSDC
    qusdc.fork.test.ts            the contracts against the real QUSDC
    remote.fork.test.ts           a hosted deployment as separate processes with the real QUSDC
    tools.fork.test.ts            the example tools on the real QUSDC and QIEDEX
    web.fork.test.ts              the web app's reads and flows with the real QUSDC
  helpers/
    fixtures/
      env-echo-server.ts          an MCP server that lists its environment names
    assert.ts                     small assertion helpers
    chaos.ts                      a node and a disk that fail on purpose, and processes to kill
    explorer.ts                   a stand-in explorer that answers from the local chain
    fork.ts                       fork helpers
    index.ts                      shared test helpers
    mock-wallet.ts                a mock wallet that signs with throwaway keys
    payments.ts                   builds payments for the tests
    remote-scenario.ts            the scenario the two remote-hosting tests run
    remote.ts                     a whole deployment as separate processes
    spawn.ts                      starts the programs for the end-to-end tests
    spec-client.ts                a client written only from the spec
    stack.ts                      the contracts, the chain over HTTP and a facilitator
    web-copy.ts                   the words the web app shows, for the claims scan
  unit/
    e2e/
      client-kit.test.ts          the scripted client through proxy, tool server and facilitator
      end-to-end.test.ts          agent, proxy, paid tools, facilitator and router as separate processes
      remote.test.ts              proxy, HTTP tool server and facilitator, each its own process
      try-it.test.ts              the two try-it pages, followed
    examples/
      host.test.ts                the hosted tool server's settings and limits
      tools.test.ts               the three example tools on a local chain
    facilitator/
      crash.test.ts               a killed facilitator, recovered from its journal and the chain
      durability.test.ts          the journal, and a stop at each point of a batch's life
      http-onboard.test.ts        HTTP, the start with no QIE, relayed requests
      operations.test.ts          the kill switch, caps, limits, logs, settings and an orderly stop
      service.test.ts             verify, settle, caps and the relayer
    proxy/
      proxy.test.ts               config, budget and paying a paid server
    sdk/
      paid-tool.test.ts           paidTool on a real MCP server
    spec/
      compat.test.ts              a client written from the spec, and the spec held to the code
      vectors.test.ts             the spec's test vectors, recomputed by hand
    wallet-mcp/
      wallet.test.ts              the wallet MCP's tools
    web/
      components.test.ts          what each component shows
      content.test.ts             generated content, Markdown, status and the walkthrough
      design.test.ts              contrast, the tokens and the theme
      flows.test.ts               the wallet flows against a mocked wallet
      honesty.test.ts             claims, secrets and keys
      lib.test.ts                 settings, amounts, the policy and the limiter
      routes.test.ts              the risk check and the evidence counts
    AgentVault.test.ts            session keys
    PaymentRouter.test.ts         the router
    docs.test.ts                  README, docs and claims
    evidence.test.ts              the evidence checker
    golive-docs.test.ts           the go-live documents held to the code and the claims rules
    guard.test.ts                 the spend guard and live scripts
    live-tools.test.ts            the pre-flight check, dry run, verification, test token and key maker
    live.test.ts                  the live library on a local chain
    mutation.test.ts              the mutation check's engine and list
    properties.test.ts            random sequences and the fee
    recorder.test.ts              the evidence recorder against a local chain
    summary.test.ts               the paid-call summary and its filter
    surface.test.ts               what the contracts expose and lack
```

## Built for the QIE Hackathon

Sluice is a submission to QIE Hackathon 3.0, in the AI and Autonomous Agents track, with Commerce as the second story.

**How it was made.** Claude Code, Anthropic's coding agent, wrote and tested the code in this repository: the contracts, the packages, the tests, the tooling and these documents. What the founder decided, explained, tested and reviewed is for the founder to record in [docs/FOUNDER-LOG.md](docs/FOUNDER-LOG.md), a template with headings and no entries. This README does not say it for them. Claude Code was told not to send transactions, deploy, spend or commit, and it did none of those. Nothing was copied or imported from another project, and no contract library is used: the helpers in `contracts/base` and `contracts/libraries` were written for this repository, and so was every package.

**Credits.** The payment messages and the facilitator interface follow the x402 specification and its MCP transport, at https://github.com/coinbase/x402. Sluice's scheme is independent of x402 and is not an official x402 scheme. [DECISIONS.md](DECISIONS.md) lists the choices made while building.

**Libraries and tools.** Hardhat 2.17.4, ethers 6.8.1, hardhat-ethers 3.0.5, hardhat-chai-matchers 2.0.2, hardhat-network-helpers 1.0.10, chai 4.3.10, Mocha (through Hardhat), solc 0.8.24, TypeScript 5.3.3, ts-node 10.9.2, tsconfig-paths 4.2.0, cross-env 7.0.3, @modelcontextprotocol/sdk 1.32.2, zod 3.25.76. The web app adds Next.js 16.4.6, React 19.3.1, react-dom 19.3.1, @fontsource/inter-tight 5.3.0, @fontsource/ibm-plex-mono 5.3.0 and @fontsource/instrument-serif 5.3.0; its browser tests use playwright-core 1.64.1 with the system's Edge; and its lint uses ESLint 9.39.5, @eslint/js 9.39.5, typescript-eslint 8.73.0, eslint-plugin-react-hooks 7.1.1, eslint-plugin-jsx-a11y 6.10.2 and globals 17.14.0.

**The web app's design.** Its fonts, type scale, spacing, radii, component shapes and the structure of its footer follow the founder's Veylo project, which was read for reference only and never changed. The code is written fresh for this repository, and none of Veylo's colours are used.

## License

MIT. See [LICENSE](LICENSE).
