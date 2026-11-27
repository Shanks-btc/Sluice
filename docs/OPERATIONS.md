# Running the live service

A plain runbook for whoever runs Sluice for real users: what to look at every day, what to set up so that a fault reaches a person, and what to do in each failure. It assumes the three services in [DEPLOY-WEB.md](DEPLOY-WEB.md), [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md) and [DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md) are hosted, and that the rehearsal in [REHEARSAL.md](REHEARSAL.md) was run first.

Nothing in this document has been run against a hosted service. The commands are written from the code and the deployment guides, and each one says what to expect so that a difference is noticed. This repository wires up no alerts of its own: the hooks below are what a monitor can read, and connecting one is the operator's step.

## Who does what

One person can hold every role at the start. The roles are separate so that nothing depends on one person remembering.

| Role | Does | Needs |
| --- | --- | --- |
| Operator | The daily check below, reads the alerts, restarts a service, turns the kill switch on and off | Access to the hosts and the Status page |
| Key custodian | Holds the relayer key and the deployer (owner) key, rotates the relayer key | The key files, kept off the hosts that do not need them |
| Responder | Leads an incident from the checklist below, and says what happened afterwards | The operator's access, and a way to post on the Status page's channel |
| Reviewer | Reads [TERMS.md](TERMS.md) and [PRIVACY.md](PRIVACY.md) with a lawyer before launch, and again when the product changes | A lawyer who knows the region |

## Every day, five minutes

1. Open the site's `/status` page. It reads the facilitator, the tool server and the QIE nodes when you open it. It should say "Working". Anything else lists what is wrong.
2. Read the facilitator's health from your own machine. The command prints the JSON the page reads.

   ```powershell
   Invoke-RestMethod https://facilitator.example/health | ConvertTo-Json -Depth 5
   ```

   Look at `ok` (true), `killSwitch` (false), `lowBalance` (false), `inFlight.oldestAgeSeconds` (a few seconds, not minutes), `queued` (small), `lastSettled.at` (recent if there has been traffic) and `alerts` (empty). A `503` answer means `ok` is false: the service is shutting down or its journal cannot record what it is told.
   Or ask for both services at once, with a PASS or FAIL per line. It is read-only: it asks only for `/health`. A `FAIL` names what to fix, and a low relayer balance is a `WARN`. Add `--origin` with the site's origin to check that each service lets that origin read its answers, and that an origin nobody listed gets no permission. It reads the router from `deployment.json` when you run it in the repository's folder.

   ```powershell
   pnpm live:hostcheck --facilitator https://facilitator.example --tools https://tools.example --origin https://sluice.example
   ```

3. Read the tool server's health.

   ```powershell
   Invoke-RestMethod https://tools.example/health | ConvertTo-Json -Depth 5
   ```

   Expect the network, the chain id, the router, the payee and the tools with their prices, and that each matches what you set.
4. Look at the relayer's balance in the facilitator's health (`relayerBalanceWei`) and at the day's spend (`budget.spentWei` against `budget.budgetWei`). Top the relayer up before it reaches the low-balance threshold.
5. Skim the facilitator's log for lines at the levels `warn` and `error` since yesterday ([Logs](#logs)). A rate-limit warning from one address is routine. An `alert` line is not.
6. Once a week, run `pnpm evidence:check` from a clone of the repository. It re-reads every recorded row from the chain.

## What the services expose

| What | Where | Who may read it |
| --- | --- | --- |
| Health, with the relayer's balance, budget, queue, in-flight age, kill switch, last settled batch, alerts | `GET /health` on the facilitator | Anyone. It holds no key and no payer's data. |
| Intent status | `GET /status/:id` on the facilitator | Anyone who knows the id. |
| Tools and prices | `GET /health` on the tool server | Anyone. |
| The Status page | `/status` on the site, and the same readings as JSON at `/api/status` | Anyone. It reads the three services and the QIE nodes, holds an answer for ten seconds and limits each caller. |
| Counters and gauges | `GET /internal/metrics` on the facilitator and on the tool server | Only a caller that sends the bearer token. Keep it private. |

### The private metrics path

Each service has a metrics path that does not exist until a token is set. It answers `404` with no token set, `401` without the right token, and carries no CORS header, so no web page can read it. Set a token of 24 or more characters in the service's environment (`SLUICE_FACILITATOR_METRICS_TOKEN`, `SLUICE_TOOLS_METRICS_TOKEN`) and restart. A token is a secret: keep it out of the repository and out of chat.

Make a token on your machine.

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

