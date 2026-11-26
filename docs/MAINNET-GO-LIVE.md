# Mainnet go-live checklist

One page to tick through on the day. **What has already happened on QIE mainnet is what [EVIDENCE.md](EVIDENCE.md) records**, and a step with no row there is not shown to have happened. A router that has a `Deployed` row exists already: deploy again only if you mean to replace it. Every command here was written, tested on a local chain and on a local fork, and run as a simulation in [MAINNET-DRYRUN-LOG.md](MAINNET-DRYRUN-LOG.md); that log says nothing about how the real chain, its explorer or its endpoints behave. The long form, with what to expect and where to stop at each step, is [MAINNET-RUNBOOK.md](MAINNET-RUNBOOK.md).

You run every command yourself, in PowerShell, from the repository root. Nothing here is run for you, and no step moves money until a command says so.

## 1. Make the accounts, and back them up offline

Five roles, five different addresses. The deploy refuses to run if the owner or the fee recipient is the deployer's address or the relayer's.

| Role | What it is | Make it with | Back up offline | Holds |
| --- | --- | --- | --- | --- |
| Deployer | A key that deploys once and runs the smoke run | `pnpm live:new-key .\deployer-mainnet.key` | A copy of the key file, on media that is kept offline. The file is the secret: there is no seed phrase. | QIE for gas and 0.3 QUSDC for the smoke run |
| Relayer | A hot key on the facilitator's host that pays gas | `pnpm live:new-key .\relayer-mainnet.key` | A copy of the key file, offline, before it goes into the host's secret store | QIE only, never QUSDC |
| Owner | The router's owner: it can change the fee (never above 2%) and the fee recipient, and nothing else | A new Rabby account | Its seed phrase, written on paper, offline, in two places | Nothing at first; a little QIE only if you later change the fee |
| Fee recipient | Where the fee is credited | A new Rabby account | Its seed phrase, the same way | Whatever fees collect |
| Payer | The wallet that starts with no QIE, which is what the run proves | A new Rabby account | Its seed phrase, the same way | QUSDC and no QIE |

- Write each seed phrase once, by hand, offline. Do not photograph it, type it into a file or a chat, or paste it into this repository. Nothing here asks for one: the plan command takes the three public addresses (`0x...`) and nothing else.
- Nobody can recover an account whose seed is lost, and the owner is fixed in the router when it is deployed: it cannot be changed afterwards. Back up the owner's seed before anything else, and choose an account you will keep. The plan command takes plain accounts and refuses a contract; to use a multisig as the owner, follow the runbook without it.
- The `*.key` files are git-ignored, so they never reach a repository. Keep copies only on media you control.

## 2. Fund, then plan

1. Work out the funding with the calculator, at the time you buy.

   ```powershell
   pnpm live:funding --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress
   ```

2. Send what it says to the deployer and the relayer, and QUSDC to the payer. The payer holds no QIE.
3. Print the plan for your own three addresses. It reads the chain, checks the five addresses against each other and against the chain, and prints the whole sequence with them filled in. It sends nothing and runs nothing.

   ```powershell
   $env:SLUICE_NETWORK = "mainnet"
   ```

   ```powershell
   pnpm live:golive:plan --owner 0xYourOwner --fee-recipient 0xYourFeeRecipient --payer 0xYourPayer
   ```

   It refuses a wrong checksum, a repeated address, the zero address, a contract as the owner, the fee recipient or the payer, and any chain but 1990. A warning that the relayer holds less than a day's budget (0.5 QIE) is expected while it holds 0.1: the run needs about 0.004 QIE, and the facilitator's `/health` will say `lowBalance` until the relayer is topped up.

## 3. The order of operations

Tick each box only for a step you did. Confirm each one on the explorer, at `https://mainnet.qie.digital/`, before the next.

