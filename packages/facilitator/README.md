# @sluice/facilitator

A plain Node HTTP service that checks payments against the chain, queues them, and submits them to the router in batches.
It also starts wallets that hold QUSDC and no QIE, and relays signed exits and agent sessions.

| Endpoint | What it does |
| --- | --- |
| `POST /verify` | Checks a payment: the scheme's stateless checks, then the payer's nonce, their balance less what is already queued, and an agent's session. Changes nothing. |
| `POST /settle` | The same checks, then queues the intent. The same intent is one record however often it is sent. |
| `GET /status/<id>` | `queued`, `submitted`, `settled`, `skipped` (with the contract's reason), `expired` or `failed`. |
| `POST /onboard` | The start with no QIE: two pre-signed transactions, checked byte by byte, with the gas topped up. |
| `POST /relay` | A signed withdrawal, refund, agent authorisation or revocation, submitted by the relayer. |
| `GET /health` | The relayer's address, QIE balance, daily budget, alerts, whether it is low on QIE, whether the kill switch is on, whether the queue store can be written, and what is in flight. Never a key. HTTP 503 when the store cannot be written or the service is shutting down. |

Queued intents are sent with `batchSettle`. An intent the router skips (expired, spent, unaffordable, outside an agent's
policy) comes back in a `SettleSkipped` event and is reported by `/status` with the reason. The rest of the batch settles.

## The relayer key

One hot key, from the environment variable `SLUICE_RELAYER_KEY`. It is never printed, never logged and not serialised: a test
prints, serialises and inspects the relayer and looks for it. The relayer:

- holds QIE for gas and nothing else. It never holds QUSDC: it asks for no relayer fee, so the router never pays it any,
  and `/health` reports and alerts if its address ever holds some;
- is not the router's owner or its fee recipient. The service refuses to start if it is either;
- cannot change what anyone signed. Every payment is a signature, and the destination of an exit is inside its signature.

## Limits in code

These are constants in `src/caps.ts`. A setting can lower one and cannot raise it above its ceiling. A request above a ceiling
stops the service at start-up.

| Limit | Default | Ceiling |
| --- | --- | --- |
| Gas limit for one transaction | 4,000,000 | 4,000,000 |
| Gas price the relayer will pay | 2 gwei | 5 gwei |
| QIE the relayer may spend per UTC day (gas and top-ups) | 0.5 QIE | 2 QIE |
| Intents in one batch | 50 | 50 |
| QIE sent to one wallet for a start with no QIE | 0.001 QIE | 0.0015 QIE |
| QIE sent to one address in a UTC day, all top-ups | 0.001 QIE | 0.003 QIE |
| QUSDC deposited by one start with no QIE | 10 | 100 |
| Intents queued per payer per day | 2,000 | 20,000 |
| QUSDC queued per payer per day | 50 | 1,000 |
| Intents queued in all, per day | 20,000 | 200,000 |
| QUSDC queued in all, per day | 500 | 10,000 |
| Starts with no QIE per wallet per day | 1 | 3 |
| Relayed requests per account per day | 3 | 10 |

Contract calls go only to the router and the vault. The one transfer of QIE the relayer makes is the capped top-up for a
start with no QIE. An alert is raised when half of the day's budget is used, and again when it is gone; a batch that
would pass the budget or the gas price ceiling is held, and its intents stay queued.

## The start with no QIE

QUSDC has no permit, so the initial approve is a transaction that needs QIE. The wallet signs `approve(router, amount)` and
`deposit(amount)` as two legacy transactions with fixed gas limits (60,000 and 130,000), and posts them to `/onboard`. The
service checks that both are signed by the payer, for chain 1990, for the right contracts and the right calls, that the
approval is for the router and equals the deposit, that the gas price and limits are inside its caps, that the nonce is the
wallet's next and that the wallet holds the QUSDC. It sends the wallet the QIE the gas limits can use, less what it
already has, and then broadcasts both. `docs/SPEC.md` section 8 has the full rules, and `DECISIONS.md` says why this option
was chosen over the others.

## The queue survives a stop

The queue is an append-only journal, one JSON line per change, flushed to disk before a write returns. A batch is written down as
`submitted` before its transaction exists, its hash is written the moment the node has it, and only then does the wait for the
receipt begin. On the next start the service settles what it finds from the chain: a receipt names each intent's outcome, a
transaction that is still waiting keeps its intents `submitted`, a used nonce is found as a `Settled` event, and an unused nonce with
nothing in flight puts the intent back in the queue. The router burns a nonce once, so even a batch sent twice settles each intent once.
A test kills the process with SIGKILL at three points of a batch's life and checks that every intent settles once and none is lost.

The store fails closed. A journal that cannot be read, or has a damaged line before its last, refuses to open. A write that fails (a full
disk) makes the store unhealthy for good: the service accepts nothing and sends nothing, and `/health` answers 503. A half-written last
line, which is what a crash leaves, is cut off. A lock file stops two processes from using one journal.

## Operating it

- **Kill switch.** `SLUICE_FACILITATOR_KILL_SWITCH=1`, or a file named by `SLUICE_FACILITATOR_KILL_FILE`, stops queueing, settling, top-ups and relayed requests, and makes `/verify` say no. `/health` and `/status` keep answering. The file is checked on every request, so creating it stops the service at once.
- **Limits on callers.** A request body over 64 KiB is refused. A client address, and a payer address, may make a limited number of requests a minute, then get HTTP 429 with `Retry-After`. `X-Forwarded-For` is ignored unless `SLUICE_FACILITATOR_TRUST_PROXY_HOPS` says how many proxies sit in front.
- **Logs.** One JSON object per line, with the relayer key, signatures and raw transactions left out.
- **Shutdown.** SIGTERM stops it listening, waits for a batch in progress (`SLUICE_FACILITATOR_SHUTDOWN_MS`), and closes the queue. A batch it could not wait for is finished from the chain on the next start.

`docs/DEPLOY-FACILITATOR.md` has the settings, a Dockerfile, the steps for a VPS and for Railway, key rotation, backups and a checklist.

## Run it

```bash
pnpm build
SLUICE_NETWORK=local SLUICE_RPC_URL=http://127.0.0.1:8545 SLUICE_ROUTER=0x... SLUICE_RELAYER_KEY=... pnpm start:facilitator
```

Against mainnet or testnet it also needs `SLUICE_APPROVE=facilitator`, `SLUICE_MAX_QIE` (the daily budget) and `SLUICE_FACILITATOR_STATE` (the queue's journal), and it
refuses to start without them. Nothing in this repository has run it against a QIE network.
