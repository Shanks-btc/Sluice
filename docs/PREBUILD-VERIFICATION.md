# Paymeter pre-build verification: summary (2026-11-19)

Scope: read-only. No transaction, signing with a real key, faucet request, deploy or spend. Fork tests ran on a local copy of
QIE mainnet with throwaway keys. Raw outputs are under `raw/` (index at the end). Vendor and project text is treated as a claim.

Status words: CONFIRMED (value + how), CONTRADICTED (what the evidence says instead), COULD NOT CHECK (why).

## Blocked or refused (not worked around)

- `hackathon.qie.digital/api/admin/submissions` (the winners and submissions list): refused by the session's safety classifier as an
  admin path. Not fetched. Effect: no list of Hackathon 2 AI-track entries, no repo links for the five winners, no Hackathon 3 counts.
- CryptoSlate, 4pillars.io, KuCoin news: Cloudflare or Vercel challenge, or connection refused. Not retried.
- Glama's API needs an API key. Not created. Glama's public web page count was used instead.
- `qieadmin/qie-wallet-mcp-listing` and other GitHub pages were read through the public GitHub API only.

## Part 1: is the problem real?

### 1.1 MCP servers: how many, how many charge
- CONFIRMED (2026-11-19, own crawl of `registry.modelcontextprotocol.io/v0/servers?version=latest`): **67,499** latest-version listings
  (66,410 active, 1,089 deprecated); 46,009 have a remote endpoint; 45,265 use streamable-http; 30,068 were published in the last 30 days.
  A third party reported 52,042 on 2026-10-28 (claim, `dev.to/amareswer`); the registry publishes no total itself.
- CONFIRMED (read from each site today): Smithery API `totalCount` 20,747; PulseMCP page 21,526 servers; mcp.so 20,803 servers and 396 clients;
  Glama page title 123,663 (a much wider crawl). GitHub topic `mcp-server` 45,135 repos, `model-context-protocol` 45,966.
