# Risks

What can go wrong, who can do it, and what a user can still do about it. Each statement says what backs it.
Every contract behaviour below was shown on a local copy of QIE mainnet (a fork), and every fact about the
live chain is a read-only query, dated. What has happened on QIE mainnet is what [EVIDENCE.md](EVIDENCE.md)
records. The behaviour described here is backed by what each statement names, not by those rows. Section 7 says
which things a founder-run row now shows happened.

## 1. QUSDC's admin can burn any holder's balance

This is the largest risk, and it sits in QUSDC, not in Sluice.

Read from QIE mainnet on 2026-11-18 (block 11,996,097) with read-only calls:

| Fact | Value |
| --- | --- |
| Token | `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5`, name and symbol `QUSDC`, 6 decimals |
| Upgradeable? | No. The EIP-1967 implementation, admin and beacon slots are empty. |
| `VAULT_ROLE` holder | The contract `0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45` |
| `DEFAULT_ADMIN_ROLE` holder | The account `0xe1acec6312eb701D4A14De700CCec8DeE17a8D28` |
| What `VAULT_ROLE` allows | `mint(address,uint256)` and `burn(address,uint256)`. `burn` destroys the named account's tokens with no approval from that account. |
| What the admin can do | An account with `DEFAULT_ADMIN_ROLE` can grant `VAULT_ROLE` to any address, including itself. |

On a local fork, `test/fork/qusdc.fork.test.ts` impersonates the admin, grants it `VAULT_ROLE`, and burns QUSDC
from an ordinary wallet and from the router. Both work. That is what "the admin key can burn any holder's
balance" means in practice. No burn was sent on the live chain: that check sent nothing. What was read there is in the next paragraph.

Read again on 2026-11-22 (block 12,085,422), by `pnpm live:facts` with read-only calls: every row of the table above is unchanged, and the token's total supply is 8,929.088928 QUSDC. The node was also asked to run `burn(holder, 1)` as the holder of `VAULT_ROLE`, on the QUSDC held by the QUSDC/WQIE pool, without sending it: it ran the call, and it refused the same call made from an address with no role. That is a simulation by the node, so nothing was burned, and it shows that the role check separates the two, which is what the table says. The token does not list its role holders, so these reads cannot show that the two named addresses are the whole list of holders. [MAINNET-PREFLIGHT.md](MAINNET-PREFLIGHT.md) has the output.

What it means for Sluice:

- **Wallets.** Anyone who holds QUSDC is exposed, with or without Sluice.
- **The router's tokens.** If the router's QUSDC is burned, the router holds less than it owes. `solvency()` returns
  `(held, owed)`, so a shortfall is visible on chain. The fork test shows the effect: after 4 of 10 deposited QUSDC were
  burned, a refund of 10 failed, a refund of 6 worked, and 4 stayed owed.
- **First come, first served.** The router has no rule for sharing a shortfall. Whoever withdraws or refunds first is paid.

What the router does to keep users able to leave:

- `refund` and `withdraw` have no delay, no pause, no owner approval and no allow-list. The owner cannot stop them.
- `refundBySig` and `withdrawBySig` let a person with no QIE leave through a relayer.
- While the router holds what it owes, every payer can take back the whole unspent balance and every builder the whole
  earnings. `test/fork/qusdc.fork.test.ts` runs a full lifecycle on real QUSDC and ends with the router at zero.

What a user can do about the QUSDC risk: keep prepaid balances small, refund what is unspent, and withdraw earnings
often. The contracts cannot remove a power that QUSDC's admin holds.

## 2. What the Sluice owner can and cannot do

| | Power | How it is limited | Backed by |
| --- | --- | --- | --- |
| Can | Change the fee | Never above 200 basis points (2%). The change applies to later settlements only. | `setFee`, `test/unit/properties.test.ts`, `test/unit/surface.test.ts` |
| Can | Change who is credited the fee | Fees already credited stay with their holder. | `setFeeRecipient` |
| Cannot | Move, freeze or take a payer's balance or a builder's earnings | No function does it. A request signed by the owner for someone else's account is refused. | `test/unit/surface.test.ts` |
| Cannot | Pause, upgrade, replace or delete the contracts | No proxy, no pause, no `delegatecall`, no `selfdestruct`, no creation of other contracts in the deployed code. | `test/unit/surface.test.ts` (reads the bytecode) |
| Cannot | Change the token, the vault or the owner | They are `immutable`. | `test/unit/surface.test.ts` |
| Cannot | Spend an agent's session | Only the router can call the vault's `consume`. | `test/unit/AgentVault.test.ts` |
| Cannot | Make a payer pay more than the signed amount | The fee comes out of the builder's side. The payer is debited exactly the amount in the intent. | `test/unit/properties.test.ts` |

