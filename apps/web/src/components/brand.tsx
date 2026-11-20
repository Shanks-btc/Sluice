// The Sluice wordmark and mark, drawn for this project: a channel that steps down in three levels, with a gate across the middle step.
// The same drawing is saved as public/brand/mark.svg and public/brand/wordmark.svg, and src/app/icon.svg is the favicon.
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 9h9v7h8v7h9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 4v17" className="brand-gate" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ label = true }: { label?: boolean }) {
  return (
    <span className="wordmark">
      <Mark />
      {label ? <span className="wordmark-text">Sluice</span> : null}
    </span>
  );
}
