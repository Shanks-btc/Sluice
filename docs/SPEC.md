# Sluice payment scheme for MCP on QIE

Version 1. Scheme name `sluice-intent`. Network `eip155:1990` (QIE mainnet).

This document is written to be implemented by someone who has not seen the Sluice code. Test vectors are in
[`spec-vectors.json`](spec-vectors.json), and a test checks both a client written from this text and the vectors against
the reference code.

**This is an independent scheme. It is not an official x402 scheme.** It borrows the x402 message shapes and the x402
MCP transport so that tools which already speak x402 over MCP can carry it, and it says below exactly where it differs.
Nobody at x402 reviewed or endorsed it. Credit for the shapes and the flow belongs to the x402 specification
(`specs/x402-specification-v2.md`) and its MCP transport (`specs/transports-v2/mcp.md`), at
https://github.com/coinbase/x402. The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. The problem

x402's `exact` scheme on EVM chains moves a token with a signature the token itself understands: EIP-3009
`transferWithAuthorization`, or a Permit2 transfer. A token that has neither cannot be paid for that way.

QUSDC, the dollar token on QIE, has neither. It has no `permit`, no EIP-3009 functions and no EIP-2612 domain, and QIE
mainnet has no Permit2 contract. QUSDC moves through `approve` and then `transferFrom` or `transfer`, and
those are transactions that cost QIE and need an account to send them.

So a per-call payment cannot be a signed token transfer. This scheme makes it a signed message about a balance held in a
router contract:

1. The payer deposits QUSDC into the router once (`approve`, then `deposit`).
2. Each call is paid with an EIP-712 **intent** that the payer, or an agent key the payer authorised, signs off-chain.
3. Anyone may submit signed intents to the router, in batches. The router moves value between two numbers it keeps, and
   moves no token. The payer can take back what is left at any time.

## 2. Parties and flow

```
 Client (payer or agent)     Resource server (builder)       Facilitator            PaymentRouter / AgentVault
        |                              |                           |                           |
        |--- tools/call, no payment -->|                           |                           |
        |<-- isError + PaymentRequired-|                           |                           |
        |--- tools/call + _meta payment>|                          |                           |
        |                              |--- POST /verify --------->|-- reads balance, nonce ->|
        |                              |<-- isValid ---------------|                           |
        |                              | (runs the tool)           |                           |
        |                              |--- POST /settle --------->| (queues the intent)       |
        |<-- result + _meta response --|<-- queued, id ------------|                           |
        |                              |                           |--- batchSettle(...) ----->|
```

- **Client**: an MCP client that holds a signing key. The key is the payer's, or an agent session key.
- **Resource server**: an MCP server whose tools have prices.
- **Facilitator**: an HTTP service that checks payments against the chain, queues them and submits them in batches.
- **Contracts**: `PaymentRouter` (balances, settlement, fee) and its `AgentVault` (session keys).

## 3. Messages (x402 over MCP)

All messages follow the x402 v2 MCP transport. Amounts and deadlines are decimal strings; addresses are 0x hex; 32-byte
values are lower-case 0x hex.

### 3.1 Payment required

A server MUST answer a call that carries no valid payment with a tool result that has `isError: true`, a
`structuredContent` holding the `PaymentRequired` object, and `content[0].text` holding the same object as JSON.

```json
{
  "isError": true,
  "structuredContent": {
    "x402Version": 2,
    "error": "optional reason, one of the codes in section 9",
    "resource": { "url": "mcp://tool/echo", "description": "Echoes text.", "mimeType": "application/json" },
    "accepts": [
      {
        "scheme": "sluice-intent",
        "network": "eip155:1990",
        "amount": "10000",
        "asset": "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
        "payTo": "0xb01D000000000000000000000000000000000001",
        "maxTimeoutSeconds": 300,
        "extra": {
          "name": "SluiceRouter",
          "version": "1",
          "router": "0x51cE000000000000000000000000000000000001",
          "toolId": "0x30aac30d8e1f24996aaf406e85b7281051192346b2dcbea9be2461c29b1bc590",
          "vault": "0x51ce0000000000000000000000000000000000a1"
        }
      }
    ]
  },
  "content": [{ "type": "text", "text": "<the same object as JSON>" }]
}
```

