> **Draft: not legal advice.** A lawyer must review this notice before the service is offered to the public. The operator's name and contact details, how long logs are kept, the hosting provider's own practices and any wording a region needs are not filled in. This block is for people reading the repository: the site's page does not show it.

# Privacy

This notice says what the site and the services behind it collect, what stays in your browser, and what is public by nature. It is written from what the code does.

## What this site does not do

- It has no accounts, no sign-up and no cookies.
- It runs no analytics and loads no third-party scripts, fonts or images. A browser policy on every page lets the page talk to this site, to QIE's public nodes, and to the facilitator and the tool server the operator set, and to nothing else.
- It never asks for a private key or a seed phrase and has no field for one. Your wallet signs, and the key stays in your wallet.
- It collects no name, no email address and no identity document.

## What stays in your browser

- Your light or dark theme choice.
- A short list of payments you sent from this browser and have not yet seen settle: the payment's id, the tool, the amount, your address and the payment's nonce. It lets a reload pick the payment up again. Each record is dropped when the payment settles, and after a day at the latest. It holds no key, no signature and no tool answer.

You can clear both in your browser's settings for this site.

## What the site's own server sees

Like any web server, the host of this site receives your network address, the time, the page asked for and your browser's description. The app does not store them. The host may keep ordinary request logs of its own, and its practices are the host's.

Two small routes read public data for the pages: one checks a token you type in, and one reads the status of the services. They hold a count of recent requests per caller, kept in memory (never on disk), under a hash of the address, so that a runaway client can be slowed. The count is lost when the server restarts.

## What the services see and keep

When you pay for a tool call, three services take part, each run by the operator:

- **The tool server** receives the call, with its arguments, and the signed payment. Its logs hold the method, the tool name, whether a payment came with it, the answer's status, how long it took and a request id. They hold no argument, no signature and no payment. When a request is refused for going over a rate limit, the log holds the caller's address. What a tool does with its arguments is the builder's own matter.
- **The facilitator** receives the signed payment and keeps it in a journal on the operator's disk until it is settled and for as long as the operator keeps the journal: your address, the payee's address, the amount, the tool id, the nonce, the signature, the state and, once settled, the transaction hash. Its logs hold a request id, the method, the route, the status and the time, and addresses when a request is limited or an alert is raised. They never hold a key.
- **The site's pages** read the chain from your browser through QIE's public nodes.

Daily counters per address (for the limits on top-ups and starts) are kept in the same journal.

Where the operator runs the two services as Vercel functions, there is no journal on a disk. The facilitator keeps the same records and counters in a database run by Upstash, with its last 500 refusals, which may name an address. The daily counters expire after a few days; the payment records stay until the operator removes them. The tool server keeps, for two hours, each payment's result, which is the tool's answer, so that the same payment gets the same answer again. It keeps it in the same database or in one of its own, as the operator chose; where there is one, both services hold the token that opens it. Both count requests per network address, and the facilitator per payer address as well, in those databases, for about a minute.

## What is public

Everything that reaches the chain is public and cannot be deleted: deposits, payments, refunds, withdrawals, agent keys authorised or revoked, and the QIE top-ups the facilitator sends. Anyone can read a wallet's activity from the explorer. The Wallet page reads the same events to show you your own history, and its CSV file is made in your browser and goes nowhere.

## Other parties

- **QIE's public nodes** see your network address and the questions your browser asks them, such as a balance or a block.
- **The explorer** sees your network address when you follow a link to it.
- **Your wallet's maker** has its own notice.
- **The host and its network** see the traffic to this site.

## Keeping and removing

The software does not set how long logs or the journal are kept; the operator does. Chain data stays. If you want to know what the operator holds about an address, or want it removed where that is possible, ask the operator.

## Changes

This notice can change. The version on this site is the one in force.
