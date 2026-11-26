# Mainnet runbook

This is a list of steps for the founder to run, on the founder's own machine, in order. **What has already happened on QIE mainnet is what [EVIDENCE.md](EVIDENCE.md) records**, and a step with no row there is not shown to have happened. A router that has a `Deployed` row exists already: deploy again only if you mean to replace it. Every command here was written, and its logic was tested on a local chain and on a local fork of QIE mainnet. [MAINNET-DRYRUN-LOG.md](MAINNET-DRYRUN-LOG.md) is the whole path run on a fork with throwaway keys: it is a simulation, and it says nothing about how the real chain, its explorer or its public endpoints behave. [MAINNET-PREFLIGHT.md](MAINNET-PREFLIGHT.md) is what read-only calls to mainnet returned on one day.

The commands are PowerShell. Each one is a single line that can be copied and pasted, and none chains commands with the shell operators that Windows PowerShell 5 does not parse; where one line does two things, it uses a semicolon. A step says what to expect and when to stop. If you stop, nothing later is safe to run until you know why.

Run the steps in [REHEARSAL.md](REHEARSAL.md) on the testnet before this. They are the same steps with a token that has no value. [MAINNET-GO-LIVE.md](MAINNET-GO-LIVE.md) is the one-page checklist around them, and `pnpm live:golive:plan` prints them with your addresses filled in.

## Contents

