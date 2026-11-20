# @sluice/proxy

A stdio MCP payment proxy. An agent runs it in front of any upstream paid MCP server that speaks x402 over MCP with the
scheme `sluice-intent`. It forwards every call. When the server answers "payment required", it checks the price against
the owner's budget, signs an intent with the agent's session key, retries the call once with the payment attached, and
returns the result. Every payment, refusal and failure goes into a local log.

## What it refuses

It does not pay, and says why to the agent as a tool error with a reason code, when:

| Code | The call asked for |
| --- | --- |
| `unknown_tool` | a tool the owner did not list |
| `payee_not_allowed` | a payee the owner did not name for that tool |
| `tool_id_mismatch` | payment for a tool id that is not the tool that was called |
| `over_per_call_cap` | a price above the per-call cap |
| `over_total_cap` | a purchase that would pass the total cap |
| `budget_expired` | any payment after the budget's expiry |
| `unsupported_requirements` | another router, network, asset or scheme than the config names |
| `invalid_amount` | a price that is zero or not a number |

The total is counted and written to disk before the signed payment leaves the proxy, so a crash or a failed retry can only make
it think more was spent, never less. An unreadable state file counts as fully spent. It pays at most once per call. It signs
only with the session key it was given, and refuses to start if that key is the owner's own address. The key is not passed to
the upstream process. The chain enforces the same limits in the AgentVault, so a looser local config cannot spend past what the
owner authorised on chain.

## Configuration

A JSON file, passed with `--config` (or `SLUICE_CONFIG`). It holds no key.

```json
{
  "upstream": { "command": "node", "args": ["examples/paid-tools/dist/cli.js"], "env": { "SLUICE_ROUTER": "0x...", "SLUICE_FACILITATOR_URL": "https://...", "SLUICE_PAYEE": "0x..." } },
  "router": "0x...",
  "payer": "0xTheOwnersAddress",
  "budget": {
    "perCallCap": "0.05",
    "totalCap": "1.00",
    "expiresAt": "2026-12-31T00:00:00Z",
    "allowedTools": [{ "tool": "token_risk_check", "payee": "0xBuildersAddress" }]
  },
  "logFile": "sluice-payments.jsonl",
  "stateFile": "sluice-budget.json"
}
```

`upstream` is either `{ "url": "https://..." }` (Streamable HTTP; plain http only for the local machine) or a `command` with
`args`, `env` and `cwd` for a stdio server. Amounts are QUSDC with at most six places. `payer` is the owner whose prepaid
router balance pays. Relative file names are relative to the config file. The session key is read from the environment
variable named by `sessionKeyEnv` (default `SLUICE_AGENT_KEY`).

The owner makes the same limits real on chain by authorising the agent's address on the vault (`authorize`, or by signature with
`signAuthorize` from `@sluice/sdk`, so the owner needs no QIE). `node packages/proxy/dist/cli.js --config <file> --check`
validates the file and prints the agent address and the budget, never the key.

## Use it from Claude Code and Cursor

These are static configuration for the two clients' documented MCP formats. They were **not** run in Claude Code or in Cursor:
no real MCP client was used to test this repository. Check each client's own documentation for the current format. Build first
with `pnpm build`, and replace the absolute paths.

Claude Code, in `.mcp.json` at the project root (or added with `claude mcp add`):

```json
{
  "mcpServers": {
    "sluice-paid-tools": {
      "command": "node",
      "args": ["/absolute/path/to/Sluice/packages/proxy/dist/cli.js", "--config", "/absolute/path/to/sluice.config.json"],
      "env": { "SLUICE_AGENT_KEY": "0x...the agent's session key..." }
    }
  }
}
```

Cursor, in `.cursor/mcp.json` (or the global `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sluice-paid-tools": {
      "command": "node",
      "args": ["/absolute/path/to/Sluice/packages/proxy/dist/cli.js", "--config", "/absolute/path/to/sluice.config.json"],
      "env": { "SLUICE_AGENT_KEY": "0x...the agent's session key..." }
    }
  }
}
```

Both configs hold a session key, so keep the file out of git. A session key is meant to be low-stakes: it can spend only inside the
budget the owner set on chain, and the owner can revoke it. Never put the owner's key there. Some clients can read an
environment variable into this field instead of holding the key in the file; whether yours does is for its documentation to say.
Run the wallet MCP next to it (see `packages/wallet-mcp`) as a second server entry with the same config file.

## Tests

`test/unit/proxy` (config, policy, paying a real paid server) and `test/unit/e2e` (the proxy as its own process, in front of the
example paid tools, on a local chain).
