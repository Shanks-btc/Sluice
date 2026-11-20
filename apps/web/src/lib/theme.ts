// The theme choice: light, dark, or follow the system. The choice is kept in this browser (localStorage) and applied by
// public/theme-init.js before the page paints, so there is no flash. Storage can be missing or blocked, so every access is guarded.
export type ThemeChoice = "light" | "dark" | "system";
export type Resolved = "light" | "dark";

export const THEME_KEY = "sluice-theme";

export const isChoice = (v: unknown): v is ThemeChoice => v === "light" || v === "dark" || v === "system";

export const resolveTheme = (choice: ThemeChoice, systemDark: boolean): Resolved => (choice === "system" ? (systemDark ? "dark" : "light") : choice);

/** What the toggle does: from the theme showing now to its opposite, as an explicit choice. */
export const toggled = (showing: Resolved): Resolved => (showing === "dark" ? "light" : "dark");

export type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export function readChoice(storage: StorageLike | undefined): ThemeChoice {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isChoice(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function storeChoice(storage: StorageLike | undefined, choice: ThemeChoice): boolean {
  try {
    storage?.setItem(THEME_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

export type RootLike = { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };

/** "system" leaves the attribute off so the media query decides; light and dark set it. */
export function applyChoice(root: RootLike, choice: ThemeChoice): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}
