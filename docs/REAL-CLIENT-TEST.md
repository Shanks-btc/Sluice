# Trying Sluice from Claude Code and Cursor

This is a test for the founder to run. **Nothing here has been run in Claude Code or in Cursor.** The configuration below is written from what those clients document for MCP servers, and it has not been checked against either of them. One MCP client has run this path: a script that uses the official MCP SDK client, described in [What has been tried](#what-has-been-tried).

Claude Code, Cursor and the other applications change how they read configuration. Check each one's own documentation for the current format before you rely on a line here.

## Contents

- [What has been tried](#what-has-been-tried)
- [What you need](#what-you-need)
- [Step 1: run the scripted client](#step-1-run-the-scripted-client)
- [Step 2: write the proxy's config](#step-2-write-the-proxys-config)
- [Step 3: add the proxy to Claude Code](#step-3-add-the-proxy-to-claude-code)
- [Step 4: add the proxy to Cursor](#step-4-add-the-proxy-to-cursor)
- [Step 5: ask for a paid tool](#step-5-ask-for-a-paid-tool)
- [What stays unverified until you run it](#what-stays-unverified-until-you-run-it)
- [If it does not work](#if-it-does-not-work)
- [What to record](#what-to-record)

## What has been tried

| What | Where | What it shows |
| --- | --- | --- |
| `scripts/client/smoke-client.ts`, a script that uses the official MCP SDK client | A local chain, with the proxy, the tool server and the facilitator each as a separate process | A client that speaks MCP over stdio can list the tools, make a paid call through the proxy, and receive the result and the payment response. |
| The same scenario with the real QUSDC | A local fork of QIE mainnet | The same, with the real token. |
| Claude Code, Cursor or any other MCP application | Nowhere | Nothing. |

The proxy and the tool server run the same code whichever client is in front of them, but how an application lists tools, shows a tool error, asks for approval, times out a slow call or passes environment variables is that application's own behaviour, and none of it has been seen.

## What you need

- A router, a facilitator and a tool server, hosted as in [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md) and [DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md). To try this without spending anything, use the testnet rehearsal in [REHEARSAL.md](REHEARSAL.md).
- An owner wallet with QUSDC deposited in the router, and an agent session key authorised for the tools you will try. [TRY-IT-AGENT.md](TRY-IT-AGENT.md) has the steps.
- `pnpm build`, which makes `packages/proxy/dist/cli.js`.

## Step 1: run the scripted client

Run this before the applications. If it fails, an application will fail the same way, and this prints every step.

```powershell
$env:SLUICE_AGENT_KEY = Get-Content .\agent.key
pnpm client:smoke --config .\sluice.config.json --tool contract_lookup --args '{"address":"0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5"}'
Remove-Item Env:SLUICE_AGENT_KEY
```

You should see six steps and a payment response with `success true`. The call is a scripted client's, and the output says so.

## Step 2: write the proxy's config

The proxy is what the application starts. It points at the hosted tool server, so the config names a URL, not a command. Save this as `sluice.config.json`, with your own addresses and dates. It holds no key.

```json
{
  "upstream": { "url": "https://tools.example.com/mcp" },
  "router": "0xYourRouter",
  "payer": "0xTheOwnersAddress",
  "budget": {
    "perCallCap": "0.02",
    "totalCap": "0.50",
    "expiresAt": "2026-12-31T00:00:00Z",
    "allowedTools": [
      { "tool": "token_risk_check", "payee": "0xTheBuildersAddress" },
      { "tool": "contract_lookup", "payee": "0xTheBuildersAddress" }
    ]
  },
  "logFile": "sluice-payments.jsonl",
  "stateFile": "sluice-budget.json"
}
```

Check it:

```powershell
$env:SLUICE_AGENT_KEY = Get-Content .\agent.key
node packages\proxy\dist\cli.js --config .\sluice.config.json --check
Remove-Item Env:SLUICE_AGENT_KEY
```

This prints the agent's address and the budget, never the key. The agent's address must be the one the owner authorised on the vault.

## Step 3: add the proxy to Claude Code

In `.mcp.json` at the root of a project (or with `claude mcp add`; see Claude Code's documentation). Use absolute paths.

```json
{
  "mcpServers": {
    "sluice-paid-tools": {
      "command": "node",
      "args": ["C:/path/to/Sluice/packages/proxy/dist/cli.js", "--config", "C:/path/to/sluice.config.json"],
      "env": { "SLUICE_AGENT_KEY": "0x...the agent's session key..." }
    }
  }
}
```

The file holds a session key. Keep it out of git. A session key can spend only inside the budget the owner set on chain, and the owner can revoke it. Never put the owner's key in this file: the proxy refuses to start with it.

## Step 4: add the proxy to Cursor

In `.cursor/mcp.json` in a project, or the global `mcp.json` in Cursor's settings folder.

```json
{
  "mcpServers": {
    "sluice-paid-tools": {
      "command": "node",
      "args": ["C:/path/to/Sluice/packages/proxy/dist/cli.js", "--config", "C:/path/to/sluice.config.json"],
      "env": { "SLUICE_AGENT_KEY": "0x...the agent's session key..." }
    }
  }
}
```

## Step 5: ask for a paid tool

Ask the assistant to use `contract_lookup` on an address, for example QUSDC's. Watch for:

1. The tool appears in the client's list, with the three tools' names.
2. The call goes through without a prompt about payment from the application. The proxy pays inside the owner's budget.
3. The answer comes back with the contract's details.
4. The facilitator's `/status/<id>` shows the payment move from `queued` to `settled`. The intent's id is in the reply's `_meta` under `x402/payment-response`, if the client shows it, and in the proxy's log file `sluice-payments.jsonl`.
5. A tool outside the allowed list, or a price above the cap, is refused with a reason (`unknown_tool`, `over_per_call_cap`), and nothing is paid.

## What stays unverified until you run it

| Question | Why nobody knows yet |
| --- | --- |
| Does the application start a stdio server from this config on Windows? | Paths, quoting and the `env` block are the application's. |
| Does it show the three tools, with their prices in the descriptions? | The proxy forwards what the tool server lists. How it is shown is the application's. |
| Does it wait long enough for a paid call? A paid call takes one extra round trip, to the facilitator, before the tool runs. | Timeouts differ between applications. |
| Does it show a refusal, which arrives as a tool error with a reason code, in a way a person can read? | Applications show tool errors differently. |
| Does it pass `_meta` through, so the payment response is visible? | The proxy puts it there. Whether the application keeps it is not known. |
| Does it ask the person to approve each tool call, and how does that sit with a call that pays? | An application's approval prompts are its own. |
| Does it run the proxy once per project or once per window, and does that matter for the budget file? | The proxy keeps its running total in `sluice-budget.json`. Two proxies on one file share one total; two files do not. |

## If it does not work

- Run Step 1 again. If the scripted client passes and the application fails, the difference is in the application's configuration or behaviour.
- The proxy writes to standard error only. An application usually keeps the server's error output in a log: look there for a line that starts `refusing` or `sluice-proxy ready`.
- `the session key is the owner's own address`: the key in `env` is the owner's. Use the agent's.
- `unknown_tool`: the tool is not in `allowedTools`, or the payee in the config is not the one the tool server names.
- `sluice_budget_exceeded` or `sluice_session_not_found` from the facilitator: the owner has not authorised this agent on the vault for that tool, or the session's budget is used up. See [TRY-IT-AGENT.md](TRY-IT-AGENT.md).
- A call that hangs: check the tool server's `/health` and the facilitator's `/health`.

## What to record

When you have run it, write in [FOUNDER-LOG.md](FOUNDER-LOG.md), in your own words: which application and which version, the date, what you saw at each step above, and what did not work. Add a screenshot or a copy of the proxy's log. Until that is written, the README's status for using Sluice from these applications does not change, and nothing in the repository says it works.
