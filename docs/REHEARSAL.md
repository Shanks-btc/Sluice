# Rehearsal on the testnet

This rehearses [MAINNET-RUNBOOK.md](MAINNET-RUNBOOK.md) on chain 1983 with a token that has no value, so that every command, every locally hosted service and every recorder claim has been used once before anything touches mainnet. There are two ways to run it: one command that does the whole list (`pnpm rehearsal:testnet`), and the manual steps further down.

**Where it stands.** The manual steps below were not run on QIE's testnet. The automated command ran as far as its balance check, on 2026-11-20, and stopped because both testnet addresses held no QIE. Nothing has been sent to the testnet yet. [REHEARSAL-LOG.md](REHEARSAL-LOG.md) has what it printed and what has to happen next.

A rehearsal proves the tooling and the process. It does not prove anything about QUSDC: the real token has its own behaviour (no permit, no EIP-3009, an admin that can burn), and the rehearsal token is a plain token with an open mint.

## The automated run

```powershell
pnpm build
```

```powershell
pnpm rehearsal:testnet
```

It needs two throwaway key files in the repository root, `deployer-testnet.key` and `relayer-testnet.key`, each holding a key that has only ever held testnet funds. It reads them inside the program, checks each against the address it is meant to hold, and stops if one does not match. It never prints a key, copies one, or writes one into a log, a state file or a document. Both files are git-ignored (`*.key`) and kept out of Docker builds.

It sends on the testnet only. Every step that sends asks the node for its chain id first and stops unless the answer is 1983, and a node that answers 1990 stops the whole run. No transaction may cost more than 0.05 QIE (its gas limit at its gas price). It calls no faucet and uses no key except the two above and two throwaway keys it makes for the run, in `.rehearsal/`, which hold no QIE and only test tokens.

| Step | What it does |
| --- | --- |
| 1 | Reads the two key files and checks their addresses, chooses a healthy testnet endpoint and confirms chain 1983, then reads both balances. If an address holds less than the run needs, it prints the address and the amount and stops. |
| 2 | Deploys the test token, runs the pre-flight check, shows the router deploy as a dry run, deploys the router (owner and fee recipient are the deployer, 100 bps), records the deploy claim, runs the pre-flight check against the deployment. |
| 3 | Shows the smoke run as a dry run, runs it (eight transactions), and records its deposit, withdraw and refund claims. |
| 4 | Starts the facilitator and the example tool server on this machine. The facilitator's relayer key is passed through its environment and never printed, and its queue is a file in `.rehearsal/`. |
| 5 | The funded flow, with a new owner key that holds no QIE: the deployer mints it test tokens, it starts through the facilitator (which tops it up and sends its two transactions), it authorises an agent key by signature, and three paid calls on two tools go through `pnpm client:smoke` and the payment proxy. It waits for the settlement and records the paid-call, relayed-start and deposit claims. |
| 6 | Two drills, logged and not recorded as evidence. The facilitator is killed with an intent queued and restarted, and the chain is checked to show the intent settled once. The kill switch is turned on (a paid call and a zero-QIE start are refused, and nothing is sent) and then off (a paid call settles). |
| 9 | The builder withdraws what the settlement credited to it, and the withdraw claim is recorded. It runs before step 7, so that the check sees every row. |
| 7 | Runs `pnpm evidence:check` and `pnpm evidence:summary`, and keeps what they print. Testnet rows are in the Testnet table and are not in the summary's counts. |
| 8 | Asks the testnet explorer whether it shows verified source for the router, and submits the router's source if it does not. Nothing is submitted for the vault, which the router's constructor creates. The files for the manual route are written first. |

If a step fails it prints the exact error and the run goes on with the steps that do not depend on it. The next run retries the failed steps and skips the ones already done. Where it has got to is in `rehearsal-state.json` (addresses, hashes and numbers; git-ignored), and `pnpm rehearsal:testnet --status` prints it without running anything. The exit code is 0 when every step is done, 1 when a step failed or was blocked, and 2 when the run stopped for testnet QIE.

### How much QIE

