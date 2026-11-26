# A local run against mainnet

**This is a local run against mainnet, not a hosted product.** The facilitator and the tool server run on your own computer, answer at `127.0.0.1`, and stop when you close their windows. Nobody else can reach them. The transactions are real, on QIE mainnet, with real QUSDC and real QIE.

**What has happened on mainnet is what [EVIDENCE.md](EVIDENCE.md) records.** It holds rows with this page's addresses and amounts: a start with no QIE, three paid-call settlements, the builder's withdrawal and the payer's refund, all founder-run. A row shows a transaction; it does not show which program signed it or whether these steps were followed as written. The page's commands, settings and arguments are also read out of it and run by a test on a local chain, with throwaway keys and stand-ins for QUSDC, the exchange and the explorer. That test does not run PowerShell, and says nothing about how mainnet, its endpoints or its explorer behave on another day.

## What the run does

One payer who holds QUSDC and no QIE starts, makes three paid tool calls, and the builder withdraws what it earned. A relayer pays the gas.

| Who | Address | Key file, in the repository's folder | Needs before you start |
| --- | --- | --- | --- |
| Payer | `0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C` | `payer-mainnet.key` (you make it) | 0.05 QUSDC, 0 QIE |
| Builder (the payee) | `0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E` | `builder-mainnet.key` (you make it) | nothing |
| Relayer | `0x0A021bC732325C57E0cC838E4111A861b84fFEB1` | `relayer-mainnet.key` (made earlier) | 0.1 QIE |

Router `0xf6F4C1Cc954B1798d134750438ada58768978716`, QUSDC `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5`.

The last column is what the page was written for. A run changes the balances, and the start in step 5 leaves a little QIE in the payer's wallet, so the same payer cannot start with no QIE a second time. Step 1 shows what each address holds today and says when to stop.

## What it spends, and what can be undone

QIE figures are at a gas price of 1.125 gwei, read from mainnet on 2026-11-26, with the gas measured on a fork in [GAS.md](GAS.md). They are estimates.

| Step | QUSDC | QIE, from the relayer | Can it be undone? |
| --- | --- | --- | --- |
| 1 to 4: look, start the two programs, check them | nothing | nothing | Yes: close the windows |
| 5: start with no QIE | 0.02 from the payer's wallet into the router | about 0.00026 (about 0.000235 of it is sent to the payer) | The transactions, no. Unspent QUSDC comes back with step 9. The QIE does not come back. |
| 6: three paid calls | 0.017 of the 0.02: 0.01683 to the builder's earnings, 0.00017 to the fee recipient | about 0.000125 for each batch | No. A settled payment is final. |
| 8: the builder withdraws | 0.01683 from the router to the builder's wallet | about 0.000115 | No |
| 9: the payer takes back the rest (optional) | 0.003 from the router to the payer's wallet | about 0.000115 | No (it can be deposited again) |
| 7 and 10: record and check | nothing | nothing | A recorded row stays: it describes a real transaction |

In all: about 0.001 QIE of the relayer's 0.1, and at the end the payer holds 0.033 QUSDC in its wallet and the builder 0.01683.

## The caps used here

| Cap | Value | What it bounds |
| --- | --- | --- |
| `SLUICE_MAX_QIE` on the facilitator | 0.003 | Everything the relayer spends in a UTC day, top-ups included. About three times what the run needs, and above its cost at the facilitator's gas price ceiling of 2 gwei. |
| `SLUICE_FACILITATOR_MAX_TOPUP_QIE` and `..._PER_ADDRESS_QIE` | 0.0004 | One top-up, and all of one address's in a day. A start signs 190,000 gas, which is 0.00038 QIE at 2 gwei. |
| `SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC` | 0.02 | The deposit a start may make |
| `SLUICE_FACILITATOR_PAYER_DAILY_QUSDC` and `..._DAILY_QUSDC` | 0.03 | Payments queued in a day: the three calls (0.017) and room to repeat one |
| `SLUICE_MAX_QUSDC` at step 5 | 0.02 | What `client:owner` may move out of the payer's wallet |
| `SLUICE_MAX_QUSDC` at step 6 | the call's price | What one `client:call` may pay |

## Before you start