Because the owner cannot be changed or removed, a lost or compromised owner key cannot change the fee cap. At worst
it sets the fee to 2% and moves the fee recipient.

## 3. The contracts cannot be fixed after deployment

They are immutable on purpose. A bug stays. No outside security review has been done. The tests are broad
(see the README for the counts) but a test suite shows the absence of the bugs it looks for, not of every bug.
Start with small amounts. The live scripts cap what they move at 10 QUSDC and 5 QIE by default and refuse more
than 100 QUSDC or 50 QIE.

## 4. Signatures and agent keys

- **A payer's own key has no limit.** An intent signed by the payer spends from the payer's prepaid balance, up to
  what is in it. Keep that balance small.
- **An agent key is limited, not harmless.** A stolen agent key can spend its remaining budget, within its per-call
  cap, on its allowed tools, until its expiry or until the payer revokes it. It cannot spend more than that.
- **Revoking is immediate,** in the block the revoke lands in. An intent already settled stays settled.
- **Replay and look-alike chains.** Every signed message is bound to the chain id and the contract address, expires,
  and can be used once. Signatures with a high `s` value are refused, so one signature has one form.
- **A relayer cannot change what was signed.** `withdrawBySig` and `refundBySig` fix the destination and the relayer's
  fee inside the signature. The relayer fee can never exceed the amount.
- **A facilitator can decline to submit an intent.** `settle` is open to anyone, so the payer or the builder can submit it
  themselves. A skipped intent in a batch costs the submitter gas and charges the payer nothing.

## 5. Tokens the router does not support

The router measures what it actually received on deposit and refuses a deposit where the amount differs. That rules
out fee-on-transfer tokens. A token that can reduce the router's balance without a transfer (as QUSDC's admin can,
section 1) leaves the router short, as described above.

## 6. Facts about QIE, read on 2026-11-18

Read-only queries to `https://rpc1mainnet.qie.digital/` at blocks 11,996,097 to 11,996,226:

| Fact | Result | How it shaped the design |
| --- | --- | --- |
| EVM level | `PUSH0` runs. `MCOPY`, `TSTORE`, `TLOAD`, `BLOBBASEFEE` and `BLOBHASH` are rejected (a simulated `eth_call` that executes the opcode). | Compiled for Shanghai. A test fails if any Cancun opcode appears. |
| QUSDC permit or EIP-3009 | Absent. The calls revert with no data. | Deposits take two steps: approve, then deposit. |
| Multicall3, CREATE2 deployer, ERC-4337 EntryPoint (v0.6 and v0.7), Permit2 | No code at their usual addresses. | The contracts do not depend on any of them. Batching is built into `batchSettle`. |
| Gas price | 1.125 gwei (`eth_gasPrice`). | Basis of `docs/GAS.md`. |
| Block gas limit | 4,294,967,295 in the header. | Not relied on. Whether a single transaction can be that large was not tested. |

## 7. What was not tested