| Field | Meaning |
| --- | --- |
| `scheme` | `sluice-intent` |
| `network` | CAIP-2 chain id. `eip155:1990` for QIE mainnet. |
| `amount` | The price, in token base units. QUSDC has 6 decimals, so `10000` is 0.01 QUSDC. |
| `asset` | The token the router holds. |
| `payTo` | The builder's address. It is the `payee` of the intent. |
| `maxTimeoutSeconds` | How long, from the verifier's clock, an intent may stay valid. |
| `extra.name`, `extra.version` | The EIP-712 domain name and version of the router: `SluiceRouter`, `1`. |
| `extra.router` | The PaymentRouter the payment must be signed for. |
| `extra.toolId` | `keccak256` of the UTF-8 tool name. The payment is bound to this tool. |
| `extra.vault` | Optional. The router's AgentVault. |
| `extra.facilitator` | Optional. The facilitator's base URL. |

A client reads `structuredContent` and falls back to `content[0].text`, as the x402 MCP transport says.

A server MAY also advertise a price in `tools/list`, under the tool's `_meta["sluice/pricing"]`. That is advice for
price checks. The price that binds is the one in the payment-required result.

### 3.2 Payment

The client retries the same `tools/call` with the payment in `params._meta["x402/payment"]`:

```json
{
  "x402Version": 2,
  "resource": { "url": "mcp://tool/echo", "description": "Echoes text.", "mimeType": "application/json" },
  "accepted": { "...": "the accepts entry being paid, copied exactly" },
  "payload": {
    "signature": "0xcc9fd50e03f590e64d1004b68d4c32dc101b79fa366f33bde3ac4eb3e9006801254afef682132c78c9556d6c830c08d1f0e43a2a326eb6739b0ecb5b2883aff51c",
    "authorization": {
      "payer": "0xb53341a6706D74ee98A7b4193eCFF68395377C01",
      "payee": "0xb01D000000000000000000000000000000000001",
      "amount": "10000",
      "toolId": "0x30aac30d8e1f24996aaf406e85b7281051192346b2dcbea9be2461c29b1bc590",
      "nonce": "0xb8baa9781262a77c1124a82f7bb59f3616aea41ba0d5ada72a59e9c21f37caa4",
      "deadline": "1800000300"
    }
  }
}
```

`payload.authorization` carries the fields of the signed intent (section 4) and `payload.signature` is the signature
over it. x402's `exact` scheme puts an EIP-3009 authorization in the same place.

### 3.3 Settlement response

On success the server returns the tool's result with `result._meta["x402/payment-response"]`:

```json
{
  "success": true,
  "transaction": "",
  "network": "eip155:1990",
  "payer": "0xb53341a6706D74ee98A7b4193eCFF68395377C01",
  "amount": "10000",
  "extensions": { "sluice": { "id": "0xe56e5fee8fe076ffba71f4d1b1cf51b28898a1fdb52dd10888342f22c6b20325", "status": "queued" } }
}
```

`transaction` is empty because settlement is queued and sent later in a batch. `extensions.sluice.id` is the intent's
EIP-712 digest (section 4), which is also its id at the facilitator (section 7).

If settlement cannot be requested after the tool ran, the server MUST return an error result in the payment-required
form and MUST NOT return the tool's content, as the x402 MCP transport says.

## 4. The signed intent

The intent is EIP-712 typed data.

