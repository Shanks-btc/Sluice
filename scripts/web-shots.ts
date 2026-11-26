// pnpm web:shots: screenshots of every page of the built web app, at 390px and 1440px wide, in the light and the dark theme, saved to
// design/screenshots/slice5/. Run after `pnpm web:build`. Pages are shown with nothing configured (the honest empty states), and the live
// pages are shown again against a local chain, with a local tool server and facilitator, a mock wallet and throwaway keys, in files named
// "-local": the live demo with balances, the deposit review, the payment review, a settled call, the wallet's history, the builder's tools
// and the status page. Nothing in them is mainnet. It also writes design/screenshots/sluice-landing.png, the one image at the top of the
// README.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseEther } from "ethers";
import { USDC, signedIntent } from "../test/helpers";
import { MockWallet } from "../test/helpers/mock-wallet";
import { depositFor, fundWallet, freshChain, startStack, throwawayWallet } from "../test/helpers/stack";
import type { Stack } from "../test/helpers/stack";
import { fakeExplorer } from "../test/helpers/explorer";
import { createToolServer, readToolServerEnv } from "../examples/paid-tools/src";

const root = join(__dirname, "..");
const webDir = join(root, "apps", "web");
const out = join(root, "design", "screenshots", "slice5");
const { chromium } = createRequire(join(webDir, "package.json"))("playwright-core") as typeof import("playwright-core");

const PORT_EMPTY = 3220;
const PORT_LIVE = 3221;

