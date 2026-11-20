# Evidence

Sluice claims only what a transaction on QIE can show. This page is the list of those transactions.

Both tables are **empty** because nothing has been run on a QIE network yet. Every contract in this
repository has been tested on a local copy of QIE mainnet (a fork) and nowhere else. See
[the status table in the README](../README.md#current-status).

## How a row gets here

1. The founder runs a script from `scripts/live/` on QIE mainnet or testnet. The scripts refuse to run without an
   approval variable and a spending cap. See the README for the variable names.
2. The founder gives the transaction hash and the kind of claim to the recorder:
   `pnpm evidence:record --claim deposit --tx 0x... --network mainnet --router 0x...`.
3. The recorder reads that transaction back from QIE's public RPC (rpc1 to rpc5, in turn), using read-only methods
   only. It checks that the transaction succeeded and that it shows what the claim says. If it does, the recorder
   adds the row, with an explorer link (mainnet) and the command that checks it again. If it does not, the recorder
   says why and writes nothing. **No one writes a row by hand**: a table that holds a row the recorder did not write
   is not trusted by anything that reads this file.
4. `pnpm evidence:check` reads every row back from the chain again, by RPC. It asks the explorer only for a
   `verify-link` row, because "verified" is something only the explorer can say. `pnpm evidence:check --hash 0x...`
   checks the rows for one transaction.

A row **fails** the check if the transaction is missing, if it failed, if the block or the time is different,
if the contract that emitted the event is not the one in the row, if the event is not the one named, if the
amount differs by even one unit, if the event is not about the address in the Who column, or if the transaction no
longer shows what its claim says. If QIE's RPC cannot be reached the row is **skipped**, which is never reported as a pass.

## Claims

| Claim | What the recorder checks from the chain | What it does not show |
| --- | --- | --- |
| `deploy` | The transaction created a contract. Its code has the compiled PaymentRouter's length and metadata hash. It answers like a Sluice router on this chain, and on mainnet it holds QUSDC. | That the source is published. See `verify-link`. |
| `verify-link` | The deployment's contract has verified source on the explorer. | That the explorer's source is the source in this repository. Compare it yourself. |
| `deposit` | A router `Deposited` event in a successful transaction. | Who controls the account. |
| `withdraw` | A router `Withdrawn` event in a successful transaction. | Anything about the balance that was left. |
| `settle-batch` | The transaction is a call to the router's `batchSettle`, and the router reported each intent in it as settled or skipped. One row per settled intent. | That the payments were for real tool calls. |
| `paid-call-settlement` | A router `Settled` event for a signed payment that someone other than its payer, payee and signer submitted, which is what a facilitator does. The row can name the tool the payment was for. | That an MCP tool call took place or that its result was good. It shows a signed payment settled, and nothing more. |
| `relayed-start` | A deposit that the payer signed themselves, after a plain QIE top-up from another address, when the payer's QIE balance was zero. The top-up's hash is in the Claim column. | Who sent the top-up, beyond that it was not the payer. |

## Columns

| Column | Meaning |
| --- | --- |
| Date (UTC) | The block's timestamp as `2026-12-01T10:00:00Z`, to the second. |
| Event | `Deployed` and `SourceVerified` for the two claims about a contract, otherwise the router's event: `Deposited`, `Settled` or `Withdrawn`. |
| Transaction hash | `0x` and 64 hex characters, as a link to the explorer on mainnet. For `verify-link`, the deployment's hash, linked to the contract's page. |
| Block | The block number, as a plain integer. |
| Contract | The address that emitted the event, or the contract that was created. |
| Amount | QUSDC with exactly six decimals, like `0.010000`. `—` where there is no amount. |
| Who | The address the event is about: the account for `Deposited` and `Withdrawn`, the payer for `Settled`, the deployer for the two contract claims. |
| Network | `mainnet` or `testnet`. Mandatory, and it must be the network of the table the row is in. A row labelled anything else makes this file unreadable, so a row from a test run cannot pass as mainnet proof. |
| Claim | The claim type, and for `relayed-start` the top-up's hash, and for `paid-call-settlement` the tool's name if one was given. |
| Re-check | The command that checks the row again. |

A run on a local fork of QIE mainnet has the same chain id as the real thing, so the recorder reads a local node only for a
run labelled `fork`, and writes that run to a file of its own, never to this one. A fork row is not evidence of anything on QIE.

## Mainnet (chain 1990)

| Date (UTC) | Event | Transaction hash | Block | Contract | Amount | Who | Network | Claim | Re-check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Testnet (chain 1983)

| Date (UTC) | Event | Transaction hash | Block | Contract | Amount | Who | Network | Claim | Re-check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
