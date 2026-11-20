"use client";
// The simulated walkthrough. It runs in this page against messages from the spec's test vectors, with no chain and no funds, and says
// so on a banner that stays on screen. The steps advance by themselves unless the person has asked their system for reduced motion;
// then each press of the button shows the next step and nothing moves on its own.
import { useEffect, useMemo, useReducer, useState } from "react";
import { SIMULATION_BANNER, buildSimulation, initialPlayback, playbackReducer, refusalExamples } from "../lib/simulation";
import type { SimStep } from "../lib/simulation";

const STEP_MS = 1500;

export function SimulationBanner() {
  return (
    <p className="banner" role="status" data-testid="sim-banner">
      <span className="tag tag-warn">Simulated</span>
      <span>{SIMULATION_BANNER}</span>
    </p>
  );
}

function StepView({ step, index, current }: { step: SimStep; index: number; current: boolean }) {
  return (
    <li className={current ? "sim-step sim-current" : "sim-step"} data-testid={`sim-step-${step.id}`} aria-current={current ? "step" : undefined}>
      <div className="sim-head">
        <span className="step-dot">{index + 1}</span>
        <div>
          <p className="eye">{step.actor}</p>
          <h3>{step.title}</h3>
        </div>
      </div>
      <p className="muted">{step.explain}</p>
      <details open={current}>
        <summary className="sim-label mono">{step.label}</summary>
        <pre className="code" data-testid={`sim-body-${step.id}`}>{JSON.stringify(step.body, null, 2)}</pre>
      </details>
      {step.checks ? (
        <ul className="checks" data-testid="sim-checks">
          {step.checks.map((c) => (
            <li key={c.label} className={c.pass ? "check-pass" : "check-fail"}>
              <span className={c.pass ? "tag tag-success" : "tag tag-error"}>{c.pass ? "pass" : "refused"}</span>
              <span>
                <strong>{c.label}.</strong> {c.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function RefusalExamples() {
  const examples = useMemo(() => refusalExamples(), []);
  const [name, setName] = useState(examples[0]?.name ?? "");
  const chosen = examples.find((e) => e.name === name);
  return (
    <div className="card card-solid stack" data-testid="refusals">
      <h3>What a paid server refuses</h3>
      <p className="muted">
        The spec&apos;s refusal vectors, each run through the same check in this page. Pick one to see the code a server returns.
      </p>
      <div className="field">
        <label htmlFor="refusal">A payment that is wrong because…</label>
        <select id="refusal" value={name} onChange={(e) => setName(e.target.value)}>
          {examples.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
      {chosen ? (
        <p data-testid="refusal-result">
          <span className="tag tag-error">refused</span> <code>{chosen.got}</code> {chosen.match ? <span className="muted">(the code the spec gives for this case)</span> : <span className="field-error-text">(not the code the spec gives)</span>}
        </p>
      ) : null}
    </div>
  );
}

export function SimulationPlayer() {
  const steps = useMemo(() => buildSimulation(), []);
  const [state, dispatch] = useReducer((s: typeof initialPlayback, a: Parameters<typeof playbackReducer>[1]) => playbackReducer(s, a, steps.length), initialPlayback);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!state.playing || reduced) return;
    const timer = setTimeout(() => dispatch({ type: "tick" }), STEP_MS);
    return () => clearTimeout(timer);
  }, [state, reduced]);

  const finished = state.index >= steps.length - 1;
  const shown = steps.slice(0, state.index + 1);

  const advance = () => {
    if (reduced) dispatch(finished ? { type: "reset" } : { type: "play" });
    else dispatch({ type: "play" });
  };
  // With reduced motion, "play" must show exactly one step and stop.
  useEffect(() => {
    if (reduced && state.playing) dispatch({ type: "pause" });
  }, [reduced, state.playing]);

  return (
    <div className="stack gap-lg" data-testid="simulation">
      <SimulationBanner />
      <div className="row">
        <button type="button" className="btn btn-dark" onClick={advance} disabled={!reduced && state.playing} data-testid="sim-run">
          {state.index < 0 ? (reduced ? "Show step one" : "Run the walkthrough") : finished ? "Run it again" : reduced ? "Next step" : state.playing ? "Running…" : "Continue"}
        </button>
        <button type="button" className="btn btn-soft" onClick={() => dispatch({ type: "finish" })} disabled={finished} data-testid="sim-all">
          Show every step
        </button>
        <button type="button" className="btn btn-soft" onClick={() => dispatch({ type: "reset" })} disabled={state.index < 0} data-testid="sim-reset">
          Reset
        </button>
        <span className="muted" aria-live="polite" data-testid="sim-progress">
          {state.index < 0 ? "Not started" : `Step ${state.index + 1} of ${steps.length}`}
        </span>
      </div>
      {shown.length > 0 ? (
        <ol className="sim-steps">
          {shown.map((s, i) => (
            <StepView key={s.id} step={s} index={i} current={i === state.index} />
          ))}
        </ol>
      ) : (
        <div className="empty">
          <h3>Nothing has run yet</h3>
          <p>The walkthrough shows one paid call from the request to the batch that settles it, using the messages in the spec.</p>
        </div>
      )}
      {finished ? (
        <p className="banner banner-info" data-testid="sim-done">
          Simulated run complete. No transaction was sent, because the settlement above is a simulation. A real run would show a transaction on the explorer.
        </p>
      ) : null}
    </div>
  );
}
