// Names that mean a file or a folder may hold a secret, or the founder's own record of a deployment. A walk over the repository skips them by
// their path, before anything is opened, and a test run refuses to open them (test/helpers/secret-guard.js).
//
// This is plain JavaScript because the guard of a test run loads it into every program the tests start, before TypeScript is set up there.
"use strict";

const { readdirSync } = require("node:fs");
const { basename } = require("node:path");

/** True for the name of one file or folder: *.key, .env, .env.* (but not .env.example), deployment.json and .local-mainnet, in any case. */
function isSecretName(name) {
  const n = String(name).toLowerCase();
  if (n === ".env.example") return false;
  return n.endsWith(".key") || n === ".env" || n.startsWith(".env.") || n === "deployment.json" || n === ".local-mainnet";
}

/** True when any part of the path is such a name, so that everything inside .local-mainnet is covered with it. */
function isSecretPath(path) {
  return String(path).split(/[\\/]+/).some(isSecretName);
}

/** The names in a folder, without the secret ones, and nothing at all from a secret folder. A walk reads folders through this. */
function safeReaddir(dir) {
  return isSecretName(basename(String(dir))) ? [] : readdirSync(dir).filter((name) => !isSecretName(name));
}

/** The same with each entry's type, for a walk that asks which entries are folders. */
function safeEntries(dir) {
  return isSecretName(basename(String(dir))) ? [] : readdirSync(dir, { withFileTypes: true }).filter((entry) => !isSecretName(entry.name));
}

/** The filter of a recursive copy (fs.cpSync): a secret entry is passed over, so it is never read. */
function copyable(source) {
  return !isSecretName(basename(String(source)));
}

module.exports = { isSecretName, isSecretPath, safeReaddir, safeEntries, copyable };
