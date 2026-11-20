// A dry run of a live script: what it would send, to whom, with what data, and what that would cost, without sending anything.
//
// It builds each transaction the script would build, prints where it goes, how much QIE it carries and what its call data decodes to,
// and asks the node what it would cost (`eth_estimateGas`, which runs the call on the node and discards the result). A step that cannot
// be estimated yet, because it depends on an earlier step having happened (a deposit before its approval), is given the gas measured on a
// fork and listed in docs/GAS.md, and says so. Nothing here calls a method that sends: the provider it is given is only asked to
// estimate gas, read the fee and read the network.
import { Contract, Interface, getAddress, hexlify, randomBytes, id } from "ethers";
import type { Provider } from "ethers";
import { MEASURED_GAS, SMOKE_STEPS_GAS } from "./gas-figures";
import { formatQie } from "./guard";
import { loadArtifact } from "./live";
import type { DeployParams, SmokeAmounts, SmokeParams } from "./live";

export type PlannedTx = {
  step: string;
  /** Where it goes; null is a contract creation. */
  to: string | null;
  /** QIE it carries, in wei. Every transaction of the live scripts carries none. */
  value: bigint;
  /** The call data, decoded: `approve(spender=0x…, amount=300000)`. */
  decoded: string;
  /** The call data's length in bytes. */
  dataBytes: number;
  /** The gas limit the script would give it: the node's estimate with a margin of a fifth, or the measured figure. */
  gasLimit: bigint;
  gasSource: "estimated by the node" | "measured on a fork (docs/GAS.md)";
  costWei: bigint;
};

export type DryRunReport = {
  script: string;
  from: string;
  chainId: number;
  gasPrice: bigint;
  txs: PlannedTx[];
  totalGas: bigint;
  totalCostWei: bigint;
};

const ERC20 = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);