You need Windows PowerShell, Node, pnpm, and this repository. Run every command from the repository's folder.

1. Install and build. Nothing is sent anywhere but to the package registry.

   ```powershell
   pnpm install
   ```

   ```powershell
   pnpm build
   ```

2. Make the two key files. In Notepad, put one private key on one line (`0x` and 64 characters) and save it as `payer-mainnet.key`, then the same for `builder-mainnet.key`, in the repository's folder. Git ignores every `*.key` file. Do not type a key into a terminal, a chat or any other file. `relayer-mainnet.key` was made earlier and should be there. Each command below checks that a key is the address it expects, and never prints it.

3. If your payer or builder key is already in a file under another name, use that name in the commands instead.

## Step 1: look before you start

Open a PowerShell window. Call it **window C**. Both commands are read-only.

```powershell
$env:SLUICE_NETWORK = "mainnet"
$env:SLUICE_ROUTER = "0xf6F4C1Cc954B1798d134750438ada58768978716"
```

```powershell
pnpm live:balances --address 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --address 0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E --address 0x0A021bC732325C57E0cC838E4111A861b84fFEB1
```

Expect the payer with `QIE 0` and `QUSDC in wallet 0.050000`, and the relayer with `QIE 0.1`. **Stop if** the payer holds under 0.02 QUSDC, or holds any QIE (the start in step 5 is then an ordinary deposit, and cannot be recorded as a start with no QIE).

```powershell
pnpm live:facts
```

Expect `These match what docs/RISKS.md says.` **Stop on a difference** and read [RISKS.md](RISKS.md): QUSDC's admin can burn a balance, and this is the moment to see whether who holds that power has changed.

Spends: nothing. Undo: nothing to undo.

## Step 2: start the facilitator

Open a new PowerShell window, **window A**, in the repository's folder. A new window holds no setting left over from other work.

```powershell
$env:SLUICE_NETWORK = "mainnet"
$env:SLUICE_APPROVE = "facilitator"
$env:SLUICE_ROUTER = "0xf6F4C1Cc954B1798d134750438ada58768978716"
$env:SLUICE_MAX_QIE = "0.003"
$env:SLUICE_FACILITATOR_MAX_TOPUP_QIE = "0.0004"
$env:SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE = "0.0004"
$env:SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC = "0.02"
$env:SLUICE_FACILITATOR_PAYER_DAILY_QUSDC = "0.03"
$env:SLUICE_FACILITATOR_DAILY_QUSDC = "0.03"
$env:SLUICE_FACILITATOR_STATE = ".local-mainnet\queue.jsonl"
$env:SLUICE_FACILITATOR_KILL_FILE = ".local-mainnet\KILL"
$env:SLUICE_FACILITATOR_HOST = "127.0.0.1"
$env:SLUICE_FACILITATOR_PORT = "8402"
$env:SLUICE_FACILITATOR_URL = "http://127.0.0.1:8402"
```

Make the folder for the queue (git ignores it), read the relayer's key into this window only, and start.

```powershell
New-Item -ItemType Directory -Force .local-mainnet | Out-Null
$env:SLUICE_RELAYER_KEY = (Get-Content .\relayer-mainnet.key -Raw).Trim()
```

```powershell
pnpm start:facilitator
```

Expect a line with `"msg":"started"` that names `"relayer":"0x0A021bC732325C57E0cC838E4111A861b84fFEB1"`, `"chainId":1990`, `"store":"journal"` and `"dailyBudgetWei":"3000000000000000"`. **Stop (Ctrl+C) if** the relayer is another address. A message that starts `refusing to start` names the setting to fix. Leave the window running.

Spends: nothing by starting. Undo: Ctrl+C.

**To stop all spending at once**, from window C: `New-Item -ItemType File .local-mainnet\KILL`. Delete the file to carry on.

## Step 3: start the tool server

Open a third window, **window B**, in the repository's folder.

```powershell
$env:SLUICE_NETWORK = "mainnet"
$env:SLUICE_ROUTER = "0xf6F4C1Cc954B1798d134750438ada58768978716"
$env:SLUICE_PAYEE = "0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E"
$env:SLUICE_FACILITATOR_URL = "http://127.0.0.1:8402"
$env:SLUICE_TOOLS_HOST = "127.0.0.1"
$env:SLUICE_TOOLS_PORT = "8403"
$env:SLUICE_TOOLS_PRICES = "dex_quote=0.002,contract_lookup=0.005,token_risk_check=0.01"
```

