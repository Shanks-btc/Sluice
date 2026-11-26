"use client";
// The builder's tools as the tool server declares them (names and prices as the builder configured them), who is paid for them, and a
// test button: one real paid call from the connected wallet, reviewed and signed like any other. Reading needs no wallet.
import { useEffect, useState } from "react";
import type { FlowDeps } from "../lib/flows";
import { readToolServer } from "../lib/paid-call";
import type { ToolServerRead } from "../lib/paid-call";
import type { ChainReader } from "../lib/reads";
import { shortAddress } from "../lib/format";
import { PaidCallPanel } from "./paid-call-panel";
import { useConfig } from "./providers";

export function BuilderTools({ reader, account, deps, viewing }: { reader: ChainReader; account: string | null; deps: FlowDeps | null; viewing: string | null }) {
  const config = useConfig();
  const [server, setServer] = useState<ToolServerRead | "loading" | "unconfigured">(config.toolsUrl ? "loading" : "unconfigured");

  useEffect(() => {
    if (!config.toolsUrl) return;
    let live = true;
    setServer("loading");
    void readToolServer(config.toolsUrl, { chainId: config.chainId, router: reader.routerAddress }).then((r) => {
      if (live) setServer(r);
    });
    return () => {
      live = false;
    };
  }, [config.toolsUrl, config.chainId, reader.routerAddress]);

  return (
    <div className="stack gap-lg" data-testid="builder-tools">
      <section className="stack" aria-labelledby="tools-title">
        <h2 id="tools-title" className="h-section">Registered tools and prices</h2>
        {server === "unconfigured" ? (
          <div className="empty" data-testid="tools-none">
            <h3>No tool server set</h3>
            <p>This site has no tool server address (<code>NEXT_PUBLIC_TOOLS_URL</code>), so there are no registered tools to list. The prices are the builder&apos;s own, set where the tool server runs.</p>
          </div>
        ) : server === "loading" ? (
          <p className="muted">Reading the tool server…</p>
        ) : !server.ok ? (
          <p className="banner banner-error" role="alert" data-testid="tools-list-error">{server.reason}</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table" data-testid="tools-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th className="right">Price (QUSDC)</th>
                  </tr>
                </thead>
                <tbody>
                  {server.info.tools.map((t) => (
                    <tr key={t.name}>
                      <td data-label="Tool" className="mono">{t.name}</td>
                      <td data-label="Price" className="right amount">{t.price}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" data-testid="tools-payee">
              Paid to <span className="address">{shortAddress(server.info.payee)}</span>. {viewing && viewing.toLowerCase() !== server.info.payee.toLowerCase() ? "That is not the address you are looking at, so these tools do not earn for it." : "The prices are the builder's, as the tool server states them."}
            </p>
          </>
        )}
      </section>
      <PaidCallPanel
        reader={reader}
        account={account}
        deps={deps}
        title="Test your tool"
        intro="Makes one real paid call from your connected wallet, so you see what a customer sees: the price, the review, the answer and the settlement. It is paid from your prepaid balance, to the address the tool server declares."
      />
    </div>
  );
}
