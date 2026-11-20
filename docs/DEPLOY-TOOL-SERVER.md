# Hosting the demo tool server

This is a set of steps for the founder to follow. Nothing in it has been run on a hosting service: the tool server was tested on a local chain and on a fork of QIE mainnet, and the Docker image was not built where this was written (see [What this does not prove](#what-this-does-not-prove)).

The tool server is the example in `examples/paid-tools` served over Streamable HTTP: three paid MCP tools (`token_risk_check`, `dex_quote`, `contract_lookup`) that read public QIE data. A call without a payment is answered with a price. A call with a signed payment runs the tool, and the tool server queues the payment with the facilitator. The server holds no key and sends no transaction.

## Contents

- [Before you start](#before-you-start)
- [Settings](#settings)
- [When it refuses to start](#when-it-refuses-to-start)
- [Limits on callers](#limits-on-callers)
- [Option A: a VPS](#option-a-a-vps)
- [Option B: Railway](#option-b-railway)
- [Pointing a proxy at it](#pointing-a-proxy-at-it)
- [After you deploy: a checklist](#after-you-deploy-a-checklist)
- [What this does not prove](#what-this-does-not-prove)

## Before you start

You need:

- a router, from [MAINNET-RUNBOOK.md](MAINNET-RUNBOOK.md) (or the testnet rehearsal in [REHEARSAL.md](REHEARSAL.md), where you should host this to begin with);
- a facilitator the tool server can reach over https, hosted as in [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md);
- the address that is paid: a wallet you control, which is the builder's address. Funds for a paid call end up as earnings of this address inside the router, and it withdraws them.

## Settings

Everything comes from the environment. Names are also in [.env.example](../.env.example), without values. None of them is a secret.

| Name | Required | Recommended | What it does |
| --- | --- | --- | --- |
| `SLUICE_NETWORK` | yes | `testnet`, then `mainnet` | Which chain. There is no default: without it the server refuses to start. |
| `SLUICE_ROUTER` | yes | from the deploy | The router payments go through. A payment naming another router is refused. |
| `SLUICE_PAYEE` | yes | your builder address | The address that is paid. |
| `SLUICE_FACILITATOR_URL` | yes | `https://<your facilitator>` | The facilitator that verifies and settles. Must be https. |
| `SLUICE_RPC_URL` | no | the default for the network | An https RPC. |
| `SLUICE_EXPLORER_URL` | no | the default | The explorer's read API, for `contract_lookup` and `token_risk_check`. |
| `SLUICE_TOOLS_PRICES` | no | the defaults | Prices in QUSDC, like `token_risk_check=0.01,dex_quote=0.002,contract_lookup=0.005`. A name that is not a tool, or a price that is not above zero with at most six decimals, stops the start. |
| `SLUICE_TOOLS_HOST` | no | `0.0.0.0` in a container | The address to listen on. Default `127.0.0.1`. |
| `SLUICE_TOOLS_PORT` | no | `8403` | The port. |
| `SLUICE_TOOLS_TRUST_PROXY_HOPS` | no | `1` behind one proxy | How many proxies in front append to `X-Forwarded-For`. At 0 the header is ignored, because anyone can send one. |
| `SLUICE_TOOLS_MAX_BODY_BYTES` | no | `32768` | The largest request body. At most 1048576. |
| `SLUICE_TOOLS_RATE_LIMIT_IP` | no | `300` | Requests a minute from one address. |
| `SLUICE_TOOLS_RATE_LIMIT_UNPAID` | no | `60` | Requests a minute from one address that carry no payment. |
| `SLUICE_TOOLS_RPC_TIMEOUT_MS` | no | `10000` | How long one read from the node or the explorer may take. |
| `SLUICE_TOOLS_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. |

A setting it cannot read stops the start, so a mistyped limit does not quietly leave a protection off.

## When it refuses to start

- `SLUICE_NETWORK` is not `mainnet`, `testnet` or `local`. On mainnet this means it never starts by accident: you have to write the word.
- `SLUICE_ROUTER` is missing or is not an address, or the router cannot be read on the network named (the read has its own time limit).
- On mainnet, the router does not hold QUSDC. A price is in the token the router holds, so a router for another token is refused.
- `SLUICE_PAYEE` is missing or is not an address, or `SLUICE_FACILITATOR_URL`, `SLUICE_RPC_URL` or `SLUICE_EXPLORER_URL` is plain http away from this machine.
- A price, a limit or a log level cannot be read, or the unpaid limit is above the general one.

## Limits on callers

- One request body is read, size-limited and parsed before anything runs. Over the limit is HTTP 413; not JSON is 400.
- A call that carries a payment in `params._meta["x402/payment"]` is a paid call. Every other request, including `tools/list` and a call with no payment, is unpaid. An address may make `SLUICE_TOOLS_RATE_LIMIT_UNPAID` unpaid requests a minute and `SLUICE_TOOLS_RATE_LIMIT_IP` requests of any kind a minute. Past a limit the answer is HTTP 429 with `Retry-After`.
- A payment proxy asks without a payment before it pays, so each paid call uses one unpaid request. At the default of 60 a minute, one agent address can make about 58 paid calls a minute. Raise the limit if a busy agent needs more.
- Reads from the node and the explorer have time limits, and a whole request that runs past 60 seconds is answered with 504.
- Logs are JSON lines on standard error with the method, the tool name, whether it was paid and the status. They hold no signature, no argument and no payment.
- These limits are in memory, per process, and per address. They slow a flood from one place; they are not a defence against many addresses.

## Option A: a VPS

These are Linux commands for a small server you control. Replace the angle-bracket names.

1. Install Docker and open ports 80 and 443 only.
2. Build the image from the repository root.

   ```bash
   docker build -f examples/paid-tools/Dockerfile -t sluice-tool-server .
   ```

3. Write the settings to a file only you can read.

   ```bash
   install -m 600 /dev/null /etc/sluice/tools.env
   ```

   Then edit `/etc/sluice/tools.env` and add one `NAME=value` line per setting, at least `SLUICE_NETWORK`, `SLUICE_ROUTER`, `SLUICE_PAYEE` and `SLUICE_FACILITATOR_URL`.

4. Run it. It listens on the machine's loopback only.

   ```bash
   docker run -d --name sluice-tool-server --restart unless-stopped --env-file /etc/sluice/tools.env -p 127.0.0.1:8403:8403 sluice-tool-server
   ```

5. Put a TLS proxy in front. With Caddy, and `SLUICE_TOOLS_TRUST_PROXY_HOPS=1`:

   ```text
   tools.example.com {
     reverse_proxy 127.0.0.1:8403
   }
   ```

6. Check it from your own computer.

   ```powershell
   Invoke-RestMethod https://tools.example.com/health
   ```

## Option B: Railway

These describe what to set. Railway's screens change, so follow its current documentation for where each setting lives.

1. Create a service from this repository using the Dockerfile at `examples/paid-tools/Dockerfile`, with the repository root as the build context.
2. Add the settings above as the service's variables. Set `SLUICE_TOOLS_PORT` to the port the service is told to expose.
3. Set the health check path to `/health`.
4. Give the service a domain. Leave `SLUICE_TOOLS_TRUST_PROXY_HOPS` at 0 unless Railway's documentation tells you how many proxies it puts in front; at 0, every caller shares one rate limit.

## Pointing a proxy at it

A payment proxy connects to the tool server's address instead of starting a local process. In the proxy's config file:

```json
{
  "upstream": { "url": "https://tools.example.com/mcp" }
}
```

Everything else in the config stays as it is: the router, the payer, the budget and the list of allowed tools. The proxy keeps all of its refusals when the upstream is remote: a tool that is not on the list, a price above the cap per call, a payment that would pass the total budget, and a server that asks for a different router, asset or chain. See [REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md) for a full config and [TRY-IT-AGENT.md](TRY-IT-AGENT.md) for the steps an agent's owner follows.

## After you deploy: a checklist

Tick each box yourself, in order. [FOUNDER-LOG.md](FOUNDER-LOG.md) has a copy to keep a record.

- [ ] `/health` answers 200 over https and lists the three tools with the prices you set.
- [ ] `SLUICE_NETWORK` is the network you meant, and the `router` in `/health` is the router you deployed.
- [ ] A call with no payment gets the price. Use `pnpm client:smoke` against the address to see it, or call `tools/call` yourself.
- [ ] A burst of unpaid requests from one machine ends in HTTP 429 with a `Retry-After` header.
- [ ] A request over the size limit is refused with 413.
- [ ] The logs hold no signature and no payment. Read a few lines after a paid test call.
- [ ] A paid call from a proxy settles: the facilitator's `/status/<id>` goes from `queued` to `settled`.
- [ ] You did all of this against the testnet before the mainnet.

## What this does not prove

- The Docker image was not built where this was written, so a build on your machine may need a fix. The build steps (install from the lockfile, compile, copy the production files, start) were each run outside Docker, from a copy of the build context that follows `.dockerignore`.
- The tool server was tested as its own process behind a proxy and a facilitator that were also their own processes, on a local chain and on a fork of QIE mainnet. It has not been called by a real MCP client such as Claude Code or Cursor.
- The tools read public data and are not a security review of any token. Their answers say so.
- Rate limiting is per process and per address, in memory.
- No outside party has reviewed this service.