Do not publish `/internal/` through the public reverse proxy. Reach it from the machine itself, or from a private network. With the Caddy setup in the deployment guides, add a rule that answers `404` to `/internal/*` for the public name, and scrape the service's own address (`http://127.0.0.1:8402/internal/metrics`) from the host.

Check that it works from the host, with the token in an environment variable you set for this window only.

```powershell
$env:METRICS_TOKEN = "the token"
```

```powershell
Invoke-WebRequest http://127.0.0.1:8402/internal/metrics -Headers @{ Authorization = "Bearer $env:METRICS_TOKEN" } | Select-Object -ExpandProperty Content
```

```powershell
Remove-Item Env:METRICS_TOKEN
```

The answer is plain text, one counter or gauge to a line. The names:

| Metric | Meaning |
| --- | --- |
| `sluice_facilitator_requests_total{route,status}` | Requests by route and status class (`2xx`, `4xx`, `5xx`) |
| `sluice_facilitator_intents{status}` | Intents in each state, from the journal: queued, submitted, settled, skipped, expired, failed |
| `sluice_facilitator_oldest_queued_age_seconds` | Age of the oldest intent still waiting for a batch |
| `sluice_facilitator_in_flight`, `sluice_facilitator_oldest_in_flight_age_seconds` | Intents in a batch whose outcome is not yet recorded, and the age of the oldest |
| `sluice_facilitator_kill_switch` | 1 while the kill switch is on |
| `sluice_facilitator_low_balance` | 1 while the relayer holds less QIE than its threshold |
| `sluice_facilitator_store_healthy` | 1 while the journal can record what it is told |
| `sluice_facilitator_relayer_balance_wei`, `sluice_facilitator_budget_wei`, `sluice_facilitator_spent_wei` | The relayer's QIE, and the day's budget and spend |
| `sluice_facilitator_alerts` | Open alerts |
| `sluice_facilitator_last_settled_block`, `sluice_facilitator_last_settled_timestamp_seconds` | The last settled batch (left out until one has settled) |
| `sluice_tools_requests_total{route,status}` | Tool server requests by route and status class |
| `sluice_tools_calls_total{kind}` | Calls by `paid`, `unpaid` and `rate_limited` |

Counters of requests start from zero when a service restarts. The intent counts come from the journal and survive a restart.

## Alert hooks

A monitor needs something to read and a threshold. These are the ones that matter, with the signal for each. Any uptime service that can poll a URL, or a scraper that reads the metrics path, can carry them.

