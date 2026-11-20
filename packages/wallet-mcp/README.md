# @sluice/wallet-mcp

A stdio MCP server for an AI agent that pays with Sluice. It reads the same config file as the proxy.

| Tool | What it does |
| --- | --- |
| `balance` | The owner's prepaid QUSDC balance in the router, the QUSDC in the owner's wallet, and this agent's session. |
| `deposit_instructions` | How the owner funds the balance and authorises this agent: the exact `approve` and `deposit` calls, the `authorize` arguments, the option with no QIE, and the QUSDC admin risk. Sends nothing. |
| `price_check` | What a tool on the configured upstream costs, read from its advertisement and, with `arguments`, from its own payment-required answer, and whether this agent's budget would allow it. Pays nothing. |
| `pay_history` | The proxy's local log (payments, refusals, failures) and `Settled` events for the owner on the chain, in a recent block window. |
| `budget_status` | The owner's per-call cap, total cap, spent, remaining, expiry and allowed tools, from the local config and from the chain, with a warning when they disagree. |

## What it cannot do

It has no tool that signs, sends a transaction, takes a key, or changes a budget, and a test checks the tool list and every
parameter name. Only the owner's signature on the AgentVault can create, raise or revoke a session, so an agent cannot raise its
own budget. The session key is loaded only to learn this agent's address, and the program refuses to start if that key is the
owner's address, the router owner's or the fee recipient's. Paying is the proxy's job, with the same key.

The local spent total is read again on every query, because the proxy updates it from another process.

## `.qie` names

`balance` takes an address. A `.qie` name is not resolved: no documented on-chain read for QIE ID names was found. A third-party
contract verified on QIE says the QIE ID token answers `balanceOf` but not `ownerOf` or the ENS-style `addr` and `name` calls;
that was not checked here. The tool says this in its answer and points to the hosted QIE Wallet MCP's `qie_resolve_name` tool,
which is a remote service and not an on-chain read.

## Run it

```bash
pnpm build
SLUICE_AGENT_KEY=0x... node packages/wallet-mcp/dist/cli.js --config /path/to/sluice.config.json
```

The RPC is `rpcUrl` in the config, or `SLUICE_RPC_URL`, or QIE's public RPC. In a client's MCP configuration it is a second entry
beside the proxy: see `packages/proxy/README.md` for the static Claude Code and Cursor formats. Those were not run in either client.
