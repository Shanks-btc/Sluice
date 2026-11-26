# Rehearsal log

This is what `pnpm rehearsal:testnet` did, step by step, with what the testnet showed. Everything here is about QIE's **testnet** (chain 1983) and a token with no value. It says nothing about mainnet, QUSDC, a real client or a real user, and it is not a record of anything the founder did. The command and what it needs are in [REHEARSAL.md](REHEARSAL.md).

## Run 1: 2026-11-20, stopped at the balance check

The command ran from 15:48 UTC. It read the two key files in the repository root, checked each against the address it is meant to hold (both matched), chose an endpoint, confirmed the chain, read both balances, and stopped because both held no QIE. **No transaction was sent. No faucet was called. Nothing was spent.** There is no transaction hash to list, because there is none.

| Step | What it did | What the testnet showed |
| --- | --- | --- |
| 1. Keys | Read `deployer-testnet.key` and `relayer-testnet.key` inside the program and checked each against its address. Made a throwaway owner key and a throwaway agent key for the run in `.rehearsal/` (git-ignored; they hold no QIE). | Deployer `0xA628018769dacfcdB84dc58A68D2CaA982C77877` and relayer `0x5f49b193BAe4D8Ec010a191DC41b8d5fAC16D772` both matched. Throwaway owner `0x76A4fF2F6aB9c023121F275ea1f9c4A1939872f7`, agent `0x00C2bF2246A1FFa800990706a857351645FEeb47`. |
| 1. Endpoint | Probed the five testnet endpoints (rpc1 to rpc5 of `testnet.qie.digital`) with `eth_chainId`, each with a short limit, and used the earliest that answered with 1983. | **Chose `rpc4testnet.qie.digital`** (chain 1983, 1,545 ms) with `rpc5testnet.qie.digital` as the one fallback for reads. `rpc1testnet` and `rpc2testnet` timed out and `rpc3testnet` was unreachable. The chain was at block 9,868,305. |
| 1. Balances | Read the gas price and both balances, and sized the amounts. | Gas price **7 wei**. Deployer **0 QIE**. Relayer **0 QIE**. The run needs at least **0.01 QIE at the deployer** and **0.025 QIE at the relayer**. |
| 1. Result | Stopped, with the message below. | Exit code 2 (stopped for QIE, not a failure). |

The message it printed:

```text
STOP: the rehearsal needs testnet QIE before it can send anything.
  deployer 0xA628018769dacfcdB84dc58A68D2CaA982C77877 holds 0 QIE and needs at least 0.01 QIE (0.01 more).
  relayer 0x5f49b193BAe4D8Ec010a191DC41b8d5fAC16D772 holds 0 QIE and needs at least 0.025 QIE (0.025 more).
  The sizes are from the gas docs/GAS.md measured, at 1.125 gwei with half again on top, and no single transaction may cost more than 0.05 QIE.
  The testnet's own gas price reads 0.000000007 gwei just now, so the real cost may be far below this; the run asks for the larger figure in case the price rises.
  QIE's documentation gives the faucet as https://www.qie.digital/faucet. This run did not open it.
  Get it from QIE's testnet faucet, then run pnpm rehearsal:testnet again.
  This run called no faucet and sent nothing. The run keeps its place in rehearsal-state.json and carries on from here.
```

Steps 2 to 9 did not run. Their state is "not run" in `rehearsal-state.json`, and the next run starts at the balance check.

### Where the amounts come from

Gas from [GAS.md](GAS.md): deploying the router 3,158,652, the smoke run's eight transactions 636,021, a withdraw 71,538, an authorisation by signature 134,066, a top-up transfer 21,000, a batch of ten intents 695,167. The test token's deploy and the two mints are sized at the limits the scripts allow (1,500,000 and 100,000 gas), because the testnet has not measured them. The deployer's figure is the sum for what its address sends, at no less than 1.125 gwei, with half again on top, rounded up to 0.005 QIE. The relayer's figure is the largest of: five of the biggest batches in GAS.md (what the pre-flight check calls a failure to be below), the 0.02 QIE daily budget the run gives the facilitator, and its own gas plus the top-up. A test holds each of these to the pre-flight check, so a funded address does not fail it at any gas price.

### What the testnet endpoints did

On 2026-11-20 `rpc1testnet` and `rpc2testnet` timed out and `rpc3testnet` was unreachable, while `rpc4testnet` and `rpc5testnet` answered with chain 1983. QIE's documentation lists a sixth testnet endpoint (`rpc6testnet.qie.digital`) that this run did not use.

