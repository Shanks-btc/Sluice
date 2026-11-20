# Mainnet runbook

This is a list of steps for the founder to run, on the founder's own machine, in order. **Nothing in it has been run on QIE mainnet.** Every command was written and its logic was tested on a local chain and on a local fork of QIE mainnet, and that is all. Expected outputs below are what the code prints, not what a mainnet run has printed.

The commands are PowerShell. Each one is a single line that can be copied and pasted. A step says what to expect and when to stop. If you stop, nothing later is safe to run until you know why.

Run the steps in [REHEARSAL.md](REHEARSAL.md) on the testnet before this. They are the same steps with a token that has no value.

## Contents

- [Rules](#rules)
- [The funding plan](#the-funding-plan)
- [The steps](#the-steps)
- [Verifying the source by hand](#verifying-the-source-by-hand)
- [When the explorer returns 502](#when-the-explorer-returns-502)
- [Where to stop](#where-to-stop)
- [After the run](#after-the-run)

## Rules

- Every script that sends a transaction refuses to start without `SLUICE_NETWORK`, `SLUICE_APPROVE` set to its own name, a key and its spending caps. The caps default to 10 QUSDC and 5 QIE, and cannot be set above 100 QUSDC or 50 QIE.
- Keys go in files that only you can read, and are read into the session when needed. Do not type a key into a command line, and do not paste one into a chat or a document.
- The deployer key, the relayer key and the owner (a multisig) are three different things. The relayer key is a hot key that pays gas only.
- Nothing is written into `docs/EVIDENCE.md` by hand. A row is added by `pnpm evidence:record`, after the recorder has read the transaction back from the chain.
- Nothing in this repository calls itself live until `docs/EVIDENCE.md` has a verified mainnet row for it.

## The funding plan

Gas figures are the ones measured on a fork and listed in [GAS.md](GAS.md). They are measurements of one state, not promises. QIE's gas price when GAS.md was made was 1.125 gwei.

| What | Gas | QIE at 1.125 gwei |
| --- | --- | --- |
| Deploy the router, which creates the vault | 3,158,652 | 0.003553 |
| The smoke run: eight transactions | 636,021 | 0.000716 |
| Deploy and smoke run together | 3,794,673 | 0.004269 |
| The largest batch measured, 50 intents from 50 payers to 50 builders | 3,291,319 | 0.003703 |

| Who | Holds | Why |
| --- | --- | --- |
| Deployer | 0.05 QIE and 1 QUSDC | The deploy and the smoke run cost about 0.0043 QIE. The rest is room for a higher gas price. The smoke run deposits 0.3 QUSDC and takes nearly all of it back. |
| Relayer | 1 QIE | Twice the default daily budget of 0.5 QIE. It sends batches, and a start with no QIE sends a top-up of at most 0.0015 QIE to one address. |
| Owner wallet, for the funded run | 10 QUSDC and a little QIE for its own transactions, unless you use the start with no QIE | See step 17. |
| Router owner and fee recipient | A multisig you control. No funds needed. | The owner can change the fee (at most 2%) and the fee recipient, and nothing else. |

QIEDEX's pool is thin: about 100 QUSDC of swap moved the price by about 2.5% when it was looked at. Keep the funded run to about 10 QUSDC, which is also the default cap. At the QIE price GAS.md assumes (a quote from 2026-11-18, which will have moved), 10 QUSDC costs about 61 QIE plus the pool's slippage. Look up the price on the day and size the QIE you buy to it.

## The steps

Run each from the repository root, in PowerShell.

### Set up

1. Install, build and compile.

   ```powershell
   pnpm install
   ```

   ```powershell
   pnpm build
   ```

   ```powershell
   pnpm compile
   ```

   Expect each to finish with no error. Stop if one fails.

2. Make the relayer key. This writes it to a file and prints only the address.

   ```powershell
   pnpm live:new-key .\relayer.key
   ```

   Expect a line `address: 0x...`. Note the address. The deployer key is a separate key you already hold; keep it in `.\deployer.key`.

3. Choose the owner. It must be a multisig you control. Note its address, and the address that receives fees.

4. Fund the deployer and the relayer as in the funding plan, from wallets you control. Wait for the transfers to be confirmed.

### Check, then deploy

5. Choose the network and read the deployer key into this session.

   ```powershell
   $env:SLUICE_NETWORK = "mainnet"; $env:SLUICE_KEY = (Get-Content .\deployer.key -Raw).Trim()
   ```

6. Run the pre-flight check. It is read-only.

   ```powershell
   pnpm live:preflight --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress
   ```

   Expect lines that start `PASS` and a last line `GO on mainnet`. A `WARN` is worth reading and does not stop you. **Stop on `NO-GO`.** The line before it names the check that failed: the chain, the endpoints, the gas price, QUSDC, a balance, or the deployer and relayer being the same address.

7. Set the deploy settings.

   ```powershell
   $env:SLUICE_APPROVE = "deploy"; $env:SLUICE_OWNER = "0xYourMultisig"; $env:SLUICE_FEE_RECIPIENT = "0xYourFeeRecipient"; $env:SLUICE_FEE_BPS = "100"
   ```

   The fee is in basis points: 100 is 1%, and the contract refuses more than 200. The token is QUSDC, and the script refuses any other token on mainnet.

8. Dry-run the deploy. It sends nothing.

   ```powershell
   pnpm exec ts-node scripts/live/deploy.ts --dry-run
   ```

   Expect `DRY RUN of deploy: nothing is sent`, the deployer's address, the token, owner, fee recipient and fee you set, `to: (creates a contract)`, `value: 0 QIE`, a gas figure near 3.8 million, and `the plan fits`. **Stop if** any address or the fee is not what you set, or if it says the plan does not fit.

9. Deploy.

   ```powershell
   pnpm exec ts-node scripts/live/deploy.ts
   ```

   Expect `router 0x...`, `vault 0x...` and `wrote deployment.json`. Copy the router address and the deployment's transaction hash from the output. **Stop if** it reports an error. A failed deployment may still have spent gas: look at the deployer's address on the explorer before trying again.

10. Record the deployment. The recorder reads it back from the chain.

    ```powershell
    pnpm evidence:record --claim deploy --tx 0xTheDeploymentHash --network mainnet
    ```

    Expect `recorded 1 row for the deploy claim on mainnet`. If it refuses, it says why and wrote nothing.

11. Set the router for the later steps, and run the pre-flight check again, now with the deployment record.

    ```powershell
    $env:SLUICE_ROUTER = "0xTheRouter"
    ```

    ```powershell
    pnpm live:preflight --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress --deployment deployment.json
    ```

    Expect `GO on mainnet`, and `Deployed code: the router's and the vault's code hash match the deployment record`. **Stop on `NO-GO`.**

### Verify the source

12. Check what the explorer says, and prepare the files for the manual route.

    ```powershell
    pnpm live:verify --prepare-only
    ```

    Expect the compiler, optimizer and EVM settings, and three files per contract in `artifacts\verification\`.

13. Submit the source to the explorer, and have the script confirm with a separate read.

    ```powershell
    $env:SLUICE_APPROVE = "verify"; pnpm live:verify
    ```

    Expect `explorer: PaymentRouter now shows verified source` and the same for `AgentVault`. Exit code 2 or a line about 502 means the explorer did not answer: see [When the explorer returns 502](#when-the-explorer-returns-502). This script has not been tried against the real explorer.

14. Record the verification once the explorer shows it.

    ```powershell
    pnpm evidence:record --claim verify-link --tx 0xTheDeploymentHash --network mainnet
    ```

### The smoke run

15. Dry-run the smoke run, then run it. It moves 0.3 QUSDC in and takes nearly all of it back.

    ```powershell
    $env:SLUICE_APPROVE = "smoke"; pnpm exec ts-node scripts/live/smoke.ts --dry-run
    ```

    Expect eight steps, each with its destination and decoded call, and `the plan fits`. Then:

    ```powershell
    pnpm exec ts-node scripts/live/smoke.ts
    ```

    Expect eight lines with a transaction hash each, then `pnpm evidence:record` commands for the deposit and the withdrawal. **Stop if** any step fails: later steps depend on earlier ones.

16. Run the commands it printed, one per transaction. For example:

    ```powershell
    pnpm evidence:record --claim deposit --tx 0xTheDepositHash --network mainnet --router $env:SLUICE_ROUTER
    ```

    The smoke run's settlements are submitted by the payer, so no claim type covers them. Settlements are recorded from the facilitator's batches in step 19.

### Host, then the funded run

17. Host the facilitator and the tool server as in [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md) and [DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md), with `SLUICE_NETWORK=mainnet` and the router from step 9. Fund the relayer. Do the checklists in both documents, including the kill switch drill.

18. The owner, an agent and a call. The steps are in [TRY-IT-AGENT.md](TRY-IT-AGENT.md): the owner holds about 10 QUSDC, deposits some of it (or starts with no QIE through the facilitator), authorises an agent key for the tools, and runs `pnpm client:smoke` against the hosted tool server. Keep the total moved to about 10 QUSDC.

19. When the facilitator's batch has settled (its `/status/<id>` says `settled`), record what the chain shows. Use the transaction hashes from the facilitator's status and from the owner's start.

    ```powershell
    pnpm evidence:record --claim paid-call-settlement --tx 0xTheBatchHash --network mainnet --router $env:SLUICE_ROUTER --tool contract_lookup
    ```

    ```powershell
    pnpm evidence:record --claim settle-batch --tx 0xTheBatchHash --network mainnet --router $env:SLUICE_ROUTER
    ```

    For a start with no QIE, the deposit's hash and the facilitator's top-up hash:

    ```powershell
    pnpm evidence:record --claim relayed-start --tx 0xTheDepositHash --topup 0xTheTopUpHash --network mainnet --router $env:SLUICE_ROUTER
    ```

    The recorder refuses a claim the chain does not show. [EVIDENCE.md](EVIDENCE.md) says what each claim shows and what it does not.

20. The builder withdraws its earnings, then record it.

    ```powershell
    pnpm evidence:record --claim withdraw --tx 0xTheWithdrawHash --network mainnet --router $env:SLUICE_ROUTER
    ```

### Check and clean up

21. Check every row against the chain again, and count.

    ```powershell
    pnpm evidence:check
    ```

    ```powershell
    pnpm evidence:summary
    ```

    Expect every row `PASS`. The summary prints counts per claim type and leaves out the founder wallets in `docs/founder-wallets.json`.

22. Clear the secrets from the session.

    ```powershell
    Remove-Item Env:SLUICE_KEY; Remove-Item Env:SLUICE_APPROVE
    ```

    Delete `.\relayer.key` once it is in the host's secret store. Keep `.\deployer.key` where it was.

## Verifying the source by hand

Use this when `pnpm live:verify` could not finish. `pnpm live:verify --prepare-only` writes everything needed to `artifacts\verification\`: for each of `PaymentRouter` and `AgentVault`, the standard JSON input, a flattened single file, and the constructor arguments.

The settings, exactly:

| Setting | Value |
| --- | --- |
| Compiler | Solidity v0.8.24+commit.e11b9ed9 |
| EVM version | shanghai |
| Optimization | enabled, 200 runs |
| License | MIT |
| Contract names | `contracts/PaymentRouter.sol:PaymentRouter` and `contracts/AgentVault.sol:AgentVault` |
| Router constructor arguments | in `PaymentRouter.constructor-arguments.txt`: the token, the owner, the fee recipient and the fee, ABI-encoded, hex without `0x` |
| Vault constructor arguments | in `AgentVault.constructor-arguments.txt`: the router's address, ABI-encoded |

On the explorer's page for the contract, choose to verify and publish, then choose "Standard JSON input" and upload the `.standard-input.json` file, set the compiler and the contract name, and add the constructor arguments. The standard JSON route matches the deployed code exactly. If the explorer offers only a single file, use the `.flat.sol` file with the same settings; a single file matches the code but not the metadata, so an explorer may call it a partial match.

When the explorer shows the contract as verified, check it and record it:

```powershell
pnpm live:verify --check-only
```

```powershell
pnpm evidence:record --claim verify-link --tx 0xTheDeploymentHash --network mainnet
```

## When the explorer returns 502

The explorer answers 502 at times. `pnpm live:verify` retries a request a few times, with a longer pause each time, then says the explorer could not be reached and exits with code 2. Nothing is lost: the files for the manual route are written before anything is sent.

- Wait a while and run the same command again. A contract the explorer already verified is reported as already verified.
- Or follow the manual steps above in the explorer's page when it answers.
- Run `pnpm live:preflight` to see whether the explorer answers. A `WARN` on it does not stop anything: the explorer is used for links and for verified source, and every other check reads the chain through the RPC.
- The recorder's other claims read the chain through the RPC and do not need the explorer. Only `verify-link` does.

## Where to stop

| If | Then |
| --- | --- |
| The pre-flight check says `NO-GO` | Fix the named check. Do not deploy. |
| The dry run shows an address, a token or a fee you did not set | Do not deploy. Check the environment variables. |
| The deployment fails or times out | Look at the deployer on the explorer. Do not send the same transaction again until you know whether the earlier one landed. |
| `Deployed code` fails in the second pre-flight check | The code at the router address is not the code the deploy script recorded. Do not use that router. |
| A smoke step fails | Do not run later steps. Look at the transaction on the explorer. |
| The facilitator's `/health` shows `ok` false, `lowBalance` true or an alert | Turn the kill switch on, then fix it ([DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md)). |
| A recorder command refuses | The chain does not show that claim. Do not record it another way. |
| You are unsure about any of this | Stop. A step that has not been run cannot be undone. |

## After the run

- Fill in [FOUNDER-LOG.md](FOUNDER-LOG.md): what you did, on what day, with which hashes, in your own words.
- The README's status table changes only for a surface that has a verified mainnet row in `docs/EVIDENCE.md`. A test holds the README to that.
- The router's owner is the multisig. The deployer key is no longer needed for anything on chain, and can be put away.
