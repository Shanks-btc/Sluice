# Gas and cost

Measured on a local fork of QIE mainnet (chain 1990) at block 12,027,290, on 2026-11-19, with the real QUSDC. Nothing was sent to QIE. Regenerate it with `pnpm gas:report`.

Gas used is exact for the state the test built. On the live chain it can differ a little with the state it meets (for example whether a balance slot is already set), so read these as measurements, not promises.

## Basis

| Input | Value | Source |
| --- | --- | --- |
| Gas price | 1.125 gwei | QIE's public RPC, `eth_gasPrice`, read when this was generated |
| QIE price | $0.164378 | an assumed price: a quote taken on 2026-11-18. QIE's price moves; set `QIE_PRICE_USD` to change it |
| Block gas limit | 4,294,967,295 | read from the header of block 12,027,290 on QIE mainnet |
| Compiler | Solidity 0.8.24, Shanghai EVM, optimizer 200 runs | `hardhat.config.ts` |

## Single operations

| Operation | Gas | QIE | USD |
| --- | --- | --- | --- |
| QUSDC transfer to a new holder (for comparison) | 52,174 | 0.00005870 | $0.00000965 |
| QUSDC transfer to an existing holder (for comparison) | 35,074 | 0.00003946 | $0.00000649 |
| Approve QUSDC for the router | 46,973 | 0.00005284 | $0.00000869 |
| Deposit, first for this payer | 112,937 | 0.00012705 | $0.00002088 |
| Deposit, later | 61,637 | 0.00006934 | $0.00001140 |
| Settle, first payment to a builder | 110,078 | 0.00012384 | $0.00002036 |
| Settle, later payment | 75,866 | 0.00008535 | $0.00001403 |
| Withdraw, part of earnings | 71,538 | 0.00008048 | $0.00001323 |
| Withdraw by signature, through a relayer | 101,687 | 0.00011440 | $0.00001880 |
| Refund, part of the balance | 54,477 | 0.00006129 | $0.00001007 |
| Refund by signature, through a relayer | 101,639 | 0.00011434 | $0.00001880 |
| Authorize an agent, one tool | 119,499 | 0.00013444 | $0.00002210 |
| Authorize an agent by signature, one tool | 134,066 | 0.00015082 | $0.00002479 |
| QIE top-up transfer by a facilitator, for a wallet with no QIE | 21,000 | 0.00002363 | $0.00000388 |
| Revoke an agent | 27,315 | 0.00003073 | $0.00000505 |
| Settle signed by an agent, first spend | 93,204 | 0.00010485 | $0.00001724 |
| Deploy the router (creates the vault) | 3,158,652 | 0.00355348 | $0.00058411 |

## Batch settle, scenario A: one payer, one builder (the cheapest case: the same storage is reused by every intent)

| Batch size | Total gas | Gas per intent | QIE per intent | USD per intent |
| --- | --- | --- | --- | --- |
| 1 | 111,208 | 111,208 | 0.00012511 | $0.00002057 |
| 10 | 454,831 | 45,483 | 0.00005117 | $0.00000841 |
| 50 | 1,982,319 | 39,646 | 0.00004460 | $0.00000733 |

## Batch settle, scenario B: every intent from a different payer to a different builder (the most expensive case)

| Batch size | Total gas | Gas per intent | QIE per intent | USD per intent |
| --- | --- | --- | --- | --- |
| 1 | 111,228 | 111,228 | 0.00012513 | $0.00002057 |
| 10 | 695,167 | 69,516 | 0.00007821 | $0.00001286 |
| 50 | 3,291,319 | 65,826 | 0.00007405 | $0.00001217 |

## Reading this

- A payer deposits once and then every call is signed off-chain, so the per-call cost is the batch row, paid by whoever submits the batch (a facilitator), not by the payer or the builder.
- Settling does not move any QUSDC: it changes two balances inside the router. QUSDC moves only on deposit, withdraw and refund.
- A wallet with QUSDC and no QIE starts through a facilitator. The wallet signs an approve and a deposit with gas limits of 60,000 and 130,000; the facilitator sends it the QIE those limits can use (190,000 gas at the price above, 0.00021375 QIE) and pays 21,000 gas for that transfer, 0.00023738 QIE in all. The wallet keeps what its two transactions do not use.
- The block gas limit above is what the chain's header says. Whether the network accepts a single transaction as large as the biggest batch here was not tested, because nothing was sent. Keep batches modest until it has been.
- The USD column depends on the QIE price above, which moves. It is an illustration, not a quote.