The run reads the testnet's gas price and sizes the amounts from the gas in [GAS.md](GAS.md), at no less than the 1.125 gwei that document measured, with half again on top. At that price it asks for at least **0.01 QIE at the deployer** and **0.025 QIE at the relayer**. The testnet's own gas price read about 7 wei on 2026-11-20, so the real cost may be far below those figures; the run asks for the larger ones in case the price rises. When an address holds too little it prints the address and the amount, and says to get the QIE from QIE's testnet faucet and run the command again.

### What it needs from a person

- Testnet QIE at the two addresses (the amounts above). The faucet is for a person to use. QIE's documentation gives it as `https://www.qie.digital/faucet`; nothing in this repository calls it.
- `pnpm build` once, so that the facilitator, the tool server and the payment proxy exist as programs.

## What differs from the mainnet run

| | Testnet | Mainnet |
| --- | --- | --- |
| `SLUICE_NETWORK` | `testnet` | `mainnet` |
| Chain id | 1983 | 1990 |
| Token | A token with no value that `pnpm live:test-token` deploys, given in `SLUICE_TOKEN` | QUSDC, and the deploy script refuses any other token |
| QIE | From QIE's testnet faucet, which is for you to use; nothing in this repository calls it | Bought and sent from wallets you control |
| Explorer | `https://testnet.qie.digital`, as QIE's documentation gives it. Whether its source-verification endpoint works is not confirmed. Rows in EVIDENCE.md show a testnet transaction as a plain hash, with no link | `https://mainnet.qie.digital` |
| Endpoints | rpc1 to rpc5 of `testnet.qie.digital` (QIE's documentation lists a sixth) | rpc1 to rpc5 of `mainnet.qie.digital` |
| Evidence | Rows go in the **Testnet** table of [EVIDENCE.md](EVIDENCE.md), labelled `testnet` | Rows go in the **Mainnet** table, labelled `mainnet` |

A testnet row never goes in the mainnet table and never counts toward a mainnet claim. The file refuses a row whose Network column does not match its table, and the recorder writes each network's rows under that network's heading.

### When an endpoint is down

On 2026-11-20, rpc1 to rpc3 of the testnet timed out or refused, and rpc4 and rpc5 answered with chain 1983. Every program that reads the chain now asks each endpoint for its chain id (with a short limit), uses the earliest in the list that answers with the right one, says which it chose, and keeps the others as fallbacks for reads. A transaction is never sent to a second endpoint after the chosen one fails. `SLUICE_RPC_URL` names one endpoint and is used as given, with no probe. This covers the live scripts, the pre-flight check, the facilitator, the tool server, the scripted client, the evidence recorder and `pnpm evidence:check`.

## Manual steps

Run each from the repository root, in PowerShell. They follow the mainnet runbook's numbering where they match. The automated run above does the same list.

1. Build and compile.

   ```powershell
   pnpm install
   ```

   ```powershell
   pnpm build
   ```

   ```powershell
   pnpm compile
   ```

2. Make both keys: a deployer key and a relayer key. Each command writes its key to a file and prints only the address. Use keys that have only ever held testnet funds.

   ```powershell
   pnpm live:new-key .\deployer-testnet.key
   ```

   ```powershell
   pnpm live:new-key .\relayer-testnet.key
   ```

3. Get testnet QIE for the deployer and the relayer from QIE's testnet faucet: at least 0.01 QIE at the deployer and 0.025 QIE at the relayer.

4. Read the deployer key and choose the testnet.

   ```powershell
   $env:SLUICE_NETWORK = "testnet"; $env:SLUICE_KEY = (Get-Content .\deployer-testnet.key -Raw).Trim()
   ```

5. Deploy the token with no value. The script refuses mainnet twice: by the network name before it reads the key, and by the chain id the node reports.

   ```powershell
   $env:SLUICE_APPROVE = "deploy-test-token"; pnpm live:test-token
   ```

   Expect `test token 0x...`, `minted 1000.000000 test tokens to 0x...` and `wrote testnet-token.json`. **Stop if** it says the RPC is on another chain.

6. Name the token, and run the pre-flight check.

   ```powershell
   $env:SLUICE_TOKEN = "0xTheTestToken"
   ```

   ```powershell
   pnpm live:preflight --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress
   ```

   Expect `GO on testnet`. The deployer's token balance is checked against the testnet token.

7. Deploy the router on the testnet with that token. Use any owner and fee recipient you control; this router has no value.

   ```powershell
   $env:SLUICE_APPROVE = "deploy"; $env:SLUICE_OWNER = "0xYourAddress"; $env:SLUICE_FEE_RECIPIENT = "0xYourAddress"; $env:SLUICE_FEE_BPS = "100"
   ```

   ```powershell
   pnpm exec ts-node scripts/live/deploy.ts --dry-run
   ```

   ```powershell
   pnpm exec ts-node scripts/live/deploy.ts
   ```

   Expect the dry run to print the plan and send nothing, and the deploy to print the router and vault and write `deployment.json`.

8. Record the deployment into the testnet table.

   ```powershell
   pnpm evidence:record --claim deploy --tx 0xTheDeploymentHash --network testnet
   ```

   Expect `recorded 1 row for the deploy claim on testnet`. Open `docs/EVIDENCE.md` and see that the row is under the Testnet heading with `testnet` in its Network column.

9. Run the pre-flight check with the deployment record, then the smoke run.

   ```powershell
   $env:SLUICE_ROUTER = "0xTheRouter"
   ```

   ```powershell
   pnpm live:preflight --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress --deployment deployment.json
   ```

   ```powershell
   $env:SLUICE_APPROVE = "smoke"; pnpm exec ts-node scripts/live/smoke.ts --dry-run
   ```

   ```powershell
   pnpm exec ts-node scripts/live/smoke.ts
   ```

   Then run the `pnpm evidence:record` commands it prints, with `--network testnet`.

10. Verify the source. QIE's documentation gives the testnet explorer as `https://testnet.qie.digital`; whether its verification endpoint answers is not confirmed. If it does not answer, use the manual route in the runbook.

    ```powershell
    $env:SLUICE_APPROVE = "verify"; pnpm live:verify --explorer https://testnet.qie.digital
    ```

11. Host the facilitator and the tool server against the testnet, as in [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md) and [DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md), with `SLUICE_NETWORK=testnet`, `SLUICE_ROUTER` from step 7 and the relayer key from step 2. Do both documents' checklists. This is where the restart drill and the kill switch drill are done for the real services. The automated run does both drills against local copies of the two programs.

12. Run the funded flow with the test token: an owner holds some, starts with no QIE through the facilitator, authorises an agent, and makes paid calls with `pnpm client:smoke`. The steps are in [TRY-IT-AGENT.md](TRY-IT-AGENT.md). Then record what the chain shows, with `--network testnet`:

    ```powershell
    pnpm evidence:record --claim paid-call-settlement --tx 0xTheBatchHash --network testnet --router $env:SLUICE_ROUTER
    ```

    ```powershell
    pnpm evidence:record --claim relayed-start --tx 0xTheDepositHash --topup 0xTheTopUpHash --network testnet --router $env:SLUICE_ROUTER
    ```

13. Check the rows against the chain, and read the counts.

    ```powershell
    pnpm evidence:check
    ```

    ```powershell
    pnpm evidence:summary
    ```

    The summary counts mainnet rows. Testnet rows are not in its counts.

14. Try the clients. [REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md) is the test for Claude Code and Cursor. It works against the testnet deployment with no money at risk.

15. Clear the secrets from the session.

    ```powershell
    Remove-Item Env:SLUICE_KEY; Remove-Item Env:SLUICE_APPROVE
    ```

## What the rehearsal leaves unproven

- The real QUSDC. The fork tests use it, and no testnet run can.
- The public explorer's verification endpoint, on either network. The script was tested against a stand-in that holds the endpoint's documented shape.
- How the hosted services behave under real traffic. The automated run starts the facilitator and the tool server on one machine, for one owner.
- Everything about the clients that [REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md) lists as unverified, until it has been run.

When you have run it, write what happened in [FOUNDER-LOG.md](FOUNDER-LOG.md).
