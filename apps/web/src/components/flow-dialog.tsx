"use client";
// The review step. It shows exactly what the wallet will be asked to approve, in words, and waits. Nothing is sent to the wallet until
// the person presses Confirm: the FlowSession refuses to send from any state but "confirmed", and the Confirm button is the only
// thing that confirms. Retrying a failed flow comes back to this review step: it never submits by itself.
//
// States the person sees: review (nothing sent), waiting for the wallet, sent and waiting for the network to confirm, confirmed, and
// not completed, with what happened, what to do and whether any money moved (src/lib/errors.ts).
import { useEffect, useRef, useState } from "react";
import { FlowSession } from "../lib/flows";
import type { FlowProgress, FlowResult, Plan } from "../lib/flows";
import { costLine, explain, explainLine } from "../lib/errors";
import type { Explained } from "../lib/errors";
import { explorerTxUrl, networkFor } from "../lib/networks";
import { shortHash } from "../lib/format";
import { useConfig } from "./providers";

type Phase = "review" | "sending" | "done" | "failed";

/** One sentence for a failure: what happened and what to do. The dialog itself shows the three parts. */
export function describeFlowError(err: unknown): string {
  return explainLine(err);
}

const WAITING: Record<FlowProgress["stage"], string> = {
  wallet: "Waiting for your wallet. Open it and answer the request.",
  network: "Sent. Waiting for the network to confirm it.",
  facilitator: "Waiting for the facilitator to send it.",
};

export function FlowDialog({
  session,
  onClose,
  onFinished,
  onRetry,
}: {
  session: FlowSession | null;
  onClose: () => void;
  onFinished?: (result: FlowResult) => void;
  /** Called with the plan when the person asks to try again. The parent opens a new review for it; nothing is sent from here. */
  onRetry?: (plan: Plan) => void;
}) {
  const config = useConfig();
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>("review");
  const [result, setResult] = useState<FlowResult | null>(null);
  const [failure, setFailure] = useState<Explained | null>(null);
  const [progress, setProgress] = useState<FlowProgress | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (session) {
      // A new session (including one opened for a retry while the dialog stays open) starts again at the review.
      setPhase("review");
      setResult(null);
      setFailure(null);
      setProgress(null);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [session]);

  if (!session) return <dialog ref={ref} className="modal" aria-label="Review" />;

  const cancel = () => {
    session.cancel();
    onClose();
  };

  const confirm = async () => {
    // The first press leaves "planned" at once, so a second press (a double click, a slow tap) cannot start a second send.
    try {
      session.confirm();
    } catch {
      return;
    }
    session.watch(setProgress);
    setPhase("sending");
    setProgress({ stage: session.plan.route === "facilitator" ? "facilitator" : "wallet" });
    try {
      const outcome = await session.send();
      setResult(outcome);
      setPhase("done");
      onFinished?.(outcome);
    } catch (err) {
      setFailure(explain(err));
      setPhase("failed");
    }
  };

  const { plan } = session;
  const network = networkFor(config.chainId, config.rpcUrl);
  const retry = failure && (failure.retry === "now" || failure.retry === "later") && onRetry;
  return (
    <dialog ref={ref} className="modal" aria-labelledby="flow-title" onCancel={(e) => { e.preventDefault(); if (phase !== "sending") cancel(); }} data-testid="flow-dialog">
      <div className="modal-body">
        <p className="eye">{phase === "review" ? "Review before your wallet opens" : phase === "sending" ? "Pending" : phase === "done" ? "Confirmed" : "Not completed"}</p>
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
            {plan.gas ? (
              <p className="muted" data-testid="flow-cost">
                {costLine(plan.gas.units, plan.gas.priceWei, true)}
              </p>
            ) : plan.route === "facilitator" ? (
              <p className="muted" data-testid="flow-cost">
                You pay no network fee on this route.
              </p>
            ) : null}
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
            {phase === "sending" && progress ? (
              <p className="banner banner-info" role="status" data-testid="flow-pending">
                {WAITING[progress.stage]}
                {progress.stage === "network" ? (
                  <>
                    {" "}
                    {explorerTxUrl(progress.hash, network) ? (
                      <a className="link" href={explorerTxUrl(progress.hash, network)} rel="noopener noreferrer" target="_blank">
                        {shortHash(progress.hash)}
                      </a>
                    ) : (
                      <span className="mono">{shortHash(progress.hash)}</span>
                    )}
                  </>
                ) : null}
              </p>
            ) : (
              <p className="muted">Nothing is sent until you press Confirm.</p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-soft" onClick={cancel} disabled={phase === "sending"} data-testid="flow-cancel">
                Cancel
              </button>
              <button type="button" className="btn btn-dark" onClick={() => void confirm()} disabled={phase === "sending"} data-testid="flow-confirm">
                {phase === "sending" ? "Working…" : plan.route === "facilitator" ? "Confirm and sign in wallet" : "Confirm and open wallet"}
              </button>
            </div>
          </>
        ) : null}
        {phase === "done" && result ? (
          <div className="stack" data-testid="flow-done">
            <p>
              <span className="tag tag-success">Confirmed</span> {result.via === "facilitator" ? "Sent by the facilitator." : "Sent from your wallet."} The transaction{result.transactions.length === 1 ? "" : "s"} below {result.transactions.length === 1 ? "is" : "are"} on {network.label}.
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
        {phase === "failed" && failure ? (
          <div className="stack" data-testid="flow-failed">
            <p className="banner banner-error" role="alert">
              <strong data-testid="flow-failed-headline">{failure.headline}</strong> <span data-testid="flow-failed-advice">{failure.advice}</span>
            </p>
            <p className="muted" data-testid="flow-failed-funds">
              {failure.funds}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-soft" onClick={onClose} data-testid="flow-close">
                Close
              </button>
              {retry ? (
                <button
                  type="button"
                  className="btn btn-dark"
                  onClick={() => {
                    onClose();
                    onRetry?.(plan);
                  }}
                  data-testid="flow-retry"
                >
                  Review and try again
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
