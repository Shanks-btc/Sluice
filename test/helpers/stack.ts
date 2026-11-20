// A whole Sluice stack on the local Hardhat chain: the contracts, the chain served over real HTTP JSON-RPC, and a
// running facilitator. Used by the package tests and the end-to-end tests. Everything is local: the keys are
// generated here and never printed, and nothing leaves this machine.
import { JsonRpcProvider, Network, Wallet, hexlify, parseEther, randomBytes } from "ethers";
import { network } from "hardhat";
import { JsonRpcServer } from "hardhat/internal/hardhat-network/jsonrpc/server";
import { Facilitator, createServer, listen } from "@sluice/facilitator";
import type { Caps } from "@sluice/facilitator";
import { deploy } from "./index";
import type { World } from "./index";
import { deployOnFork } from "./fork";

/** A key generated for this test run only. */
export const throwawayWallet = (): Wallet => new Wallet(hexlify(randomBytes(32)));

export async function setQie(address: string, wei: bigint): Promise<void> {
  await network.provider.send("hardhat_setBalance", [address, `0x${wei.toString(16)}`]);
}

/** Serves the in-process Hardhat network over HTTP, so child processes and plain fetch can reach it. */
export async function startRpc(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new JsonRpcServer({ hostname: "127.0.0.1", port: 0, provider: network.provider });
  const { port } = await server.listen();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export function rpcProvider(url: string): JsonRpcProvider {
  const net = Network.from(1990);
  // cacheTimeout -1: ethers otherwise caches a wallet's pending nonce for 250 ms, so two quick sends could reuse one.
  const provider = new JsonRpcProvider(url, net, { staticNetwork: net, cacheTimeout: -1 });
  provider.pollingInterval = 50; // ethers 6.8.1 reads this as a property; the default of 4 seconds would slow every wait
  return provider;
}

/**
 * Unix seconds on the chain's clock. Other tests move Hardhat's clock forward, so the wall clock can be behind
 * it. This mines one block, reads its time, and returns a clock that keeps that offset from the wall clock.
 */
export async function chainClock(): Promise<() => number> {
  await network.provider.send("evm_mine", []);
  const block = (await network.provider.send("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
  const offset = Number(BigInt(block.timestamp)) - Math.floor(Date.now() / 1000);
  return () => Math.floor(Date.now() / 1000) + offset;
}

/**
 * Resets the in-process Hardhat chain to a fresh one whose clock is the wall clock. Other test files move the shared chain's clock
 * forward (time.increase) and it never goes back, which is harmless for code that takes its clock from the chain, but a program
 * started as a separate process reads the wall clock and would see every deadline as long past. Local chain only: not for forks.
 */
export async function freshChain(): Promise<void> {
  await network.provider.send("hardhat_reset", []);
  // A reset chain's clock starts from when Hardhat loaded its configuration, which can be minutes behind the wall clock in a long
  // run. Move it to the wall clock; later blocks then keep pace with it.
  const wall = Math.floor(Date.now() / 1000) + 1;
  const block = (await network.provider.send("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
  if (Number(BigInt(block.timestamp)) < wall) await network.provider.send("evm_setNextBlockTimestamp", [wall]);
  await network.provider.send("evm_mine", []);
}

export type Stack = World & {
  rpcUrl: string;
  provider: JsonRpcProvider;
  facilitator: Facilitator;
  facilitatorUrl: string;
  relayerAddress: string;
  clock: () => number;
  stop: () => Promise<void>;
};

/** `fork: true` deploys the router against the real QUSDC on the mainnet fork (pnpm test:fork) instead of a test token. */
export async function startStack(options: { feeBps?: number; caps?: Partial<Caps>; relayerQie?: bigint; fork?: boolean; corsOrigins?: string[] } = {}): Promise<Stack> {
  const world = options.fork ? await deployOnFork(options.feeBps ?? 100) : await deploy({ feeBps: options.feeBps ?? 100 });
  const rpc = await startRpc();
  const provider = rpcProvider(rpc.url);
  const relayerKey = hexlify(randomBytes(32));
  const relayerAddress = new Wallet(relayerKey).address;
  await setQie(relayerAddress, options.relayerQie ?? parseEther("1"));
  const clock = await chainClock();
  const facilitator = await Facilitator.create({
    provider,
    router: world.routerAddress,
    relayerKey,
    caps: options.caps,
    now: clock,
  });
  const server = createServer(facilitator, { origins: options.corsOrigins });
  const port = await listen(server, 0);
  const stop = async () => {
    facilitator.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    provider.destroy();
    await rpc.close();
  };
  return { ...world, rpcUrl: rpc.url, provider, facilitator, facilitatorUrl: `http://127.0.0.1:${port}`, relayerAddress, clock, stop };
}

/** Gives a throwaway wallet QUSDC in its wallet (not yet deposited) and, optionally, some QIE. */
export async function fundWallet(stack: Stack, wallet: Wallet, qusdc: bigint, qie = 0n): Promise<void> {
  await stack.mint(wallet.address, qusdc);
  if (qie > 0n) await setQie(wallet.address, qie);
}

/** Approves and deposits for a throwaway wallet that has QIE for gas. */
export async function depositFor(stack: Stack, wallet: Wallet, amount: bigint): Promise<void> {
  const connected = wallet.connect(stack.provider);
  const token = stack.token.connect(connected) as unknown as { approve: (s: string, a: bigint) => Promise<{ wait: () => Promise<unknown> }> };
  await (await token.approve(stack.routerAddress, amount)).wait();
  const router = stack.router.connect(connected) as unknown as { deposit: (a: bigint) => Promise<{ wait: () => Promise<unknown> }> };
  await (await router.deposit(amount)).wait();
}