```powershell
pnpm start:paid-tools --http
```

Expect a line with `"msg":"started"` that names `"payee":"0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E"` and the three tools. Leave the window running.

Spends: nothing, ever: it holds no key. Undo: Ctrl+C.

## Step 4: check both from window C

```powershell
pnpm live:hostcheck --facilitator http://127.0.0.1:8402 --tools http://127.0.0.1:8403
```

Expect `PASS` on every line and `0 failed`. **Stop on a `FAIL`**: it names what is wrong.

Spends: nothing. It asks for `/health` and nothing else.

## Step 5: the payer starts with no QIE

In window C. The payer signs an approval and a deposit of 0.02 QUSDC; the facilitator sends the payer the QIE those two can use, then broadcasts them.

```powershell
$env:SLUICE_APPROVE = "owner-setup"
$env:SLUICE_MAX_QUSDC = "0.02"
$env:SLUICE_FACILITATOR_URL = "http://127.0.0.1:8402"
$env:SLUICE_KEY = (Get-Content .\payer-mainnet.key -Raw).Trim()
```

```powershell
pnpm client:owner start --from 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --amount 0.02
```

Expect `top-up from the facilitator: 0x...`, `approval: 0x...`, `deposit:  0x...`, `done: 0.020000 QUSDC is in the router`, and a `record it:` line holding the deposit's and the top-up's hashes.

**Stop if** it says the facilitator did not start the wallet. A wallet gets one start with no QIE in a UTC day, counted before any QIE is sent. If a top-up was sent and a later transaction failed, look at the payer on the explorer before doing anything else.

Spends: 0.02 QUSDC from the payer's wallet; about 0.00026 QIE from the relayer. A little of the QIE sent to the payer stays in the payer's wallet. Undo: the transactions cannot be undone; step 9 brings unspent QUSDC back.

Record it, with the two hashes from the output:

```powershell
pnpm evidence:record --claim relayed-start --tx 0xDepositHash --topup 0xTopUpHash --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716
```

Expect `recorded 1 row`. If it refuses, it says why and writes nothing. Do it soon: it reads the payer's QIE balance from before the top-up, and a node may not keep old state for long.

## Step 6: three paid calls

Still in window C, with the payer's key. Each command asks the tool for its price, refuses an offer that is not for this router, QUSDC and this payee or that is above the cap, signs one payment, gets the answer and waits for the settlement. No session or agent key is made. To use the payment proxy instead, see [Through the proxy instead](#through-the-proxy-instead).

```powershell
$env:SLUICE_APPROVE = "paid-call"
$env:SLUICE_MAX_QUSDC = "0.002"
```

```powershell
pnpm client:call --server http://127.0.0.1:8403/mcp --from 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --payee 0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E --tool dex_quote --arg tokenIn=QIE --arg tokenOut=0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5 --arg amountIn=1
```

```powershell
$env:SLUICE_MAX_QUSDC = "0.005"
```

```powershell
pnpm client:call --server http://127.0.0.1:8403/mcp --from 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --payee 0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E --tool contract_lookup --arg address=0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5
```

```powershell
$env:SLUICE_MAX_QUSDC = "0.01"
```

```powershell
pnpm client:call --server http://127.0.0.1:8403/mcp --from 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --payee 0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E --tool token_risk_check --arg address=0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5
```

Expect, for each: `signed a payment of ... QUSDC`, `the tool answered: ...`, `settlement: settled, transaction 0x...`, and two `record it:` lines.

- A call that fails is not charged: the tool server queues a payment after the tool has answered. The tools read mainnet and the explorer, so one may fail on a bad day; run it again.
- `not settled yet` means the facilitator holds the payment. **Do not pay again.** Open the status address it prints a little later. A payment that is not sent within five minutes expires, and is not charged.

Spends: the price of each call from the payer's balance in the router (0.002, 0.005 and 0.01 QUSDC); about 0.000125 QIE from the relayer for each batch. Undo: a settled payment cannot be undone.

