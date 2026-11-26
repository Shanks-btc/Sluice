# Hosting the facilitator

This is a set of steps for the founder to follow. Nothing in it has been run on a hosting service: the facilitator, its queue and its shutdown were tested on a local chain, and the Docker image was not built where this was written (see [What this does not prove](#what-this-does-not-prove)).

The facilitator is one process. It takes signed payments from paid tool servers, keeps them in a queue file, and sends them to the router in batches. It holds one key, the relayer key, which pays gas and nothing else. It never holds QUSDC and has no power over anyone's balance: a payment is a signature the payer made, and the router checks it.

## Contents

- [Before you start](#before-you-start)
- [The relayer key](#the-relayer-key)
- [Settings](#settings)
- [The caps in code](#the-caps-in-code)
- [Option A: a VPS](#option-a-a-vps)
- [Option B: Railway](#option-b-railway)
- [The kill switch](#the-kill-switch)
- [Rotating the relayer key](#rotating-the-relayer-key)
- [Backing up the queue](#backing-up-the-queue)
- [What it does when something breaks](#what-it-does-when-something-breaks)
- [After you deploy: a checklist](#after-you-deploy-a-checklist)
- [What this does not prove](#what-this-does-not-prove)

## Before you start

You need:

- the router's address, from the deploy step in [MAINNET-RUNBOOK.md](MAINNET-RUNBOOK.md) (or from the testnet rehearsal in [REHEARSAL.md](REHEARSAL.md), which is where to host this to begin with);
- a host: a small VPS you control, or Railway;
- a name for the host with TLS in front of it, because tool servers and browsers will call it over the internet;
- a relayer key made for this service and used for nothing else.

Host it against the testnet before the mainnet. The settings are the same, with `SLUICE_NETWORK=testnet`.

## The relayer key

The relayer key is a hot key: it sits in the service's environment, so anyone who can read that environment can spend what the relayer holds. Keep it small.

1. Make a key on your own computer. This writes the key to a file you name and prints only the address. It refuses to overwrite a file.

   ```powershell
   pnpm live:new-key .\relayer.key
   ```

2. Put the file's contents into the host's secret store (a VPS file with mode 600, or Railway's variables), then delete the file.

   ```powershell
   Remove-Item .\relayer.key
   ```

3. Send QIE to the printed address from a wallet you control. Send about twice the daily budget you set (see below), not more. [GAS.md](GAS.md) has the measured cost of a batch; the relayer's `/health` shows what it has spent today.
4. The relayer must not be the router's owner and must not be its fee recipient. The service checks both when it starts and refuses to run if either is true.

The relayer holds no QUSDC. If `/health` ever shows `relayerQusdcUnits` above zero, something sent QUSDC to it by mistake: the service raises an alert, and you should move it out.

## Settings

Everything comes from the environment. Names are also in [.env.example](../.env.example), without values.

| Name | Secret | Recommended | What it does |
| --- | --- | --- | --- |
| `SLUICE_NETWORK` | no | `testnet`, then `mainnet` | Which chain. Without it the service refuses to start. |
| `SLUICE_APPROVE` | no | `facilitator` | You approve this program by name. Anything else and it refuses to start. |
| `SLUICE_MAX_QIE` | no | `0.5` | The most QIE the relayer may spend in a UTC day, gas and top-ups together. Ceiling 2. Required on mainnet and testnet. |
| `SLUICE_ROUTER` | no | from the deploy | The router's address. |
| `SLUICE_RELAYER_KEY` | **yes** | a key made for this | The relayer's key. Never printed or logged. |
| `SLUICE_RPC_URL` | no | the default for the network | An https RPC. |
| `SLUICE_FACILITATOR_STATE` | no | `/data/queue.jsonl` | The queue's journal. Required on mainnet and testnet: a queue kept only in memory is lost when the process stops. |
| `SLUICE_FACILITATOR_URL` | no | `https://<your host>` | Where it is reached. Used to build the status link in replies. |
| `SLUICE_FACILITATOR_HOST` | no | `0.0.0.0` in a container, `127.0.0.1` behind a proxy on the same machine | The address to listen on. |
| `SLUICE_FACILITATOR_PORT` | no | `8402` | The port. The image listens on the platform's `PORT` instead when the platform sets one (Railway does). |
| `SLUICE_FACILITATOR_TRUST_PROXY_HOPS` | no | `1` behind one proxy | How many proxies in front append to `X-Forwarded-For`. Leave it at 0 with no proxy: the header is then ignored, because anyone can send one. |
| `SLUICE_FACILITATOR_CORS_ORIGINS` | no | your web app's origin | Exact origins allowed to read answers from a browser. Empty allows none. Never a wildcard. |
| `SLUICE_FACILITATOR_METRICS_TOKEN` | no | a random value of 24 or more characters | Secret. Turns on `GET /internal/metrics`, which needs `Authorization: Bearer <this value>`. With none set, that path does not exist. See [OPERATIONS.md](OPERATIONS.md). |
| `SLUICE_FACILITATOR_KILL_FILE` | no | `/data/KILL` | While this file exists, the kill switch is on. |
| `SLUICE_FACILITATOR_KILL_SWITCH` | no | empty | `1` turns the kill switch on from the start. It takes a restart to change. |
| `SLUICE_FACILITATOR_MAX_BODY_BYTES` | no | `65536` | The largest request body. At most 1048576. |
| `SLUICE_FACILITATOR_RATE_LIMIT_IP` | no | `240` | Requests per minute from one client address. |
| `SLUICE_FACILITATOR_RATE_LIMIT_PAYER` | no | `60` | Requests per minute that name one payer address. |
| `SLUICE_FACILITATOR_MAX_TOPUP_QIE` | no | `0.001` | The most QIE one top-up may send. Ceiling 0.0015. |
| `SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE` | no | `0.001` | The most QIE all top-ups to one address may send in a UTC day. Ceiling 0.003. |
| `SLUICE_FACILITATOR_LOW_BALANCE_QIE` | no | `0.5` | The relayer's balance below which `/health` sets `lowBalance`. |
| `SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC` | no | `10` | The most QUSDC one zero-QIE start may deposit. It can only be lowered. |
| `SLUICE_FACILITATOR_PAYER_DAILY_QUSDC` | no | `50` | The most QUSDC one payer may queue in a UTC day. It can only be lowered. |
| `SLUICE_FACILITATOR_DAILY_QUSDC` | no | `500` | The most QUSDC all payers may queue in a UTC day. It can only be lowered. |
| `SLUICE_FACILITATOR_FLUSH_MS` | no | `15000` | How often queued payments are batched. |
| `SLUICE_FACILITATOR_SHUTDOWN_MS` | no | `30000` | How long a shutdown waits for a batch in progress. |
| `SLUICE_FACILITATOR_RPC_TIMEOUT_MS` | no | `20000` | How long one request to the node may take before the service gives up on it. |
| `SLUICE_FACILITATOR_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. |

A setting it cannot read stops the start. That is on purpose: a mistyped limit or kill switch must not quietly leave a protection off.

## The caps in code

These are constants in the program. A setting can never raise a cap past its ceiling; a value above a ceiling stops the start. The three QUSDC amounts that have a setting can only be lowered: a value above the default stops the start.

| Cap | Default | Ceiling |
| --- | --- | --- |
| Gas limit of one transaction | 4,000,000 | 4,000,000 |
| Highest gas price | 2 gwei | 5 gwei |
| QIE the relayer may spend in a UTC day | 0.5 | 2 |
| Payments in one batch | 50 | 50 |
| One top-up | 0.001 QIE | 0.0015 QIE |
| All top-ups to one address in a UTC day | 0.001 QIE | 0.003 QIE |
| QUSDC one zero-QIE start may deposit | 10 | 100 |
| Payments one payer may queue in a UTC day | 2,000 | 20,000 |
| QUSDC one payer may queue in a UTC day | 50 | 1,000 |
| Payments all payers may queue in a UTC day | 20,000 | 200,000 |
| QUSDC all payers may queue in a UTC day | 500 | 10,000 |
| Zero-QIE starts per payer per UTC day | 1 | 3 |
| Relayed withdrawals and refunds per account per UTC day | 3 | 10 |

Counts and amounts kept per day are written to the queue's journal, so a restart does not reset them.

The relayer will send a transaction to the router or the vault and nowhere else, and will send QIE only as a capped top-up to a wallet that is starting without any.

## Option A: a VPS

These are Linux commands for a small server you control. Replace the angle-bracket names.

1. Install Docker on the server and open ports 80 and 443 only. Do not open 8402 to the internet.
2. Get the repository onto the server and build the image from its root.

   ```bash
   docker build -f packages/facilitator/Dockerfile -t sluice-facilitator .
   ```

3. Write the settings to a file only you can read. Put the relayer key in it from your secret store, not from your shell history.

   ```bash
   install -m 600 /dev/null /etc/sluice/facilitator.env
   ```

   Then edit `/etc/sluice/facilitator.env` and add one `NAME=value` line per setting in the table above. At least `SLUICE_NETWORK`, `SLUICE_APPROVE`, `SLUICE_MAX_QIE`, `SLUICE_ROUTER`, `SLUICE_RELAYER_KEY` and `SLUICE_FACILITATOR_URL`, and `SLUICE_FACILITATOR_KILL_FILE=/data/KILL`.

4. Run it with a volume for the queue, a restart policy and a stop timeout longer than the shutdown wait. It listens on the machine's loopback only.

   ```bash
   docker volume create sluice-queue
   docker run -d --name sluice-facilitator --restart unless-stopped --stop-timeout 45 \
     --env-file /etc/sluice/facilitator.env -v sluice-queue:/data -p 127.0.0.1:8402:8402 sluice-facilitator
   ```

5. Put a TLS proxy in front. With Caddy, this is the whole file, and `SLUICE_FACILITATOR_TRUST_PROXY_HOPS=1` is then right:

   ```text
   facilitator.example.com {
     reverse_proxy 127.0.0.1:8402
   }
   ```

6. Check it from your own computer.

   ```powershell
   Invoke-RestMethod https://facilitator.example.com/health
   ```

## Option B: Railway

[HOSTING-RAILWAY.md](HOSTING-RAILWAY.md) has the click-by-click steps, the exact list of variables, the kill switch drill and how to roll back. In short:

1. Create a service from this repository, with the repository root as the build context and `RAILWAY_DOCKERFILE_PATH` set to `/packages/facilitator/Dockerfile`.
2. Add the settings above as the service's variables. Put `SLUICE_RELAYER_KEY` in as a sealed variable, from the host's secret store and never from a file in the repository. The image listens on the `PORT` Railway gives it, so leave `SLUICE_FACILITATOR_PORT` alone. Set `SLUICE_FACILITATOR_TRUST_PROXY_HOPS` to 1 (HOSTING-RAILWAY.md says why, and what is unverified).
3. Attach a volume mounted at `/data`. Without it the queue file is lost when the service is replaced. Railway mounts a volume as root, so the image starts as root, gives `/data` to the `node` user, and runs the service as `node`.
4. Set the health check path to `/health`. Railway checks it only while a deploy starts.
5. Give the service a domain and use it as `SLUICE_FACILITATOR_URL`.
6. Run `pnpm live:hostcheck` to check it from outside.

## The kill switch

The kill switch stops everything that sends a transaction or spends QIE: queueing new payments, settling, zero-QIE starts, top-ups and relayed requests. It also makes `/verify` say no, so that a tool server does not do work it cannot be paid for. `/health` and `/status` keep answering.

- To turn it on now, create the file named by `SLUICE_FACILITATOR_KILL_FILE`. In the container above: `docker exec sluice-facilitator sh -c "touch /data/KILL"`.
- To turn it off, delete the file: `docker exec sluice-facilitator rm /data/KILL`.
- Payments already in the queue stay there and go out once the switch is off, if their deadlines have not passed.

`/health` shows `killSwitch` so you can see its state.

## Rotating the relayer key

1. Make and fund a new key as in [The relayer key](#the-relayer-key).
2. Turn the kill switch on, and wait until `/health` shows `inFlight.count` of 0.
3. Put the new key in the secret store and restart the service.
4. Check `/health`: `relayer` must show the new address, and `killSwitch` the state you want.
5. Turn the kill switch off.
6. Move what is left of the old key's QIE to a wallet you control, then stop using the old key.

The router's owner and fee recipient do not change, because the relayer is neither.

## Backing up the queue

The queue is the file named by `SLUICE_FACILITATOR_STATE`. It is append-only, one JSON object per line, and holds the payments waiting to be sent, the outcome of each, and the day's counters. It holds signed intents, so treat it like any file that holds customers' payment data: keep copies private.

- Copy it while the service runs. If the copy ends in a half-written line, the service cuts that line off when it opens the file, and keeps everything before it.
- A copy is good for putting the queue back after a lost disk. Stop the service, put the file where it was, start it. The service settles what it finds against the chain before it takes any request, and the router refuses any payment that already settled, so an old copy cannot cause a payment to be taken twice.
- Do not run two services on one queue file. A lock file stops a second process on the same machine; two machines with copies would waste gas sending the same batch twice.

## What it does when something breaks

| What happens | What the service does |
| --- | --- |
| The process is killed or the machine loses power | The next start reads the queue and finishes any batch that was in flight from the chain's own record. |
| The disk is full or the queue file cannot be written | It stops accepting payments and sends nothing, `/health` answers 503 with `store.healthy` false, and a platform health check replaces the container. Free the space and restart. |
| The queue file is damaged in the middle | It refuses to start and says so. It does not guess. Restore from a copy. |
| The RPC is down | Queued payments wait and are not counted as failed. |
| The relayer runs low on QIE | `/health` shows `lowBalance` true and raises an alert. It still sends while it has QIE and budget. |
| The day's budget is used up | Batches wait until the next UTC day. `/health` shows the budget. |
| It receives SIGTERM | It stops listening, waits up to `SLUICE_FACILITATOR_SHUTDOWN_MS` for a batch in progress, and closes the queue. A batch it could not wait for is finished from the chain on the next start. |

## After you deploy: a checklist

Tick each box yourself, in order. [FOUNDER-LOG.md](FOUNDER-LOG.md) has a copy to keep a record.

- [ ] `/health` answers 200 over https, with `ok` true, the `chainId` you expect and the `relayer` address you generated.
- [ ] `killSwitch` is false, `store.healthy` is true and `lowBalance` is false.
- [ ] The response of `/health` holds no key. Search it for a few characters from the start of your relayer key.
- [ ] The logs hold no key and no full signature. Read a few lines after a test payment.
- [ ] From a page on an origin you did not list, a browser cannot read the answer. From the origin you listed, it can.
- [ ] A burst of requests from one machine ends in HTTP 429 with a `Retry-After` header.
- [ ] Restart drill: queue a payment, restart the container, and see the payment in `/status/<id>` still queued, then settled.
- [ ] Kill switch drill: create the kill file, see `killSwitch` true and a refused `/settle`, delete the file, see it settle.
- [ ] A copy of the queue file is taken on a schedule, and you have restored one on a scratch machine.
- [ ] Something watches `/health` and tells you when it answers 503, when `lowBalance` is true, or when it does not answer.
- [ ] You did all of this against the testnet before the mainnet.

## What this does not prove

- The Docker image was not built where this was written, so a build on your machine may need a fix. The build steps (install from the lockfile, compile, copy the production files, start) were each run outside Docker, from a copy of the build context that follows `.dockerignore`.
- The `SIGTERM` handler was tested by calling the same shutdown function in a test. On Windows a signal ends a process without running a handler, so the signal itself was not sent.
- The crash tests kill the process with `SIGKILL` on a local chain behind a proxy that drops messages on purpose. A real RPC and a real disk can fail in ways that does not cover.
- Rate limiting is kept in memory, per process. It stops a flood from one address; it is not a defence against many addresses.
- No outside party has reviewed this service.
