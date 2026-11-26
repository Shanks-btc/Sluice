# Hosting the web app on Vercel

This is a set of steps for you to follow, in order. **Nothing in it has been run on Vercel.** The web app was built and tested here; the steps come from Vercel's documentation, read on 2026-11-23, and from [DEPLOY-WEB.md](DEPLOY-WEB.md), which says what the app reads and why. [What this does not verify](#what-this-does-not-verify) lists what to watch for.

The facilitator and the tool server go on Railway first, because the web app needs their addresses and they need the web app's: [HOSTING-RAILWAY.md](HOSTING-RAILWAY.md). This page is the Vercel part, and it ends with the one thing the Railway part is waiting for.

## Contents

- [Before you start](#before-you-start)
- [Part 1: the project](#part-1-the-project)
- [Part 2: the variables](#part-2-the-variables)
- [Part 3: deploy, and hand the origin back](#part-3-deploy-and-hand-the-origin-back)
- [Rolling back](#rolling-back)
- [What this does not verify](#what-this-does-not-verify)

## Before you start

- The repository is on GitHub, as [HOSTING-RAILWAY.md](HOSTING-RAILWAY.md) asks.
- The facilitator and the tool server have their Railway domains: two `https://` addresses, each with no path.
- The three `.env.mainnet.*` files from `pnpm live:wire --network mainnet`. This page uses `.env.mainnet.web`. It holds no key, and **every `NEXT_PUBLIC_` value reaches the browser**, so nothing secret ever goes in this project.

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
4. Give the origin to the two services. This is the step [HOSTING-RAILWAY.md, Part 3](HOSTING-RAILWAY.md#part-3-after-the-web-app-exists) is waiting for: `SLUICE_FACILITATOR_CORS_ORIGINS` on the facilitator and `SLUICE_TOOLS_CORS_ORIGINS` on the tool server, each set to that origin and nothing else. Never a wildcard. If you later add a custom domain, add its origin after a comma in both.
5. Check it all from your own computer, in the folder that holds `deployment.json`. Use your three addresses.

   ```powershell
   pnpm live:hostcheck --facilitator https://sluice-facilitator-production.up.railway.app --tools https://sluice-tool-server-production.up.railway.app --origin https://sluice.vercel.app
   ```

   Every line is `PASS`, except a `WARN` while the relayer holds less than 0.5 QIE. The origin lines show that each service lets this site read its answers, and that an origin nobody listed gets no permission.
6. Open the site's `/status` page. It reads the facilitator's `/health`, and says so if the facilitator is unwell.

## Rolling back

Vercel's **Instant Rollback** points the site's domains back at an earlier deployment. On the project's page, in the Production Deployment tile, choose **Instant Rollback**, pick the deployment, choose **Continue**, and then **Confirm Rollback**. On a Hobby plan only the deployment just before the current one can be chosen. Vercel then stops giving the production domains to new deployments until you undo the rollback (**Manage**, or `vercel promote`).

A rolled-back deployment keeps the variables it was made with. If you changed `NEXT_PUBLIC_FACILITATOR_URL` or `NEXT_PUBLIC_TOOLS_URL` since, the older deployment points at the older addresses. Roll the Railway side back too, or redeploy rather than roll back.

## What this does not verify

- **Nothing was run on Vercel.** The names of its settings come from its documentation. Its pages did not say which pnpm version it uses for a lockfile like this one, which is why `ENABLE_EXPERIMENTAL_COREPACK` is here.
- **The build.** `pnpm web:build` passes on the machine this was written on. A Vercel build also copies the fonts from the repository's own dependencies (`scripts/fonts.mjs`) and reads the repository's documents from outside `apps/web`; neither was tried there.
- **Origins.** The check proves what each service answers to a request that carries an `Origin` header. It does not prove what a particular browser does.
- **Nothing here is proof of a hosted site.** A passing host check is a reading at one moment.
