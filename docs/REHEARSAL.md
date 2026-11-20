# Rehearsal on the testnet

This is a list of steps for the founder to run. **Nothing in it has been run on QIE's testnet.** It rehearses [MAINNET-RUNBOOK.md](MAINNET-RUNBOOK.md) on chain 1983 with a token that has no value, so that every command, every hosted service and every recorder claim has been used once before anything touches mainnet.

A rehearsal proves the tooling and the process. It does not prove anything about QUSDC: the real token has its own behaviour (no permit, no EIP-3009, an admin that can burn), and the rehearsal token is a plain token with an open mint.

## What differs from the mainnet run

| | Testnet | Mainnet |
| --- | --- | --- |
| `SLUICE_NETWORK` | `testnet` | `mainnet` |
| Chain id | 1983 | 1990 |
| Token | A token with no value that `pnpm live:test-token` deploys, given in `SLUICE_TOKEN` | QUSDC, and the deploy script refuses any other token |
| QIE | From QIE's testnet faucet, which is for you to use; nothing in this repository calls it | Bought and sent from wallets you control |
| Explorer | This repository does not know a testnet explorer, so you give its address with `--explorer` where a step needs it | `https://mainnet.qie.digital` |
| Evidence | Rows go in the **Testnet** table of [EVIDENCE.md](EVIDENCE.md), labelled `testnet` | Rows go in the **Mainnet** table, labelled `mainnet` |

A testnet row never goes in the mainnet table and never counts toward a mainnet claim. The file refuses a row whose Network column does not match its table, and the recorder writes each network's rows under that network's heading.

## Steps

Run each from the repository root, in PowerShell. They follow the mainnet runbook's numbering where they match.

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

2. Make a relayer key, and note the address. Use a deployer key that has only ever held testnet funds.

   ```powershell
   pnpm live:new-key .\relayer-testnet.key
   ```

3. Get testnet QIE for the deployer and the relayer from QIE's testnet faucet.

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

10. Verify the source if the testnet has an explorer you can reach. Give its address. If it does not answer, use the manual route in the runbook.

    ```powershell
    $env:SLUICE_APPROVE = "verify"; pnpm live:verify --explorer https://the-testnet-explorer.example
    ```

11. Host the facilitator and the tool server against the testnet, as in [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md) and [DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md), with `SLUICE_NETWORK=testnet`, `SLUICE_ROUTER` from step 7 and the relayer key from step 2. Do both documents' checklists. This is where the restart drill and the kill switch drill are done for the real services.

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
- The public explorer's verification endpoint for mainnet. The script was tested against a stand-in that holds the endpoint's documented shape.
- How the hosted services behave under real traffic.
- Everything about the clients that [REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md) lists as unverified, until you have run it.

When you have run it, write what happened in [FOUNDER-LOG.md](FOUNDER-LOG.md).