- CONFIRMED: **none of these directories exposes a price or paid field** (Smithery's server object has no price key; the others show none),
  so "how many charge money" cannot be read from them.
- Proxy, from listing text only (what listings SAY, not what servers charge): 2,343 official-registry listings mention x402 (3.5%) across
  **1,814 distinct publishers** (top ten publishers = 9.6%); 2,802 mention payments broadly (4.2%).
- CONFIRMED proxy 2: Coinbase's public x402 Bazaar lists **36,222** priced resources (2026-11-19), of which 547 are `type: mcp`;
  ~74% are priced at or under $0.01 per call. Listed, not used.
- Third-party claim (Nevermined/SettleGrid-affiliated): "fewer than 5%" of MCP servers monetise. Unverified vendor claim.

### 1.2 Who lets MCP builders get paid
- x402 (Coinbase, now a Linux Foundation project; Foundation members include Cloudflare, Google, Microsoft, Stripe, Visa per Forkast, a site that says its reporters are AI):
  HTTP 402 plus signed payment. MCP transport is specified (`x402` repo, `specs/transports-v2/mcp.md`): tool result `isError:true` with `PaymentRequired`,
  retry with `_meta["x402/payment"]`, result carries `_meta["x402/payment-response"]`. Schemes seen in the Bazaar: `exact` (EIP-3009 or Permit2), `upto`,
  `batch-settlement` (312 accepts entries), plus ~100+ custom names. 49 networks listed in the Bazaar; **none is QIE (eip155:1990)**.
- Vercel `x402-mcp` (blog 2025-09-12): `paidTool` with a USD price, x402 on Base. Cloudflare Agents SDK `paidTool` (docs updated 2026-10-27): per-call USD price,
  network `base`, facilitator `https://x402.org/facilitator`. Adoption numbers for both: COULD NOT CHECK (none published).
- Stripe + Tempo Machine Payments Protocol (announced 2026-03-18): Stripe's docs say private preview; cards via Shared Payment Tokens and stablecoins. Numbers: none public.
- Apify pay-per-event for MCP Actors (`Actor.charge`), commission rate COULD NOT CHECK. Smithery: no native billing seen; third-party layers (SettleGrid, MCP Hive) are vendor claims.
- Real usage vs marketing (all second-hand; originals not fetched unless stated): cumulative x402 transactions claimed 165M-205M (headline, mixed sources);
  TRM Labs (via spotedcrypto.com, 2026-09-15): $52.7M across 198.9M settlements on Base, Solana and Polygon since May 2025, only 0.6%-7.5% plausibly agentic
  ($154K-$1.92M; run-rate $5K-$11K per month); CoinDesk (via search summaries, March 2026): ~$28K real daily volume; Artemis: ~half of transactions self-dealing or wash;
  Visa and Artemis (The Defiant headline): adjusted volume ~$19M, ~4,000 wallets drive ~90%; Allium $3M vs x402.org $24M for 30 days. These conflict; treat as ranges.

### 1.3 Demand signals
- CONFIRMED: the MCP specification (2025-11-25) has no payment or 402 semantics; `_meta` is reserved metadata only.
- CONFIRMED: MCP payment proposals exist and went nowhere: SEP-2007 (payments, error code -32402, by `shivankgoel`), opened 2025-12-23, closed 2026-06-24 by a maintainer
  as dormant for lack of a sponsor ("not a permanent decision"); issue #2009 closed 2025-12-27 as a duplicate; RFC #3229 (x402 token metering) closed 2026-08-23 with a maintainer comment
  "AI-generated with no disclosure". #3229 cites "$2,800 in 60 seconds" from `gemini-cli#4472`: second-hand and unverified.
- Weak: Hacker News (Algolia): "MCP monetization" 14 hits since 2025, best story 1 to 3 points and 0 comments; "x402 MCP" 44 hits, mostly Show HN with 0 to 4 points.
- Vendor blogs say MCP has "no native monetization". That is true of the spec but is vendor content, not developer complaints. No direct developer complaints found.

### 1.4 Demand on QIE
- CONFIRMED (GitHub API): `qie-blockchain` has 3 public repos, none about agents or payments; `qieadmin` (a user) has 20, including `qie-wallet-mcp-listing`, `qusdc-sdk`, `qie-lend-sdk`.
- CONFIRMED: QIE Wallet MCP exists (official registry name `digital.qie/wallet` v0.1.0), read-only, six tools. OctopusWork: "targeted for January 2027" (QIE Medium, 2026-11-17).
- CONFIRMED (explorer + GitHub, 2026-11-19): at least five other agent-spend efforts on QIE this season:
  1. PayEndpoint suite (AgentRegistry, MandateVault, PayEndpoint, SettlementRouter, EscrowCore, InvoiceVault, RecurringMandate, MerchantRegistry, CreditPassport),
     deployer `0x33E0...3586`, deployed 2026-09-16, verified. Its own comments: "price-per-call", agents pay "via pre-funded mandates", per-call and daily caps,
     "the on-chain settlement leg of the x402-style HTTP flow". Usage: a one-day smoke test (PayEndpoint 8 txs on 2026-09-17).
  2. `Meter402Policy` (0x6910...DdAC): deployer `0x7791...3E4C`, deployed 2026-11-19 01:40 UTC, 14 txs, 12 QUSDC transfers; then `TurnpikeAllowance` (setPolicy, revokeAgent, deposit, withdraw) hours later.
  3. Semilla1 Guard (factory 0x24f0...4aF2, guard 0x390E...9cc4): live on mainnet, 5 txs; README says it is a port of a NEAR project.
  4. Leash (`arvindcr4/leash-qie`, MIT, 2026-08-03): spending vault with caps, expiry, allowlist, revoke.
  5. QIE AgentPay (`jexdox1997`, 2026-11-18): read-only Telegram bot so far.
- Hackathon 2 AI-track entries: COULD NOT CHECK (admin API blocked). QIE says 411 submissions and 2,300+ developers (QIE claim).
- Does any QIE project charge per call today? Mainnet contracts with per-call logic exist (PayEndpoint `payForCall`, Meter402Policy `pay`) but their activity is developer smoke testing. No QIE service with real paying users was found.
- QIE's "800+ dApps" is, by the site's own note, contracts deployed (830 deployed, 140 verified), not projects.

### 1.5 Verdict (evidence strength in brackets)
- A real, current gap in the MCP *specification* (no payments), [strong].
- A mostly future problem for *paying agents*: independent measures put real agent spend at roughly $5K-$11K a month across the whole x402 ecosystem [moderate, second-hand].
- Already solved elsewhere for Base and Solana (x402 MCP transport, Vercel, Cloudflare, Coinbase client wrapper, Bazaar) [strong].
- Open on QIE: no x402 listing on chain 1990, and x402's published contracts cannot run on QIE (see 4.x) [strong]. But paying demand on QIE is unevidenced [strong that it is absent].

## Part 2: rules and claims

### 2.1 Official pages (hub `https://hackathon.qie.digital/`, FAQ answers read from the page's own script, `raw/p2/2.1-faq-verbatim.txt`)
- Mainnet: "Yes. Testnet-only projects are not eligible." Judges verify contracts, transactions, deployment and frontend on mainnet. CONFIRMED.
- Mandatory: "mainnet deployment, open-source smart contracts, live public app, public repository, demo video, documentation, and team presentation." CONFIRMED.
- Payout: "50% immediately on Dec 10, 2026"; the rest "after meeting any 3 traction milestones within 90 days". Milestones (page): wallet growth, transaction volume, recurring users, merchants, monthly usage, revenue. CONFIRMED.
- Weights (FAQ): Innovation 30%, Technical Quality 25%, UX 15%, Mainnet Integration 15%, Business Potential 15%. The hub page lists five different criteria without weights; the FAQ is the only place with numbers. Noted discrepancy.
- AI: "Yes, AI-assisted development is encouraged. Teams must fully understand and maintain their code and be able to explain architecture to judges." CONFIRMED.
- Prizes: $17,000 pool ($5K/$3K/$2K, five $500 category awards, special awards: Most Traction $2,500, Community Choice $1,000, Best Student Team $1,000). Bonus consideration for integrating QIE ecosystem components.

### 2.2 Deadline
- Hub (page text, FAQ and the countdown in the page's script `2026-11-30T23:59:59+01:00`): submissions close **23:59 CET, 30 November 2026**; demo week Dec 1-5; winners Dec 10. Authoritative: it is the live submission portal.
- Medium (2026-07-22): "four-month build period running from 1 August through 10 December 2026". Conflicts; 10 December is the winners date on the hub. Treat 30 Nov 23:59 CET as the deadline. Today (2026-11-19) leaves 11 days.

### 2.3 Anti-abuse rules (hub text) and what the repo should show
Zero tolerance for: forked or recycled code ("code from previous hackathons or existing projects"); copied projects ("from Ethereum or other blockchain hackathons"); simple clones ("basic copies without meaningful innovation or differentiation");
AI-generated projects ("minimal developer contribution or effort"); no working demo. Disqualification is immediate, no appeal. Evidence to keep: dated commit history from the founder's own account across the build period;
the founder's own decision log (DECISIONS.md) and the ability to explain every contract; a README comparison with x402 batch-settlement and with other QIE entries stating real differences; credit for any spec the design follows;
nothing imported from Veylo or other projects; an honest AI disclosure that also says what the founder did (only if true); mainnet transactions that anyone can check.

### 2.4 Claims audit: what proof makes each claim true
See the table in the chat report. Never claim: first, only, unique, yield, APY, interest, compliance, audited, guaranteed.

## Part 3: competition

### 3.1 Qantara, SpendGrid, Fluenci, RemitChain, VeridiChain
- Source for what they do: only QIE's own announcement (2026-07-22), which is marketing. No independent coverage, repos, docs or demos found by web search; the hub's list of winners is behind the blocked admin API.
- Qantara: repo, docs, contracts COULD NOT CHECK (no explorer name match). Announced: invoices, milestone escrow, streaming, subscriptions, batch payouts, splits, gasless, SDKs.
  The unattributed PayEndpoint suite (3.1/1.4) matches that feature list closely (InvoiceVault, EscrowCore with relayer, RecurringMandate) but attribution is NOT proven.
- SpendGrid: COULD NOT CHECK (no repo, no contract name match). Announced: payment intents validated against budget, identity and liquidity rules.
- Fluenci: explorer name matches only: FluenciRegistry (29 txs), four "Fluenci Subscription NFT" contracts (21-36 txs each), three FluenciAIAuditor contracts (2-12 txs). Streaming, AI agents that freeze streams: announced, not verified. No pay-per-call, MCP or x402 evidence.
- RemitChain: one verified contract `0xc1D5...F0c2`, 1 transaction (deployed 2026-06-13). VeridiChain: one unverified credential NFT contract, 1 transaction.
- Overlap matrix is in the chat report.

### 3.2 QIE Wallet MCP and OctopusWork
- QIE Wallet MCP: CONFIRMED read-only ("does not sign or send transactions"), no sign-in, six tools: balances, network info, tx status, list tokens, resolve `.qie`, reverse lookup. Remote `https://mcp.qie.digital/mcp`. Source: `qieadmin/qie-wallet-mcp-listing` README and QIE's 2026-11-17 post.
- OctopusWork: CONFIRMED not live: "targeted for January 2027", an AI-agent paid-work marketplace with escrow. No contract named Octopus on mainnet.
- QIE has not announced payment tooling for MCP. It announced a planned "introductory gas grant of 0.0005 QIE for new wallets", and ChatGPT, Claude and Grok directory listings for the Wallet MCP.

## Part 4: routes and technical risks (fork tests in `fork17/`, block 12,018,928-12,018,959)

### 4.1 MCP clients
- Unmodified clients cannot attach a per-call signed payment. Evidence: Claude Code `--header` (static); Cursor `headers` in `mcp.json` (static); LangChain adapters `headers` per connection; Claude custom connectors
  authenticate by OAuth sign-in; VS Code HTTP servers follow the server's own authentication; none document 402 handling.
- OpenAI Agents SDK exposes `tool_meta_resolver`, "injects per-call MCP `_meta` payloads before `call_tool()`": the hook exists but needs code; it runs before the call so it cannot read a 402 price unless the price is known in advance.
- Where the signature travels in x402-over-MCP: `params._meta["x402/payment"]` of `tools/call`; the price arrives as a tool result with `isError:true` and `structuredContent` = PaymentRequired.
  Coinbase's client wrapper is `wrapMCPClientWithPayment` (`@x402/mcp`); it wraps the MCP SDK client, so it also needs code.
- Least friction (design, not tested): builder = an SDK middleware that returns PaymentRequired and verifies `_meta`; agent = a local stdio payment proxy or wallet MCP that handles the retry, or SDK-level wrapping for agent frameworks.

### 4.2 First approve (QUSDC has no permit and no EIP-3009; confirmed on the fork)
| Option | Payer needs | Facilitator pays | Gas (measured) |
| --- | --- | --- | --- |
| baseline | needs QIE, 0 fails ("max upfront cost 0.000129 QIE") | - | - |
| A. seed the wallet with QIE | 0.0002 QIE (EIP-1559 default fee fields, warm router) or 0.00015 (legacy gas price); 0.00017 failed; first deposit into a cold router needed more | the seed | approve 46,961; deposit 103,337 first / 69,137 later |
| B. deposit box per payer (anyone sweeps) | nothing, but the QUSDC must arrive from another account | box creation 248,705 gas; sweep 85,577 | transfer into box 47,374 |
| C. facilitator tops up exact gas and broadcasts the payer's signed approve and deposit | 0 QIE at start | 0.000214 QIE top-up plus own cost; total 0.000237 QIE | approve 46,961; deposit 69,137 |
| D. payer signs ONE approve to a pull-helper; anyone pulls deposits | 0 QIE if topped up; 1 payer tx | pull 97,012-110,692 gas | approve 46,961 |
Pull beyond the allowance reverted. QIE's planned 0.0005 QIE grant covers approve plus first deposit about 3 times. A new wallet holding QUSDC but no QIE cannot move it by itself (no permit, no EntryPoint).

### 4.3 Limits
- Router runtime 7,763 B and vault 6,174 B against the 24,576 B limit; Shanghai compile; header gas limit 4,294,967,295 (read live). A node accepted `eth_call` with 100M gas (2026-11-18). Real per-transaction size limit: COULD NOT CHECK (nothing is sent).
- Fork batches (gas, per intent, calldata): A (one payer, one builder): 50 = 1,982,343 (39,646); 100 = 3,892,502 (38,925; 34.5 KB); 200 = 7,718,140 (38,590; 68.9 KB); 400 = 15,385,645 (38,464; 137.6 KB).
  B (all different): 50 = 3,290,627 (65,812); 100 = 6,535,602 (65,356); 200 = 13,030,768 (65,153); 400 = 26,038,281 (65,095). All settled in full. Costs at 1.125 gwei and $0.164856: B200 = 0.0147 QIE ($0.0024).

### 4.4 Verification
- Explorer is Blockscout v7.0.2. Live config: options standard-input, flattened-code, multi-part; compiler `v0.8.24+commit.e11b9ed9` listed (our exact build); EVM `shanghai` listed; 96 solc versions.
- Documented endpoint (Blockscout docs, self-hosted form): `POST https://mainnet.qie.digital/api?module=contract&action=verifysourcecode` with form fields `contractaddress`, `contractname`, `codeformat` (`solidity-standard-json-input`), `sourceCode`, `compilerversion`, `optimizationUsed`, `runs`, `evmversion`, `constructorArguments`, `licenseType`; status via `action=checkverifystatus&guid=` (answers on QIE).
- Hardhat 2: `@nomicfoundation/hardhat-verify@hh2` with `customChains` (`chainId 1990`, `apiURL https://mainnet.qie.digital/api`, `browserURL https://mainnet.qie.digital`) and any non-empty API key string (docs example is for a hosted instance; applying it to QIE is an extrapolation). Foundry: `--verifier blockscout --verifier-url https://mainnet.qie.digital/api/` (extrapolated). Nothing submitted.
- Other teams' contracts are verified on QIE with the same compiler string, so verification works in practice. Whether QIE requires an API key: COULD NOT CHECK without a submission.
- Testnet dry-run proposal (not done, needs founder approval): a throwaway key generated locally; QIE testnet faucet (qie.digital/faucet per the hub); a test ERC-20 (testnet QUSDC address unknown); deploy router; run smoke; verify via standard-input JSON; testnet gas price was 7 wei. Rehearsal only (hackathon rejects testnet-only).

### 4.5 QUSDC dependence (re-run 2026-11-19, `raw/p4/s04...`, `s05...`)
- CONFIRMED: `DEFAULT_ADMIN_ROLE` is held by `0xe1ac...8D28`, an **ordinary key-controlled account (no code)**; `VAULT_ROLE` by contract QUSDVault `0xdC20...3D45` (2,792 B, verified, no owner; `burnAndWithdraw` burns only the caller). Two `RoleGranted` events ever (blocks 5,244,996 and 5,245,201), no revocations. The same account owns WUSDC (bridge-backed).
- Proven on the fork (Slice 1): an account that grants itself `VAULT_ROLE` can burn any holder's balance.
- README sentence: "QUSDC's admin account can give itself the right to burn any holder's QUSDC, including the router's; the router cannot prevent that. Keep prepaid balances small and withdraw to your own wallet often."

### 4.6 Acquiring about 10 QUSDC and 5 QIE
- QIEDEX (today's pool QUSDC 4,631.14 / WQIE 28,237.54): buying 10 QUSDC costs 61.29 QIE (0.52% above spot, 0.2% of the pool's QUSDC); 100 QUSDC costs 625.06 QIE (2.51% above spot). Spot 1 WQIE = 0.16401 QUSDC; explorer QIE price $0.164856.
- Cheapest realistic route (computed): about 66 QIE total (61.3 for the QUSDC, a few for gas) swapped on QIEDEX, roughly $11. Where to buy that QIE cheaply (exchange): COULD NOT CHECK. Bridging USDC from Ethereum: Ethereum gas cost not measured; bridge fees and limits: not published on the pages read, COULD NOT CHECK. QUSDC total supply 9,171.13, so 10 QUSDC is 0.11% of supply.

### 4.7 Relayer and facilitator (design)
Plain Node service on Vercel (Veylo already runs Vercel and Neon) or a small VPS; one dedicated hot key holding at most about 1 QIE (about 68 batches of 200), no QUSDC, not the owner, not the fee recipient. If compromised it can: spend its own QIE; submit valid signed intents and withdraw requests for anyone; delay or censor; capture relayer fees that signers already allowed.
It cannot: move a payer's or builder's balance (destination and relayer fee are inside the signatures), change the fee, or call owner functions. Caps: per-transaction gas limit, max gas price, daily QIE budget, a destination allowlist of the router address, alerts at 50%, manual top-up. Vercel function time limits: COULD NOT CHECK today.

## Part 5: see the chat report

## Raw outputs index
`raw/p1`: registry crawls and analysis (`official-registry-latest.jsonl`, `-analysis.json`, `-concentration.json`), `bazaar-summary.json`, GitHub counts, HN, x402 pages and specs.
`raw/p2/2.1-faq-verbatim.txt`, hub script. `raw/p3-*.json`: explorer searches, suite and competitor data. `raw/p4*`: client docs, verification config, fork results (`p4-approve.json`, `p4-seed.json`, `p4-batch.json`, `p4-costs.json`), role re-runs, swap quotes.
Earlier findings reused: `raw/s01`-`s28` (chain, QUSDC, roles, pools, swap, infra, Safe, QIE ID, costs, hackathon pages, Medium feed).
