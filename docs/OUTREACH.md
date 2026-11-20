# Outreach drafts

Three short messages the founder can adapt and send, in the founder's own name and words. This file only drafts them: nothing has been sent, and the founder decides whether, where and when.

Each one says what Sluice is, what it is not, and what asking someone to do costs them. Each one links a page that was followed on a local chain in a test and has not yet been followed by an outside person. Read each against the facts below before you send it, and take out anything that is not true on the day.

## Facts every message must keep true

- The product, in the words the README uses and no others: "Payment middleware that lets MCP builders get paid, with an MCP-compatible wallet so AI agents can pay for the tools and services they use. Agents pay per request on QIE using HTTP 402-style payments, in QUSDC, with no manual subscriptions or API keys."
- It is an independent scheme. It is **not** an official x402 scheme: QUSDC supports neither EIP-3009 nor Permit2, so Sluice uses a prepaid balance in a router contract and signed payments against it. [SPEC.md](SPEC.md) says exactly what it is.
- The payer **prepays**. Money sits in the router as the payer's balance until a signed call spends it, and the payer can take back what is unspent.
- QUSDC has an admin that can burn a holder's balance, and a router balance is a QUSDC balance. That power is outside Sluice. [RISKS.md](RISKS.md) says what it is. Say so in every message that asks someone to put funds in.
- No outside party has reviewed the contracts. Do not describe them as safe, secure or checked.
- Do not say the product is live, deployed, running or used until [EVIDENCE.md](EVIDENCE.md) has verified mainnet rows that show it, and say which network a try-out is on.
- Do not say what the founder did, tested or reviewed beyond what [FOUNDER-LOG.md](FOUNDER-LOG.md) records in the founder's own words.
- The code was written with an AI coding assistant, Claude Code, and the README says so. If someone asks, say so.

## 1. To an MCP builder

Subject: A way to charge per call for an MCP tool, on QIE: would you try it?

> Hi [name],
>
> I'm working on Sluice. Payment middleware that lets MCP builders get paid, with an MCP-compatible wallet so AI agents can pay for the tools and services they use. Agents pay per request on QIE using HTTP 402-style payments, in QUSDC, with no manual subscriptions or API keys. For you, that means you put a price in QUSDC on a tool; a call with no payment gets the price back, and a call with a signed payment runs the tool. Payers prepay a balance in a router contract, so there is no per-call transaction for them to sign and no subscription or API key.
>
> It is its own scheme and not an official x402 one, because QUSDC has no permit or EIP-3009 to build that on. I've only run it on a local chain and a local copy of QIE mainnet. I'm asking for [ten] minutes on the testnet, where nothing has value: wrap one tool with the SDK, run it, and tell me where it stops making sense.
>
> The steps are here: [link to TRY-IT-BUILDER.md]. They end with a form for what went wrong or what was unclear, and a broken step is as useful to me as a working one.
>
> What I can't tell you yet: whether any agent will find your tool, whether the price model suits it, or whether it holds up under real traffic.
>
> [Your name]

## 2. To someone who might pay

Subject: Would you let an agent pay for MCP tools from a budget you set?

> Hi [name],
>
> Sluice lets an agent pay for MCP tools per call, from a balance you put in a router contract, inside a budget you set: an amount, a limit for each call, an expiry and a list of tools. The agent holds a key that can spend only inside that session, and you can revoke it. You hold no subscription and the agent holds no API key for the tool.
>
> I'm asking you to try it on the testnet, where the token has no value, to see whether the steps make sense. It takes about [ten] minutes and a wallet you don't mind exporting a key from, so please use a new one: [link to TRY-IT-AGENT.md].
>
> Two things you should know before putting real money anywhere near it. The balance is prepaid, so it sits in the router until it is spent or you take it back. And QUSDC itself has an admin that can burn a holder's balance, which Sluice doesn't change; [link to RISKS.md] explains it. No one outside the project has reviewed the contracts. Nothing I'm asking involves mainnet.
>
> The page ends with a short form. Telling me it didn't work helps.
>
> [Your name]

## 3. To a developer community

Subject: Looking for people to try breaking an MCP payment tool

> Hi [community],
>
> I'm building Sluice. Payment middleware that lets MCP builders get paid, with an MCP-compatible wallet so AI agents can pay for the tools and services they use. Agents pay per request on QIE using HTTP 402-style payments, in QUSDC, with no manual subscriptions or API keys.
>
> Some honest limits. It is an independent scheme, not an official x402 one, because QUSDC has no permit or EIP-3009. The payer prepays a balance in a router contract. QUSDC's admin can burn a holder's balance, and that sits outside Sluice. No one outside the project has reviewed the contracts. It has been run on a local chain and a local fork of QIE mainnet, and nowhere else; I'm about to rehearse it on the testnet.
>
> What I'd like: read the spec ([link to SPEC.md]), or run the testnet steps ([link to TRY-IT-BUILDER.md] or [link to TRY-IT-AGENT.md]), and tell me what is wrong, missing or unclear. Reports go in an issue form ([link]) that asks what broke first. If you want to try breaking the contracts, the tests and the fork tests are in the repository, and I'd like to hear what they miss.
>
> [Your name]

## After someone replies

- Thank them, and say what you will do with what they said.
- Do not count anyone as a user because they said they would try it. A person counts when their address is in a settlement on the chain that is not one of the project's own wallets, and that is what `pnpm evidence:summary` reads.
- Do not quote someone without asking them.
- Record what you sent and to whom in [FOUNDER-LOG.md](FOUNDER-LOG.md).