| Alert | Signal | Suggested threshold | What to do |
| --- | --- | --- | --- |
| The facilitator is down or unwell | `GET /health` is not `200` | Two failures in a row, one minute apart | [The facilitator is down](#the-facilitator-is-down) |
| The relayer is running low | `lowBalance` is true, or `sluice_facilitator_low_balance` is 1 | At once | [The relayer is out of QIE](#the-relayer-is-out-of-qie) |
| Payments wait too long | `sluice_facilitator_oldest_queued_age_seconds` | Above 120 seconds | [Payments are queued and not settling](#payments-are-queued-and-not-settling) |
| A batch is stuck | `inFlight.oldestAgeSeconds`, or `sluice_facilitator_oldest_in_flight_age_seconds` | Above 600 seconds | [A batch is stuck](#a-batch-is-stuck) |
| Failed batches repeat | `sluice_facilitator_intents{status="failed"}` rising | Any rise | Read the log for the reason before anything else |
| The kill switch is on | `killSwitch` is true | At once, so it is never left on by mistake | [The kill switch drill](#the-kill-switch-drill) |
| The journal is unhealthy | `store.healthy` is false | At once | [Journal backup and restore](#journal-backup-and-restore) |
| The tool server is down | `GET /health` on it is not `200` | Two failures in a row | Restart it. It holds no money and no queue. |
| No QIE endpoint answers | `rpc.healthy` is 0 in `/api/status` | At once | [The QIE endpoints are down](#the-qie-endpoints-are-down) |

A hook is a small script that polls and tells you. This one polls the facilitator once a minute and posts to a webhook you own when something is wrong. Run it from a scheduled task on a machine that is not the one it watches.

```powershell
$health = "https://facilitator.example/health"
$hook = "https://hooks.example/your-webhook"
while ($true) {
  $problem = $null
  try {
    $h = Invoke-RestMethod $health -TimeoutSec 15
    if (-not $h.ok) { $problem = "the facilitator reports ok false" }
    elseif ($h.killSwitch) { $problem = "the kill switch is on" }
    elseif ($h.lowBalance) { $problem = "the relayer is low on QIE" }
    elseif ($h.inFlight.oldestAgeSeconds -gt 600) { $problem = "a batch has waited more than ten minutes" }
  } catch { $problem = "the facilitator did not answer" }
  if ($problem) { Invoke-RestMethod -Method Post -Uri $hook -ContentType "application/json" -Body (@{ text = "Sluice: $problem" } | ConvertTo-Json) | Out-Null }
  Start-Sleep -Seconds 60
}
```

It repeats the message every minute while the problem lasts. That is on purpose: a one-time message is easy to miss.

## Logs

Each service writes one JSON object per line to its standard error (the facilitator and the tool server), and the host collects them (`docker logs sluice-facilitator`, or the host's log view). Every request has an id. A caller may send an `x-request-id` of its own (8 to 64 letters, digits, dots, dashes and underscores); any other is replaced. The id comes back in the response's `x-request-id` header and is in the log line, so a report of the form "this request, at this time" finds its line.

A request line holds the id, the method, the route, the status and how long it took. Nothing in a log holds a key, a signature, an argument or a payment. A rate-limit warning holds the caller's address, which is a reason to treat logs as private.

Find one request on a host that has the container.

```powershell
docker logs sluice-facilitator --since 24h 2>&1 | Select-String "the-request-id"
```

Find every warning and error since yesterday.

```powershell
docker logs sluice-facilitator --since 24h 2>&1 | Select-String '"level":"(warn|error)"'
```

How long logs are kept is the host's setting, not the software's. Write it down and say it in the privacy notice before launch.

## The kill switch drill

The kill switch stops everything that spends QIE or sends a transaction: no new payment is queued, none is settled, no zero-QIE start or top-up is sent, and no signed request is relayed. Reading still works. Do the drill on a schedule, so that using it for real is not a new experience in an emergency.

1. Turn it on at the host. In the container from the deployment guide:

   ```powershell
   docker exec sluice-facilitator sh -c "touch /data/KILL"
   ```

2. Within a second, `GET /health` shows `killSwitch: true`, the Status page says "Working with problems" and names the switch, and a paid call from the demo is refused with a message that the operator has paused payments. `/verify` answers that the payment is not valid, so the tool server does not run the tool.
3. Confirm that nothing was sent: the relayer's transaction count on the explorer does not change.
4. Turn it off.

   ```powershell
   docker exec sluice-facilitator rm /data/KILL
   ```

5. `killSwitch` is false again, and a paid call settles. Write the date in your log.

What users see while it is on: a clear refusal, no charge, and their balance unchanged. They can refund or withdraw from any wallet that holds QIE, with no Sluice service involved.

On Vercel there is no file to touch. The switch to rely on is `SLUICE_FACILITATOR_KILL_SWITCH` with a redeploy, which does not depend on the database. A key in the database, set from its console, is a second, quicker one, and anything holding the database's token can delete it: [HOSTING-VERCEL.md, Stopping it](HOSTING-VERCEL.md#stopping-it). There the queue and the daily counters are in that database too, so the journal below does not exist.

## Journal backup and restore

The facilitator's journal (`SLUICE_FACILITATOR_STATE`) is the one file that matters: it holds every intent and its state, and the daily counters. It is written as lines that are only ever added, each flushed to disk, and opened with a lock file next to it.

**Back it up.** Once a day, and before any change to the host. A copy taken while the service runs is safe to restore from, because a last line that was half written is dropped when the file is opened and everything before it is kept. A copy taken after stopping the service is clean. Either way, copy to somewhere that is not the same disk.

```powershell
docker cp sluice-facilitator:/data/queue.jsonl .\queue-backup.jsonl
```

**Restore.** Stop the service. Put the backup in place. Remove the lock file if one was left (a lock left by a process that is gone is taken over by itself, so this is only needed if you see the refusal "another facilitator process is using this queue store" and you know none is running). Start the service.

```powershell
docker stop sluice-facilitator
```

```powershell
docker cp .\queue-backup.jsonl sluice-facilitator:/data/queue.jsonl
```

```powershell
docker start sluice-facilitator
```

On start the facilitator reads the chain for any batch the journal says was submitted and settles, or drops, what it finds, so a restore from a backup a few minutes old does not send an intent twice. Read `/health` and the log afterwards: `store.healthy` true, `inFlight.count` falling to 0, and no repeated warnings.

A journal with a damaged line in the middle (not the last line) is refused, and nothing is settled from it. That is by design: restore from the last good backup.

## Key rotation

**The relayer key** holds QIE for gas and nothing else, and the router does not know it, so rotating it needs no transaction on chain beyond moving the QIE.

1. Make a new key and note its address. The command writes the key to a file and prints only the address.

   ```powershell
   pnpm live:new-key .\relayer-new.key
   ```

2. Send the new address enough QIE for a few days (see the funding plan in the runbook).
3. Turn the kill switch on, so nothing new starts. Wait until `inFlight.count` is 0.
4. Stop the facilitator. Put the new key in the service's environment as `SLUICE_RELAYER_KEY`. Start it, and check `/health` shows the new address and its balance, and that the kill switch file is gone only after that.
5. Turn the kill switch off, and make a paid call to see it settle.
6. Send what is left of the old key's QIE to the new address, then delete the old key file.

If the relayer key may have leaked, do steps 3 to 6 at once and treat anything on the old address as lost. The key cannot touch a user's balance: it can only spend the QIE on its own address.

**The metrics tokens** are rotated by setting a new value and restarting the service, then updating whatever scrapes it.

**The owner key** cannot be rotated. The contracts fix the owner at deployment, and the owner can change the fee (never above 2%) and who is credited it, and nothing else. Keep that key somewhere safe, and prefer a multisig as the owner when deploying. Losing it loses the ability to change the fee, and nothing else.

## The incident checklist

For any incident: say so on the Status page's channel first, then work down the section for it, and write down what was seen and when. No step below moves a user's money, because nothing in the operator's hands can.

### The facilitator is down

1. `GET /health` and the host's log. A `503` with the service up means shutting down, or an unhealthy journal.
2. If the process is gone, start it (`docker start sluice-facilitator`). It reads the chain and its journal and carries on. Do not delete the journal.
3. If it refuses to start, read the message. A missing setting, a journal that cannot be read and a lock held by another process each say so in words.
4. Users meanwhile: paid calls are refused with a clear message, no charge, balances unchanged. Their refunds and withdrawals still work from a wallet with QIE.

### The relayer is out of QIE

1. Send QIE to the relayer's address. `/health` shows `relayerBalanceWei`.
2. Intents wait in the queue and settle once it can send. Their signatures expire within the hour, so one that waited too long is dropped, and the payer is not charged.

### Payments are queued and not settling

1. Is the kill switch on? Is the relayer low? Is the gas price above the facilitator's ceiling (the log says so)? Is the daily budget used up (`budget.remainingWei`)?
2. Do the QIE endpoints answer? The Status page lists them.
3. If none of those, read the log for the last batch's error before restarting anything.

### A batch is stuck

1. `inFlight.oldestAgeSeconds` is high: a transaction was sent and has not been seen to finish. Look up the hash in the log, then on the explorer.
2. If it is pending, the chain is slow, and it will finish. If it is not on the chain, a restart makes the facilitator reconcile it against the chain and send it again once.
3. Do not clear the journal by hand.

### The QIE endpoints are down

The pages and the services probe QIE's endpoints and use the earliest that answers. With one down, nothing changes. With all down, nothing can be read or settled: the Status page says so. Wait for QIE, or set `SLUICE_RPC_URL` on the services to another provider's address and restart them (an address named this way is used as given, with no probe).

### The tool server is misbehaving or abused

1. Its limits are per address and per minute (see `SLUICE_TOOLS_RATE_LIMIT_IP` and `SLUICE_TOOLS_RATE_LIMIT_UNPAID`). A flood from one address shows as rate-limit warnings and `sluice_tools_calls_total{kind="rate_limited"}`.
2. Block an address at the proxy in front of it. Lower the limits if needed and restart.
3. A bad tool answer is the builder's matter; a bad payment is refused by the facilitator before the tool runs.

### QUSDC's admin may have burned a balance

This is outside Sluice (see [RISKS.md](RISKS.md)). Check `solvency()` on the router: `held` below `owed` is the sign. Turn the kill switch on, tell users on the Status page's channel, and read the token's events on the explorer. The contracts cannot fix it, and refunds are paid from what the router holds.

### The wrong address is configured

If the site or a service points at a router that is not the intended one (the Status page shows "different from this site" for a service, or the pre-flight check says no), turn the kill switch on, correct the setting, restart, and run `pnpm live:preflight` with `--deployment deployment.json`.

## Cadence

| When | What |
| --- | --- |
| Every day | The five-minute check above |
| Every week | `pnpm evidence:check`; read the warnings in the logs; look at the relayer's spend against its budget |
| Every month | The kill switch drill; restore the journal backup somewhere else and start a copy against the testnet, to know the backup works |
| Before a change to a service | A journal backup, then the change, then the five-minute check |
| After an incident | Write what happened, when, what was done and what changes |

## What this document cannot confirm

That the hosts behave as the deployment guides describe, that a monitor can reach the metrics path the way it is set up here, and what any real traffic looks like. Run the whole of it once on the testnet first.
