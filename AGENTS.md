# AGENTS.md

Sluice is pay-per-use for AI tools and APIs on QIE, settled in QUSDC. It is a new project for QIE Hackathon 3.0, written from scratch. Nothing in this repository is copied from another project.

## Working rules

These rules apply to every session and every slice. Follow them exactly.

1. **Do not stop to ask questions.** When a choice has to be made, pick the most secure option, implement it, and list it under "Decisions I made" in the report, with one line of reasoning.
2. **Stop only for these four things:** an irreversible action; any mainnet or testnet transaction; spending of any kind (QUSDC, QIE, or money); deleting files outside the slice.
3. **Never print secrets.** No private key, seed phrase, API key or token in output, logs, test names, docs or commit text. Only variable names go in `.env.example`.
4. **Never run `git add`, `git commit` or `git push`.** The founder does all git.
5. **Never claim anything the code, the tests or the chain data do not prove.** If it is not proven, write "unknown" or "Coming soon".
6. **Banned words in all user-facing text:** "first", "only", "unique" (as claims), "yield", "APY", "interest", and any compliance claim. Also avoid "audited", "guaranteed", "risk-free" and "trustless": nothing here proves them.
7. **A status of "Live" needs evidence.** `docs/EVIDENCE.md` must hold a verified mainnet row for it, and `pnpm evidence:check` must pass.
8. **No transaction leaves this machine from a test.** Tests use a local fork or a local chain with impersonated or random accounts. Scripts that touch mainnet or testnet refuse to run without an approval variable and a spend cap, and are never run by an agent.
9. **Write all code fresh.** Do not import or copy code from Veylo or from any other project. Libraries come from the package registry, pinned to exact versions.
10. **Honest AI disclosure.** Claude Code (Anthropic) wrote and tested this code with the founder. Say so wherever authorship is described.

## Decisions I made

Every slice report lists its decisions here in the same format, and `DECISIONS.md` keeps the running record.

## Fixed facts about QIE (measured, pinned in tests where possible)

- Mainnet chain ID 1990, RPC `https://rpc1mainnet.qie.digital/`, explorer `https://mainnet.qie.digital/`.
- QUSDC `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5`, 6 decimals. It has no `permit` and no EIP-3009, so deposits use `approve` plus `transferFrom`.
- EVM is Shanghai at most: compile with `evmVersion: shanghai`, solc 0.8.24. No `MCOPY`, `TSTORE` or `BLOBBASEFEE`.
- No Multicall3, no CREATE2 deployer, no ERC-4337 EntryPoint and no Permit2 on QIE mainnet.
- A QUSDC transfer costs about 35K to 52K gas.
- QUSDC's admin key can grant a role that burns any holder's balance. `docs/RISKS.md` says so, and the contracts let a user withdraw everything at any time.