## Step 7: record the three settlements

Use each call's transaction hash. Each command writes rows to `docs/EVIDENCE.md` after reading the transaction back from QIE's public RPC.

```powershell
pnpm evidence:record --claim paid-call-settlement --tx 0xBatchHash1 --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716 --tool dex_quote
pnpm evidence:record --claim settle-batch --tx 0xBatchHash1 --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716
```

```powershell
pnpm evidence:record --claim paid-call-settlement --tx 0xBatchHash2 --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716 --tool contract_lookup
pnpm evidence:record --claim settle-batch --tx 0xBatchHash2 --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716
```

```powershell
pnpm evidence:record --claim paid-call-settlement --tx 0xBatchHash3 --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716 --tool token_risk_check
pnpm evidence:record --claim settle-batch --tx 0xBatchHash3 --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716
```

If two calls show the same transaction hash, they were settled in one batch: record `paid-call-settlement` once for each tool, and `settle-batch` once for that hash.

A `paid-call-settlement` row shows that a signed payment was settled by someone other than its payer, payee and signer. It does not show that a tool call took place, or that anyone but you was involved.

Spends: nothing.

## Step 8: the builder withdraws

Read what the builder earned. Expect `earnings in router 0.016830`.

```powershell
pnpm live:balances --address 0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E
```

The builder holds no QIE, so it signs and the facilitator sends. If the earnings shown differ, use the figure shown as the amount.

```powershell
$env:SLUICE_APPROVE = "owner-setup"
$env:SLUICE_KEY = (Get-Content .\builder-mainnet.key -Raw).Trim()
```

```powershell
pnpm client:owner withdraw --from 0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E --amount 0.01683
```

Expect `withdrawn: 0x...` and a `record it:` line.

```powershell
pnpm evidence:record --claim withdraw --tx 0xWithdrawHash --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716
```

Spends: about 0.000115 QIE from the relayer. 0.01683 QUSDC moves from the router to the builder's wallet. Undo: no.

## Step 9: the payer takes back the rest (optional)

```powershell
$env:SLUICE_KEY = (Get-Content .\payer-mainnet.key -Raw).Trim()
```

```powershell
pnpm client:owner refund --from 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --amount 0.003
```

Expect `refunded: 0x...` and a `record it:` line. An account gets three signed requests of this kind (withdrawals, refunds, session changes) from the facilitator in a UTC day.

```powershell
pnpm evidence:record --claim refund --tx 0xRefundHash --network mainnet --router 0xf6F4C1Cc954B1798d134750438ada58768978716
```

Spends: about 0.000115 QIE from the relayer. Undo: no.

## Step 10: check

```powershell
pnpm evidence:check
```

Expect every row `PASS`.

`pnpm evidence:summary` leaves out every payment in which a wallet on [founder-wallets.json](founder-wallets.json) is the payer, the payee or the signer, and the web app's evidence page counts the same way. Version 2 of that list holds the payer, the builder and the relayer of this run and the router's deployer, owner and fee recipient. So the summary should count none of this run's three calls as paid calls, nor the two settlements made before it, in blocks 12119315 and 12119319: it reports them as left out. If you pay or are paid from any other wallet of yours, add that one first, with a new entry in the list's history.

```powershell
$env:SLUICE_FROM_BLOCK = "12119118"
pnpm evidence:summary
```

```powershell
pnpm live:balances --address 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --address 0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E --address 0x0A021bC732325C57E0cC838E4111A861b84fFEB1
```

## Step 11: stop and clear up

In window A and window B press Ctrl+C. Then clear the secrets, and close all three windows.

```powershell
Remove-Item Env:SLUICE_KEY, Env:SLUICE_APPROVE, Env:SLUICE_RELAYER_KEY, Env:SLUICE_AGENT_KEY -ErrorAction SilentlyContinue
```

- Keep `.local-mainnet\queue.jsonl`. It is the record of what the facilitator queued and sent.
- The key files stay on this disk until you delete them. Delete `payer-mainnet.key` or `builder-mainnet.key` **only if you hold the same key somewhere else**: a deleted key cannot be recovered, and what its address holds goes with it.