**Domain** (the PaymentRouter):

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name = "SluiceRouter"   version = "1"   chainId = 1990   verifyingContract = the router
```

**Type**:

```
Payment(address payer,address payee,uint256 amount,bytes32 toolId,bytes32 nonce,uint256 deadline)
```

| Field | Meaning |
| --- | --- |
| `payer` | Whose prepaid balance pays. |
| `payee` | The builder who is paid. |
| `amount` | Token base units. The payer is debited exactly this amount. |
| `toolId` | `keccak256` of the tool name. |
| `nonce` | 32 random bytes chosen by the signer. Used once per payer. |
| `deadline` | Unix seconds. The router refuses the intent after it. |

The digest, with `domainSeparator = keccak256(abi.encode(keccak256(EIP712Domain string), keccak256(name), keccak256(version), chainId, verifyingContract))` and `structHash = keccak256(abi.encode(keccak256(Payment string), payer, payee, amount, toolId, nonce, deadline))`:

```
digest = keccak256(0x1901 ‖ domainSeparator ‖ structHash)
```

The digest is the intent's **id**. [`spec-vectors.json`](spec-vectors.json) gives every type string, every domain
separator and a digest for each example, so an implementation can check its hashing before it checks anything else.

**Signature.** 65 bytes, `r ‖ s ‖ v`, with `v` of 27 or 28 and `s` at most half the secp256k1 group order (EIP-2). The
router refuses every other form, so a verifier MUST refuse them too, before recovering a signer.

**Signer.** The signer is the payer, or an agent session key the payer authorised (section 6). The router decides which
by comparing the recovered address with `payer`.

## 5. Balance, settlement and fee

- `deposit(amount)` moves tokens from the caller to the router and credits the caller's prepaid balance. The router
  checks that exactly `amount` arrived, which rules out tokens that take a cut. `depositFor(account, amount)` credits
  someone else. A payer can take back any unspent amount at any time with `refund`, with no delay.
- `settle(intent, signature)` settles one intent and reverts with the reason if it cannot. `batchSettle(intents,
  signatures)` settles many, and **skips** an intent that cannot settle, reporting it in
  `SettleSkipped(index, payer, nonce, reason)` where `reason` is the four-byte selector of one of the contract's error
  names. One bad intent does not cost a facilitator the batch. Anyone may call both: the signature is the authority.
- A settled intent debits the payer's balance by `amount` and credits the builder's earnings by `amount - fee`, where
  `fee = floor(amount × feeBps / 10000)` is credited to the fee recipient's earnings. The payer always pays exactly the
  signed amount. `Settled(payer, payee, toolId, amount, fee, nonce, signer)` is emitted.
- **The fee is capped by the contract at 2%** (`MAX_FEE_BPS = 200`). The owner can change the fee within that cap and the
  fee recipient, and cannot move any balance.
- A builder takes earnings out with `withdraw`, or by signature (section 8).

## 6. Session keys

A payer lets an agent key spend inside limits the chain enforces. `AgentVault.authorize(grant, tools)` creates a session:

| Field | Meaning |
| --- | --- |
| `grant.agent` | The session key's address. It cannot be the payer. |
| `grant.budget` | Total the agent may spend. |
| `grant.perCallCap` | The most any one intent may cost. It cannot exceed the budget. |
| `grant.expiry` | Unix seconds after which the session is dead. |
| `tools` | Up to 32 `(payee, toolId)` pairs the agent may pay. A `toolId` of zero allows every tool of that payee. |

When the router settles an intent signed by anyone but the payer, it asks the vault to allow it, and the vault refuses
with one of `SessionNotFound`, `SessionExpired`, `PerCallCapExceeded`, `BudgetExceeded` or `ToolNotAllowed`, in that
order. Authorising an agent again replaces its session and resets what it spent. The payer revokes with `revoke(agent)`,
effective in the same block. Only the payer's own signature can create, change or revoke a session, so **an agent cannot
raise its own budget.**

## 7. Verification and the facilitator

### 7.1 What a resource server checks

Before running a paid tool a server MUST check, in this order, and answer with the code in brackets (section 9):

1. `x402Version` is 2 [`invalid_x402_version`], and the payment is readable [`invalid_payload`].
2. `scheme` is `sluice-intent` [`invalid_scheme`] and `network` is the network it serves [`invalid_network`].
3. `asset` and `extra.router` are the token and router it serves [`invalid_sluice_asset`, `invalid_sluice_router`].
4. `accepted` equals, field for field, the terms the server offered for this tool [`sluice_accepted_mismatch`]. The price
   is the server's own, never the client's copy.
5. `payee` equals `payTo` [`sluice_payee_mismatch`] and `toolId` equals the tool's id [`sluice_tool_mismatch`].
6. `amount` is above zero and at least the price [`sluice_amount_too_low`]. A payer MAY pay more than the price.
7. `deadline` is at least 20 seconds ahead of the verifier's clock [`sluice_intent_expired`] and no more than
   `min(maxTimeoutSeconds, 3600) + 30` seconds ahead [`sluice_deadline_too_far`].
8. The signature has the form in section 4 and recovers to a signer [`invalid_sluice_signature`].

A signature made under another chain id or another router is well formed and recovers to an unrelated key. Steps 1 to 8
cannot tell. The facilitator then finds that this key is not the payer and holds no session, and answers
`sluice_session_not_found`. [`spec-vectors.json`](spec-vectors.json) has both cases.

It then asks the facilitator's `/verify` for what only the chain knows, runs the tool, and calls `/settle`.

### 7.2 Idempotency

A server MUST NOT charge twice or run a tool twice for one intent. It keys what it has done by the intent's digest:

- The same intent on the same call returns the original result and the same settlement, and runs nothing.
- The same intent on a different call is refused with `sluice_intent_already_used`: it paid for one call.
- A tool that fails is not charged, and its intent may be used again.
- If settlement could not be requested, a retry with the same intent requests it again and does not re-run the tool.

### 7.3 Facilitator endpoints

Bodies are JSON. The request body for `/verify` and `/settle` is the x402 facilitator body:
`{ "x402Version": 2, "paymentPayload": <3.2>, "paymentRequirements": <the accepts entry> }`. The facilitator MUST repeat
every check in 7.1 against its own configuration and not trust the caller.

**`POST /verify`** returns `{ "isValid": true, "payer": "0x…" }` or `{ "isValid": false, "invalidReason": "<code>", "payer": "0x…" }`.
After the checks in 7.1 it reads the chain: the payer's nonce [`sluice_nonce_used`], the payer's balance less what the
facilitator has already queued for that payer [`insufficient_funds`], and, for an agent signer, the session in the order
of section 6 with the agent's queued spend counted against its budget [`sluice_session_not_found`,
`sluice_session_expired`, `sluice_per_call_cap_exceeded`, `sluice_budget_exceeded`, `sluice_tool_not_allowed`].
`/verify` changes nothing.

**`POST /settle`** runs the same checks and **queues** the intent. It returns `{ "success": true, "transaction": "",
"network": "eip155:1990", "payer": …, "amount": …, "extensions": { "sluice": { "id": "<digest>", "status": "queued" } } }`, or
`{ "success": false, "errorReason": "<code>", … }`. The same intent is one record however often it is sent. A second
intent with the same payer and nonce is refused with `sluice_nonce_used`. The facilitator submits queued intents with
`batchSettle`, and reads the `Settled` and `SettleSkipped` events to learn each one's outcome.

**`GET /status/<id>`** returns `{ "id", "status", "transaction"?, "blockNumber"?, "reason"?, "payer", "payee", "amount" }`.
`status` is `queued`, `settled`, `skipped` (with `reason` the contract's error name), `expired` (the deadline passed
before submission) or `failed`. An unknown id is a 404.

**`POST /onboard`** and **`POST /relay`** are section 8. **`GET /health`** reports the relayer's address, balance, budget
and alerts, and never a key.

## 8. Starting with no QIE, and leaving

A wallet that holds QUSDC and no QIE cannot send the two transactions that an initial deposit needs, because QUSDC has no
permit. It can sign them. The client signs two **legacy** (type 0) transactions bound to chain 1990:

```
approve(router, amount)   to the token    gasLimit 60,000    value 0
deposit(amount)           to the router   gasLimit 130,000   value 0     (nonce = the approve's nonce + 1)
```

with the same `gasPrice`, and posts `{ "payer", "approveTx", "depositTx" }` (raw signed hex) to `/onboard`. The facilitator
checks every byte: signed by the payer, chain 1990, legacy type, no value, the approval is for the router and equals the
deposit, the destinations are the token and the router, the gas limits and price are inside its caps, the nonce is the
wallet's next, the wallet holds the QUSDC, and the amount is inside its cap. It sends the wallet the QIE the two gas limits
can use, less what the wallet already holds, then broadcasts both and returns their hashes. Gas that the transactions do not
use is refunded to the wallet by the chain. Because the payer's own key signed both transactions, the facilitator cannot
change what they do. If something fails part-way the wallet keeps the QIE it was sent, which is at most the facilitator's
cap.

`/relay` submits a request the owner of the funds signed, so the owner needs no QIE:

| `kind` | Contract call | Signed message |
| --- | --- | --- |
| `withdraw` | `withdrawBySig` | `Withdraw(address account,address to,uint256 amount,uint256 relayerFee,bytes32 nonce,uint256 deadline)` on the router domain |
| `refund` | `refundBySig` | `Refund(address payer,address to,uint256 amount,uint256 relayerFee,bytes32 nonce,uint256 deadline)` on the router domain |
| `authorize` | `authorizeBySig` | `Authorize(address payer,address agent,uint256 budget,uint256 perCallCap,uint256 expiry,Tool[] tools,uint256 nonce,uint256 deadline)Tool(address payee,bytes32 toolId)` on the vault domain |
| `revoke` | `revokeBySig` | `Revoke(address payer,address agent,uint256 nonce,uint256 deadline)` on the vault domain |

The vault domain is `EIP712Domain` with name `SluiceAgentVault`, version `1`, chain 1990 and the vault's address. The
destination of a withdrawal or refund, and its relayer fee, are inside the signature, so a relayer cannot redirect it. A
facilitator that never holds the token MUST submit these with a relayer fee of zero, because the router pays the fee in
tokens to whoever submits. A signed `nonce` for `authorize` and `revoke` is the payer's `vault.nonces(payer)`, which rises
by one with each.

## 9. Error codes

Codes are returned as `invalidReason`, `errorReason` or the `error` of a payment-required result. Names that x402 defines
keep their meaning.

| Code | Meaning |
| --- | --- |
| `invalid_x402_version` | `x402Version` is not 2. |
| `invalid_scheme` | The scheme is not `sluice-intent`. |
| `invalid_network` | The network is not the one served. |
| `invalid_payload`, `invalid_payment_requirements` | A message is malformed. |
| `insufficient_funds` | The payer's balance, less queued intents, is below the amount. |
| `invalid_sluice_asset` | The asset is not the token the router holds. |
| `invalid_sluice_router` | The router is not the one served. |
| `invalid_sluice_signature` | The signature is malformed, malleable or does not recover. |
| `sluice_accepted_mismatch` | `accepted` is not the offered terms. |
| `sluice_payee_mismatch`, `sluice_tool_mismatch` | `payee` is not `payTo`, or `toolId` is not the tool's. |
| `sluice_amount_too_low` | The amount is below the price. |
| `sluice_intent_expired`, `sluice_deadline_too_far` | The deadline is too near or too far. |
| `sluice_nonce_used` | The payer's nonce is spent, cancelled or already queued. |
| `sluice_intent_already_used` | The intent already paid for another call. |
| `sluice_session_not_found`, `sluice_session_expired` | The signer holds no live session from the payer. |
| `sluice_per_call_cap_exceeded`, `sluice_budget_exceeded`, `sluice_tool_not_allowed` | The session's limits. |
| `sluice_cap_payer_daily`, `sluice_cap_global_daily` | The facilitator's per-day limits. |
| `sluice_relayer_budget_exhausted`, `sluice_relayer_gas_price_too_high` | The relayer's own limits held a batch. |
| `sluice_facilitator_unavailable` | The facilitator could not be reached. It is an error result and not a payment request: the client should not sign again. |
| `sluice_store_unavailable` | The facilitator could not record the intent durably (its queue store is unreadable or the disk is full), so it accepted nothing. Nothing was queued and nothing was charged. |
| `sluice_kill_switch` | The operator has stopped the facilitator from relaying, settling and topping up. Reads still work. The client should not sign again. |
| `sluice_rate_limited` | The facilitator's limit on requests from one address or one payer was reached. The HTTP status is 429 and `Retry-After` says how long to wait. |
| `sluice_onboard_refused`, `sluice_relay_refused` | An `/onboard` or `/relay` request was refused, with a detail. |
| `sluice_not_found` | A `/status` id is not known. The HTTP status is 404. |
| `unexpected_verify_error`, `unexpected_settle_error` | An unexpected failure. |

A `SettleSkipped` reason is the name of a contract error: `ZeroAmount`, `InvalidPayee`, `Expired`, `NonceAlreadyUsed`,
`InvalidSignature`, `InsufficientBalance`, or a session error from section 6.

## 10. Replay protection

- **Chain and contract.** The domain binds a signature to one chain id and one router address. A signature made for
  another deployment recovers to an unrelated key.
- **Nonce.** The router burns `(payer, nonce)` when it settles, so an intent settles once. A payer can cancel an unsent
  nonce with `cancelNonce`. Nonces are random 32-byte values the signer picks, so signers need no coordination.
- **Deadline.** An intent dies at its deadline. A verifier refuses one that is too near or too far.
- **Tool binding.** `toolId` is signed, so an intent for one tool cannot pay for another.
- **Server idempotency.** Section 7.2.
- **Facilitator idempotency.** Section 7.3. The chain is the last guard: a second submission is skipped with
  `NonceAlreadyUsed`.

## 11. Security considerations

- **QUSDC's admin can burn balances.** QUSDC's admin account can give itself the right to burn any holder's QUSDC,
  including the router's; the router cannot prevent that. A payer should keep prepaid balances small and withdraw to their
  own wallet often. The router exposes `solvency()`, which shows `held < owed` if QUSDC is burned from under it.
- **The server runs the tool before it is paid.** A server verifies, runs the tool, then queues settlement. Between those
  steps the payer can refund their balance, and the intent is then skipped on chain. Facilitators reduce the window by
  counting queued intents against a payer's balance and an agent's budget. A server that cannot bear the loss for a
  call should price it low, or settle before running it.
- **The facilitator is trusted to report honestly** to a resource server, as in x402. It cannot move any balance: every
  payment is a signature, the destination of exits is signed, and only the router moves value. If it lies, the cost is to
  the resource server, which can check any intent's outcome on chain.
- **The relayer's key.** It holds QIE only. It is not the router's owner or fee recipient and never holds the token. A
  reference implementation caps what a stolen key could do: contract calls only to the router and the vault; a gas limit per
  transaction (4,000,000), a gas price ceiling (5 gwei), a daily QIE budget (ceiling 2 QIE), a top-up cap, per-payer and
  per-day limits on intents and QUSDC, and an alert when half of the day's budget is used. It cannot change a payment or a
  withdrawal. It can spend its own QIE, delay or drop requests, and submit valid signed requests for anyone.
- **Agent keys.** A stolen session key can pay only the tools and builders the owner named, up to the budget and cap and
  before the expiry, and the owner can revoke it at once. An agent holds no owner key, and the signed authorisation is what
  an agent cannot make.
- **A signed intent is a bearer instruction to pay the named builder.** Anyone who sees it can submit it, which pays the
  builder the named amount once. It cannot be redirected. Keep deadlines short.
- **Clocks.** A verifier's clock and the chain's clock can differ. The 20-second floor and 30-second allowance in 7.1 are
  there so that a batch is submitted before the deadline.
- **Not reviewed.** No outside security review of the contracts or of this scheme has been done.

## 12. Differences from x402

| | x402 `exact` (EVM) | `sluice-intent` |
| --- | --- | --- |
| What is signed | An EIP-3009 authorization or Permit2 transfer, executed by the token | An EIP-712 intent about a prepaid balance in the router |
| Token needs | EIP-3009 or Permit2 | `approve` and `transferFrom`, once, for the deposit |
| Amount | Equals the price | At least the price |
| `payload` | `{ signature, authorization: { from, to, value, validAfter, validBefore, nonce } }` | `{ signature, authorization: { payer, payee, amount, toolId, nonce, deadline } }` |
| Tool binding | None in the signature | `toolId` is signed |
| Who may sign | The payer | The payer, or an agent session key with on-chain limits |
| Settlement | One transfer per payment | Batched, after the tool runs |
| `transaction` in the settlement response | The transfer's hash | Empty until the batch is sent; the intent id and a `/status` endpoint instead |
| Verification | Facilitator `/verify` | The same, plus the router balance and the session policy |
| `accepted` | Echoed | Echoed and checked field for field |
| Extra facilitator endpoints | `/supported`, discovery | `/status`, `/onboard`, `/relay`, `/health` |

Same as x402: the MCP transport and its keys, `x402Version` 2, the `PaymentRequired`, `PaymentPayload` and
`SettleResponse` shapes, CAIP-2 networks, the `resource` object, and the facilitator's `/verify` and `/settle` bodies.

## 13. Conformance

A client conforms if it: reads the payment-required result from `structuredContent` or `content[0].text`; pays only an
`accepts` entry whose scheme, network, asset and router it expects; signs `Payment` as in section 4 with a fresh random
nonce and a short deadline; sends the payment in `params._meta["x402/payment"]`; and pays at most once per call.

A resource server conforms if it performs section 7.1 and 7.2, returns section 3.1 for a missing or invalid payment and
section 3.3 for a paid call, does not charge for a failed call, and does not return a tool's content when settlement could not
be requested.

A facilitator conforms if it performs sections 7.1 and 7.3, is idempotent by digest, and, when it also offers section 8,
checks every field of the signed transactions and relays exits with a relayer fee of zero.

## 14. Test vectors

[`spec-vectors.json`](spec-vectors.json) holds, for a fixed router and vault address and a fixed clock
(`verifierNow`): the type strings, the domain separators, the tool ids, three payments a verifier must accept (one signed
by the payer, one by an agent, one paying above the price), twelve it must refuse with a stated code, two that recover to an
unrelated key, and a withdraw, refund, authorize and revoke with their digests and signatures. The keys that signed them were
generated for the file and discarded, and the file does not contain them: each vector names the address its signature must
recover to. `test/unit/spec/vectors.test.ts` recomputes every digest from the formulas above with no Sluice code, recovers
every signer, checks the verdicts against the SDK, and compares the digests with what the compiled contracts compute.
`test/unit/spec/compat.test.ts` runs a client written from this document, with no Sluice code either, through a complete paid
call against the SDK.

## 15. Credits

x402, Coinbase and the x402 Foundation: the message shapes, the facilitator interface and the MCP transport this scheme
follows, from https://github.com/coinbase/x402. The Model Context Protocol: the `_meta` field and the tool-result error
form. EIP-712 and EIP-2 for the signing rules.