/** Names an argument for printing: addresses and numbers as they are, long bytes shortened. */
function show(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    // A named tuple from the decoder is an array that also has names: print it by its names.
    try {
      const named = (value as unknown as { toObject?: () => Record<string, unknown> }).toObject?.();
      if (named) return `{${Object.entries(named).map(([k, v]) => `${k}=${show(v)}`).join(", ")}}`;
    } catch {
      // unnamed: print it as a list
    }
    return `[${value.map(show).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}=${show(v)}`).join(", ")}}`;
  const text = String(value);
  return text.length > 70 ? `${text.slice(0, 18)}…(${(text.length - 2) / 2} bytes)` : text;
}

/** `name(arg=value, …)` from call data the interface can decode. Throws if it cannot, which would mean the data is not what the step says. */
export function decodeCall(iface: Interface, data: string): string {
  const parsed = iface.parseTransaction({ data });
  if (!parsed) throw new Error("the call data does not decode");
  return `${parsed.name}(${parsed.fragment.inputs.map((input, i) => `${input.name}=${show(parsed.args[i])}`).join(", ")})`;
}

async function gasPriceOf(provider: Provider): Promise<bigint> {
  const price = (await provider.getFeeData()).gasPrice;
  if (price === null || price === undefined || price <= 0n) throw new Error("the node did not give a gas price");
  return price;
}

/** The gas limit for a step: what the node estimates (times 1.2, as the scripts do), or the measured figure when the node cannot yet. */
async function gasFor(provider: Provider, tx: { from: string; to?: string; data: string }, measured: bigint): Promise<Pick<PlannedTx, "gasLimit" | "gasSource">> {
  try {
    const estimate = await provider.estimateGas(tx);
    return { gasLimit: (estimate * 12n) / 10n, gasSource: "estimated by the node" };
  } catch {
    return { gasLimit: (measured * 12n) / 10n, gasSource: "measured on a fork (docs/GAS.md)" };
  }
}

function totals(script: string, from: string, chainId: number, gasPrice: bigint, txs: PlannedTx[]): DryRunReport {
  return { script, from, chainId, gasPrice, txs, totalGas: txs.reduce((a, t) => a + t.gasLimit, 0n), totalCostWei: txs.reduce((a, t) => a + t.costWei, 0n) };
}

export async function dryRunDeploy(provider: Provider, from: string, params: DeployParams): Promise<DryRunReport> {
  const { abi, bytecode } = loadArtifact("PaymentRouter");
  const iface = new Interface(abi as never);
  const args = iface.encodeDeploy([params.token, params.owner, params.feeRecipient, params.feeBps]);
  const data = `${bytecode}${args.slice(2)}`;
  const gasPrice = await gasPriceOf(provider);
  const chainId = Number((await provider.getNetwork()).chainId);
  const gas = await gasFor(provider, { from, data }, MEASURED_GAS.deployRouter);
  const tx: PlannedTx = {
    step: "deploy PaymentRouter (it creates its AgentVault)",
    to: null,
    value: 0n,
    decoded: `PaymentRouter(token=${getAddress(params.token)}, owner=${getAddress(params.owner)}, feeRecipient=${getAddress(params.feeRecipient)}, feeBps=${params.feeBps})`,
    dataBytes: (data.length - 2) / 2,
    ...gas,
    costWei: gas.gasLimit * gasPrice,
  };
  return totals("deploy", from, chainId, gasPrice, [tx]);
}

/** The eight transactions of the smoke run, built as the script builds them, with a placeholder where a signature goes. */
export async function dryRunSmoke(provider: Provider, from: string, params: SmokeParams, amounts: SmokeAmounts): Promise<DryRunReport> {
  const routerIface = new Interface(loadArtifact("PaymentRouter").abi as never);
  const vaultIface = new Interface(loadArtifact("AgentVault").abi as never);
  const gasPrice = await gasPriceOf(provider);
  const chainId = Number((await provider.getNetwork()).chainId);
  const payee = params.payee ?? from;
  const toolId = id("sluice-smoke");
  const router = getAddress(params.router);
  const placeholder = "0x" + "00".repeat(65);
  const agent = hexlify(randomBytes(20)); // a stand-in for the throwaway agent key the real run makes
  const intent = { payer: from, payee, amount: amounts.call, toolId, nonce: hexlify(randomBytes(32)), deadline: 2n ** 40n };

  // The vault and the token are read from the router, which the dry run can do because the router is deployed.
  const reader = new Contract(router, ["function vault() view returns (address)", "function token() view returns (address)"], provider);
  const vault = getAddress((await reader.getFunction("vault")()) as string);
  const token = getAddress((await reader.getFunction("token")()) as string);

  const steps: Array<{ step: string; to: string; iface: Interface; data: string }> = [
    { step: "approve", to: token, iface: ERC20, data: ERC20.encodeFunctionData("approve", [router, amounts.deposit]) },
    { step: "deposit", to: router, iface: routerIface, data: routerIface.encodeFunctionData("deposit", [amounts.deposit]) },
    { step: "settle (payer-signed)", to: router, iface: routerIface, data: routerIface.encodeFunctionData("settle", [intent, placeholder]) },
    { step: "authorize agent", to: vault, iface: vaultIface, data: vaultIface.encodeFunctionData("authorize", [{ agent, budget: amounts.agentBudget, perCallCap: amounts.agentCap, expiry: 2n ** 40n }, [{ payee, toolId }]]) },
    { step: "settle (agent-signed)", to: router, iface: routerIface, data: routerIface.encodeFunctionData("settle", [{ ...intent, amount: amounts.agentCall }, placeholder]) },
    { step: "revoke agent", to: vault, iface: vaultIface, data: vaultIface.encodeFunctionData("revoke", [agent]) },
    { step: "withdraw", to: router, iface: routerIface, data: routerIface.encodeFunctionData("withdraw", [amounts.call + amounts.agentCall, from]) },
    { step: "refund", to: router, iface: routerIface, data: routerIface.encodeFunctionData("refund", [amounts.deposit - amounts.call - amounts.agentCall, from]) },
  ];
  const txs: PlannedTx[] = [];
  for (const s of steps) {
    const measured = SMOKE_STEPS_GAS.find(([name]) => name === s.step)?.[1] ?? 0n;
    const gas = await gasFor(provider, { from, to: s.to, data: s.data }, measured);
    txs.push({ step: s.step, to: s.to, value: 0n, decoded: decodeCall(s.iface, s.data), dataBytes: (s.data.length - 2) / 2, ...gas, costWei: gas.gasLimit * gasPrice });
  }
  return totals("smoke", from, chainId, gasPrice, txs);
}

/** The lines to print for a dry run. `capWei` is the script's QIE cap, to say whether the plan fits inside it. */
export function formatDryRun(report: DryRunReport, capWei: bigint): string[] {
  const out = [
    `DRY RUN of ${report.script}: nothing is sent. From ${report.from} on chain ${report.chainId}, at a gas price of ${report.gasPrice} wei.`,
  ];
  report.txs.forEach((t, i) => {
    out.push(`${i + 1}. ${t.step}`);
    out.push(`   to:      ${t.to ?? "(creates a contract)"}`);
    out.push(`   value:   ${formatQie(t.value)} QIE`);
    out.push(`   call:    ${t.decoded}`);
    out.push(`   data:    ${t.dataBytes} bytes`);
    out.push(`   gas:     up to ${t.gasLimit} (${t.gasSource}); at most ${formatQie(t.costWei)} QIE`);
  });
  out.push(`total: up to ${report.totalGas} gas, at most ${formatQie(report.totalCostWei)} QIE. The cap is ${formatQie(capWei)} QIE: ${report.totalCostWei <= capWei ? "the plan fits" : "the plan DOES NOT fit"}.`);
  return out;
}

