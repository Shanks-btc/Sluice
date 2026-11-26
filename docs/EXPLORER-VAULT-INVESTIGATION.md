# The vault on QIE's explorer

What was asked, on 2026-11-26: can anything on our side get AgentVault verified, or recognised as a contract, on QIE's explorer without help from the QIE team? Everything below was run from this repository's machine on that day. No transaction was sent on any chain and no key was used.

| | |
| --- | --- |
| Explorer | `https://mainnet.qie.digital`, a Blockscout instance, backend `v7.0.2` |
| Vault | `0xC8bfECBF9Dc5d18943b38873705DeeE9D13d751B` |
| Router | `0xf6F4C1Cc954B1798d134750438ada58768978716` |
| Deployment transaction | `0xd30777bca5c2e0d2538c52557ac4faba2665ab42c558ca343fe8d1b296143b33`, block 12119118 |
| Times | UTC, from this machine's clock. The explorer's own clock was about two minutes behind it: its `Date` header read 06:08:32 when this machine read 06:10:35. So the explorer's `verified_at` of 06:07:10 is the submission made here at 06:09:13. |

## Conclusion

**Fixed for verification and recognition. Not fixed for the creation record.**

- A standard JSON input sent to the explorer's `verifysourcecode` endpoint was accepted. The explorer now shows verified source for the vault, as a full match, and lists the address as a contract named `AgentVault`. Its answers are saved in [explorer/vault-record.json](explorer/vault-record.json).
- The explorer still holds no creator and no creation transaction for the vault. Nothing tried here changes that. It has indexed no internal transaction after block 8,819,845 (2026-07-07), which is QIE's to fix.
- Why an attempt on 2026-11-24 was answered with "The address is not a smart contract" is **not established**. That answer was reported and not reproduced here, and which route the attempt used is not recorded.
- This rests on one day's answers from the explorer. It is not a row of [EVIDENCE.md](EVIDENCE.md). The check that needs no explorer is still `pnpm live:vaultcheck`, which compares the vault's code with the compiled AgentVault by hash, with the six values the constructor wrote into it.

## 1. What the explorer's API answered before anything was submitted

Read between 06:06 and 06:07. All requests were `GET`.

| Request | Status | What it said |
| --- | --- | --- |
| `/api/v2/addresses/{vault}` | 200 | `is_contract: false`, `is_verified: false`, `creator_address_hash: null`, `creation_transaction_hash: null`, `has_logs: true` |
| `/api/v2/addresses/{router}` | 200 | `is_contract: true`, `is_verified: true`, `name: "PaymentRouter"`, creator `0x539e8616E5D1DD6C5b4F46055242eEF111209b70`, creation transaction the deployment's |
| `/api/v2/smart-contracts/{vault}` | 200 | The deployed bytecode (6,174 bytes) and `is_self_destructed`, `proxy_type`, `implementations` and two `has_custom_methods` flags. No `is_verified`, name or source. |
| `/api/v2/main-page/indexing-status` | 200 | `{"finished_indexing":false,"finished_indexing_blocks":false,"indexed_blocks_ratio":"0.98","indexed_internal_transactions_ratio":null}` |
| `/api/v2/config/backend-version` | 200 | `{"backend_version":"v7.0.2"}` |
| `/api/v2/config/backend`, `/api/v2/config/indexer`, `/api/v2/config/json-rpc-url` | 400 | `{"message":"Params 'module' and 'action' are required parameters","result":null,"status":"0"}` |
| `/api?module=contract&action=getcontractcreation&contractaddresses={vault},{router}` | 200 | One result, the router. The vault is left out. |
| `/api/v2/addresses/{router}/internal-transactions` | 200 | `{"items":[],"next_page_params":null}` |
| `/api/v2/addresses/{vault}/internal-transactions` | 200 | `{"items":[],"next_page_params":null}` |
| `/api/v2/transactions/{deployment}/internal-transactions` | 200 | `{"items":[],"next_page_params":null}`, although the deployment creates the vault by an internal `CREATE` |
| `/api?module=account&action=txlistinternal&txhash={deployment}` | 200 | `{"message":"No internal transactions found","result":[],"status":"0"}` |
| `/api/v2/internal-transactions` | 200 | Internal transactions exist. The newest is in block 8819845, 2026-07-07T14:34:15Z. |
| `/api/v2/addresses/{vault}/logs` and `/transactions` | 200 | Events and calls of the vault are indexed (blocks 12119317 to 12119321), while the same answers called the address not a contract |
| `/api?module=contract&action=getsourcecode&address={vault}` | 200 | `{"message":"OK","result":[{"Address":"0xc8bfecbf9dc5d18943b38873705deee9d13d751b"}],"status":"1"}` |
| `/api/v2/smart-contracts/verification/config` | 200 | Methods `multi-part`, `standard-input`, `flattened-code` and three for Vyper. No Sourcify method. Solidity `v0.8.24+commit.e11b9ed9` and the `shanghai` EVM are offered. |
| `/api/health` | 200 | `healthy: true` |