- [ ] **Set the session and read QUSDC's facts.** `$env:SLUICE_KEY = (Get-Content .\deployer-mainnet.key -Raw).Trim()`, then `pnpm live:facts`. Expect `These match what docs/RISKS.md says.`
- [ ] **Pre-flight.** `pnpm live:preflight --deployer 0xYourDeployerAddress --relayer 0xYourRelayerAddress`. Expect `GO on mainnet`. Stop on `NO-GO`.
- [ ] **Set the deploy settings and caps** as the plan prints them (`SLUICE_APPROVE = "deploy"`, the owner, the fee recipient, `SLUICE_FEE_BPS = "100"`, the relayer, and the three caps), then **dry-run:** `pnpm exec ts-node scripts/live/deploy.ts --dry-run`. Check every address and the fee against what you meant.
- [ ] **Deploy:** `pnpm exec ts-node scripts/live/deploy.ts`. It spends about 3.16 million gas. Explorer: open `/tx/` with the hash in `deployment.json` and see `Success`; open `/address/` with the router's address and see the contract and its creation.
- [ ] **Record it:** `$d = Get-Content .\deployment.json -Raw | ConvertFrom-Json`, then `pnpm evidence:record --claim deploy --tx $d.hash --network mainnet`.
- [ ] **Wire the settings files:** `pnpm live:wire --network mainnet`. Then `$env:SLUICE_ROUTER = $d.router` and the pre-flight again with `--deployment deployment.json`. Expect `GO` and that the deployed code matches.
- [ ] **Verify the router's source:** `pnpm live:verify --prepare-only`, then `$env:SLUICE_APPROVE = "verify"; pnpm live:verify`, then `pnpm live:verify --check-only`. Explorer: the router's page shows verified source. Then `pnpm evidence:record --claim verify-link --tx $d.hash --network mainnet`. This command submits nothing for the vault, which the router's constructor creates: see [The vault](MAINNET-RUNBOOK.md#the-vault).
- [ ] **Check the vault's code:** `pnpm live:vaultcheck`. It reads the vault's address from the router and compares the code there with the compiled AgentVault, and prints the settings to build it again (solc 0.8.24, optimizer 200 runs, shanghai). Expect `0 failed`. It writes no row.
- [ ] **Smoke run:** set the smoke caps, `pnpm exec ts-node scripts/live/smoke.ts --dry-run`, then `pnpm exec ts-node scripts/live/smoke.ts`. Explorer: each of the eight hashes it prints shows `Success`. Record the deposit and the withdrawal with the lines it prints.
- [ ] **Host** the facilitator and the tool server from the files `live:wire` wrote ([DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md), [DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md); on Railway and Vercel, [HOSTING-RAILWAY.md](HOSTING-RAILWAY.md) and [HOSTING-VERCEL.md](HOSTING-VERCEL.md)). The relayer's key goes into the host's secret store. Do the kill switch drill.
- [ ] **Health check:** `Invoke-RestMethod https://facilitator.example/health | ConvertTo-Json -Depth 5` with your own address, or both services at once with `pnpm live:hostcheck --facilitator https://facilitator.example --tools https://tools.example`. Expect `ok` true, `chainId` 1990, your router, `killSwitch` false.
- [ ] **The payer starts with no QIE:** the payer's settings from the plan, then `pnpm client:owner start --amount 0.3`. Explorer: the payer's page shows the facilitator's small QIE top-up, then the approval and the deposit. Then `pnpm evidence:record --claim relayed-start --tx 0xTheDepositHash --topup 0xTheTopUpHash --network mainnet --router $env:SLUICE_ROUTER`.
- [ ] **Check and clean up:** `pnpm evidence:check`, `pnpm evidence:summary`, then clear `SLUICE_KEY`, `SLUICE_APPROVE` and the three caps from the session. `SLUICE_MAX_QIE` also sets the facilitator's day budget and the funding calculator's, so set the caps only in the session that runs the scripts.

## 4. If a step fails halfway

| Where | What to do |
| --- | --- |
| Any step refuses before it sends | Nothing was sent. Fix the setting it names and run the same line again. |
| The deploy times out, or says it failed | Open the deployer's address on the explorer. Do not send again until you know whether that attempt landed: a second one would make a second router. |
| The deploy landed but the record or the wiring failed | Run that line again. The recorder reads the chain, and `live:wire` refuses to overwrite a file you filled in (`--force` replaces it). |
| The explorer answers 502 during verification | Wait and run the same command again, or use the manual route in the runbook. The router is not affected. Do not point anyone at it until the source shows as verified. |
| The smoke run stops partway | Run nothing after it. The deployer's QUSDC that went in is the deployer's own balance in the router. Read the deployer's page to see which of the eight transactions landed, then take the balance back with `pnpm client:owner refund` through a running facilitator, or from the web app's refund flow with a wallet that holds QIE. |
| The facilitator shows `ok` false, or an alert other than the low balance one | Turn the kill switch on, then fix it. |
| You are unsure | Stop. A step that has not been run cannot be undone. |

## 5. Rolling back, and redeploying

- The router and the vault have no pause, no upgrade and no delete. Rolling back means stopping the services: turn the kill switch on, stop the facilitator and the tool server, and take the web app down. Balances stay where they are, and a payer can refund and a builder can withdraw with no one to ask.
- The owner can change the fee (at most 200 basis points) and the fee recipient. That is all it can do, and it cannot move anyone's balance.
- A redeploy makes a second router and vault at new addresses and costs about 3.16 million gas (about 0.0036 QIE at 1.125 gwei, as measured on a fork). The old router stays on the chain. After one: wire again (`pnpm live:wire --network mainnet --force`), point the hosts at the new addresses, and record new rows. Rows already recorded stay as they are.

## 6. After deploy: facts that must be recorded

Write these into [FOUNDER-LOG.md](FOUNDER-LOG.md) in your own words, on the day. Rows in `docs/EVIDENCE.md` come only from the recorder. Print them from the deployment record:

```powershell
$d = Get-Content .\deployment.json -Raw | ConvertFrom-Json
```

```powershell
"router  https://mainnet.qie.digital/address/$($d.router)"
```

```powershell
"vault   https://mainnet.qie.digital/address/$($d.vault)"
```

```powershell
"deploy  https://mainnet.qie.digital/tx/$($d.hash)  block $($d.block)"
```

| Fact | Where it comes from |
| --- | --- |
| Router address and vault address | `deployment.json`, and the explorer's address page |
| Deploy transaction hash, and its block number | `deployment.json` (`hash`, `block`) |
| The explorer links for the router, the vault and the deploy | The four lines above. What the vault's page shows is the explorer's to say: look, and write down what you see |
| The router's code hash and the vault's | `deployment.json`; the second pre-flight check compares them with the chain, and `pnpm live:vaultcheck` compares the vault's with the compiled AgentVault |
| The token (QUSDC `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5`), the owner, the fee recipient, the fee in basis points, and the relayer | The deploy's output and `deployment.json` |
| The hashes of the smoke run's eight transactions, and of the payer's start and its top-up | What those commands printed, and the explorer |
| Whether the explorer shows verified source for the router, and the date and time you checked | The router's page. `pnpm live:verify` asks nothing about the vault: see [The vault](MAINNET-RUNBOOK.md#the-vault) |
| The result of `pnpm live:vaultcheck`: the vault's code hash, and the date and block it was read at | What the command printed |
| The facilitator's and the tool server's public addresses, and the day each was started | Your hosts |

The README's status table changes only for a surface that has a verified mainnet row in `docs/EVIDENCE.md`. Until then nothing here is called live.