- Anything on QIE mainnet beyond what the rows of `docs/EVIDENCE.md` show, and anything on the testnet. All of those rows
  are founder-run. Among them: a start with no QIE (the payer held 0 QIE before the relayer's top-up of QIE); three paid
  calls settled, 0.002 QUSDC for `dex_quote`, 0.005 for `contract_lookup` and 0.010 for `token_risk_check`; the builder's
  withdrawal of 0.016830 QUSDC; and the payer's refund of 0.003 QUSDC. Each shows that it happened on that day. None shows
  how often it works, how it behaves under load, or that it works for anyone else. No row records a session being authorised
  or revoked or a hosted service, and there is no testnet row.
- Use by anyone outside the project. Every wallet in the mainnet rows is on the founder list, and `pnpm evidence:summary`
  counted 0 paid calls, 0 distinct payers and 0 distinct builders from outside it on 2026-11-26.
- Signing with a real wallet (QIE Wallet or MetaMask). The web app's browser tests use a mock wallet that signs with
  throwaway keys, and no row says which program signed a transaction. Whether a real wallet can sign a transaction without
  sending it, which a start with no QIE from the web app needs, is unknown.
- How the real network orders, delays or drops transactions.
- A very large batch against the real per-transaction gas limit.
- The branch of `domainSeparator()` that rebuilds the EIP-712 domain if the chain id changes (for example after a chain
  split). A local chain cannot change its chain id, so no test reaches it. Every other path through the domain is tested.
- The behaviour of QUSDC's admin or vault on the live chain. Its effect was shown only on a fork.
- Real MCP clients. The proxy and the wallet MCP were run as separate processes under a test client on a local chain, and the
  Claude Code and Cursor configurations in `packages/proxy/README.md` were written from the clients' documented formats and were
  not run in either client. The mainnet paid-call rows show signed payments being settled for a tool id. They do not show that
  an MCP client, the proxy or the wallet MCP made a call, or that a tool ran.
- A facilitator run by anyone else, a public relayer under load, and the real network's behaviour with the relayer's transactions
  (ordering, delay, replacement). The facilitator was tested against a local chain and a local fork. The founder-run mainnet
  rows, a start with no QIE and three settlements submitted by someone other than the payer, the payee and the signer, say
  nothing about any of these.
- The Claude and OpenAI directories and any other place a paid server might be listed. Nothing was listed anywhere.
- Resolving `.qie` names. No documented on-chain read for QIE ID names was found, so nothing resolves them.
- The Docker images. The Docker daemon was not running where they were written, so neither image was built. The build steps (install
  from the lockfile, compile, copy the production files, start the program) were each run outside Docker, from a copy of the build
  context that follows `.dockerignore`.
- A hosted facilitator or tool server. They were run as separate processes on a local chain and on a fork, behind a proxy that drops
  messages on purpose and with the process killed (SIGKILL) at three points of a batch's life. Nothing was run on a VPS or on
  Railway, behind a real TLS proxy, or under real traffic. No mainnet row shows a hosted service.
- The two services as Vercel functions. Nothing was run on Vercel, on Upstash or in GitHub Actions. Copies that run at once
  were tried on a local chain against a stand-in database that runs the same scripts in Lua 5.3, where Redis runs 5.1. That the
  platform hands a function the path that was asked for, how long a cold start takes, how Upstash counts a script against its
  quota, and the platform's time limits in practice are all unknown. [HOSTING-VERCEL.md](HOSTING-VERCEL.md) lists them.
  The guard that lets the two services share one database was tried against the same stand-in, and its daily command figures
  were counted there.
- The `SIGTERM` handler as a signal. A signal ends a process on Windows without running a handler, so the shutdown function was
  called directly and the signal itself was not sent.
- The explorer's verification, beyond one vault. The tests of `pnpm live:verify` use a stand-in that holds the endpoint's
  documented shape. The real explorer was tried from this repository on 2026-11-26, for the vault only
  ([EXPLORER-VAULT-INVESTIGATION.md](EXPLORER-VAULT-INVESTIGATION.md)), and no testnet explorer endpoint was tried.
- What the explorer's page for the vault rests on. The explorer holds no creation transaction for the vault, so its verification
  compared the running code and not the code that created it. The six values the constructor wrote into the code are checked by
  `pnpm live:vaultcheck`, which needs no explorer. The explorer can change or lose what it shows; the saved answer in
  [explorer/vault-record.json](explorer/vault-record.json) is of one day.
- Part of the recorder against a real QIE network. It has written mainnet rows, which `pnpm evidence:check` reads back from the
  chain, and every claim it knows has a mainnet row: `deploy`, `verify-link`, `deposit`, `withdraw`, `refund`,
  `relayed-start`, `settle-batch` and `paid-call-settlement`. What it refuses was tried on a local chain whose chain id is
  mainnet's, with every run labelled `fork`, not against the real network. No testnet row has been written.
- A person outside the project following `docs/TRY-IT-BUILDER.md` or `docs/TRY-IT-AGENT.md`. The two pages were followed in a test.

## 8. The MCP layer: what it adds, and what each part can and cannot do

These statements are about the facilitator, the proxy, the wallet MCP and the SDK. `docs/SPEC.md` section 11 repeats the ones a
spec reader needs.

| Part | If its key or its service is compromised or lying | What it cannot do | Backed by |
| --- | --- | --- | --- |
| Relayer key (facilitator) | It can spend its own QIE up to the day's budget, delay or drop requests, and submit valid signed requests for anyone. | Change a payment or a withdrawal, take QUSDC (it never holds any and asks for no relayer fee), call any contract but the router and the vault, pay more than 5 gwei or 4,000,000 gas for a transaction, or spend more than 2 QIE in a day. | `test/unit/facilitator/service.test.ts`, `test/unit/facilitator/http-onboard.test.ts` |
| Facilitator service | It can report a payment as valid or invalid wrongly to a resource server, and so cost that server a tool run. | Move any balance. Every payment is a signature, the destination of an exit is inside its signature, and only the router moves value. | `test/unit/facilitator/service.test.ts` |
| Start with no QIE | A wallet can keep the top-up it was sent: at most 0.0015 QIE, once per wallet per day, and only if it holds the QUSDC it asked to deposit. | Change what the two signed transactions do, or send QIE anywhere but to the wallet that signed. | `test/unit/facilitator/http-onboard.test.ts`, `test/fork/mcp.fork.test.ts` |
| Agent session key | It can spend its remaining budget, within its per-call cap, on the tools and builders the owner named, until the expiry or a revocation. | Raise its own budget, pay another builder or tool, or outlive its expiry. Only the owner's signature creates a session. | `test/unit/proxy/proxy.test.ts`, `test/unit/wallet-mcp/wallet.test.ts` |
| Payment proxy | A bug could let it overspend its local budget. | Spend past what the owner authorised on chain: the vault refuses, and a test shows it. | `test/unit/proxy/proxy.test.ts` |
| Wallet MCP | None that matters: it has no tool that signs, sends, takes a key or changes a budget. | Sign. It refuses to load the owner's key. | `test/unit/wallet-mcp/wallet.test.ts` |
| Paid server (SDK) | It can run a tool and then fail to be paid, if the payer takes their balance back between verify and settle. | Charge twice for one intent. | `test/unit/sdk/paid-tool.test.ts` |

Two risks are worth stating plainly.

- **The server runs the tool before it is paid.** The payer's balance is checked when the call arrives, net of what the
  facilitator has already queued, and settlement happens after the tool runs. A payer who refunds in between leaves the intent
  skipped on chain and the tool run. The window is short and the facilitator narrows it, and it is not closed. A builder who cannot
  bear that loss should price the tool low. The tool server as it runs on Vercel gives its answer only once the payment has
  settled, so such a payer gets no answer; the tool has still run.
- **A signed intent can be submitted by anyone.** It can only pay the builder it names, once, for the amount it names, before
  its deadline. A leaked intent cannot be redirected, and it is a bearer instruction until it is used or expires.

The example `token_risk_check` tool reproduces the finding in section 1 from chain data. It is a set of read-only checks, not a
security review, and its answers say what they cannot see.

## 9. Hosting the facilitator and the tool server

These statements are about `docs/DEPLOY-FACILITATOR.md`, `docs/DEPLOY-TOOL-SERVER.md` and the code behind them.

| Failure | What happens | Backed by |
| --- | --- | --- |
| The facilitator process is killed or the machine loses power | The next start reads the journal and settles what was in flight from the chain's own record. Each intent settles once, because the router burns a nonce once. | `test/unit/facilitator/crash.test.ts`, `test/unit/facilitator/durability.test.ts` |
| The disk is full or the journal cannot be written | The service accepts nothing and sends nothing, and `/health` answers 503. A batch already sent is found from the chain on the next start. | `test/unit/facilitator/durability.test.ts` |
| The journal is damaged before its last line | The service refuses to start and says so. It does not guess. | `test/unit/facilitator/durability.test.ts` |
| The relayer key leaks | The thief can spend the relayer's own QIE (up to what it holds), delay requests, and submit valid signed requests. It cannot move anyone's QUSDC. Turn the kill switch on, rotate the key, and move what is left. | `test/unit/facilitator/service.test.ts` |
| Someone floods the facilitator or the tool server | A rate limit per address and per payer, a body size limit and time limits answer 429 or 413, or cut the connection. The limits are in memory and per address, so many addresses are not stopped by them. | `test/unit/facilitator/operations.test.ts`, `test/unit/examples/host.test.ts` |
| The queue's copy is restored from an old backup | The service settles what it finds against the chain before it takes a request, and the router refuses a payment that already settled, so nothing is taken twice. Two services on two copies would waste gas sending the same batch. | `test/unit/facilitator/durability.test.ts` |
| A wrongly written evidence row | The recorder refuses a claim the chain does not show, and writes nothing. A row labelled with another network than its table makes the file unreadable. | `test/unit/recorder.test.ts` |
| On Vercel, two copies of the facilitator try to send at once | One lock with a rising token: the other sends nothing, and a copy that lost the lock can neither sign nor write. The pending nonce is read under the lock. | `test/unit/facilitator/serverless-concurrency.test.ts` |
| On Vercel, a function is stopped part-way through a batch | The lock expires, and the next drain settles what was in flight from the chain's own record. If it comes after a payment's deadline, a payment that never reached the chain expires, and a server that answered when it queued that payment is not paid for the call. | `test/unit/facilitator/serverless-concurrency.test.ts` |
| On Vercel, an attempt to settle a call of the hosted tool server fails | The answer is withheld. A payment that was not sent is marked as never to be sent; one that was, or may have been, is finished from the chain, and the same payment then fetches the answer. The tool has run, so the builder may bear its cost unpaid. | `test/unit/facilitator/unpaid.test.ts` |
| On Vercel, the hosted tool server answers "pending" and the caller signs a new payment | If the earlier payment settles later, the caller has paid twice for one call. The proxy and the web app send the same payment again instead, up to three times; another client must be written to do the same. | `test/unit/facilitator/unpaid.test.ts`, `test/unit/web/live-logic.test.ts` |
| On Vercel, a tool server that queues with `/settle` and answers at once | It can be left unpaid for a served call after one failed attempt to settle, when the next one comes after the payment's five minutes. | `test/unit/facilitator/unpaid.test.ts` |
| A session is revoked and the same key authorised again while a signed payment is unexpired | The old payment can settle against the new session, within its limits. The five-minute lifetime the clients sign is what bounds this, which is why it was not lengthened. | `test/unit/facilitator/validity.test.ts` |
| On Vercel, the database cannot be asked, or refuses commands | Nothing is accepted, sent or served, and a tool server runs no tool. | `test/unit/facilitator/serverless-handlers.test.ts` |
| On Vercel, the database is lost or emptied | The queue is gone, so its payments go unpaid, the day's counters start again and the stored kill switch is off. Nothing is charged twice, because the router burns a nonce once. Leave eviction off. | `test/unit/PaymentRouter.test.ts` |
| Something else sends with the relayer key (a second facilitator on another host) | The lock does not cover it, so the two can collide on a nonce. Use a relayer key in one place. | Nothing: it is a rule for whoever hosts it. |
| One database for both services: a fault in the tool server's code reaches for the facilitator's data | A guard refuses every key outside the tool server's own prefix, every other command and every script but its own two. The guard is in the code: see below. | `test/unit/facilitator/shared-database.test.ts` |
| One database for both services, and the facilitator was not told | It refuses to start once a tool server has marked the database, and a running copy accepts and sends nothing from then on. | `test/unit/facilitator/shared-database.test.ts` |
| One database for both services: the tool server's code or a library it loads is compromised, or the token leaks | Not stopped. See below. A database for each is the stronger setup. | Nothing. |
| One database for both services: a flood on the tool server uses up the month's commands or the space | The database refuses commands, and both services accept, send and serve nothing until it takes them again. A copy of the tool server stops asking the database for a caller it has itself counted past the limit, which slows a flood from one place and does not stop it. | `test/unit/facilitator/shared-database.test.ts` |

**Both services share one token** on the setup that uses one database. The in-code isolation can be bypassed by a bug or a
compromise in the tool server's code, in a library it loads, or by anyone who gets the token. Whoever does so can read and
change everything the facilitator keeps: the queued payments and their signatures, the stored kill switch, the daily caps,
and the counters of the relayer's daily budget and top-ups, which could be reset so that the relayer spends beyond its day's
budget, up to what it holds. The relayer key is not in the database, and no QUSDC moves except as a payer's own signature
allows. The setting `SLUICE_FACILITATOR_KILL_SWITCH` does not depend on the database and is the switch to rely on; the key in
the database is a second one. Separate databases are the stronger setup, to be used once a paid plan exists. Until then, keep
little QIE on the relayer.

A sluggish facilitator can still cost a tool server a tool run: the server verifies, runs the tool and then settles, as section 8 says.
