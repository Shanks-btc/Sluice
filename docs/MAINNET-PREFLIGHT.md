# Mainnet pre-flight, read-only

What read-only calls to QIE mainnet returned on **2026-11-22**, before anything is deployed or funded. The last section, about the vault's code, was read on **2026-11-24**, after the router was deployed. Nothing was sent: the calls were `eth_chainId`, `eth_blockNumber`, `eth_gasPrice`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getBlockByNumber` and `eth_call` (which asks the node to run a call on its copy of the state and throw the result away). No key signed anything. Each result below is what the command printed, and nothing here claims more than that. The chain moves, so none of it is a promise about the day the founder runs the steps: run the commands again then.

The commands, from the repository root:

```powershell
$env:SLUICE_NETWORK = "mainnet"
```

```powershell
pnpm live:preflight --deployer 0x539e8616E5D1DD6C5b4F46055242eEF111209b70 --relayer 0x0A021bC732325C57E0cC838E4111A861b84fFEB1
```

```powershell
pnpm live:facts
```

```powershell
pnpm live:funding --deployer 0x539e8616E5D1DD6C5b4F46055242eEF111209b70 --relayer 0x0A021bC732325C57E0cC838E4111A861b84fFEB1
```

## The two addresses

Two new keys were made for the mainnet run, with `pnpm live:new-key`: a deployer's and a relayer's. They are in `deployer-mainnet.key` and `relayer-mainnet.key` in the repository root, which `.gitignore` covers (`git check-ignore` named the `*.key` rule for both). Neither key was printed or used, and neither address holds anything yet. The testnet keys were not reused.

| Role | Address |
| --- | --- |
| Deployer | `0x539e8616E5D1DD6C5b4F46055242eEF111209b70` |
| Relayer | `0x0A021bC732325C57E0cC838E4111A861b84fFEB1` |

## The pre-flight check

Run at 2026-11-22T07:18:23Z. The endpoint chosen was `rpc1mainnet.qie.digital` (chain 1990, 1083 ms), with four fallbacks. The check stopped with `NO-GO`, for the one reason the state at that moment gives: the two addresses hold nothing. Every check about the chain and the token passed.

```text
PASS RPC endpoints: 5 of 5 endpoints answered, all on chain 1990
PASS Endpoints agree on the chain's height: blocks 12085410 to 12085412
PASS Chain id: 1990 (mainnet)
PASS Gas price: 1.125 gwei
PASS QUSDC: 0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5 has code and 6 decimals
PASS QUSDC roles: at block 12085412: VAULT_ROLE is held by 0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45 and DEFAULT_ADMIN_ROLE by 0xe1acec6312eb701D4A14De700CCec8DeE17a8D28, the vault role's holder can burn, and the token is not upgradeable, as docs/RISKS.md says; total supply 8929.088928 QUSDC (run pnpm live:facts for all of it)
FAIL Deployer QIE: 0.0 QIE is below 0.0064035106875 QIE, the measured cost of a deploy and the smoke run at this price with a margin of half again
FAIL Deployer QUSDC: 0.000000 QUSDC is below the 0.300000 the smoke run deposits
FAIL Relayer QIE: 0.0 QIE is below 0.018513669375 QIE, five of the largest batches measured
SKIP Router: nothing is deployed yet
PASS Explorer: answers

NO-GO on mainnet: Deployer QIE, Deployer QUSDC, Relayer QIE
```

The pre-flight check's minimum for the deployer uses a margin of half again, and the funding calculator below uses a margin of 3, so fund to the calculator's figure.

## QUSDC's facts, read again

`pnpm live:facts` reads each fact at one block (12085422) and compares it with [RISKS.md](RISKS.md). It exited 0: **nothing differs from what RISKS.md says**, so RISKS.md needed no correction of those facts.

| Fact | Value |
| --- | --- |
| Name, symbol, decimals | QUSDC, QUSDC, 6 |
| Total supply | 8929.088928 QUSDC (8929088928 units) |
| Upgradeable (an EIP-1967 slot is set) | no: all three slots are empty |
| VAULT_ROLE held by 0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45 | yes; that address is a contract |
| DEFAULT_ADMIN_ROLE held by 0xe1acec6312eb701D4A14De700CCec8DeE17a8D28 | yes |
| That admin account also holds VAULT_ROLE | no |
| VAULT_ROLE holders listed by the token | not listed by this token |
| DEFAULT_ADMIN_ROLE holders listed by the token | not listed by this token |
| burn(holder, 1) run as the vault role's holder | yes, the node ran it (on 0x73a3cCF7da7e473ed2e9994aE764f0E30f4e4DFe, the QUSDC/WQIE pool) |
| The same call run as an address with no role (the control) | no, the node refused it |
| mint(address, 1) run as the vault role's holder | yes, the node ran it |
| The same call run as an address with no role (the control) | no, the node refused it |