### The explorer and the faucet

QIE's documentation (docs.qie.digital, the page "Access Mainnet or Testnet", read on 2026-11-20) gives the testnet explorer as `https://testnet.qie.digital` and the faucet as `https://www.qie.digital/faucet`, with chain id 1983. Those two addresses are what a person reading that page would find; this run did not open either, so neither is confirmed to work. The explorer's source-verification endpoint has not been tried. No testnet transaction is linked to an explorer anywhere in this repository: a testnet row in EVIDENCE.md shows the hash alone.

## Run 2: 2026-11-20, 22:00 UTC, the same stop

The command was run again at the end of the work. It skipped the two steps already done, probed the endpoints again (`rpc4testnet.qie.digital` chosen at 1,816 ms; `rpc1testnet` and `rpc2testnet` timed out, `rpc3testnet` unreachable), read the gas price (7 wei) and both balances (0 QIE each), printed the same message and stopped at the same step. Nothing was sent, no faucet was called, and the Testnet table in EVIDENCE.md still has no rows.

## A dress rehearsal on this machine (not the testnet)

Before stopping for QIE, the whole command was run against a **local node that reports chain 1983**, with keys made for that run, a copy of the evidence file and a stand-in for the explorer. It is a test of the program, on this machine, with no value. Nothing in it reached QIE, nothing in it is evidence, and none of its hashes is listed here because a local chain's hashes mean nothing elsewhere. The real key files and the real `docs/EVIDENCE.md` were not touched (the file's hash was the same before and after).

What it showed:

- Every step ran in order: the test token, the pre-flight checks (both GO), the router deploy as a dry run and then for real, the recorded deploy claim, the smoke run's eight transactions and its two recorded claims, the facilitator and the tool server started as separate programs, the funded flow (an owner with no QIE, started by the facilitator, an agent authorised by signature, three paid calls on two tools through `pnpm client:smoke` and the proxy), the settlement, five recorded claims (paid-call-settlement, relayed-start, deposit), the builder's withdraw and its claim, and `pnpm evidence:check` passing every row.
- The restart drill: the facilitator was killed with an intent queued, restarted on the same queue file, and the intent settled once; the router showed one `Settled` event for each intent the run had made, each with its own nonce.
- The kill switch drill: with the switch on, a paid call was refused (`sluice_kill_switch`), a zero-QIE start for a new wallet was refused, the wallet still held 0 QIE and the relayer's transaction count did not change; with it off, a paid call settled.
- Steps that failed, and what was done: the smoke run's agent authorisation reused a transaction count that ethers had cached for 250 ms (a node that mines at once makes it show; a chain with blocks seconds apart would not), so the scripts' provider now reads counts fresh. A second run resumed from the saved state, skipped every step already done, and ran the smoke run and its recording cleanly. The step that asks the explorer failed as it should when the explorer answered 502: it printed that the explorer could not be reached, wrote the files for the manual route, and recorded no `verify-link` row.
- Gas on that local node, for the same code: deploying the router 3,158,652 (the figure in GAS.md), the top-up transfer 21,000 (GAS.md 21,000), a batch settle of one intent 89,534 and of two 135,745. Its token is the test token, not QUSDC, so the other figures differ from GAS.md in places where the token's own code runs; these are not testnet measurements.

## Not done yet

- Every step after the balance check, on the testnet. That includes both drills and every recorder claim for the testnet: the Testnet table in [EVIDENCE.md](EVIDENCE.md) has no rows.
- Source verification on an explorer.
- Whether the testnet node serves `eth_getBalance` for the block before a top-up, which the `relayed-start` claim needs. The recorder says so, and writes nothing, if it does not.

## What has to happen next

1. Get testnet QIE to the two addresses: at least 0.01 QIE to `0xA628018769dacfcdB84dc58A68D2CaA982C77877` (the deployer) and at least 0.025 QIE to `0x5f49b193BAe4D8Ec010a191DC41b8d5fAC16D772` (the relayer), from QIE's testnet faucet.
2. Run `pnpm build` once, then `pnpm rehearsal:testnet` again. It carries on from the balance check.
3. Read the output. A step that fails prints its exact error and the run goes on without the steps that need it; running the command again retries it. This log should then be extended with what that run showed, transaction by transaction.
