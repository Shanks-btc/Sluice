"use client";
// The floating navigation and the theme toggle. On a narrow screen the links fold into a native disclosure, which works without
// scripts and is reachable by keyboard.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { applyChoice, readChoice, resolveTheme, storeChoice, toggled } from "../lib/theme";
import type { Resolved } from "../lib/theme";
import { Wordmark } from "./brand";

export const NAV_LINKS = [
  { href: "/demo", label: "Demo" },
  { href: "/builder", label: "Builders" },
  { href: "/wallet", label: "Wallet" },
  { href: "/docs", label: "Docs" },
  { href: "/evidence", label: "Evidence" },
] as const;

function Sun() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function Moon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </svg>
  );
}

export function ThemeToggle() {
  const [showing, setShowing] = useState<Resolved>("light");

  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setShowing(resolveTheme(readChoice(window.localStorage), dark.matches));
    sync();
    dark.addEventListener("change", sync);
    return () => dark.removeEventListener("change", sync);
  }, []);

  const flip = () => {
    const next = toggled(showing);
    applyChoice(document.documentElement, next);
    storeChoice(window.localStorage, next);
    setShowing(next);
  };

  return (
    <button type="button" className="icon-btn" onClick={flip} aria-label={showing === "dark" ? "Switch to the light theme" : "Switch to the dark theme"} data-testid="theme-toggle" data-theme-showing={showing}>
      {showing === "dark" ? <Sun /> : <Moon />}
    </button>
  );
}

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="navwrap">
      <nav className="nav" aria-label="Main">
        <Link href="/" className="brand" aria-label="Sluice, home">
          <Wordmark />
        </Link>
        <ul className="nav-links">
          {NAV_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} aria-current={pathname === l.href || pathname.startsWith(`${l.href}/`) ? "page" : undefined}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <ThemeToggle />
        <details className="nav-menu">
          <summary aria-label="Menu">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </summary>
          <ul className="nav-panel">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} aria-current={pathname === l.href || pathname.startsWith(`${l.href}/`) ? "page" : undefined}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      </nav>
    </header>
  );
}
