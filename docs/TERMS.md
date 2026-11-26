> **Draft: not legal advice.** A lawyer must review these terms before the service is offered to the public. The operator's name and contact details, the governing law, any wording a region needs and the limits of liability are not filled in. This block is for people reading the repository: the site's page does not show it.

# Terms of use

These terms say what Sluice is, what you can and cannot count on, and what you are responsible for. They are written to match what the software does today. If the software changes, they change with it.

## What Sluice is

Sluice is payment software for MCP tools on QIE. A builder puts a price in QUSDC on a tool. An agent, or a person using this site, pays per call by signing a message. The payment is kept as a balance inside a smart contract (the router) and settled on chain in batches by a service called a facilitator. The operator is the person or team that runs this site, the facilitator and the example tool server.

The contracts are public and cannot be changed after they are deployed. The site, the facilitator and the tool server are services the operator runs, and they can change, stop or be unavailable.

## Your money

- **You deposit into a balance that stays yours.** A deposit moves QUSDC from your wallet into the router and credits it to you. Nobody, including the operator and the contracts' owner, has a function that moves, freezes or takes your balance.
- **You can take it back at any time.** A refund returns your unspent prepaid balance, and a withdrawal returns what a builder earned. Neither has a delay, a pause or an approval step. They work from a wallet that holds a little QIE even if every Sluice service is down.
- **QUSDC is not Sluice.** QUSDC's own admin holds a power to burn the QUSDC held by any account, including the router's. That power is outside Sluice and the contracts cannot remove it. It is the main reason to keep prepaid balances small and to refund what you do not need. [Risks](/docs/risks) shows how it was measured.
- **The fee.** The fee comes out of the builder's side of a payment and is never above 2% (200 basis points). A payer pays exactly the price they signed.
- **Test networks.** Funds on QIE's testnet have no value. This site says which network it is set to, and whether the funds there are real.

## Signing

Your wallet signs, and Sluice never sees a key or a seed phrase. This site has no field for either, and you should never type one into any page. Every action shows what your wallet will be asked to sign before the wallet opens, and nothing is sent until you confirm.

A payment you sign can be used once, for the price and the payee it names, until it expires. It cannot move anything else.

## Agent keys

An owner can authorise an agent key with a budget, a cap per call, an expiry and a list of tools. The vault enforces those limits when a payment settles. The agent key cannot raise its own limits, and the owner can revoke it at any time. You are responsible for the keys you give an agent and for the limits you set.

## Services and what may be unavailable

The site, the facilitator and the tool server may be slow, down or paused. The operator can turn on a kill switch that stops the facilitator from queuing, settling and topping up. When that happens:

- a payment that was not settled is not charged, and a signed payment expires within the hour;
- reading still works, and the Status page says what is wrong;
- your balance stays in the router, and a refund or withdrawal from a wallet with QIE still works.

A wallet that holds no QIE can start through the facilitator. The facilitator sends a small amount of QIE, within limits per address and per day, so two signed transactions can be sent. What the transactions do not use stays in your wallet. It is a way to get started, and the operator can decline or stop it.

## What has not been done

- No outside security review of the contracts or the services has been done. A bug in the contracts would stay, because they cannot be fixed after deployment.
- Nothing here is financial, legal or tax advice.
- The software is provided as it is. The operator makes no promise about uptime, speed, results, or that a tool's answer is right.

## For builders

You set your prices and your payee. A tool runs when a valid payment is shown to the tool server, and the payment is settled later, so a payer who refunds between the two can leave a call unpaid. A call that fails (a bad address, a node that does not answer) is not charged. Your earnings sit in the router until you withdraw them, and a withdrawal to your own wallet needs no one's permission.

## Use of the services

Do not use the services to attack them or the network, to get around their limits, to pay for something illegal where you are, or to harm others. The services have limits on request rates, amounts and daily spending, and the operator can block an address that abuses them.

## Changes

These terms can change. The version on this site is the one in force. A change does not reach back to what you did under an earlier version.
