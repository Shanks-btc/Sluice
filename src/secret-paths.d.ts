// The types of secret-paths.js, which says what it does.
import type { Dirent } from "node:fs";

export function isSecretName(name: string): boolean;
export function isSecretPath(path: string): boolean;
export function safeReaddir(dir: string): string[];
export function safeEntries(dir: string): Dirent[];
export function copyable(source: string): boolean;
