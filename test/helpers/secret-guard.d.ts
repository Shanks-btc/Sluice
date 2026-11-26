// The types of secret-guard.js, which says what it does.
export type Refusal = { operation: string; path: string; pid: number };

export const LOG_ENV: string;
export function install(): void;
export function installed(): boolean;
export function violations(): Refusal[];
export function probe<T>(run: () => T): { result: T | undefined; error: (Error & { code?: string }) | undefined; refused: Refusal[] };
