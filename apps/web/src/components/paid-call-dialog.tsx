"use client";
// The review step for a paid call. It shows the decoded payment the wallet will be asked to sign (price, payee, router, token, deadline,
// nonce), and waits. The wallet is not asked for anything until the person presses Confirm: PaidCallSession refuses to send from any state
// but "confirmed". A failed call can be retried only by coming back to this review, so nothing is signed twice by accident.
import { useEffect, useRef, useState } from "react";
import { PaidCallSession } from "../lib/paid-call";
import type { PaidCallPlan, PaidCallResult } from "../lib/paid-call";
import { explain } from "../lib/errors";
import type { Explained } from "../lib/errors";

type Phase = "review" | "sending" | "done" | "failed";

export function PaidCallDialog({
  session,
  onClose,
  onPaid,
  onRetry,
}: {
  session: PaidCallSession | null;
  onClose: () => void;
  onPaid?: (result: PaidCallResult, plan: PaidCallPlan) => void;
  onRetry?: (plan: PaidCallPlan) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>("review");
  const [failure, setFailure] = useState<Explained | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (session) {
      setPhase("review");
      setFailure(null);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [session]);

  if (!session) return <dialog ref={ref} className="modal" aria-label="Review payment" />;

  const cancel = () => {
    session.cancel();
    onClose();
  };

  const confirm = async () => {
    try {
      session.confirm();
    } catch {
      return; // a second press: the first one has already confirmed
    }
    setPhase("sending");
    try {
      const result = await session.send();
      setPhase("done");
      onPaid?.(result, session.plan);
    } catch (err) {
      setFailure(explain(err));
      setPhase("failed");
    }
  };

  const { plan } = session;
  const retry = failure && (failure.retry === "now" || failure.retry === "later" || failure.retry === "change") && onRetry;
  return (
    <dialog ref={ref} className="modal" aria-labelledby="pay-title" onCancel={(e) => { e.preventDefault(); if (phase !== "sending") cancel(); }} data-testid="pay-dialog">
      <div className="modal-body">
        <p className="eye">{phase === "review" ? "Review before your wallet opens" : phase === "sending" ? "Pending" : phase === "done" ? "Paid" : "Not completed"}</p>
        <h2 id="pay-title">{plan.title}</h2>
        {phase === "review" || phase === "sending" ? (
          <>
            <p>{plan.summary}</p>
            <dl className="kv" data-testid="pay-fields">
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
            {phase === "sending" ? (
              <p className="banner banner-info" role="status" data-testid="pay-pending">
                Waiting for your wallet to sign, then for the tool server to accept the payment. Do not close this window.
              </p>
            ) : (
              <p className="muted">Nothing is signed until you press Confirm.</p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-soft" onClick={cancel} disabled={phase === "sending"} data-testid="pay-cancel">
                Cancel
              </button>
              <button type="button" className="btn btn-dark" onClick={() => void confirm()} disabled={phase === "sending"} data-testid="pay-confirm">
                {phase === "sending" ? "Working…" : "Confirm and sign in wallet"}
              </button>
            </div>
          </>
        ) : null}
        {phase === "done" ? (
          <div className="stack" data-testid="pay-done">
            <p>
              <span className="tag tag-success">Paid</span> The tool server accepted the payment and ran the tool. The answer and the settlement are on the page behind this window.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-dark" onClick={onClose} data-testid="pay-close">
                Close
              </button>
            </div>
          </div>
        ) : null}
        {phase === "failed" && failure ? (
          <div className="stack" data-testid="pay-failed">
            <p className="banner banner-error" role="alert">
              <strong data-testid="pay-failed-headline">{failure.headline}</strong> <span data-testid="pay-failed-advice">{failure.advice}</span>
            </p>
            <p className="muted" data-testid="pay-failed-funds">
              {failure.funds}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-soft" onClick={onClose} data-testid="pay-close">
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
                  data-testid="pay-retry"
                >
                  Ask for the price and review again
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
