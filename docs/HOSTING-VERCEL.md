# Hosting Sluice on Vercel

This is a set of steps for you to follow, in order. **Nothing in it has been run on Vercel.** The programs were built and tested on a local chain, the database they use on Vercel was stood in for by a program on the test machine, and the platform's settings come from Vercel's, Upstash's and GitHub's documentation (read on 2026-11-23 for the web app and on 2026-11-26 and 2026-11-27 for the two services). [What this does not verify](#what-this-does-not-verify) lists what to watch for.

There are two parts. [The facilitator and the tool server on Vercel](#the-facilitator-and-the-tool-server-on-vercel) runs the two services as Vercel functions. If they run on Railway instead ([HOSTING-RAILWAY.md](HOSTING-RAILWAY.md)), skip that section. [Parts 1 to 3](#part-1-the-project) host the web app.

## Contents

- [Before you start](#before-you-start)
- [The facilitator and the tool server on Vercel](#the-facilitator-and-the-tool-server-on-vercel)
- [Part 1: the project](#part-1-the-project)
- [Part 2: the variables](#part-2-the-variables)
- [Part 3: deploy, and hand the origin back](#part-3-deploy-and-hand-the-origin-back)
- [Rolling back](#rolling-back)
- [Limits to know before relying on it](#limits-to-know-before-relying-on-it)
- [The free plan's daily commands, estimated](#the-free-plans-daily-commands-estimated)
- [What this does not verify](#what-this-does-not-verify)

## Before you start

- The repository is on GitHub, and what you mean to deploy is on its default branch.
- The three `.env.mainnet.*` files from `pnpm live:wire --network mainnet`. None of them holds a key. In the web app's file, **every `NEXT_PUBLIC_` value reaches the browser**, so nothing secret ever goes in the web app's project.
- For the services on Vercel: the relayer's key file on your computer, and a relayer that holds QIE for gas.
- Read [Limits to know before relying on it](#limits-to-know-before-relying-on-it). Vercel's Hobby plan is for non-commercial use.

## The facilitator and the tool server on Vercel

A function on Vercel runs for one request at a time, on a disk that does not last. So the facilitator keeps its queue, daily counters, relayer budget, relayer lock, stored kill switch and rate limits in a Redis database, and the tool server keeps there what each payment was used for and its own rate limits.

| Project | Root Directory | Database | Holds a key |
| --- | --- | --- | --- |
| `sluice-facilitator` | `packages/facilitator` | one database, shared | the relayer's |
| `sluice-tools` | `examples/paid-tools` | the same one | none |
| the web app (Parts 1 to 3) | `apps/web` | none | none |

Three separate projects, so that neither the tool server nor the web app holds the facilitator's settings. The two services do share a database, and with it a token.

**Read this before you share.** Both services share one token. The tool server's code is held to its own keys by a guard, and that guard is in the code and nowhere else: a bug or a compromise in the tool server's code, in a library it loads, or a token that leaks, could bypass it and read or change everything the facilitator keeps. That means the payments in its queue with their signatures, the stored kill switch, the daily caps, and the counters behind the relayer's daily budget and top-ups, which could then be reset so that the relayer spends more than its day's budget, up to what it holds. It could not sign with the relayer key, which is not in the database, or move QUSDC except as a payer's own signature allows. **Separate databases are the stronger setup, and the one to move to once there is a paid plan.** Until then, keep little QIE on the relayer.

**One facilitator per relayer key.** The lock in the database keeps the Vercel copies out of each other's way and knows nothing about a facilitator anywhere else. Stop any facilitator that runs with the same key on Railway, on a server or on your computer before you deploy this one.

Try it on the testnet before the mainnet: the same steps with `SLUICE_NETWORK` set to `testnet`, a testnet router, and a testnet key.

### Step 1: make two secrets, with no file and nothing on screen

Turn off clipboard history and clipboard sync in Windows (Settings, System, Clipboard), so that what you copy is not kept.

You need two different random values: one for the sweeper, one for Vercel's daily cron. This puts one on the clipboard without showing it:

```powershell
$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard
```

Make the sweeper's value when you reach `SLUICE_FACILITATOR_SWEEP_SECRET` in step 3, paste it there, and paste it again into GitHub (step 5) before you copy anything else. Then run the line again for `CRON_SECRET`. After each secret, empty the clipboard:

```powershell
Set-Clipboard -Value " "
```

Vercel does not show a Secret value again. If you lose track of one, make a new one and set it in both places.

The relayer's key goes from its file to the clipboard the same way, without being printed:

```powershell
(Get-Content .\relayer-mainnet.key -Raw).Trim() | Set-Clipboard
```

Paste it into the one field in step 3, then empty the clipboard. Never paste a key into a chat, an issue, a file in the repository or a command line.

### Step 2: one database for both services

Upstash's free plan allowed one database per account when its pricing page was read, so these steps use one.

1. In Vercel, open **Storage** (the Marketplace), choose **Upstash**, then **Redis**, and create one database. Pick a region close to where the projects' functions run.
2. Leave **Eviction** off (Upstash's documentation says it is off unless turned on). With it on, a full database throws entries away, and the entries here are queued payments, the counters behind the daily caps and the stored kill switch. Both services fill the same space.
3. Connect the database to the `sluice-facilitator` project and to the `sluice-tools` project, for **Production** only (steps 3 and 4 make the projects, so come back to this).
4. After connecting, look at each project's **Environment Variables**. The program reads one of these pairs: `SLUICE_REDIS_REST_URL` with `SLUICE_REDIS_REST_TOKEN`, or `UPSTASH_REDIS_REST_URL` with `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` with `KV_REST_API_TOKEN`. If a project has none of these (the integration may add a prefix of its own, or may not connect a second project), type `SLUICE_REDIS_REST_URL` and `SLUICE_REDIS_REST_TOKEN` there yourself from the database's REST settings, the same two values in both, the token as a Secret. Do not use the read-only token.
5. On the facilitator's project, set `SLUICE_FACILITATOR_SHARED_DATABASE` to `one-token-for-both-services` (it is in the table below). This is your word that you mean to share.

How the two are kept apart: every key of the facilitator starts with `sluice:facilitator:` and every key of the tool server with `sluice:tools:`, both fixed in the code. The tool server reaches the database through a guard that allows its own keys, its two scripts and nothing else. It writes the key `sluice:tools:in-use` before it serves anything. A facilitator that finds that key and has not been told to share refuses to start, and one already running accepts and sends nothing from then on.

**With two databases** (a paid plan): give each project its own and leave `SLUICE_FACILITATOR_SHARED_DATABASE` out. Move while nothing is calling the tools: the tool server's record of what each payment was used for stays behind, so a payment sent again afterwards is refused, even one that was charged and not yet answered. To move from one to two, in this order:

1. Connect a new database to the tool server's project, disconnect the old one from it, and redeploy it.
2. Reset the old database's token, because the tool server held it, and give the facilitator the new one.
3. Delete the key `sluice:tools:in-use` from the facilitator's database.
4. Remove `SLUICE_FACILITATOR_SHARED_DATABASE` and redeploy the facilitator.

### Step 3: the facilitator's project

1. In Vercel, choose **Add New**, then **Project**, import this repository, and name the project `sluice-facilitator`.
2. Set **Framework Preset** to **Other** and **Root Directory** to `packages/facilitator`. Leave **Include files outside the root directory in the Build Step** on: the build needs `packages/sdk`.
3. Leave the Build Command and Output Directory as they come: [packages/facilitator/vercel.json](../packages/facilitator/vercel.json) sets them, with the function's longest run (120 seconds) and a daily cron call. Set the Install Command to `pnpm install --frozen-lockfile` and the Node.js Version to `24.x`.
4. Under the project's **Settings**, in **Environment Variables**, turn on access to System Environment Variables. On mainnet the program starts only where Vercel says `VERCEL_ENV` is `production`.
5. Enter the variables below, each for **Production** only. Mark every **secret** row as **Secret** (Vercel's name for what it used to call Sensitive).
6. Deploy from Git. Do not run `vercel deploy` from your working folder, which holds key files. [.vercelignore](../.vercelignore) is a backstop for that mistake and no more.

### The facilitator's variables on Vercel

| Name | Kind | Value | What it is |
| --- | --- | --- | --- |
| `SLUICE_NETWORK` | public | `mainnet` | Which chain. |
| `SLUICE_APPROVE` | public | `facilitator` | Your approval of this program, by name. |
| `SLUICE_ROUTER` | public | your router | From `.env.mainnet.facilitator`. |
| `SLUICE_MAX_QIE` | **secret** | `0.5` | The most QIE the relayer may spend in a UTC day. Ceiling 2. |
| `SLUICE_RELAYER_KEY` | **secret** | the relayer's key, from the clipboard | Pays gas. This project is its one user. |
| `SLUICE_FACILITATOR_SWEEP_SECRET` | **secret** | the random value of step 1 | What the GitHub workflow sends to `/internal/drain`. |
| `CRON_SECRET` | **secret** | a second random value | Vercel sends it with its daily cron call. |
| `SLUICE_FACILITATOR_MAX_TOPUP_QIE` | **secret** | `0.001` | The most QIE one top-up may send. Ceiling 0.0015. |
| `SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE` | **secret** | `0.001` | The most all top-ups to one address may send in a UTC day. Ceiling 0.003. |
| `SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC` | **secret** | `10` | The most QUSDC one zero-QIE start may deposit. It can be lowered, not raised. |
| `SLUICE_FACILITATOR_PAYER_DAILY_QUSDC` | **secret** | `50` | The most QUSDC one payer may queue in a UTC day. It can be lowered, not raised. |
| `SLUICE_FACILITATOR_DAILY_QUSDC` | **secret** | `500` | The most QUSDC all payers may queue in a UTC day. It can be lowered, not raised. |
| `SLUICE_FACILITATOR_KILL_SWITCH` | public | `0` | The kill switch to rely on. `1` stops every send, from the next deployment on, whatever the database holds. |
| `SLUICE_FACILITATOR_SHARED_DATABASE` | public | `one-token-for-both-services` | Accepts that the tool server uses the same database. Leave it out if the two have a database each. |
| `SLUICE_FACILITATOR_URL` | you fill in | the project's production `https://` address | Used for the status links. You know it once the project has been deployed: set it then, and redeploy. |
| `SLUICE_FACILITATOR_CORS_ORIGINS` | you fill in | the web app's origin | Exact origins that may read answers from a browser. Never a wildcard. Set it after Part 3. |
| `NODEJS_HELPERS` | public | `0` | Vercel's own setting: the function gets the request as it arrived, and the program's size limit reads the body. |
| `ENABLE_EXPERIMENTAL_COREPACK` | public | `1` | So the build uses the pnpm the repository pins. |

Optional: `SLUICE_RPC_URL` (https), and `SLUICE_FACILITATOR_METRICS_TOKEN` (a Secret). The function refuses to start if `SLUICE_FACILITATOR_STATE` or `SLUICE_FACILITATOR_KILL_FILE` is set.

### Step 4: the tool server's project

The same as step 3, with the name `sluice-tools` and the Root Directory `examples/paid-tools` ([its vercel.json](../examples/paid-tools/vercel.json) allows a function 60 seconds), the database of step 2, and these variables for **Production** only. It needs no key: never set `SLUICE_RELAYER_KEY` or `SLUICE_KEY` here.

### The tool server's variables on Vercel

| Name | Kind | Value | What it is |
| --- | --- | --- | --- |
| `SLUICE_NETWORK` | public | `mainnet` | Which chain. |
| `SLUICE_ROUTER` | public | your router | From `.env.mainnet.tool-server`. |
| `SLUICE_PAYEE` | you fill in | your builder address | The address that is paid. |
| `SLUICE_FACILITATOR_URL` | you fill in | the facilitator's production `https://` address | The facilitator that verifies and settles. |
| `SLUICE_TOOLS_CORS_ORIGINS` | you fill in | the web app's origin | Exact origins that may read answers from a browser. Never a wildcard. Set it after Part 3. |
| `NODEJS_HELPERS` | public | `0` | As for the facilitator. |
| `ENABLE_EXPERIMENTAL_COREPACK` | public | `1` | As for the facilitator. |

### Step 5: the five-minute sweeper in GitHub

[.github/workflows/sluice-drain.yml](../.github/workflows/sluice-drain.yml) asks the facilitator every five minutes to settle what is queued. GitHub runs it from the default branch.

1. In the GitHub repository, open **Settings**, **Secrets and variables**, **Actions**, and add two repository secrets: `SLUICE_FACILITATOR_URL` (the facilitator's production address, https, no path) and `SLUICE_FACILITATOR_SWEEP_SECRET` (the same value as in Vercel).
2. Open **Actions**, **Sluice drain**, **Run workflow**. The log shows the facilitator's answer, which holds counts such as `settled` and `remaining`.

With neither secret set, the job warns and does nothing. Read the GitHub entry under [Limits](#limits-to-know-before-relying-on-it) if the repository is private.

### Step 6: check it

1. Open `https://<the facilitator's address>/health`. It must be the facilitator's own report: `ok` true, your relayer's address, `killSwitch` false. If it answers `{"error":"not_found"}` instead, the platform did not hand the function the path that was asked for: stop here.
2. From your own computer, in the folder that holds `deployment.json`, with your three addresses:

   ```powershell
   pnpm live:hostcheck --facilitator https://sluice-facilitator.vercel.app --tools https://sluice-tools.vercel.app --origin https://sluice.vercel.app
   ```

3. Do the kill switch drill below.
4. Make one small paid call. Its answer should arrive with a settlement that names a transaction, and `/status/<id>` should show `settled`. Note how long it took, and make a second call after the services have been idle for an hour, to see what a cold start costs.

### Stopping it

There are two switches. Either one stops everything that sends a transaction or spends QIE: `/verify`, `/settle` and `/hold` refuse, a drain reports why it sent nothing, and `/health` shows `killSwitch` true.

- **The one to rely on: the setting.** Set `SLUICE_FACILITATOR_KILL_SWITCH` to `1` on the facilitator's project and redeploy. It does not depend on the database: it holds whatever the database says, if the database cannot be reached, and if someone holding its token has changed it. It takes effect with the new deployment, so check that `/health` shows `killSwitch` true.
- **A second, quicker one: a key in the database.** In the Upstash console, open the database and run this, with your network and your router's address in lower case:

  ```text
  SET sluice:facilitator:mainnet:<router address in lower case>:kill 1
  ```

  Any value but `0` means on. To let it go on, delete the key (`DEL` with the same name). It acts on the next request, and it is only as good as the database: whatever holds the token can delete it, and with one database that includes a compromised tool server.

In an emergency, set the key to stop at once, then set the setting and redeploy so that the stop does not depend on the database.

Every refusal is written to the function's log, and the last 500 are also kept in the database, in the list named like the key above with `refusals` in place of `kill`.

Payments already queued wait. One whose deadline passes while it waits is marked expired and is not charged.

### What settles a payment, and when

| What | When |
| --- | --- |
| The tool server's `/capture` | while the paid call waits, which is how this tool server's calls are paid |
| The request that queued a payment with `/settle` | at once, after `/settle` has answered |
| The GitHub workflow | every five minutes, when GitHub runs it |
| Vercel's cron | once a day, at about 03:17 UTC |

All of them do the same thing and may overlap: one copy at a time holds the relayer, a copy that lost the lock can neither sign nor write, and the router pays an intent once.

## Part 1: the project

1. In Vercel, choose **Add New**, then **Project**, then **Import Git Repository**, and pick this repository.
2. Under **Configure Project**, leave the **Framework Preset** as Next.js. Next to **Root Directory**, choose **Edit** and set it to `apps/web`.
3. In the project's **Settings**, under **General**, in the Root Directory section, check that **Include source files outside of the Root Directory in the Build Step** is on. It is on by default for projects made after August 2020. The build reads `docs/`, `DECISIONS.md`, `packages/` and `src/` from the repository root, so the site can show the repository's own files.
4. Under **Build and Deployment**, turn on the overrides and set:

   | Setting | Value |
   | --- | --- |
   | Install Command | `pnpm install --frozen-lockfile` |
   | Build Command | `pnpm run build` |
   | Output Directory | empty (the default) |
   | Node.js Version | `24.x` |

   Do not turn on static export and do not set a framework override: every page is rendered when it is asked for, because the Content Security Policy carries a new nonce on each request, and the `/api/risk` route needs a server.
5. Add one environment variable now, for Production: `ENABLE_EXPERIMENTAL_COREPACK` with the value `1`. The repository pins pnpm 11 in its root `package.json`, and Vercel's own choice of pnpm comes from the lockfile, which can be an older one. Vercel marks Corepack experimental. If the install step then fails on the lockfile, look at this variable before anything else; if it works without the variable, take it out.

## Part 2: the variables

In **Settings**, **Environment Variables**, enter each **Name** and **Value**, choose the environments, and **Save**. Vercel encrypts values at rest. A change reaches only the deployments made after it, so redeploy after changing one.

Print the lines of your file that have values (they are public):

```powershell
Get-Content .\.env.mainnet.web | Where-Object { $_ -match '^[A-Z_]+=.+' }
```

### The values from `.env.mainnet.web`

| Name | Kind | Value | What it is |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_CHAIN_ID` | public | `1990` | The chain the pages read and send on. |
| `NEXT_PUBLIC_ROUTER_ADDRESS` | public | your router | The router. Without it the live pages say "Contracts not configured". |
| `NEXT_PUBLIC_VAULT_ADDRESS` | public | your vault | The router's vault. The app checks it against `router.vault()` and refuses a mismatch. |
| `NEXT_PUBLIC_FROM_BLOCK` | public | your deployment's block | Where scans for events stop. |
| `SLUICE_FROM_BLOCK` | public | the same block | The same, for the pages that read on the server. |
| `NEXT_PUBLIC_SESSION_CAP_QUSDC` | public | `1` | The most QUSDC one session may deposit on the live pages. Never above 10. |

### What you fill in, now that the two Railway addresses exist

If the two services run on Vercel, the addresses are their Vercel production addresses.

| Name | Kind | Value | What it is |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_FACILITATOR_URL` | you fill in | the facilitator's `https://` domain | The facilitator offered to a wallet with no QIE. It must list this site's origin in `SLUICE_FACILITATOR_CORS_ORIGINS`. |
| `NEXT_PUBLIC_TOOLS_URL` | you fill in | the tool server's `https://` domain | The hosted tool server that the live demo and the builder's test call pay. It must list this site's origin in `SLUICE_TOOLS_CORS_ORIGINS`. |
| `NEXT_PUBLIC_SITE_URL` | you fill in | where the site is served | So link previews carry an absolute address. You know it once the project has been deployed: see Part 3. |

Optional: `NEXT_PUBLIC_GITHUB_URL` (the repository's address, for the footer and for links from the documents to files) and `NEXT_PUBLIC_RPC_URL` (left out, the app reads through QIE's public RPC for the chain). Server only, and optional: `SLUICE_RPC_URL` and `SLUICE_EXPLORER_URL`, which must be https.

Set the two live addresses for **Production** only. Leave them out of **Preview** and **Development**: a preview deployment is served from its own address, which no service lists, so its live pages could not read the services anyway, and without the variables they say plainly that no facilitator or tool server is configured. Do not add a wildcard to the services to make previews work.

**Never set** `SLUICE_KEY`, `SLUICE_RELAYER_KEY`, `SLUICE_AGENT_KEY` or `SLUICE_APPROVE` here. The web app does not read them, and a test fails the build if its code names one.

## Part 3: deploy, and hand the origin back

1. Choose **Deploy**. The build runs the repository's `pnpm run build` for `apps/web`: it writes the site's content from the repository's documents, copies the fonts, and runs `next build --webpack`.
2. When it finishes, Vercel shows the project's production address, `https://<project>.vercel.app`, under **Domains**. That is the web app's **origin**. Copy it exactly: `https`, the host, no path, no trailing slash.
3. Set `NEXT_PUBLIC_SITE_URL` to it, and redeploy.
4. Give the origin to the two services. This is the step [HOSTING-RAILWAY.md, Part 3](HOSTING-RAILWAY.md#part-3-after-the-web-app-exists) is waiting for, and on Vercel it is the last row of each service's table above: `SLUICE_FACILITATOR_CORS_ORIGINS` on the facilitator and `SLUICE_TOOLS_CORS_ORIGINS` on the tool server, each set to that origin and nothing else. Never a wildcard. If you later add a custom domain, add its origin after a comma in both. On Vercel, redeploy both after setting it.
5. Check it all from your own computer, in the folder that holds `deployment.json`. Use your three addresses.

   ```powershell
   pnpm live:hostcheck --facilitator https://sluice-facilitator-production.up.railway.app --tools https://sluice-tool-server-production.up.railway.app --origin https://sluice.vercel.app
   ```

   Every line is `PASS`, except a `WARN` while the relayer holds less than 0.5 QIE. The origin lines show that each service lets this site read its answers, and that an origin nobody listed gets no permission.
6. Open the site's `/status` page. It reads the facilitator's `/health`, and says so if the facilitator is unwell.

## Rolling back

Vercel's **Instant Rollback** points the site's domains back at an earlier deployment. On the project's page, in the Production Deployment tile, choose **Instant Rollback**, pick the deployment, choose **Continue**, and then **Confirm Rollback**. On a Hobby plan only the deployment just before the current one can be chosen. Vercel then stops giving the production domains to new deployments until you undo the rollback (**Manage**, or `vercel promote`).

A rolled-back deployment keeps the variables it was made with. If you changed `NEXT_PUBLIC_FACILITATOR_URL` or `NEXT_PUBLIC_TOOLS_URL` since, the older deployment points at the older addresses. Roll the services back too, or redeploy rather than roll back.

Rolling a service back changes its code and not its database. Turn the kill switch on first if you are not sure the older code reads what the newer one wrote.

## Limits to know before relying on it

These concern the two services on Vercel. None of them was measured on the platform.

- **The plan's terms.** Vercel's Hobby plan is restricted to non-commercial, personal use, and commercial use needs Pro or Enterprise ([fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines), [terms](https://vercel.com/terms), [Hobby plan](https://vercel.com/docs/plans/hobby)). A service that settles payments, and a tool server that charges for calls, are likely commercial use. Read the terms and decide before you deploy them on Hobby.
- **One database, one token.** Both services share one token. The guard that keeps the tool server to its own keys is in its code, so a bug or a compromise in the tool server's code could bypass it. Separate databases are the stronger setup once a paid plan exists. The two also share one allowance of commands and one limit of space, so a tool server that is flooded can stop the facilitator.
- **A paid call waits for the chain.** A payment expires, by default, five minutes after it is signed, and a sweep may come later than that. So this tool server has the facilitator hold each payment before the tool runs, and gives the tool's answer only once the payment has settled on chain. If the attempt to settle fails, the payment is marked as never to be sent, the caller is not charged and gets no answer, and the tool has run for nothing: that cost falls on the builder. If the chain takes longer than the facilitator waits (20 seconds), the answer is `sluice_payment_pending`: the proxy and the web app send the same payment again, up to three times. A client that signs a new payment instead can pay twice for one call, if the earlier one then settles.
- **Other tool servers.** This holds for the tool server in this repository run as step 4 says, and for a server that sets `answerOnlyWhenSettled`. A server that queues a payment with `/settle` and answers at once can still be left unpaid when an attempt to settle fails.
- **GitHub's schedule** is at most every five minutes, may start late or be skipped when GitHub is busy, and stops in a public repository after 60 days without activity. Standard runners are free for public repositories. In a private one, five minutes means about 8,640 jobs in 30 days; GitHub counts each job's time in whole minutes, so that is likely more than the Free plan's included usage (about 2,000 Linux minutes, worked out from GitHub's prices). Check your usage, or run the sweep less often.
- **Vercel's cron** runs once a day on Hobby, may be up to 59 minutes off, is not retried, and may be missed or run twice.
- **Time limits.** The functions ask for 120 seconds (facilitator) and 60 (tool server), inside the 300 that Hobby allows with Fluid compute, the default for new projects. Check that Fluid compute is on. Work that runs on after an answer shares that time and is cut off with it; the next sweep finishes from the chain. A paid call must run its tool and see the payment settle within the tool server's 45 seconds, or it is answered later, when the same payment is sent again.
- **Cold starts** were not measured. A copy that has been idle connects to the node before it answers. The tool server gives the facilitator 10 seconds (`SLUICE_TOOLS_RPC_TIMEOUT_MS`): a slower start fails that call, and no tool runs.
- **Logs** on Hobby are kept for one hour. Refusals are also kept in the facilitator's database.
- **The database's quota.** Upstash's free plan has 500,000 commands a month, 250 MB of data and 10 GB of traffic. Past the allowance it refuses commands, and both services then accept, send and serve nothing until the next month or a paid plan. [The estimate below](#the-free-plans-daily-commands-estimated) says what a day may use.
- **Nothing keeps a copy of the database.** The chain is the record of what was paid. A lost or emptied database loses the queue, whose payments then go unpaid, resets the day's counters and clears the stored kill switch.

## The free plan's daily commands, estimated

500,000 a month is about 16,100 a day over 31 days. The counts per item were taken once on the stand-in, with the two services on one database. The numbers a day are assumptions: change them to yours. Whether Upstash counts a script as one command or as each command inside it is not stated in its pricing pages, so both are shown.

| What uses commands | Assumed a day | A script as one command, each | Every command inside scripts, each | A day, scripts as one | A day, every command |
| --- | --- | --- | --- | --- | --- |
| Sweeps from GitHub, every five minutes | 288 | 10 | 14 | 2,880 | 4,032 |
| Vercel's daily cron | 1 | 10 | 14 | 10 | 14 |
| Cold starts of either service | 200 | 1 | 1 | 200 | 200 |
| Readings of the facilitator's `/health`, by the status page and checks | 100 | 9 | 10 | 900 | 1,000 |
| Requests that ask a price and pay nothing | 500 | 2 | 6 | 1,000 | 3,000 |
| **Before any paid call** | | | | **4,990** | **8,246** |

One paid call (the price asked, the paid call itself with a chain that confirms after 5 seconds, and one reading of `/status`) used 69 commands with a script as one, and 148 counting every command. What is left in a day then pays for **about 160 calls a day** with a script as one command, or **about 50 a day** counting every command.

- Each further second a payment takes to confirm adds about 5 commands to its call.
- Not counted: refused and repeated requests, zero-QIE starts and relayed requests, and outside monitors.
- A caller who stays inside the limits can use up the month. At the tool server's 60 requests a minute that pay nothing, one address uses it in about three days; at its 300 a minute for requests that carry a payment, real or not, in under two. The facilitator's own public paths cost commands too. `SLUICE_TOOLS_RATE_LIMIT_IP` and `SLUICE_TOOLS_RATE_LIMIT_UNPAID` can be lowered.
- Watch the usage page for a week, and compare.

## What this does not verify

- **Nothing was run on Vercel, Upstash or GitHub Actions.** The names of settings come from their documentation.
- **One database on two projects.** Vercel's pages speak of the projects connected to a resource, and do not say outright that one Upstash database can be connected to two. Step 2 covers typing the values by hand.
- **A narrower token.** Upstash documents users limited to key patterns, with their own REST tokens (`ACL SETUSER`, `ACL RESTTOKEN`). A token for the tool server limited to `sluice:tools:` would move the isolation into the database. Whether the free plan offers it, and whether such limits apply to keys used by scripts, is not stated, and it was not tried.
- **Resetting a database's token**, in the move to two databases, was not looked into.
- **The path a function sees.** Both services send every path to one function (`rewrites` in `vercel.json`). The documentation read did not state that the function still sees the path that was asked for. Step 6 checks it.
- **The database.** The tests ran the same scripts in a different Lua engine (5.3, where Redis runs 5.1) behind a stand-in that knows the commands used here. Some of the facilitator's scripts form key names inside the script, from its prefix (the tool server's do not); Upstash's documentation advises passing every key in `KEYS` where possible and does not say that other keys are refused.
- **The integration's variable names** were not stated in the documentation read, which is why step 2 has you look.
- **The builds.** `pnpm build` passes on the machine this was written on. A Vercel build from a subfolder reads the workspace packages above it, which Vercel's documentation says is on by default; it was not tried. Vercel did not say which pnpm version it uses for a lockfile like this one, which is why `ENABLE_EXPERIMENTAL_COREPACK` is here. The web app's build also copies the fonts from the repository's own dependencies (`scripts/fonts.mjs`).
- **Whether the production addresses answer the public.** Vercel can protect deployments behind a login. Step 6 would show it.
- **Origins.** The check proves what each service answers to a request that carries an `Origin` header. It does not prove what a particular browser does.
- **Nothing here is proof of a hosted site.** A passing host check is a reading at one moment.
