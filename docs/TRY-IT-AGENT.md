# Try Sluice as an agent's owner

This takes about ten minutes. You put some QUSDC in the router, give an agent a key that can spend only inside a budget you set, and make one paid call to a tool server through the payment proxy. The commands were run against a local chain in a test (`test/unit/e2e/try-it.test.ts`). A person outside the project has not followed them yet. If a step does not work for you, use the [issue form](../.github/ISSUE_TEMPLATE/i-tried-sluice.yml).

**Start on the testnet.** The maintainer gives you a router, a facilitator's address, a token's address and the address of a tool server. Nothing on the testnet has value.

## What you need

- A copy of this repository, built (`pnpm install`, then `pnpm build`).
- A wallet for the owner that holds only what you mean to put in. You will export its key to a file only you can read. Do not use a wallet that holds anything you cannot afford to lose.
- On the testnet, some of the token. Its mint is open: ask the maintainer, or call `mint` on the token from the explorer.
- The router, the facilitator's address, the tool server's address and the payee it names (its `/health` shows it).

## How it works in one paragraph

You hold the money. You deposit QUSDC in the router, which keeps it as a balance that is yours. You then sign a session for an agent's key: a budget, a limit for each call, an expiry and a list of tools. The agent signs payments only inside that session, and the router checks the session on chain, so the agent cannot spend more than you allowed, whatever its own config says. You can take back what is unspent at any time. A wallet with QUSDC and no QIE can do all of this by signing: the facilitator sends the transactions and pays the gas.

## Steps

1. Make the agent's key. This writes it to a file and prints only the address.

   ```powershell
   pnpm live:new-key .\agent.key
   ```

2. Set the environment for this window. The owner key is read from your file and used to sign on this machine only.

   ```powershell
   $env:SLUICE_NETWORK = "testnet"; $env:SLUICE_APPROVE = "owner-setup"; $env:SLUICE_KEY = (Get-Content .\owner.key -Raw).Trim(); $env:SLUICE_ROUTER = "0xTheRouter"; $env:SLUICE_FACILITATOR_URL = "https://the-facilitator.example"
   ```

3. Put QUSDC in the router. The wallet needs the token and no QIE. The facilitator sends it the QIE its two transactions can use, within its caps, and sends the transactions.

   ```powershell
   pnpm client:owner start --amount 5
   ```

   Expect `signed an approval and a deposit ... (nothing sent yet)`, then the transaction hashes, then `done: 5.000000 QUSDC is in the router`. The script stops at 10 QUSDC unless you raise `SLUICE_MAX_QUSDC`, and cannot go above 100. A wallet that already holds QIE gets no top-up.

4. Authorise the agent. Give its address from step 1, the budget, the limit for a call, the number of days, and each tool with the address that is paid for it.

   ```powershell
   pnpm client:owner authorize --agent 0xTheAgentAddress --budget 0.5 --per-call 0.02 --days 7 --tool summarise=0xTheBuildersAddress
   ```

   Expect `signed the agent session`, then `authorised: 0x...`. The script refuses an agent key that is your own.

5. Write the proxy's config, with the same limits and tools. Save it as `sluice.config.json`. It holds no key.

   ```json
   {
     "upstream": { "url": "https://tools.example.com/mcp" },
     "router": "0xTheRouter",
     "payer": "0xTheOwnersAddress",
     "chainId": 1983,
     "asset": "0xTheTestToken",
     "budget": {
       "perCallCap": "0.02",
       "totalCap": "0.50",
       "expiresAt": "2026-12-31T00:00:00Z",
       "allowedTools": [{ "tool": "summarise", "payee": "0xTheBuildersAddress" }]
     },
     "logFile": "sluice-payments.jsonl",
     "stateFile": "sluice-budget.json"
   }
   ```

   On mainnet, leave out `chainId` and `asset`: the defaults are chain 1990 and QUSDC. The proxy's own refusals and the vault's limits are two separate checks: keep the two sets of numbers the same. Check the file, with the agent's key in the session:

   ```powershell
   $env:SLUICE_AGENT_KEY = (Get-Content .\agent.key -Raw).Trim()
   ```

   ```powershell
   node packages\proxy\dist\cli.js --config .\sluice.config.json --check
   ```

   Expect the agent's address and the budget, and never the key.

6. Make one paid call with the scripted client.

   ```powershell
   pnpm client:smoke --config .\sluice.config.json --tool summarise --arg url=https://example.com
   ```

   Expect six steps and `payment response: success true`. The reply says the payment is `queued`: the facilitator has it and will send a batch to the router within a few seconds. Ask the facilitator where it is:

   ```powershell
   Invoke-RestMethod https://the-facilitator.example/status/0xTheIntentId
   ```

   The status goes from `queued` to `settled`, with a transaction hash.

7. Clear the secrets from this window.

   ```powershell
   Remove-Item Env:SLUICE_KEY; Remove-Item Env:SLUICE_AGENT_KEY; Remove-Item Env:SLUICE_APPROVE
   ```

## Taking money back, and stopping the agent

- The part of your deposit that is unspent is yours. The web app's wallet page (`apps/web`, the `/wallet` route) shows the balance, refunds it and revokes an agent's session. You sign each, and the facilitator can submit them, so you need no QIE.
- The agent's session ends at its expiry. Revoking it ends it sooner.
- The agent's key can spend only inside the session. If it leaks, the most it can spend is what is left of the budget, and you can revoke it.

## What can go wrong

| What you see | Why |
| --- | --- |
| `the wallet holds ... less than the ... to put in` | The owner's wallet has less of the token than `--amount`. |
| The facilitator refuses a start | It says why: a second start in a day, an amount above its cap, a wallet that needs more than its top-up cap, or a nonce that is not the wallet's next. |
| `sluice_session_not_found` or `sluice_tool_not_allowed` | The agent's session does not exist yet, or does not list that tool and payee. Run step 4 again with the right tool and payee. |
| `sluice_budget_exceeded` | The session's budget is spent. Authorise a new one. |
| `unknown_tool` or `over_per_call_cap` from the proxy | The proxy's own config refused before anything was signed. |

## What you are trusting

- The facilitator sends your transactions and pays gas. It cannot move your QUSDC: every payment is a signature your agent's key made inside your session, and the router checks it.
- QUSDC has an admin that can burn a holder's balance. That power is outside Sluice, and a router balance is a QUSDC balance. [RISKS.md](RISKS.md) says what it is.
- No outside party has reviewed the router. Put in what you can afford to lose.