- [Rules](#rules)
- [The funding plan](#the-funding-plan)
- [The steps](#the-steps)
- [What each recorded claim proves](#what-each-recorded-claim-proves)
- [Verifying the source](#verifying-the-source)
- [The vault](#the-vault)
- [When the explorer returns 502](#when-the-explorer-returns-502)
- [Where to stop](#where-to-stop)
- [After the run](#after-the-run)

## Rules

- Every script that sends a transaction refuses to start without `SLUICE_NETWORK`, `SLUICE_APPROVE` set to its own name, a key and its spending caps. The caps default to 10 QUSDC and 5 QIE, and cannot be set above 100 QUSDC or 50 QIE.
- Every script asks the node which chain it is on, before it reads or sends anything. With `SLUICE_NETWORK` set to `mainnet` it needs chain 1990, and it stops with a message if the node says anything else. The facilitator and the tool server do the same when they start.
- The deploy refuses any token that is not QUSDC on mainnet, and checks before it sends anything that the token address holds a contract with six decimals. It refuses a fee above 200 basis points, and uses 100 (1%) if `SLUICE_FEE_BPS` is not set.
- The deployer key, the relayer key and the owner are three different things, and the deploy keeps them apart. It refuses to run if the owner or the fee recipient is the zero address, the deployer key's own address or the relayer's address, and on mainnet it needs the relayer's address (`SLUICE_RELAYER`, or `--relayer`) so that the check cannot be left out. The owner should be a multisig you control. The relayer key is a hot key that pays gas only.
- `deploy.ts` and `smoke.ts` refuse an option they do not know. A mistyped `--dry-run` is an error, never a real run.
- Keys go in files that only you can read, and are read into the session when needed. Do not type a key into a command line, and do not paste one into a chat or a document. Make a new key for each role: do not reuse a testnet key.
- Nothing is written into `docs/EVIDENCE.md` by hand. A row is added by `pnpm evidence:record`, after the recorder has read the transaction back from the chain.
- Nothing in this repository calls itself live until `docs/EVIDENCE.md` has a verified mainnet row for it.

## The funding plan

The numbers that decide how much to send come from a command, at the time you run it, and are not copied into this document. It reads the gas price on the chain now, QIEDEX's QUSDC/WQIE pool, and the balances of the two addresses it is given, and prints the block and the time it read them at. It sends nothing and holds no key. It reads no price in dollars, so it states none.

```powershell
pnpm live:funding --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress
```

It prints, in this order:

1. **(a) QIE for each address.** For the deployer: the gas of the deploy and the smoke run (from [GAS.md](GAS.md)) times the gas price just read and a margin of 3, what the address holds, and how much more to send. For the relayer: the gas of every step the funded run asks of it, plus the QIE the facilitator sends the owner, times the same margin; and what to hold, which is the largest of that need, the pre-flight check's floor and a day's budget, so that the facilitator's `/health` does not report a low balance. The owner of the funded run starts with no QIE.
2. **(b) QUSDC.** The QUSDC the funded run needs (10 by default, and the cap of the live scripts is also 10; use `--qusdc` to change it, up to 100), and the deployer's 0.3 for the smoke run. Then what buying QUSDC from the pool would cost in QIE at 10, 25 and 100 QUSDC, and at the total needed: the QIE to put in, the price paid for each QUSDC, how much dearer than the pool's own price that is, and how much of the pool's QUSDC it takes. The formula is printed under the table. The calculator also asks the pool's own router, and says if its answer differs.
3. **One line**: the QIE for the deployer, the QIE for the relayer and the QIE to buy the QUSDC, added up.

Where a number cannot be read (the pool, for one) the calculator says so and prices nothing. `--margin` changes the factor on the gas figures (1 to 10).

The pool is thin. The calculator prints how much of its QUSDC a purchase takes, and the price rises with it, so do not buy more QUSDC than the run needs. The funded run's size is also the cap on what the live scripts will move.

The gas the calculator budgets from is the gas measured on a fork and listed in [GAS.md](GAS.md): measurements of one state, not promises. For reference, at GAS.md's price of 1.125 gwei:

| What | Gas | QIE at 1.125 gwei |
| --- | --- | --- |
| Deploy the router, which creates the vault | 3,158,652 | 0.003553 |
| The smoke run: eight transactions | 636,021 | 0.000716 |
| Deploy and smoke run together | 3,794,673 | 0.004269 |
| The largest batch measured, 50 intents from 50 payers to 50 builders | 3,291,319 | 0.003703 |

| Who | Holds | Why |
| --- | --- | --- |
| Deployer | QIE and QUSDC, as `pnpm live:funding` says | The deploy and the smoke run. The smoke run deposits 0.3 QUSDC and takes nearly all of it back. |
| Relayer | QIE, as `pnpm live:funding` says | It sends batches, and a start with no QIE sends a top-up of at most 0.0015 QIE to one address. It never holds QUSDC. |
| Owner wallet, for the funded run | The QUSDC for the run, and no QIE if it starts through the facilitator | See step 21. |
| Router owner and fee recipient | A multisig you control. No funds needed. | The owner can change the fee (at most 2%) and the fee recipient, and nothing else. |

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

2. Make the two keys, one for the deployer and one for the relayer. Each command writes a key to a new file and prints only the address.

   ```powershell
   pnpm live:new-key .\deployer-mainnet.key
   ```

   ```powershell
   pnpm live:new-key .\relayer-mainnet.key
   ```

   Expect `address: 0x...` after each. Note both addresses. The files are git-ignored (`*.key`). The command refuses to overwrite a file that exists, so a key you already hold is never lost to a second run. The relayer's key goes into the host's secret store later (step 21) and the deployer's stays where it is.

3. Choose the owner and the address that receives fees. The owner is fixed in the router when it is deployed and cannot be changed afterwards, so choose the account you will keep; a multisig you control is the safer choice. Neither may be the deployer's address or the relayer's: the deploy will refuse if one is. `pnpm live:golive:plan` ([MAINNET-GO-LIVE.md](MAINNET-GO-LIVE.md)) prints these steps with your addresses filled in, and is stricter on purpose: it takes plain accounts for the owner, the fee recipient and the payer, and refuses a contract. To use a multisig as the owner, follow this runbook without it.

4. Work out the funding with the calculator above, then fund the deployer and the relayer from wallets you control, with at least what it says. Wait for the transfers to be confirmed, and run the calculator again to see them.

5. Read QUSDC's facts again. This is read-only, and it asks the chain again what [RISKS.md](RISKS.md) says about QUSDC: who holds its roles, whether the vault role can burn, the supply, and whether the token can be upgraded.

   ```powershell
   pnpm live:facts
   ```

   Expect `These match what docs/RISKS.md says.` and exit code 0. If it prints a difference, read it and [RISKS.md](RISKS.md) before putting any money in: a role holder that has changed is a change in the largest risk this project has.

### Check, then deploy

6. Choose the network and read the deployer key into this session.

   ```powershell
   $env:SLUICE_NETWORK = "mainnet"; $env:SLUICE_KEY = (Get-Content .\deployer-mainnet.key -Raw).Trim()
   ```

7. Run the pre-flight check. It is read-only.

   ```powershell
   pnpm live:preflight --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress
   ```

   Expect lines that start `PASS` and a last line `GO on mainnet`. The checks: the five endpoints, the chain id, the gas price, QUSDC's code and decimals, QUSDC's roles against [RISKS.md](RISKS.md), the deployer's and the relayer's balances, and that the two are not the same address. A `WARN` is worth reading and does not stop you. **Stop on `NO-GO`.** The line before it names the check that failed.

8. Set the deploy settings. The relayer's address is the one from step 2.

   ```powershell
   $env:SLUICE_APPROVE = "deploy"; $env:SLUICE_OWNER = "0xYourMultisig"; $env:SLUICE_FEE_RECIPIENT = "0xYourFeeRecipient"; $env:SLUICE_FEE_BPS = "100"; $env:SLUICE_RELAYER = "0xYourRelayerAddress"
   ```

   The fee is in basis points: 100 is 1%, the contract refuses more than 200, and the script uses 100 if you leave it out. The token is QUSDC, and the script refuses any other token on mainnet.

9. Dry-run the deploy. It sends nothing.

   ```powershell
   pnpm exec ts-node scripts/live/deploy.ts --dry-run
   ```

   Expect `network mainnet (chain 1990)`, the deployer, the relayer, the token with `(has code and 6 decimals)`, the owner, the fee recipient and the fee, then `DRY RUN of deploy: nothing is sent`, `to: (creates a contract)`, `value: 0 QIE`, a gas figure near 3.8 million, and `the plan fits`. **Stop if** any address or the fee is not what you set, or it says the plan does not fit. A refusal here names what is wrong: the owner or the fee recipient being the deployer or the relayer, a missing relayer address, a node that is not on chain 1990, or a token address with no code.

10. Deploy.

    ```powershell
    pnpm exec ts-node scripts/live/deploy.ts
    ```

    Expect `router 0x...`, `vault 0x...` and `wrote deployment.json`. Copy the router address and the deployment's transaction hash from the output. **Stop if** it reports an error. A failed deployment may still have spent gas: look at the deployer's address on the explorer before trying again.

11. Record the deployment. The recorder reads it back from the chain.

    ```powershell
    pnpm evidence:record --claim deploy --tx 0xTheDeploymentHash --network mainnet
    ```

    Expect `recorded 1 row for the deploy claim on mainnet`. If it refuses, it says why and wrote nothing.

12. Write the settings files for the facilitator, the tool server and the web app from `deployment.json`. No address is copied by hand.

    ```powershell
    pnpm live:wire --network mainnet
    ```

    Expect `wrote .env.mainnet.facilitator, .env.mainnet.tool-server, .env.mainnet.web`, then a table that says which values are public, which are secrets you make, and which you still have to fill in. The files are git-ignored (every name starts with `.env.`) and hold no key. A value left empty makes the program that reads it refuse to start, so a file nobody finished fails closed. The approval and the relayer's key are not written: you set them on the host.

13. Set the router for the later steps, and run the pre-flight check again, now with the deployment record.

    ```powershell
    $env:SLUICE_ROUTER = "0xTheRouter"
    ```

    ```powershell
    pnpm live:preflight --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress --deployment deployment.json
    ```

    Expect `GO on mainnet`, and `Deployed code: the router's and the vault's code hash match the deployment record`. **Stop on `NO-GO`.**

### Verify the source

14. Prepare the files for the manual route.

    ```powershell
    pnpm live:verify --prepare-only
    ```

    Expect the compiler, optimizer and EVM settings, and three files per contract in `artifacts\verification\`. The vault's three are for building it again, and `pnpm live:verify` does not submit them: see [The vault](#the-vault).

15. Submit the router's source to the explorer, and have the script confirm with a separate read.

    ```powershell
    $env:SLUICE_APPROVE = "verify"; pnpm live:verify
    ```

    Expect `explorer: PaymentRouter now shows verified source`, and a line saying this command submits nothing for `AgentVault`: see [The vault](#the-vault). Exit code 2 or a line about 502 means the explorer did not answer: see [When the explorer returns 502](#when-the-explorer-returns-502).

16. Record the router's verification once the explorer shows it. Then compare the vault's code with the compiled AgentVault: that reads the chain and writes no row.

    ```powershell
    pnpm evidence:record --claim verify-link --tx 0xTheDeploymentHash --network mainnet
    ```

    ```powershell
    pnpm live:vaultcheck
    ```

    Expect `vaultcheck: ... 0 failed`. A `FAIL` names what differs. **Stop on one.**

### The smoke run

17. Dry-run the smoke run, then run it. It moves 0.3 QUSDC in and takes nearly all of it back.

    ```powershell
    $env:SLUICE_APPROVE = "smoke"; pnpm exec ts-node scripts/live/smoke.ts --dry-run
    ```

    Expect eight steps, each with its destination and decoded call, and `the plan fits`. Then:

    ```powershell
    pnpm exec ts-node scripts/live/smoke.ts
    ```

    Expect eight lines with a transaction hash each, then `pnpm evidence:record` commands for the deposit and the withdrawal. The run costs the signer the fee on 0.15 QUSDC, which is 0.0015 QUSDC at 1%. **Stop if** any step fails: later steps depend on earlier ones.

18. Run the commands it printed, one per transaction. For example:

    ```powershell
    pnpm evidence:record --claim deposit --tx 0xTheDepositHash --network mainnet --router $env:SLUICE_ROUTER
    ```

    The smoke run's settlements are submitted by the payer, so no claim type covers them. Settlements are recorded from the facilitator's batches in step 24.

### Host, then the funded run

19. Fill in the three settings files. Open each one; every line with no value has a comment above it that says what goes there. Put the facilitator's and the tool server's public https addresses in the right places, the web site's origin in both lists of allowed sites, the builder's address as the tool server's payee, and a path on a disk that survives restarts for the facilitator's queue.

20. Host the facilitator and the tool server as in [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md) and [DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md), from those files. On Railway and Vercel, [HOSTING-RAILWAY.md](HOSTING-RAILWAY.md) and [HOSTING-VERCEL.md](HOSTING-VERCEL.md) are the click-by-click steps, and `pnpm live:hostcheck` checks the result from outside. On the facilitator's host, add the two things the file leaves out: `SLUICE_APPROVE` set to `facilitator`, and the relayer's key, as `SLUICE_RELAYER_KEY`, from the host's secret store (put the contents of `relayer-mainnet.key` there, then delete the file). Fund the relayer as the calculator said. Do the checklists in both documents, including the kill switch drill, and read [OPERATIONS.md](OPERATIONS.md) for the daily checks.

21. The owner, an agent and a call. The steps are in [TRY-IT-AGENT.md](TRY-IT-AGENT.md): the owner holds the QUSDC for the run, deposits some of it, authorises an agent key for the tools, and runs `pnpm client:smoke` against the hosted tool server. With no QIE, the owner signs and the facilitator sends:

    ```powershell
    $env:SLUICE_APPROVE = "owner-setup"; $env:SLUICE_KEY = (Get-Content .\owner.key -Raw).Trim(); $env:SLUICE_FACILITATOR_URL = "https://facilitator.example"
    ```

    ```powershell
    pnpm client:owner start --amount 5
    ```

    Expect the facilitator's top-up, the approval and the deposit, each with a hash, then `done: 5.000000 QUSDC is in the router`. Keep the total moved to the run's size.

22. Authorise the agent key, by signature.

    ```powershell
    pnpm client:owner authorize --agent 0xAgentAddress --budget 0.5 --per-call 0.02 --days 7 --tool dex_quote=0xBuildersAddress --tool token_risk_check=0xBuildersAddress
    ```

    Expect `authorised: 0x...`. Put the same limits in the proxy's config, as the command's last line says.

23. Make three paid calls on two tools, from the agent's key.

    ```powershell
    $env:SLUICE_AGENT_KEY = (Get-Content .\agent.key -Raw).Trim()
    ```

    ```powershell
    pnpm client:smoke --config sluice.config.json --tool dex_quote --arg tokenIn=QIE --arg tokenOut=0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5 --arg amountIn=1
    ```

    Run it again with `--tool token_risk_check --arg address=0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5`, then once more with `dex_quote`. Expect each call to print the priced answer, the payment, and the tool's result. Windows PowerShell 5 strips the quotes out of a JSON argument, so give the arguments with `--arg` as here. To run the facilitator and the tool server on your own computer instead of hosting them, follow [LOCAL-MAINNET-RUN.md](LOCAL-MAINNET-RUN.md).

24. When the facilitator's batch has settled (its `/status/<id>` says `settled`), record what the chain shows. Use the transaction hashes from the router's `Settled` events or the facilitator's status, and from the owner's start.

    ```powershell
    pnpm evidence:record --claim paid-call-settlement --tx 0xTheBatchHash --network mainnet --router $env:SLUICE_ROUTER --tool dex_quote
    ```

    ```powershell
    pnpm evidence:record --claim settle-batch --tx 0xTheBatchHash --network mainnet --router $env:SLUICE_ROUTER
    ```

    For the start with no QIE, the deposit's hash and the facilitator's top-up hash:

    ```powershell
    pnpm evidence:record --claim relayed-start --tx 0xTheDepositHash --topup 0xTheTopUpHash --network mainnet --router $env:SLUICE_ROUTER
    ```

    The recorder refuses a claim the chain does not show.

25. The builder takes its earnings out. With no QIE, the builder signs and the facilitator sends. Use the builder's key, and the amount its earnings are (read it on the web app's builder page).

    ```powershell
    $env:SLUICE_KEY = (Get-Content .\builder.key -Raw).Trim()
    ```

    ```powershell
    pnpm client:owner withdraw --amount 0.5
    ```

    Expect `withdrawn: 0x...` and a `record it:` line. A builder who holds QIE can instead withdraw from the web app's builder page. Then the owner takes back what is left, the same way, with `pnpm client:owner refund --amount 4`, which prints `refunded: 0x...` and its own `record it:` line. Record the builder's withdrawal:

    ```powershell
    pnpm evidence:record --claim withdraw --tx 0xTheWithdrawHash --network mainnet --router $env:SLUICE_ROUTER
    ```

    And the refund:

    ```powershell
    pnpm evidence:record --claim refund --tx 0xTheRefundHash --network mainnet --router $env:SLUICE_ROUTER
    ```

### Check and clean up

26. Check every row against the chain again, and count.

    ```powershell
    pnpm evidence:check
    ```

    ```powershell
    pnpm evidence:summary
    ```

    Expect every row `PASS`. The summary prints counts per claim type and leaves out the founder wallets in `docs/founder-wallets.json`: add any wallet of yours that is not listed there before quoting a count. It needs `SLUICE_ROUTER` and `SLUICE_FROM_BLOCK`, the deployment's block, which `deployment.json` holds.

27. Clear the secrets from the session.

    ```powershell
    Remove-Item Env:SLUICE_KEY; Remove-Item Env:SLUICE_APPROVE; Remove-Item Env:SLUICE_AGENT_KEY
    ```

    Delete `.\relayer-mainnet.key` once it is in the host's secret store. Keep `.\deployer-mainnet.key` where it was.

## What each recorded claim proves

A recorded row says what a transaction on QIE showed when the recorder read it. [EVIDENCE.md](EVIDENCE.md) has the full table of what the recorder checks. In short:

| Claim | What it proves | What it does not prove |
| --- | --- | --- |
| `deploy` | A contract was created, its code is the compiled router's, it answers like a Sluice router on chain 1990, it holds QUSDC, and the vault it created has code and names it as its router. | That the source is published, that the vault's code is the compiled AgentVault's (`pnpm live:vaultcheck` checks that, and writes no row), who owns the router in practice, or that the router is free of faults. No outside party has reviewed the code. |
| `verify-link` | The explorer shows verified source for the router. | That the explorer's source is the source in this repository. Compare the two yourself. Anything about the vault, which has no claim of its own. |
| `deposit` | QUSDC went into the router for an account, in a transaction that succeeded. | Who controls the account. |
| `relayed-start` | An account with no QIE put QUSDC in by signing, after a top-up from another address. | Who sent the top-up beyond that it was not the account, or that the wallet was a real person's. |
| `settle-batch` | The router's `batchSettle` ran and reported each intent settled or skipped. | That the payments were for real tool calls. |
| `paid-call-settlement` | A signed payment was settled by someone other than its payer, payee and signer, which is what a facilitator does; the row can name the tool. | That an MCP tool call took place or that its result was good. |
| `withdraw` | An account took QUSDC out of the router in a transaction that succeeded. | Anything about the balance that was left. |
| `refund` | A payer's unspent prepaid balance left the router in a transaction that succeeded. | Who submitted it, the payer or a relayer with the payer's signature, or where the QUSDC went. |

A row from the fork dry run, or from the testnet, is labelled as such and is never read as mainnet proof.

## Verifying the source

Use the script first, and the manual route when it cannot finish.

**The script.** `pnpm live:verify --prepare-only` writes everything the manual route needs to `artifacts\verification\` and sends nothing. `$env:SLUICE_APPROVE = "verify"; pnpm live:verify` submits the standard JSON input of the router to the explorer's endpoint, then confirms with a separate read that the explorer shows the router as verified. It submits nothing for the vault and does not ask the explorer about it: see [The vault](#the-vault). `pnpm live:verify --check-only` only asks the explorer about the router. It reads `deployment.json` from the repository root, so run it from there. Its tests use a stand-in for the explorer, which has its documented shape; what was tried from this repository against the real explorer is in [EXPLORER-VAULT-INVESTIGATION.md](EXPLORER-VAULT-INVESTIGATION.md). `pnpm compile` removes the `.standard-input.json` files from `artifacts\verification\`, so run `--prepare-only` again after a compile, just before you need them.

**By hand.** For `PaymentRouter`, the files are the standard JSON input, a flattened single file, and the constructor arguments. `AgentVault` has the same three files: they are for building the vault again, and the script does not submit them. The settings, exactly:

| Setting | Value |
| --- | --- |
| Compiler | Solidity v0.8.24+commit.e11b9ed9 |
| EVM version | shanghai |
| Optimization | enabled, 200 runs |
| License | MIT |
| Contract names | `contracts/PaymentRouter.sol:PaymentRouter` (submitted) and `contracts/AgentVault.sol:AgentVault` (not submitted by the script) |
| Router constructor arguments | in `PaymentRouter.constructor-arguments.txt`: the token, the owner, the fee recipient and the fee, ABI-encoded, hex without `0x` |
| Vault constructor arguments | in `AgentVault.constructor-arguments.txt`: the router's address, ABI-encoded |

On the explorer's page for the contract, choose to verify and publish, then choose "Standard JSON input" and upload the `.standard-input.json` file, set the compiler and the contract name, and add the constructor arguments. The standard JSON route matches the deployed code exactly. If the explorer offers only a single file, use the `.flat.sol` file with the same settings; a single file matches the code but not the metadata, so the explorer may report a partial match. Do not submit a single file for a contract the explorer already shows as a full match: on 2026-11-26 that replaced the vault's full match with a partial one, until the standard JSON input was submitted again.

When the explorer shows the router as verified, check it and record it:

```powershell
pnpm live:verify --check-only
```

```powershell
pnpm evidence:record --claim verify-link --tx 0xTheDeploymentHash --network mainnet
```

## The vault

AgentVault is not deployed on its own. The router's constructor creates it, so it has no deployment transaction of its own. A verification of it tried on 2026-11-24 was answered by QIE's explorer with "The address is not a smart contract". On 2026-11-26 the standard JSON input, submitted to the explorer's `verifysourcecode` endpoint, was accepted, and the explorer then showed verified source for the vault of the 2026-11-23 deployment ([EXPLORER-VAULT-INVESTIGATION.md](EXPLORER-VAULT-INVESTIGATION.md), with its answer in [explorer/vault-record.json](explorer/vault-record.json)). That was done once, from a one-off script: `pnpm live:verify` still submits the router only and asks the explorer about the router only, so a vault from a new deployment has not been submitted by any command here, and nothing says the explorer shows it. What anyone can check for any deployment, without the explorer, is the vault's code.

```powershell
pnpm live:vaultcheck
```

It reads the vault's address from the router, reads the code at that address, builds the code the compiler produced for AgentVault with the vault's six immutables filled in (the router's address, which the code reads in two places, and the five values the EIP-712 base contract caches: its name hash, its version hash, the chain id, the vault's own address and the domain separator), and compares the two by their keccak256 hash. It also checks that the vault names the router as its router, that the metadata at the end of the code names solc 0.8.24, and that the hash is the one `deployment.json` recorded when the router was deployed. It is read-only: four RPC methods, no key. It needs `pnpm compile`, because the compiled contracts are what it compares with. To check a router other than the one in `deployment.json`, give its address from [EVIDENCE.md](EVIDENCE.md): `pnpm live:vaultcheck --router 0xTheRouter`.

It prints what a reader needs to build the vault again without trusting this program: solc v0.8.24+commit.e11b9ed9, the optimizer on at 200 runs, the Shanghai EVM, the contract `contracts/AgentVault.sol:AgentVault`, the router's address as the one constructor argument, and each immutable's byte offset and value. A reader who compiles with those settings, writes those values into the runtime code at those offsets, and hashes the result should get the hash the command prints, which is the hash of `eth_getCode` at the vault's address.

What this shows, and what it does not. It shows that the code at the vault's address is the code this repository compiles for AgentVault, with the values the constructor would write. It says nothing about what the explorer shows, and it does not show that the source is free of faults or that anyone outside this repository has reviewed it. The router's standard JSON input includes `AgentVault.sol`, because the router imports it, and on 2026-11-26 the explorer's record of the router listed that file among its sources.

## When the explorer returns 502

The explorer answers 502 at times. `pnpm live:verify` retries a request a few times, with a longer pause each time, then says the explorer could not be reached and exits with code 2. Nothing is lost: the files for the manual route are written before anything is sent.

- Wait a while and run the same command again. A contract the explorer already verified is reported as already verified.
- Or follow the manual steps above in the explorer's page when it answers.
- Run `pnpm live:preflight` to see whether the explorer answers. A `WARN` on it does not stop anything: the explorer is used for links and for verified source, and every other check reads the chain through the RPC.
- The recorder's other claims read the chain through the RPC and do not need the explorer. Only `verify-link` does, and the recorder links a mainnet transaction to `https://mainnet.qie.digital`, so a 502 there means the link is dead for a while and the row is still true.
- It is safe to go on to the smoke run while the verification waits. It is not safe to point users at the router before the router's source is verified and compared, and the vault's code has been compared with `pnpm live:vaultcheck`.

## Where to stop

| If | Then |
| --- | --- |
| `pnpm live:facts` or the pre-flight check says QUSDC's roles differ from [RISKS.md](RISKS.md) | Read what changed before putting money in. Correct RISKS.md if it is the document that is out of date. |
| The pre-flight check says `NO-GO` | Fix the named check. Do not deploy. |
| The deploy refuses, naming the owner, the fee recipient, the relayer, the token or the chain | Fix the setting it names. Nothing was sent. |
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
