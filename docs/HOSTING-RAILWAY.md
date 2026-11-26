# Hosting the facilitator and the tool server on Railway

This is a set of steps for you to follow, in order. **Nothing in it has been run on Railway.** The services and the new host check were tested on a local chain; the two Docker images were not built where this was written, because the Docker daemon was not running; and the Railway steps come from Railway's documentation, read on 2026-11-23, not from a run. [What this does not verify](#what-this-does-not-verify) lists what to watch for. The web app goes on Vercel: [HOSTING-VERCEL.md](HOSTING-VERCEL.md).

The facilitator and the tool server are two Railway services in one project. They are the same programs [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md) and [DEPLOY-TOOL-SERVER.md](DEPLOY-TOOL-SERVER.md) describe, and those pages say what each setting does. This page says where to click and what to type.

## Contents

- [What you will have](#what-you-will-have)
- [Before you start](#before-you-start)
- [The order, and why](#the-order-and-why)
- [Part 1: the facilitator](#part-1-the-facilitator)
- [Part 2: the tool server](#part-2-the-tool-server)
- [Part 3: after the web app exists](#part-3-after-the-web-app-exists)
- [The variables](#the-variables)
- [The kill switch drill](#the-kill-switch-drill)
- [Watching it](#watching-it)
- [Rolling back](#rolling-back)
- [What this does not verify](#what-this-does-not-verify)

## What you will have

| | Facilitator | Tool server |
| --- | --- | --- |
| Built from | `packages/facilitator/Dockerfile` | `examples/paid-tools/Dockerfile` |
| Volume | one, mounted at `/data`: the queue, the day's counters and the kill file | none: it writes no file, so a volume would only add downtime when it is redeployed |
| Health check path | `/health` | `/health` |
| Holds a key | the relayer key, as a sealed variable | none |
| Public address | a `*.up.railway.app` domain, used as `SLUICE_FACILITATOR_URL` | a second domain, used as `NEXT_PUBLIC_TOOLS_URL` |

## Before you start

- A Railway account, and a GitHub account that holds this repository. Railway builds from GitHub. Pushing the repository is yours to do; before you do, look at the list of files you are about to commit: none may end in `.key`, none may start with `.env.`, and none may be `deployment.json`. `.gitignore` keeps them out already, and it is worth one look.
- The relayer's key file, `relayer-mainnet.key`, **and an offline copy of it.** A sealed Railway variable cannot be read back, so the copy is how you recover the key.
- The relayer funded with QIE, and the builder's address (the account that is paid for every call).
- `deployment.json` and the three `.env.mainnet.*` files that `pnpm live:wire --network mainnet` wrote. They hold no key. Railway never sees these files: you copy values out of them.

## The order, and why

Three services need each other's addresses, so there is one order that works:

1. The facilitator on Railway, with its domain, and no web origin yet. An empty list of allowed origins allows none, which is safe.
2. The tool server on Railway, pointed at the facilitator's domain, with its domain.
3. The web app on Vercel, given both Railway domains. This gives you the web app's address.
4. Back on Railway: put the web app's address into both services' allowed origins, and redeploy them.
5. Check everything with `pnpm live:hostcheck`.

## Part 1: the facilitator

1. In Railway, choose **New Project**, then **Deploy from GitHub repo**, and pick this repository. Allow Railway's GitHub app on this repository only. Railway makes one service and starts a build. It will probably fail, because it finds no Dockerfile at the root. That is expected: the next step fixes it.
2. Open the service's **Settings** and rename it `sluice-facilitator`. Under **Source**, leave the Root Directory empty: the images are built from the repository root, because they copy `packages/sdk` as well.
3. Open the **Variables** tab. Choose **New Variable**, name it `RAILWAY_DOCKERFILE_PATH`, and give it the value `/packages/facilitator/Dockerfile`.
4. Add the volume. Right-click the project canvas (or press Ctrl+K for the command palette) and choose to add a **Volume**. When it asks which service to connect, choose `sluice-facilitator`. Set its mount path to `/data`. A service can have one volume, and a service with a volume cannot have replicas: leave it at one.
5. Print the settings from your own file that have values. This prints only lines that are filled in, and the file holds no key.

   ```powershell
   Get-Content .\.env.mainnet.facilitator | Where-Object { $_ -match '^[A-Z_]+=.+' }
   ```

6. In **Variables**, choose **RAW Editor**, paste those lines, and add these below them (the [variables table](#the-facilitator-variables) says what each is):

   ```text
   SLUICE_APPROVE=facilitator
   SLUICE_FACILITATOR_STATE=/data/queue.jsonl
   SLUICE_FACILITATOR_KILL_FILE=/data/KILL
   SLUICE_FACILITATOR_TRUST_PROXY_HOPS=1
   RAILWAY_DEPLOYMENT_DRAINING_SECONDS=45
   ```

   Leave out `SLUICE_TOKEN` if you like: the facilitator does not read it, because it asks the router for its token.
7. Add the relayer's key as a variable of its own, through the form and not the Raw Editor. Put the key on the clipboard from the file, without printing it:

   ```powershell
   (Get-Content .\relayer-mainnet.key -Raw).Trim() | Set-Clipboard
   ```

   Choose **New Variable**, name it `SLUICE_RELAYER_KEY`, and paste. Then clear the clipboard, and clear Windows' clipboard history too (Settings, System, Clipboard) if it is on:

   ```powershell
   Set-Clipboard -Value " "
   ```

8. Seal it. Open the variable's three-dot menu and choose **Seal**. A sealed value is given to the build and the running service but is never shown in the page and cannot be fetched through the API. It cannot be unsealed, and it cannot be edited through the Raw Editor (use the three-dot menu), and it is not copied to a duplicated service. This is why you keep the offline copy.
9. Optional: a private metrics path. Make a token and put it on the clipboard, then add it as `SLUICE_FACILITATOR_METRICS_TOKEN` the same way, and seal it. Leave the variable out to have no such path.

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard
   ```

10. Railway keeps variable changes as staged changes. Review them and choose **Deploy**.
11. In **Settings**, under **Networking**, **Public Networking**, choose **Generate Domain**. Copy the address, which looks like `https://sluice-facilitator-production.up.railway.app`. The container listens on the `PORT` Railway gives it, so you do not choose one.
12. Add one more variable, `SLUICE_FACILITATOR_URL`, with that address (with `https://`, no path, no trailing slash), and deploy again.
13. In **Settings**, under **Deploy**, set the **Healthcheck Path** to `/health`. Railway asks for it at each deploy and waits for any 2xx answer, for 300 seconds at most. It checks only while a deploy is starting, not afterwards: see [Watching it](#watching-it).
14. Read the deploy logs. A line with the message `started` and the network `mainnet` means it is up. A line that starts `refusing to start` says which setting is wrong, and nothing was sent.
15. Look at it from your own computer. Use your address.

    ```powershell
    Invoke-RestMethod https://sluice-facilitator-production.up.railway.app/health | ConvertTo-Json -Depth 5
    ```

    Expect `ok` true, `chainId` 1990, your router, `killSwitch` false, and your relayer's address. `lowBalance` is true while the relayer holds less than 0.5 QIE: that is a warning, and the facilitator still settles.

## Part 2: the tool server

1. In the same project, choose **New**, then **GitHub Repo**, and pick this repository again. Rename the service `sluice-tool-server`. Leave the Root Directory empty.
2. In **Variables**, add `RAILWAY_DOCKERFILE_PATH` with the value `/examples/paid-tools/Dockerfile`. Do not add a volume.
3. Print its settings from your file:

   ```powershell
   Get-Content .\.env.mainnet.tool-server | Where-Object { $_ -match '^[A-Z_]+=.+' }
   ```

4. In **RAW Editor**, paste those lines and add these. Use the builder's address for `SLUICE_PAYEE`, and the facilitator's address from Part 1, step 11, for `SLUICE_FACILITATOR_URL`. It must be https: Railway's private network is plain http, and the tool server refuses that.

   ```text
   SLUICE_PAYEE=0xTheBuildersAddress
   SLUICE_FACILITATOR_URL=https://sluice-facilitator-production.up.railway.app
   SLUICE_TOOLS_TRUST_PROXY_HOPS=1
   ```

5. Optional, as in Part 1 step 9: `SLUICE_TOOLS_METRICS_TOKEN`, sealed.
6. Choose **Deploy**, then **Settings**, **Networking**, **Generate Domain**, and under **Deploy** set the **Healthcheck Path** to `/health`.
7. Read the deploy logs for the line `started`. If it says `refusing to start`, the message names the setting. A router that cannot be read, or that does not hold QUSDC, stops it on mainnet.
8. Look at it:

   ```powershell
   Invoke-RestMethod https://sluice-tool-server-production.up.railway.app/health | ConvertTo-Json -Depth 5
   ```

   Expect `ok` true, `network` mainnet, `chainId` 1990, your router, your payee, and three tools with their prices.

## Part 3: after the web app exists

Do [HOSTING-VERCEL.md](HOSTING-VERCEL.md) now, with the two addresses above. It ends with the web app's address, for example `https://sluice.vercel.app`. Then:

1. On `sluice-facilitator`, add `SLUICE_FACILITATOR_CORS_ORIGINS` with the web app's address and nothing else.
2. On `sluice-tool-server`, add `SLUICE_TOOLS_CORS_ORIGINS` with the same value.
3. Each is the exact origin: `https` and the host, no path and no trailing slash, and **never a wildcard**. Both services refuse a wildcard, a path or a plain-http address when they start. A second origin (a custom domain, say) goes after a comma in the same value.
4. Deploy both. A change to a service with a volume restarts it with a short gap.
5. Check, from your own computer, in the folder that holds `deployment.json`. Use your three addresses.

   ```powershell
   pnpm live:hostcheck --facilitator https://sluice-facilitator-production.up.railway.app --tools https://sluice-tool-server-production.up.railway.app --origin https://sluice.vercel.app
   ```

   Expect `PASS` on every line but the relayer's low balance, which is a `WARN` until it holds 0.5 QIE, and a last line `hostcheck: ... 0 failed`. A `FAIL` names the setting to change. The command only asks for `/health`. With `--origin` it asks twice more of each service, once as a page on that origin and once as a page on an origin that is not listed.

## The variables

Every variable is in Railway's **Variables** tab. **Public** values are not secret: they are on the chain or are your own settings. **Secret** values are sealed. **You fill in** values depend on your own addresses. [.env.example](../.env.example) lists the names without values, and a test holds this page to what `pnpm live:wire` writes.

### The facilitator variables

| Name | Kind | Value | What it is |
| --- | --- | --- | --- |
| `RAILWAY_DOCKERFILE_PATH` | Railway setting | `/packages/facilitator/Dockerfile` | Which Dockerfile Railway builds. The Root Directory stays empty. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | Railway setting | `45` | How long a stopping deployment may finish a batch after the stop signal. Railway's default is 0, and the facilitator waits up to 30 seconds. |
| `SLUICE_NETWORK` | public | `mainnet` | From `.env.mainnet.facilitator`. The service checks the node's chain id against it. |
| `SLUICE_APPROVE` | public | `facilitator` | You approve the program by name. `pnpm live:wire` does not write it, on purpose. |
| `SLUICE_ROUTER` | public | your router | From `.env.mainnet.facilitator`. |
| `SLUICE_TOKEN` | public | QUSDC | From `.env.mainnet.facilitator`. Not read by the facilitator, which asks the router for its token; leave it out or in. |
| `SLUICE_MAX_QIE` | public | `0.5` | From `.env.mainnet.facilitator`. The most QIE the relayer may spend in a day. |
| `SLUICE_FACILITATOR_STATE` | you fill in | `/data/queue.jsonl` | The queue's file, on the volume. The service refuses to start on mainnet without it. |
| `SLUICE_FACILITATOR_KILL_FILE` | public | `/data/KILL` | While this file exists, the kill switch is on. |
| `SLUICE_FACILITATOR_TRUST_PROXY_HOPS` | public | `1` | How many proxies in front add to `X-Forwarded-For`. Railway's edge sets that header itself, according to a Railway staff answer on its forum that its documentation does not repeat, so one hop is used. See [What this does not verify](#what-this-does-not-verify). |
| `SLUICE_FACILITATOR_URL` | you fill in | the facilitator's `https://` domain | Where it is reached, for the status links in its replies. |
| `SLUICE_FACILITATOR_CORS_ORIGINS` | you fill in | the web app's origin | Exact origins that may read its answers from a browser. Empty allows none. Never a wildcard. Set it in Part 3. |
| `SLUICE_RELAYER_KEY` | **secret** | the contents of `relayer-mainnet.key` | The relayer's key. Sealed. It never goes in a file in the repository. |
| `SLUICE_FACILITATOR_METRICS_TOKEN` | **secret** | 24 to 200 characters you make | Optional. Turns on the private metrics path. Sealed. |

Do not set `SLUICE_FACILITATOR_PORT` or `SLUICE_FACILITATOR_HOST` here. The image listens on every address, and on the `PORT` Railway gives it.

### The tool server variables

| Name | Kind | Value | What it is |
| --- | --- | --- | --- |
| `RAILWAY_DOCKERFILE_PATH` | Railway setting | `/examples/paid-tools/Dockerfile` | Which Dockerfile Railway builds. |
| `SLUICE_NETWORK` | public | `mainnet` | From `.env.mainnet.tool-server`. |
| `SLUICE_ROUTER` | public | your router | From `.env.mainnet.tool-server`. A payment naming another router is refused. |
| `SLUICE_TOKEN` | public | QUSDC | From `.env.mainnet.tool-server`. Not read by the tool server, which asks the router; leave it out or in. |
| `SLUICE_PAYEE` | you fill in | the builder's address | The account paid for every call. It must not be the relayer. |
| `SLUICE_FACILITATOR_URL` | you fill in | the facilitator's `https://` domain | The facilitator that verifies and settles. https only. |
| `SLUICE_TOOLS_CORS_ORIGINS` | you fill in | the web app's origin | Exact origins that may read its answers from a browser. Empty allows none. Never a wildcard. Set it in Part 3. |
| `SLUICE_TOOLS_TRUST_PROXY_HOPS` | public | `1` | As for the facilitator. |
| `SLUICE_TOOLS_METRICS_TOKEN` | **secret** | 24 to 200 characters you make | Optional. Sealed. |

Railway also gives each service a `PORT`. Do not set it: both images read it and listen there.

## The kill switch drill

Do this before anyone is pointed at the facilitator, and again after any change to it. It needs the web app's origin set, so do it after Part 3.

1. Turn it on. In **Variables** on `sluice-facilitator`, add `SLUICE_FACILITATOR_KILL_SWITCH` with the value `1` and deploy. It takes a restart to change, and the service starts with the switch on.
2. Run the host check. It must **fail** on the kill switch line, and that is the drill working.

   ```powershell
   pnpm live:hostcheck --facilitator https://sluice-facilitator-production.up.railway.app --tools https://sluice-tool-server-production.up.railway.app
   ```

   Expect `FAIL  facilitator  killSwitch is true`. A paid call from the demo is refused too, because `/verify` answers that the payment is not valid.
3. Turn it off. Delete the variable and deploy. Run the host check again. Expect `PASS  facilitator  killSwitch is false`.
4. A hard stop, if the facilitator itself is the problem: open the service's deployments, open the menu of the running deployment, and choose **Remove**. That stops it. The queue stays on the volume, and no balance moves, because the router never depended on the facilitator. To start it again, redeploy.

A file also works as a switch: while `/data/KILL` exists it is on, and it needs no restart. Reaching a shell on a Railway service is outside what this page checked, so the variable is the way described here.

## Watching it

Railway's health check runs only while a deploy is starting. It does not watch a service after that, and it does not restart one that is unwell. Something has to ask. Run the host check every day, and after every change, and whenever a person says something is wrong:

```powershell
pnpm live:hostcheck --facilitator https://sluice-facilitator-production.up.railway.app --tools https://sluice-tool-server-production.up.railway.app --origin https://sluice.vercel.app
```

It exits 0 when nothing failed and 1 when something did, so a scheduled task can tell you. [OPERATIONS.md](OPERATIONS.md) has the alerts, the drills and the backups. Railway keeps manual and automated backups of a volume; this page did not check their schedule, so take a copy of the queue file yourself as DEPLOY-FACILITATOR.md says until you have.

## Rolling back

- **A bad deploy.** Turn the kill switch on first if payments are at risk. Then open the service's deployments, open the menu of the last deployment that was good, and choose **Rollback**. Railway redeploys that deployment with its own source code. A deployment older than your plan keeps has no rollback. Run the host check.
- **A bad variable.** Change it back and deploy. Railway has no undo for a variable that this page checked, so keep your own note of the non-secret values (the printed lines above are the record) and your offline copy of the key.
- **A rolled-back facilitator keeps its queue.** The volume is not part of a deployment, so it stays as it was. The facilitator settles what the chain shows on its next start, and the router refuses a payment that already settled.
- **A restart** (the deployment's menu, **Restart**) restarts the process in the same deployment. It is the quick answer to a service that has locked up.
- **A redeploy of a service with a volume** has a short gap: Railway does not mount one volume in two deployments at once.
- **Taking it down.** Remove the deployments. The router, the vault and every balance are untouched, and a payer can still refund and a builder still withdraw.
- **Rotating the relayer key** is in [DEPLOY-FACILITATOR.md](DEPLOY-FACILITATOR.md#rotating-the-relayer-key).

## What this does not verify

- **The Docker images were not built.** The Docker daemon was not running where this was written. The facilitator's image changed for Railway: no `VOLUME` line (Railway's builds have been reported to refuse one), it starts as root only to give `/data` to the `node` user and then runs as `node` (Railway mounts volumes as root, and its documentation's only fix is to run as root), and it uses the platform's `PORT`. A fault in the build, in `su-exec` or in the entrypoint would show as a failed build or a service that exits. Read the logs. A test runs the entrypoint's shell line against stand-ins for `id`, `chown` and `su-exec`, and that is all it shows.
- **The build context.** Railway's documentation gives `RAILWAY_DOCKERFILE_PATH` for a Dockerfile that is not at the root. It does not say, in the pages read, that the build context stays at the repository root; a forum answer says it does. If the build says a `COPY` source is missing, that is why.
- **Click paths.** The names of buttons come from Railway's documentation, which does not give every label. If a screen differs, look for the setting named in bold.
- **The proxy header.** Whether Railway's edge overwrites `X-Forwarded-For` is from a forum answer by a Railway staff member, which says it can change. With one hop the service uses the last address in the header. If the edge did not set it, a caller could forge it and take a rate limit that is not theirs; the money is not at risk. With zero hops every caller shares one limit, which is worse.
- **Sealing, the volume's permissions, the health check on the real service, backups and rollback** are as Railway's documentation describes them. None was run.
- **Nothing here is proof of a hosted service.** A passing host check is a reading of `/health` at one moment. A row in `docs/EVIDENCE.md`, recorded from the chain, is what this repository counts as evidence.
