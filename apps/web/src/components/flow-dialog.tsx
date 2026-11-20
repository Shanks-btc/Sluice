"use client";
// The review step. It shows exactly what the wallet will be asked to approve, in words, and waits. Nothing is sent to the wallet until
// the person presses Confirm: the FlowSession refuses to send from any state but "confirmed", and the Confirm button is the only
// thing that confirms.
import { useEffect, useRef, useState } from "react";
import { FlowSession } from "../lib/flows";
import type { FlowResult } from "../lib/flows";
import { WalletError } from "../lib/eip1193";
import { explorerTxUrl, networkFor } from "../lib/networks";
import { shortHash } from "../lib/format";
import { useConfig } from "./providers";

type Phase = "review" | "sending" | "done" | "failed";

export function describeFlowError(err: unknown): string {
  if (err instanceof WalletError) return err.message;
  return "Something went wrong and nothing further was sent. Check your wallet and the explorer before trying again.";
}

export function FlowDialog({ session, onClose, onFinished }: { session: FlowSession | null; onClose: () => void; onFinished?: (result: FlowResult) => void }) {
  const config = useConfig();
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>("review");
  const [result, setResult] = useState<FlowResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (session && !dialog.open) {
      setPhase("review");
      setResult(null);
      setMessage(null);
      dialog.showModal();
    }
    if (!session && dialog.open) dialog.close();
  }, [session]);

  if (!session) return <dialog ref={ref} className="modal" aria-label="Review" />;

  const cancel = () => {
    session.cancel();
    onClose();
  };

  const confirm = async () => {
    try {
      session.confirm();
    } catch {
      return;
    }
    setPhase("sending");
    try {
      const outcome = await session.send();
      setResult(outcome);
      setPhase("done");
      onFinished?.(outcome);
    } catch (err) {
      setMessage(describeFlowError(err));
      setPhase("failed");
    }
  };

  const { plan } = session;
  const network = networkFor(config.chainId, config.rpcUrl);
  return (
    <dialog ref={ref} className="modal" aria-labelledby="flow-title" onCancel={(e) => { e.preventDefault(); if (phase !== "sending") cancel(); }} data-testid="flow-dialog">
      <div className="modal-body">
        <p className="eye">{phase === "review" ? "Review before your wallet opens" : phase === "sending" ? "Waiting" : phase === "done" ? "Done" : "Not completed"}</p>
        <h2 id="flow-title">{plan.title}</h2>
        {phase === "review" || phase === "sending" ? (
          <>
            <p>{plan.summary}</p>
            <dl className="kv" data-testid="flow-fields">
              {plan.fields.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            <ol className="steps">
              {plan.steps.map((s, i) => (
                <li key={s}>
                  <span className="step-dot">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
            {plan.warnings.map((w) => (
              <p key={w} className="banner banner-info">
                {w}
              </p>
            ))}
            <p className="muted">Nothing is sent until you press Confirm.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-soft" onClick={cancel} disabled={phase === "sending"} data-testid="flow-cancel">
                Cancel
              </button>
              <button type="button" className="btn btn-dark" onClick={() => void confirm()} disabled={phase === "sending"} data-testid="flow-confirm">
                {phase === "sending" ? "Waiting for your wallet…" : plan.route === "facilitator" ? "Confirm and sign in wallet" : "Confirm and open wallet"}
              </button>
            </div>
          </>
        ) : null}
        {phase === "done" && result ? (
          <div className="stack" data-testid="flow-done">
            <p>
              {result.via === "facilitator" ? "Sent by the facilitator." : "Sent from your wallet."} The transaction{result.transactions.length === 1 ? "" : "s"} below {result.transactions.length === 1 ? "is" : "are"} on {network.label}.
            </p>
            <ul className="stack">
              {result.transactions.map((hash) => {
                const url = explorerTxUrl(hash, network);
                return (
                  <li key={hash} className="mono">
                    {url ? (
                      <a className="link" href={url} rel="noopener noreferrer" target="_blank">
                        {shortHash(hash)}
                      </a>
                    ) : (
                      shortHash(hash)
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="modal-actions">
              <button type="button" className="btn btn-dark" onClick={onClose} data-testid="flow-close">
                Close
              </button>
            </div>
          </div>
        ) : null}
        {phase === "failed" ? (
          <div className="stack" data-testid="flow-failed">
            <p className="banner banner-error" role="alert">
              {message}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-dark" onClick={onClose} data-testid="flow-close">
                Close
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