What the last four rows show and do not show. "The node ran it" means that, on the node's copy of the state at that block, a `burn` of one unit from the pool, made by the vault role's holder, did not revert. The control, the same call from an address with no role, was refused. Together they show that the role check is what separates the two, which is what RISKS.md says about `VAULT_ROLE`. No transaction was sent and nothing was burned, so this is a simulation by the node and not a burn on the live chain. The token does not list its role holders, so these calls cannot show who else holds a role: only that the two named addresses hold the two roles RISKS.md names.

The supply is new information. It is small: a purchase of 10.3 QUSDC is 0.12% of it.

## The funding calculator

Run at block 12085429, 2026-11-22T07:19:42Z. It reads no price in dollars. The numbers below are what the command printed, at that gas price and at that pool's balance; run it again on the day.

```text
Funding for mainnet (chain 1990), read from QIE at block 12085429, 2026-11-22T07:19:42Z UTC. Gas price 1.125 gwei.
Read-only: nothing is sent. No dollar price is read or used, so none is given. Gas figures are the ones measured on a fork (docs/GAS.md), times a margin of 3x.

(a) QIE for each address
  Deployer 0x539e8616E5D1DD6C5b4F46055242eEF111209b70
    needs 0.012808 QIE: deploy 3,158,652 + smoke run 636,021 = 3,794,673 gas x 1.125 gwei x 3
    holds 0.000000 QIE and 0.000000 QUSDC: send at least 0.012808 more
    needs 0.300000 QUSDC for the smoke run's deposit (it takes back all but the 1% fee on 0.15): send at least 0.300000 QUSDC more
  Relayer 0x0A021bC732325C57E0cC838E4111A861b84fFEB1
       21,000 gas  QIE top-up transfer to the owner
      134,066 gas  authorize the agent by signature
      695,167 gas  settle a batch of up to 10 intents (3 paid calls on 2 tools fit well inside)
      101,687 gas  withdraw the builder's earnings by signature
      101,639 gas  refund the owner's unspent balance by signature
    1,053,559 gas in all x 1.125 gwei x 3, plus the top-up of 0.000236 QIE sent to the owner (x 3) = 0.004262 QIE for the funded run
    to hold: 0.500000 QIE, the largest of the run's need, five of the largest batches (0.018514, the pre-flight floor) and a day's budget (0.5, below which /health reports a low balance)
    holds 0.000000 QIE: send at least 0.500000 more
  Owner of the funded run (starts with no QIE, so the facilitator pays): no QIE needed

(b) QUSDC: 10.000000 for the owner's funded run (the cap is 10.000000 unless SLUICE_MAX_QUSDC is set) and 0.300000 for the deployer's smoke run = 10.300000 QUSDC
  QIEDEX pool 0x73a3cCF7da7e473ed2e9994aE764f0E30f4e4DFe: 4631.441385 QUSDC and 28247.084085 WQIE in its reserves at block 12085429
  Buying QUSDC from it with QIE (QIE in; price paid per QUSDC; how much dearer than the pool's own price at its current balance; share of the pool's QUSDC taken):
      10.000000 QUSDC: 61.305723 QIE in; 6.130573 QIE per QUSDC; 0.51% above the pool's price; 0.21% of the pool; the pool's own router gives the same figure
      10.300000 QUSDC: 63.148994 QIE in; 6.130971 QIE per QUSDC; 0.52% above the pool's price; 0.22% of the pool; the pool's own router gives the same figure
      25.000000 QUSDC: 153.763383 QIE in; 6.150536 QIE per QUSDC; 0.84% above the pool's price; 0.53% of the pool; the pool's own router gives the same figure
     100.000000 QUSDC: 625.233296 QIE in; 6.252333 QIE per QUSDC; 2.51% above the pool's price; 2.15% of the pool; the pool's own router gives the same figure
  Formula: QIE in = floor(reserveQIE x out x 1000 / ((reserveQUSDC - out) x 997)) + 1, the constant-product rule with a 0.3% fee. Above the pool's price = QIE in / (out x reserveQIE / reserveQUSDC) - 1.

TOTAL: 0.012808 QIE to the deployer + 0.500000 QIE to the relayer + 63.148994 QIE to buy 10.300000 QUSDC from the pool = 63.661801 QIE, before any QIE you keep for your own wallet.
```

The relayer's 0.5 QIE is a day's budget, which keeps `/health` from reporting a low balance. The run itself needs about a hundredth of that. Nothing stops the founder from sending the relayer less than that, at the price of the low-balance flag.

## The vault's code, read after the deployment

On 2026-11-24 `pnpm live:vaultcheck` read the router's vault and compared the code at its address with the compiled AgentVault of this repository. It is read-only: `eth_chainId`, `eth_getBlockByNumber`, `eth_call` and `eth_getCode`, and no key. The vault is created by the router's constructor. On that day the explorer showed its address as a plain account, and this was the check that could be made. What the explorer showed later is in [EXPLORER-VAULT-INVESTIGATION.md](EXPLORER-VAULT-INVESTIGATION.md). What the command printed:

```powershell
$env:SLUICE_NETWORK = "mainnet"; pnpm live:vaultcheck
```

```text
RPC endpoint rpc1mainnet.qie.digital (chain 1990, 1029 ms); 4 fallbacks
Vault check on mainnet (chain 1990), read at block 12131895, 2026-11-24T06:04:29Z UTC. Read-only: eth_chainId, eth_getBlockByNumber, eth_call and eth_getCode.
router 0xf6F4C1Cc954B1798d134750438ada58768978716 (deployment.json)
PASS  the RPC is on chain 1990
PASS  there is a contract at the router 0xf6F4C1Cc954B1798d134750438ada58768978716
PASS  the router's vault() is 0xC8bfECBF9Dc5d18943b38873705DeeE9D13d751B
PASS  that is the vault in deployment.json
PASS  there is code at the vault: 6,174 bytes
PASS  the vault's router() is this router
PASS  the repository compiled AgentVault with solc v0.8.24+commit.e11b9ed9, the optimizer on at 200 runs, for the shanghai EVM
PASS  the compiler's own metadata at the end of the vault's code names solc 0.8.24
PASS  the compiled AgentVault has 6 immutables, in 7 places in its code (router, _cachedThis, _cachedChainId, _cachedSeparator, _nameHash, _versionHash), each filled in as the constructor fills it
PASS  the code at the vault is the compiled AgentVault: both hash to 0x96cddf2d6eb43d8845c4d435d2cbd34af60129cc850896e0851b43b094adb517
PASS  that is also the code hash deployment.json recorded when the router was deployed
vaultcheck: 11 passed, 0 failed

To build it again without trusting this program:
  compiler        solc v0.8.24+commit.e11b9ed9
  optimizer       enabled, 200 runs
  EVM version     shanghai
  contract        contracts/AgentVault.sol:AgentVault (licence MIT)
  constructor     one argument, the router's address: 0x000000000000000000000000f6f4c1cc954b1798d134750438ada58768978716
  source          the files in artifacts/verification/AgentVault.standard-input.json (pnpm live:verify --prepare-only writes it)
  then            take the compiled runtime (deployed) bytecode, write each 32-byte slot below at its byte offset, and take keccak256 of the result
  slots (byte offset in the runtime code, name, value):
      660  router            0x000000000000000000000000f6f4c1cc954b1798d134750438ada58768978716
      749  router            0x000000000000000000000000f6f4c1cc954b1798d134750438ada58768978716
     2474  _cachedThis       0x000000000000000000000000c8bfecbf9dc5d18943b38873705deee9d13d751b
     2516  _cachedChainId    0x00000000000000000000000000000000000000000000000000000000000007c6
     2558  _cachedSeparator  0xb1cbe9eb72324a06ba7be6918d14cc4fe17e4aa558e8157894dbdd002dad0e91
     2636  _nameHash         0x917274be98c080433001e3ef0edc43c9c9898a9feb4f454e55b573f9b882f6b9
     2676  _versionHash      0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6
  the hash of the compiled code with those slots filled in: 0x96cddf2d6eb43d8845c4d435d2cbd34af60129cc850896e0851b43b094adb517
  the hash of the code at the vault, from eth_getCode:      0x96cddf2d6eb43d8845c4d435d2cbd34af60129cc850896e0851b43b094adb517
```

At block 12131895 the router named the vault `0xC8bfECBF9Dc5d18943b38873705DeeE9D13d751B`, and the 6,174 bytes of code there hashed to `0x96cddf2d6eb43d8845c4d435d2cbd34af60129cc850896e0851b43b094adb517`. That is the hash of the compiled AgentVault with its six immutables filled in, and the hash `deployment.json` recorded when the router was deployed. It shows that the code is the compiled one. It does not show that the code is free of faults, and it is not a row in [EVIDENCE.md](EVIDENCE.md).

## What this does not show

- Anything about a transaction: nothing was sent, so no figure here says what a deploy, a deposit or a batch costs on the live chain. The gas figures are measurements from a fork, in [GAS.md](GAS.md).
- How the endpoints, the explorer, a wallet or a multisig behave under load or at another time. Five endpoints answered once, within a second each.
- The QUSDC admin's intentions or key handling. The role facts say who holds the roles, and the simulation shows what the vault role allows. RISKS.md's account of the risk stands as it was written.
- A price in dollars. None was read.
- Any step of [MAINNET-RUNBOOK.md](MAINNET-RUNBOOK.md) beyond the read-only ones. This record sent nothing. What ran the whole path here was a fork: see [MAINNET-DRYRUN-LOG.md](MAINNET-DRYRUN-LOG.md). What has happened on mainnet is in [EVIDENCE.md](EVIDENCE.md).
