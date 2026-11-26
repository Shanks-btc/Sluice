# Evidence

Sluice claims only what a transaction on QIE can show. This page is the list of those transactions.

A row shows that a transaction happened. It does not show that anyone outside the project used Sluice: a row whose
Who address is on the [founder list](founder-wallets.json) is about the project's own wallet. `pnpm evidence:summary`
and the web app leave listed wallets out of what they count as use.

A table with no row in it means that nothing has been recorded for that network. A row says only what its claim
type says, in [Claims](#claims) below. Behaviour that no row shows has been tested, where it has been, on a local
chain or a local copy of QIE mainnet (a fork). See [the status table in the README](../README.md#current-status).

## How a row gets here

1. The founder runs a script from `scripts/live/` or `scripts/client/` on QIE mainnet or testnet. The scripts that
   spend refuse to run without an approval variable and a spending cap. See the README for the variable names.
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
| `deploy` | The transaction created a contract. Its code has the compiled PaymentRouter's length and metadata hash. It answers like a Sluice router on this chain, and on mainnet it holds QUSDC. The vault the router created has code, and names this router as its router. | That the source is published (see `verify-link`). Whether the vault's code is the compiled AgentVault's: see the vault, below. |
| `verify-link` | The explorer shows verified source for the deployment's contract, which is the router. | That the explorer's source is the source in this repository. Compare it yourself. Anything about the vault, which has no claim of its own: see the vault, below. |
| `deposit` | A router `Deposited` event in a successful transaction. | Who controls the account. |
| `withdraw` | A router `Withdrawn` event in a successful transaction. | Anything about the balance that was left. |
| `settle-batch` | The transaction is a call to the router's `batchSettle`, and the router reported each intent in it as settled or skipped. One row per settled intent. | That the payments were for real tool calls. |
| `paid-call-settlement` | A router `Settled` event for a signed payment that someone other than its payer, payee and signer submitted, which is what a facilitator does. The row can name the tool the payment was for. | That an MCP tool call took place or that its result was good. It shows a signed payment settled, and nothing more. |
| `relayed-start` | A deposit that the payer signed themselves, after a plain QIE top-up from another address, when the payer's QIE balance was zero. The top-up's hash is in the Claim column. | Who sent the top-up, beyond that it was not the payer. |
| `refund` | A router `Refunded` event in a successful transaction: unspent prepaid balance left the router for the payer in the Who column. | Who submitted it, the payer or a relayer with the payer's signature. Where the QUSDC went. |

**The vault.** AgentVault is not deployed on its own: the router's constructor creates it, so it has no deployment transaction and no `verify-link` row. A verification of it tried on 2026-11-24 was answered by QIE's explorer with "The address is not a smart contract". On 2026-11-26 a submission from this repository was accepted, and the explorer then showed verified source for the vault: its answer is saved in [explorer/vault-record.json](explorer/vault-record.json), and [EXPLORER-VAULT-INVESTIGATION.md](EXPLORER-VAULT-INVESTIGATION.md) has what was tried. That record is not a row of this file, and `pnpm evidence:check` does not read it: look at the vault's page on the explorer yourself. What anyone can check without the explorer is its code. `pnpm live:vaultcheck` reads the vault's address from the router, reads the code at that address, and compares its hash with the compiled AgentVault of this repository, with the six values the constructor writes into the code filled in. It prints the compiler settings to build it again: solc v0.8.24+commit.e11b9ed9, the optimizer on at 200 runs, the Shanghai EVM. It is a command to run, not a claim the recorder writes, so it has no row here. After `pnpm install` and `pnpm compile`, with the router's address from the Contract column of the `Deployed` row:

```powershell
$env:SLUICE_NETWORK = "mainnet"; pnpm live:vaultcheck --router 0xTheRouter
```

## Columns

| Column | Meaning |
| --- | --- |
| Date (UTC) | The block's timestamp as `2026-12-01T10:00:00Z`, to the second. |
| Event | `Deployed` and `SourceVerified` for the two claims about a contract, otherwise the router's event: `Deposited`, `Settled`, `Withdrawn` or `Refunded`. |
| Transaction hash | `0x` and 64 hex characters, as a link to the explorer on mainnet. For `verify-link`, the deployment's hash, linked to the router's page. |
| Block | The block number, as a plain integer. |
| Contract | The address that emitted the event, or the contract that was created. |
| Amount | QUSDC with exactly six decimals, like `0.010000`. `—` where there is no amount. |
| Who | The address the event is about: the account for `Deposited` and `Withdrawn`, the payer for `Settled` and `Refunded`, the deployer for the two contract claims. |
| Network | `mainnet` or `testnet`. Mandatory, and it must be the network of the table the row is in. A row labelled anything else makes this file unreadable, so a row from a test run cannot pass as mainnet proof. |
| Claim | The claim type, and for `relayed-start` the top-up's hash, and for `paid-call-settlement` the tool's name if one was given. |
| Re-check | The command that checks the row again. |

A run on a local fork of QIE mainnet has the same chain id as the real thing, so the recorder reads a local node only for a
run labelled `fork`, and writes that run to a file of its own, never to this one. A fork row is not evidence of anything on QIE.

## Mainnet (chain 1990)

| Date (UTC) | Event | Transaction hash | Block | Contract | Amount | Who | Network | Claim | Re-check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-23T17:15:06Z | Deployed | [0xd30777bca5c2e0d2538c52557ac4faba2665ab42c558ca343fe8d1b296143b33](https://mainnet.qie.digital/tx/0xd30777bca5c2e0d2538c52557ac4faba2665ab42c558ca343fe8d1b296143b33) | 12119118 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | — | 0x539e8616E5D1DD6C5b4F46055242eEF111209b70 | mainnet | deploy | `pnpm evidence:check --hash 0xd30777bca5c2e0d2538c52557ac4faba2665ab42c558ca343fe8d1b296143b33` |
| 2026-11-23T17:27:29Z | Withdrawn | [0x6314cf92a0623db46cf665350402a2fe0f7c46badaa39554983af4274ec996a3](https://mainnet.qie.digital/tx/0x6314cf92a0623db46cf665350402a2fe0f7c46badaa39554983af4274ec996a3) | 12119323 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.148500 | 0x539e8616E5D1DD6C5b4F46055242eEF111209b70 | mainnet | withdraw | `pnpm evidence:check --hash 0x6314cf92a0623db46cf665350402a2fe0f7c46badaa39554983af4274ec996a3` |
| 2026-11-23T17:26:53Z | Deposited | [0x458a1bb5af8b6681760ce01a52344f8b4145713151251fbce84d78ae6e6361bd](https://mainnet.qie.digital/tx/0x458a1bb5af8b6681760ce01a52344f8b4145713151251fbce84d78ae6e6361bd) | 12119313 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.300000 | 0x539e8616E5D1DD6C5b4F46055242eEF111209b70 | mainnet | deposit | `pnpm evidence:check --hash 0x458a1bb5af8b6681760ce01a52344f8b4145713151251fbce84d78ae6e6361bd` |
| 2026-11-23T17:15:06Z | SourceVerified | [0xd30777bca5c2e0d2538c52557ac4faba2665ab42c558ca343fe8d1b296143b33](https://mainnet.qie.digital/address/0xf6F4C1Cc954B1798d134750438ada58768978716?tab=contract) | 12119118 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | — | 0x539e8616E5D1DD6C5b4F46055242eEF111209b70 | mainnet | verify-link | `pnpm evidence:check --hash 0xd30777bca5c2e0d2538c52557ac4faba2665ab42c558ca343fe8d1b296143b33` |
| 2026-11-26T13:56:48Z | Deposited | [0x9d97b7f9a0ac03bd5af597f7182e536afdc44326f9e3dcd20a14e4e6c47ab3da](https://mainnet.qie.digital/tx/0x9d97b7f9a0ac03bd5af597f7182e536afdc44326f9e3dcd20a14e4e6c47ab3da) | 12187529 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.020000 | 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C | mainnet | relayed-start (top-up 0x00a0eb2a28fe81f23c2de97bc45e0f72de85624fc8ac33abab8749cc929baccc) | `pnpm evidence:check --hash 0x9d97b7f9a0ac03bd5af597f7182e536afdc44326f9e3dcd20a14e4e6c47ab3da` |
| 2026-11-26T14:03:00Z | Settled | [0x65f9116b382cd1ef7b228d5a10ba7183e1bdea5db35ab0e634b81c21eee00897](https://mainnet.qie.digital/tx/0x65f9116b382cd1ef7b228d5a10ba7183e1bdea5db35ab0e634b81c21eee00897) | 12187632 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.002000 | 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C | mainnet | paid-call-settlement (tool dex_quote) | `pnpm evidence:check --hash 0x65f9116b382cd1ef7b228d5a10ba7183e1bdea5db35ab0e634b81c21eee00897` |
| 2026-11-26T14:03:00Z | Settled | [0x65f9116b382cd1ef7b228d5a10ba7183e1bdea5db35ab0e634b81c21eee00897](https://mainnet.qie.digital/tx/0x65f9116b382cd1ef7b228d5a10ba7183e1bdea5db35ab0e634b81c21eee00897) | 12187632 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.002000 | 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C | mainnet | settle-batch | `pnpm evidence:check --hash 0x65f9116b382cd1ef7b228d5a10ba7183e1bdea5db35ab0e634b81c21eee00897` |
| 2026-11-26T14:08:01Z | Settled | [0x2d3b49df97045ef7cc2b5d473b7653e1009bb3df915bfbd2eae9572833b0b3a6](https://mainnet.qie.digital/tx/0x2d3b49df97045ef7cc2b5d473b7653e1009bb3df915bfbd2eae9572833b0b3a6) | 12187715 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.005000 | 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C | mainnet | paid-call-settlement (tool contract_lookup) | `pnpm evidence:check --hash 0x2d3b49df97045ef7cc2b5d473b7653e1009bb3df915bfbd2eae9572833b0b3a6` |
| 2026-11-26T14:08:01Z | Settled | [0x2d3b49df97045ef7cc2b5d473b7653e1009bb3df915bfbd2eae9572833b0b3a6](https://mainnet.qie.digital/tx/0x2d3b49df97045ef7cc2b5d473b7653e1009bb3df915bfbd2eae9572833b0b3a6) | 12187715 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.005000 | 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C | mainnet | settle-batch | `pnpm evidence:check --hash 0x2d3b49df97045ef7cc2b5d473b7653e1009bb3df915bfbd2eae9572833b0b3a6` |
| 2026-11-26T14:10:03Z | Settled | [0xc8459bf2a6b1345891c8cedd47314af435bfd7c3a56569869028e1219eb3990e](https://mainnet.qie.digital/tx/0xc8459bf2a6b1345891c8cedd47314af435bfd7c3a56569869028e1219eb3990e) | 12187749 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.010000 | 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C | mainnet | paid-call-settlement (tool token_risk_check) | `pnpm evidence:check --hash 0xc8459bf2a6b1345891c8cedd47314af435bfd7c3a56569869028e1219eb3990e` |
| 2026-11-26T14:10:03Z | Settled | [0xc8459bf2a6b1345891c8cedd47314af435bfd7c3a56569869028e1219eb3990e](https://mainnet.qie.digital/tx/0xc8459bf2a6b1345891c8cedd47314af435bfd7c3a56569869028e1219eb3990e) | 12187749 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.010000 | 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C | mainnet | settle-batch | `pnpm evidence:check --hash 0xc8459bf2a6b1345891c8cedd47314af435bfd7c3a56569869028e1219eb3990e` |
| 2026-11-26T14:13:51Z | Withdrawn | [0x4f6368b5d4c86878752742419c5a8506956afd724f3d713c570cb3f6146f8d70](https://mainnet.qie.digital/tx/0x4f6368b5d4c86878752742419c5a8506956afd724f3d713c570cb3f6146f8d70) | 12187812 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.016830 | 0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E | mainnet | withdraw | `pnpm evidence:check --hash 0x4f6368b5d4c86878752742419c5a8506956afd724f3d713c570cb3f6146f8d70` |
| 2026-11-26T14:15:55Z | Refunded | [0x5346fd1986303059cfa143854eb57c27b60679575d2b497b0937ba8f23eba67d](https://mainnet.qie.digital/tx/0x5346fd1986303059cfa143854eb57c27b60679575d2b497b0937ba8f23eba67d) | 12187846 | 0xf6F4C1Cc954B1798d134750438ada58768978716 | 0.003000 | 0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C | mainnet | refund | `pnpm evidence:check --hash 0x5346fd1986303059cfa143854eb57c27b60679575d2b497b0937ba8f23eba67d` |

## Testnet (chain 1983)

| Date (UTC) | Event | Transaction hash | Block | Contract | Amount | Who | Network | Claim | Re-check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