**Does the explorer index internal transactions at all?** It did once and does not now: the newest one it returns is from 2026-07-07, it returns none for the deployment, and its indexing status gives no ratio for them. The deployment's own trace, read from a public RPC with `debug_traceTransaction`, shows the creation it is missing:

```text
CREATE  (the deployment)                          -> 0xf6f4c1cc954b1798d134750438ada58768978716  (router)
  CREATE from 0xf6f4c1cc954b1798d134750438ada58768978716 -> 0xc8bfecbf9dc5d18943b38873705deee9d13d751b  (vault, 6174 bytes)
```

This explains the empty creator and creation transaction. It does **not** by itself explain why the address was not listed as a contract: five pairs that QIEDEX's factory created after block 8,819,845 (blocks 8999734 to 11969168) are listed as contracts. Five pairs created before it also have no creation transaction.

## 2. Routes tried for the vault

Source, compiler settings and constructor argument as in `artifacts/verification/` (solc v0.8.24+commit.e11b9ed9, optimizer on at 200 runs, shanghai). The routes were tried in this order from one-off scripts, and route 1 was then repeated. The router was not submitted.

| # | Time | Route | The explorer's answer | Effect |
| --- | --- | --- | --- | --- |
| 1 | 06:09:13 | `POST /api?module=contract&action=verifysourcecode`, `solidity-standard-json-input`, through this repository's `submitVerification` | 200 `{"message":"OK","result":"c8bfecbf9dc5d18943b38873705deee9d13d751b6b07cc8b","status":"1"}`, then `checkverifystatus`: `{"message":"OK","result":"Pass - Verified","status":"1"}` | **Accepted** |
| 2a | 06:09:20 | The same endpoint, `solidity-single-file` (flattened) | 200 `{"message":"Smart-contract already verified.","result":"Smart-contract already verified.","status":"0"}` | Refused as already done |
| 2b | 06:09:24 | `POST /api?module=contract&action=verify` (Blockscout's flattened route) | 200 `"message":"OK"`, with the flattened source in the result | **Replaced the stored source** with the flattened file: see below |
| 2c | 06:09:25 | `POST /api/v2/smart-contracts/{vault}/verification/via/flattened-code` | 200 `{"message":"Smart-contract verification started"}` | No separate effect observed |
| 3 | 06:09:27 | `POST /api?module=contract&action=verify_via_sourcify`, with the compiler's metadata and sources | 200 `{"message":"Unexpected response from Sourcify verify method","result":null,"status":"0"}` | Failed. Sourcify does not support this chain (section 3). |
| 1 again | 06:11:14 | Route 1 repeated | 200 with a new ticket, then `Pass - Verified` | **Restored the full match** |

The explorer's v2 `standard-input` and `multi-part` routes were not tried.

**A side effect, and its repair.** After routes 2b and 2c the explorer showed the vault as a *partial* match with one flattened file (`is_partially_verified: true`, no additional sources). Repeating route 1 brought back the full match with four files. No reading was taken between route 1 and route 2a, so what the explorer stored in those seconds is not recorded. **Do not send a flattened file for a contract the explorer already shows as a full match.**

### What the explorer shows now

Read at 06:11:46:

```json
{
  "address": { "is_contract": true, "is_verified": true, "name": "AgentVault", "creator_address_hash": null, "creation_transaction_hash": null },
  "smart_contract": { "is_verified": true, "is_fully_verified": true, "is_partially_verified": false, "is_changed_bytecode": false,
    "compiler_version": "v0.8.24+commit.e11b9ed9", "evm_version": "shanghai", "optimization_runs": 200,
    "file_path": "contracts/AgentVault.sol",
    "additional_sources": ["contracts/base/Eip712.sol", "contracts/interfaces/ISluiceErrors.sol", "contracts/libraries/SignatureLib.sol"],
    "creation_bytecode": null, "constructor_args": null }
}
```

- The four sources the explorer returned were, character for character, the four files in this repository's `contracts/` folder on that machine.
- The keccak256 of the bytecode the explorer returned is `0x96cddf2d6eb43d8845c4d435d2cbd34af60129cc850896e0851b43b094adb517`, the same hash `pnpm live:vaultcheck` computed on 2026-11-26 (11 passed, 0 failed).
- The explorer has no creation bytecode and no constructor arguments for the vault, so what it matched is the running code. A source match of running code does not show which values the constructor wrote into it. `pnpm live:vaultcheck` checks those.
- `getcontractcreation` still returns the router alone.
- The router's record was not changed: verified on 2026-11-23, and `contracts/AgentVault.sol` is among its files.

### Not done by any command yet

`pnpm live:verify` submits the router and nothing else. The vault of a **new** deployment would need route 1 again, which was done here from a one-off script that calls `submitVerification` from `src/verify-contracts.ts` with the vault's address and `vaultConstructorArguments(router)`. Whether the explorer would accept it for another vault is not known.

`pnpm compile` deletes the `.standard-input.json` files in `artifacts/verification/`. Run `pnpm live:verify --prepare-only` after any compile, just before the files are needed.

## 3. Sourcify

| Check | Result on 2026-11-26 |
| --- | --- |
| `https://chainid.network/chains.json` (2,909 chains) | **1990 is not listed.** 5656 is listed as "QIE Blockchain" with short name `QIE`. 1983, the id of QIE's testnet, is listed as "Krown Mainnet". |
| `https://sourcify.dev/server/chains` (467 chains) | 1990 is not listed, and neither is 1983 |
| `https://sourcify.dev/server/v2/contract/1990/{vault}` | 400 `{"customCode":"unsupported_chain","message":"Chain 1990 not found"}` |
| The old `check-all-by-addresses` path | 404, "API v1 is removed" |
| `rpc1mainnet` to `rpc5mainnet.qie.digital` | All five: `eth_chainId` `0x7c6`, `net_version` `1990`, the vault's 6,174 bytes from `eth_getCode`, `debug_traceTransaction` works, `trace_transaction` is not available |
| CreateX, Multicall3 and Safe's proxy factory 1.4.1 at their usual addresses | No code at any of the three |

Chain 1990 is not supported, so nothing was submitted to Sourcify. Two entries are prepared as local files and **have not been submitted**:

- [chain-registry/ethereum-lists/_data/chains/eip155-1990.json](chain-registry/ethereum-lists/_data/chains/eip155-1990.json)
- [chain-registry/sourcify-chains/chain-overrides.entry.json](chain-registry/sourcify-chains/chain-overrides.entry.json)

### Steps to open the two pull requests

QIE is not your network. Tell the QIE team before you list it, and say in each pull request that you are a user of the chain and not its operator.

**A. `ethereum-lists/chains`**

1. Check with QIE, or on their pages, that the name "QIE Mainnet", the website and the explorer address are right. `shortName` is `qie-mainnet` because `QIE` is taken by chain 5656, and the registry requires names and short names to be unlike any other entry's.
2. Fork `https://github.com/ethereum-lists/chains` and make a branch.
3. Copy `eip155-1990.json` to `_data/chains/eip155-1990.json`. No icon is included.
4. In the fork, run `npx prettier --write _data/*/*.json` and `./gradlew run` (it needs Java). Their README asks for both.
5. Open the pull request. Fix whatever their checks report.

**B. `sourcifyeth/sourcify-chains`** (their guide: `https://docs.sourcify.dev/docs/chain-support/`)

1. Wait for pull request A to be merged. Their guide asks for a chain to be in chainid.network.
2. Fork `https://github.com/sourcifyeth/sourcify-chains` and make a branch named exactly `add-chain-1990`.
3. Add the `"1990"` key of `chain-overrides.entry.json` to their `chain-overrides.json`. Do not also add it to `additional-chains.json`, and do not edit `sourcify-chains-default.json`.
4. Their test needs a known contract on the chain. None of the three it looks for exists on QIE, so their guide asks you to deploy their `Storage.sol` and add its address to `storage-contract-chain-addresses.json`. **That is a mainnet transaction that spends QIE.** It is your decision, and nothing here has done it.
5. Open the pull request and let their `Test New Chain` workflow run. To run it yourself you need Docker, Node 22 and two provider keys.
6. After the merge, their pipeline opens a second pull request that regenerates the chain list. When that is released, send `artifacts/verification/AgentVault.standard-input.json` to Sourcify for chain 1990.

Whether Sourcify would then accept the vault is not known. It finds a creation transaction through an explorer's API or traces, and this explorer holds none for the vault.

## 4. What to send to the QIE team

Nothing has been sent. One issue, ready to paste:

```text
Title: mainnet.qie.digital has indexed no internal transactions since block 8819845 (2026-07-07)

Explorer: https://mainnet.qie.digital, Blockscout v7.0.2. Checked 2026-11-26.

1. GET /api/v2/internal-transactions: the newest item is in block 8819845, 2026-07-07T14:34:15Z.
2. GET /api/v2/main-page/indexing-status:
   {"finished_indexing":false,"finished_indexing_blocks":false,"indexed_blocks_ratio":"0.98","indexed_internal_transactions_ratio":null}
3. Transaction 0xd30777bca5c2e0d2538c52557ac4faba2665ab42c558ca343fe8d1b296143b33 (block 12119118) creates two contracts.
   debug_traceTransaction on rpc1mainnet.qie.digital shows an internal CREATE of
   0xC8bfECBF9Dc5d18943b38873705DeeE9D13d751B (6174 bytes) by 0xf6F4C1Cc954B1798d134750438ada58768978716.
   GET /api/v2/transactions/<that hash>/internal-transactions returns {"items":[],"next_page_params":null}.
4. GET /api/v2/addresses/0xC8bf...751B has creator_address_hash and creation_transaction_hash null, and
   getcontractcreation omits the address. At 06:06 on 2026-11-26 it also said is_contract false, although
   eth_getCode returned its code. A source verification sent at 06:09 to the verifysourcecode endpoint was
   accepted, and it is listed as a contract since.

Please: restart or re-enable the internal transaction indexer and backfill from block 8819846, so that contracts
created by other contracts get their creator and creation transaction. Please also say whether a contract that is
only ever created internally is expected to show as an account until someone submits its source.
```