function startNext(port: number, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [join(webDir, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], {
    cwd: webDir,
    env: { ...process.env, ...env, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", () => undefined);
  return child;
}
function stop(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}
async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

/** Makes a mock wallet, which signs with a throwaway key and sends to the local chain, the page's window.ethereum. */
async function giveWallet(context: import("playwright-core").BrowserContext, wallet: MockWallet): Promise<void> {
  await context.exposeFunction("__sluiceWallet", async (args: { method: string; params?: unknown }) => {
    try {
      return { result: await wallet.request(args as never) };
    } catch (err) {
      const e = err as { code?: number; message?: string };
      return { error: { code: e.code ?? -32603, message: e.message ?? "failed" } };
    }
  });
  await context.addInitScript(() => {
    const win = window as unknown as { ethereum?: unknown; __sluiceWallet: (a: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }> };
    win.ethereum = {
      request: async (args: unknown) => {
        const answer = await win.__sluiceWallet(args);
        if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
        return answer.result;
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
  });
}

const SIZES = [
  ["390", { width: 390, height: 844 }],
  ["1440", { width: 1440, height: 900 }],
] as const;
const THEMES = ["light", "dark"] as const;

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  await freshChain();
  const stack: Stack = await startStack({ feeBps: 100, corsOrigins: [`http://127.0.0.1:${PORT_LIVE}`] });
  const tools = await createToolServer({
    env: readToolServerEnv({
      SLUICE_NETWORK: "local",
      SLUICE_ROUTER: stack.routerAddress,
      SLUICE_PAYEE: stack.builder.address,
      SLUICE_FACILITATOR_URL: stack.facilitatorUrl,
      SLUICE_RPC_URL: stack.rpcUrl,
      SLUICE_TOOLS_PORT: "0",
      SLUICE_TOOLS_CORS_ORIGINS: `http://127.0.0.1:${PORT_LIVE}`,
    }),
    explorer: fakeExplorer(stack.provider),
  });
  const toolsUrl = `http://127.0.0.1:${await tools.listen()}`;
  const empty = startNext(PORT_EMPTY, { SLUICE_RPC_URL: stack.rpcUrl });
  const live = startNext(PORT_LIVE, {
    NEXT_PUBLIC_ROUTER_ADDRESS: stack.routerAddress,
    NEXT_PUBLIC_VAULT_ADDRESS: stack.vaultAddress,
    NEXT_PUBLIC_CHAIN_ID: "1990",
    NEXT_PUBLIC_RPC_URL: stack.rpcUrl,
    NEXT_PUBLIC_FACILITATOR_URL: stack.facilitatorUrl,
    NEXT_PUBLIC_TOOLS_URL: toolsUrl,
    NEXT_PUBLIC_FROM_BLOCK: "0",
    SLUICE_RPC_URL: stack.rpcUrl,
    SLUICE_FROM_BLOCK: "0",
  });
  // Without the GPU: a tall page with frosted cards can take minutes to capture through the software fallback's GPU path, and seconds without it.
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  // A slow machine can take well over thirty seconds for a first load, so these waits are longer than the default.
  const fresh = async (options: Parameters<typeof browser.newContext>[0]) => {
    const context = await browser.newContext(options);
    context.setDefaultNavigationTimeout(120_000);
    context.setDefaultTimeout(60_000);
    return context;
  };
  try {
    await Promise.all([waitFor(`http://127.0.0.1:${PORT_EMPTY}`), waitFor(`http://127.0.0.1:${PORT_LIVE}`)]);
    const pages: Array<[string, string]> = [["landing", "/"], ["demo", "/demo"], ["builder", "/builder"], ["wallet", "/wallet"], ["docs", "/docs"], ["docs-spec", "/docs/spec"], ["evidence", "/evidence"], ["status", "/status"], ["security", "/security"], ["terms", "/terms"], ["privacy", "/privacy"], ["not-found", "/no-such-page"]];

    for (const theme of THEMES) {
      for (const [size, viewport] of SIZES) {
        const context = await fresh({ viewport, colorScheme: theme });
        await context.addInitScript((t) => window.localStorage.setItem("sluice-theme", t), theme);
        for (const [name, path] of pages) {
          const page = await context.newPage();
          await page.goto(`http://127.0.0.1:${PORT_EMPTY}${path}`, { waitUntil: "networkidle" });
          await page.screenshot({ path: join(out, `${name}-${size}-${theme}.png`), fullPage: true, timeout: 120_000 });
          if (name === "landing" && size === "1440" && theme === "light") {
            await page.screenshot({ path: join(root, "design", "screenshots", "sluice-landing.png"), fullPage: true, clip: { x: 0, y: 0, width: 1440, height: 1180 }, timeout: 120_000 });
          }
          await page.close();
        }
        // The sandbox tab of the demo, which is not the one the page opens on.
        const sandbox = await context.newPage();
        await sandbox.goto(`http://127.0.0.1:${PORT_EMPTY}/demo`, { waitUntil: "networkidle" });
        await sandbox.getByTestId("tab-sandbox").click();
        await sandbox.getByTestId("sim-run").click();
        await sandbox.getByTestId("sim-done").waitFor({ state: "visible", timeout: 30_000 });
        await sandbox.screenshot({ path: join(out, `demo-sandbox-${size}-${theme}.png`), fullPage: true, timeout: 120_000 });
        await sandbox.close();
        await context.close();
      }
    }

    // The builder and wallet pages with data, from the local chain.
    const mock = new MockWallet(stack.provider);
    await fundWallet(stack, mock.wallet, USDC("20"), parseEther("1"));
    const payer = stack.payer;
    for (const amount of [USDC("0.01"), USDC("0.25"), USDC("1.5")]) {
      await stack.mint(payer.address, amount);
      await stack.token.connect(payer).approve(stack.routerAddress, amount);
      await stack.router.connect(payer).deposit(amount);
      const { intent, signature } = await signedIntent(stack, payer, payer.address, mock.address, amount);
      await stack.router.connect(stack.stranger).settle(intent, signature);
    }
    const w = mock.wallet.connect(stack.provider);
    await stack.token.connect(w).approve(stack.routerAddress, USDC("8"));
    await stack.router.connect(w).deposit(USDC("8"));
    await stack.vault.connect(w).authorize(
      { agent: throwawayWallet().address, budget: USDC("2"), perCallCap: USDC("0.05"), expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400) },
      [{ payee: stack.builder.address, toolId: "0x" + "00".repeat(32) }],
    );
    for (const theme of THEMES) {
      for (const [size, viewport] of SIZES) {
        const context = await fresh({ viewport, colorScheme: theme });
        await context.addInitScript((t) => window.localStorage.setItem("sluice-theme", t), theme);
        await giveWallet(context, mock);
        for (const [name, path, ready] of [["builder", "/builder", "builder-stats"], ["wallet", "/wallet", "sessions"]] as const) {
          const page = await context.newPage();
          await page.goto(`http://127.0.0.1:${PORT_LIVE}${path}`, { waitUntil: "networkidle" });
          await page.getByTestId("connect").click();
          await page.getByTestId(ready).waitFor({ state: "visible", timeout: 20_000 });
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(out, `${name}-${size}-${theme}-local.png`), fullPage: true, timeout: 120_000 });
          await page.close();
        }
        await context.close();
      }
    }

    // The live demo from the local chain, and the pages that show what it did: a payer with 0.10 QUSDC prepaid goes through the deposit
    // review, the payment review, a paid call and its settlement. The status page and the builder's tools are shown after that, so they
    // have a settled batch to report.
    for (const theme of THEMES) {
      for (const [size, viewport] of SIZES) {
        const payerMock = new MockWallet(stack.provider);
        await fundWallet(stack, payerMock.wallet, USDC("5"), parseEther("1"));
        await depositFor(stack, payerMock.wallet, USDC("0.1"));
        const context = await fresh({ viewport, colorScheme: theme });
        await context.addInitScript((t) => window.localStorage.setItem("sluice-theme", t), theme);
        await giveWallet(context, payerMock);
        const shot = (page: import("playwright-core").Page, name: string, fullPage: boolean) => page.screenshot({ path: join(out, `${name}-${size}-${theme}-local.png`), fullPage, timeout: 120_000 });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${PORT_LIVE}/demo`, { waitUntil: "networkidle" });
        await page.getByTestId("connect").click();
        await page.getByTestId("live-balances-view").waitFor({ state: "visible", timeout: 20_000 });
        await page.getByTestId("tool-select").waitFor({ state: "visible", timeout: 20_000 });
        await page.waitForTimeout(400);
        await shot(page, "demo-live", true);
        await page.getByTestId("live-deposit-review").click();
        await page.getByTestId("flow-dialog").waitFor({ state: "visible" });
        await page.waitForTimeout(300);
        await shot(page, "demo-deposit-review", false);
        await page.getByTestId("flow-cancel").click();
        await page.getByTestId("pay-review").click();
        await page.getByTestId("pay-dialog").waitFor({ state: "visible" });
        await page.waitForTimeout(300);
        await shot(page, "demo-pay-review", false);
        await page.getByTestId("pay-confirm").click();
        await page.getByTestId("pay-done").waitFor({ state: "visible", timeout: 30_000 });
        await page.getByTestId("pay-close").click();
        await stack.facilitator.flush();
        for (let i = 0; i < 40; i++) {
          if (/settled on chain/i.test(await page.getByTestId("settlement-status").first().innerText().catch(() => ""))) break;
          const again = page.getByTestId("settlement-check").first();
          if (await again.isVisible().catch(() => false)) await again.click().catch(() => undefined);
          await page.waitForTimeout(500);
        }
        await page.waitForTimeout(300);
        await shot(page, "demo-paid", true);
        await page.goto(`http://127.0.0.1:${PORT_LIVE}/wallet`, { waitUntil: "networkidle" });
        await page.getByTestId("connect").click();
        await page.getByTestId("history-table").waitFor({ state: "visible", timeout: 20_000 });
        await page.waitForTimeout(300);
        await shot(page, "wallet-history", true);
        await page.goto(`http://127.0.0.1:${PORT_LIVE}/builder`, { waitUntil: "networkidle" });
        await page.getByTestId("connect").click();
        await page.getByTestId("tools-table").waitFor({ state: "visible", timeout: 20_000 });
        await page.waitForTimeout(300);
        await shot(page, "builder-tools", true);
        await page.goto(`http://127.0.0.1:${PORT_LIVE}/status`, { waitUntil: "networkidle" });
        await page.getByTestId("status-view").waitFor({ state: "visible", timeout: 20_000 });
        await page.waitForTimeout(300);
        await shot(page, "status", true);
        await page.goto(`http://127.0.0.1:${PORT_LIVE}/security`, { waitUntil: "networkidle" });
        await page.waitForTimeout(300);
        await shot(page, "security", true);
        await context.close();
      }
    }
    process.stderr.write(`web shots: written to ${out}\n`);
  } finally {
    await browser.close().catch(() => undefined);
    stop(empty);
    stop(live);
    await tools.close().catch(() => undefined);
    await stack.stop().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`web shots: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
