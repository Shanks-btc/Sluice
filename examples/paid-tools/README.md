# Example paid tools

Three paid MCP tools for people building on QIE, each with a price in QUSDC and real output from read-only data on the chain. They run
on `@sluice/sdk`, so a call without payment gets the price and a signed payment runs the tool. A call that fails is not charged.

| Tool | Price | What it returns |
| --- | --- | --- |
| `token_risk_check` | 0.010000 QUSDC | For an ERC-20 on QIE: whether it is an upgradeable proxy, who owns it, its roles and who holds them, which burn, mint, pause, blacklist and fee functions its code has, and **who can call burn and mint right now**, tested by simulating the call from each known holder. |
| `dex_quote` | 0.002000 QUSDC | A QIEDEX quote for a given size: output, the minimum output at your slippage tolerance, price impact, cost against the pool's spot price, the route (direct or through WQIE) and whether QIEDEX's own router agrees with the pool formula. |
| `contract_lookup` | 0.005000 QUSDC | For a contract: whether the explorer has verified source, its name, compiler and settings, whether it is a proxy, the creator, whether the explorer's bytecode matches the code on the chain, and which write functions look like admin controls. |

## What it reads

The node's public RPC for state, code and storage, and the public explorer's read API with GET requests for what an RPC cannot
give (a log index back to block 0, verified source). The explorer client can reach only the explorer it was built for, over https.
Nothing is sent, signed or spent. When the explorer cannot be reached, the answer says so and still returns what the node gave.

## A real answer

`token_risk_check` on QUSDC, read from QIE mainnet through the public RPC and explorer on 2026-11-19, reports that QUSDC is not a
proxy; that `0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45`, a contract, holds `VAULT_ROLE` and can burn another holder's balance
and mint; and that `0xe1acec6312eb701D4A14De700CCec8DeE17a8D28`, an ordinary key-controlled account, administers that role
and can grant it to itself. That matches `docs/RISKS.md` section 1. `test/fork/tools.fork.test.ts` runs it on a fork of the
chain and checks those addresses.

`dex_quote` for 100 QIE to QUSDC returned 16.292766 QUSDC with a price impact of 35 basis points and 65 against the spot price,
and the router agreed. The pool moves, so another day gives another number.

## Limits of the answers

They are read-only checks of public data, not a security review. Functions are found by their 4-byte selectors from a fixed list.
Who can burn or mint is tested by simulation, which a call needing more than a role (a delay, a second approval) can fail while
still being possible. Each answer carries a `limits` list and a `disclaimer`.

## Run it

```bash
pnpm build
SLUICE_ROUTER=0x... SLUICE_FACILITATOR_URL=https://... SLUICE_PAYEE=0x... node examples/paid-tools/dist/cli.js            # stdio
SLUICE_ROUTER=0x... SLUICE_FACILITATOR_URL=https://... SLUICE_PAYEE=0x... node examples/paid-tools/dist/cli.js --http 3402  # Streamable HTTP
```

Over HTTP it is the hosted tool server: `SLUICE_NETWORK` must be named (`mainnet`, `testnet` or `local`; there is no default), on mainnet the router must hold QUSDC, and there are limits on callers (a per-address rate limit that is tighter for requests with no payment, a body size limit, time limits on reads, and logs with no signatures). `docs/DEPLOY-TOOL-SERVER.md` has the settings, a Dockerfile and a checklist.

`SLUICE_RPC_URL` and `SLUICE_EXPLORER_URL` are optional and default to QIE's public ones. The payment asset is whatever token the
router holds. Put the prices you want in `DEFAULT_PRICES` in `src/server.ts`, or pass `prices` to `registerPaidTools`.

## Tests

`test/unit/examples` runs the tools on a local chain with test contracts, and `test/fork/tools.fork.test.ts` runs them on a fork of
QIE mainnet with the real QUSDC and the real QIEDEX pool.