After new rows are recorded, some pages are out of date and `pnpm test` says so: the row counts and the paragraphs of the README that list the rows, and what [RISKS.md](RISKS.md) lists as not tested. [OUTREACH.md](OUTREACH.md) also says what is recorded. Change the words to what the rows show, run `pnpm web:content`, then `pnpm test`. The rows are from a run on your own computer: they show transactions on mainnet, not a hosted service.

## Through the proxy instead

This replaces step 6. The payer authorises a key made for the agent, and the payment proxy pays inside that key's budget. It costs the relayer one more transaction. Do steps 1 to 5 first.

Make the agent's key. Only its address is printed. The command goes on to talk of sending QIE and of the relayer's and deployer's keys: none of that applies to an agent's key, which signs and never holds funds.

```powershell
pnpm live:new-key .\.local-mainnet\agent.key
```

Authorise it, with the address that command printed. The budget is exactly what the three calls cost, for one day.

```powershell
$env:SLUICE_APPROVE = "owner-setup"
$env:SLUICE_KEY = (Get-Content .\payer-mainnet.key -Raw).Trim()
```

```powershell
pnpm client:owner authorize --from 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --agent 0xAgentAddress --budget 0.017 --per-call 0.01 --days 1 --tool dex_quote=0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E --tool contract_lookup=0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E --tool token_risk_check=0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E
```

```powershell
Remove-Item Env:SLUICE_KEY
```

Expect `authorised: 0x...`. Spends: about 0.00015 QIE from the relayer. Undo: the session ends by itself after a day, or you end it with the payer's key (the command is at the end of this section).

Write the proxy's settings. This writes the file without a byte-order mark, which the proxy would not read.

```powershell
$tools = "dex_quote", "contract_lookup", "token_risk_check" | ForEach-Object { @{ tool = $_; payee = "0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E" } }
$config = @{ upstream = @{ url = "http://127.0.0.1:8403/mcp" }; router = "0xf6F4C1Cc954B1798d134750438ada58768978716"; payer = "0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C"; budget = @{ perCallCap = "0.01"; totalCap = "0.017"; expiresAt = (Get-Date).ToUniversalTime().AddHours(23).ToString("s") + "Z"; allowedTools = @($tools) }; logFile = "payments.jsonl"; stateFile = "budget.json" } | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $PWD ".local-mainnet\sluice.config.json"), $config)
```

Make the three calls with the agent's key.

```powershell
$env:SLUICE_AGENT_KEY = (Get-Content .\.local-mainnet\agent.key -Raw).Trim()
```

```powershell
pnpm client:smoke --config .local-mainnet\sluice.config.json --tool dex_quote --arg tokenIn=QIE --arg tokenOut=0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5 --arg amountIn=1
```

```powershell
pnpm client:smoke --config .local-mainnet\sluice.config.json --tool contract_lookup --arg address=0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5
```

```powershell
pnpm client:smoke --config .local-mainnet\sluice.config.json --tool token_risk_check --arg address=0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5
```

Expect each to end `intent 0x... is queued`, with a status address. After half a minute, read each transaction hash, with the intent's id:

```powershell
(Invoke-RestMethod http://127.0.0.1:8402/status/0xIntentId).transaction
```

Then record as in step 7. The calls are not waited for one by one here, so some may share a batch.

Spends: the same QUSDC as step 6, and the same QIE for each batch. Undo: a settled payment cannot be undone.

When you have finished, end the agent's session.

```powershell
$env:SLUICE_APPROVE = "owner-setup"
$env:SLUICE_KEY = (Get-Content .\payer-mainnet.key -Raw).Trim()
```

```powershell
pnpm client:owner revoke --from 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C --agent 0xAgentAddress
```

Expect `revoked: 0x...`. Spends: one further transaction from the relayer; its gas was not measured on its own, and it does less than the authorisation. Undo: no, but a new authorisation can be made. Step 9 still works afterwards: the authorisation, the revocation and the refund are the account's three signed requests of the day.

## What this does not show

- Anything about a hosted service. No one but you reached these programs.
- That a real MCP application works with the proxy. `client:smoke` is a script. See [REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md).
- The demo page's payment. It needs the payer's key in a browser wallet, and is not part of this page.
- That the tools' answers are right. They read public data and review nothing.
