# Founder log

This file is a template. The founder fills it in, truthfully, in their own words. Claude Code wrote nothing in the sections
below and has no knowledge of what the founder did, decided, understood, ran or reviewed. A section left empty means
nothing has been recorded there, and the other documents in this repository do not say otherwise.

The QIE Hackathon asks teams to understand and be able to explain their code. A dated, specific log kept as the work goes on
is the evidence for that. Write what happened, on the day it happened, and leave a heading empty if nothing happened.

How to write an entry: the date, what you did or decided, why, and where the evidence is (a commit, a file, a transaction
hash, a screenshot, a message). Leave out anything you are not sure of.

## Decisions the founder made

Product and design choices that were yours, with the reason. Each should say what you chose and what you rejected.

| Date | Decision | Reason | Evidence |
| --- | --- | --- | --- |
|  |  |  |  |

## Parts the founder has explained

Which parts of the code you can explain without help, to whom you explained them, and how (a call, a recording, a written
note). A part listed here should be one you could walk a judge through.

| Date | Part (a contract, a package, a flow) | Explained to / how | Notes |
| --- | --- | --- | --- |
|  |  |  |  |

## Tests the founder ran

Commands you ran yourself, on your own machine, and what you saw. Say which commands and say what the result was.

| Date | Command | Result | Notes |
| --- | --- | --- | --- |
|  |  |  |  |

## Reviews

Anything reviewed by you or by someone else: a read-through of a contract, a review of the spec, a security review, a
review of this repository by a friend. Name the reviewer and say what was covered and what was found. An outside security
review, if one happens, is recorded here and nowhere else until it exists.

| Date | Reviewer | What was reviewed | What was found | Evidence |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Network actions

Every deployment, funding, transaction or other action on a QIE network, whether testnet or mainnet, with the transaction
hash. The rows in [`EVIDENCE.md`](EVIDENCE.md) come from here.

| Date | Action | Network | Transaction hash | Notes |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Founder wallets

The wallets that belong to the founder are listed, with labels, in [`founder-wallets.json`](founder-wallets.json), and
`pnpm evidence:summary` leaves them out of its counts. Record here when you added a wallet and raised the list's version.

| Date | Wallet label | List version after the change |
| --- | --- | --- |
|  |  |  |

## Go-live steps

Blank until you tick them. A box is ticked by you, on the day you did the step, and only for a step you really did. Next to each, write the date and where the evidence is (a transaction hash, a screenshot, a message). The steps are in [MAINNET-RUNBOOK.md](MAINNET-RUNBOOK.md) and [REHEARSAL.md](REHEARSAL.md).

Rehearsal on the testnet:

- [ ] Deployed the test token (`pnpm live:test-token`)
- [ ] Pre-flight check said GO on the testnet
- [ ] Deployed the router on the testnet, and recorded it
- [ ] Ran the smoke run on the testnet, and recorded its transactions
- [ ] Hosted the facilitator against the testnet, and did its checklist (restart drill, kill switch drill)
- [ ] Hosted the tool server against the testnet, and did its checklist
- [ ] Made a paid call through the proxy to the hosted tool server, and recorded what the chain showed
- [ ] Tried Claude Code with the proxy ([REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md))
- [ ] Tried Cursor with the proxy ([REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md))

Mainnet:

- [ ] Funded the deployer and the relayer as in the funding plan
- [ ] Pre-flight check said GO on mainnet, before the deploy
- [ ] Dry-ran the deploy, and read what it would send
- [ ] Deployed the router with caps, and recorded it
- [ ] Pre-flight check said GO with the deployment record
- [ ] Verified the router's and the vault's source on the explorer, and recorded it
- [ ] Ran the smoke run, and recorded its transactions
- [ ] Hosted the facilitator against mainnet, and did its checklist
- [ ] Hosted the tool server against mainnet, and did its checklist
- [ ] Did the funded run of about 10 QUSDC, and recorded what the chain showed
- [ ] Withdrew the builder's earnings, and recorded it
- [ ] Ran `pnpm evidence:check` and `pnpm evidence:summary`, and read them

Other people:

- [ ] Sent the outreach messages I chose to send ([OUTREACH.md](OUTREACH.md)), and noted to whom
- [ ] Read each "I tried Sluice" report, and replied
