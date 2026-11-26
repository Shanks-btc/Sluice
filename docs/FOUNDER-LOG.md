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

`pnpm rehearsal:testnet` covers the items marked below, from two throwaway keys, and prints what the chain showed. What it has done is in [REHEARSAL-LOG.md](REHEARSAL-LOG.md); as of 2026-11-20 it has not sent a transaction, because both testnet addresses held no QIE. A run of that command does not tick a box here. These boxes are for what you did yourself, and every one stays empty until you tick it.

- [ ] Deployed the test token (`pnpm live:test-token`) (covered by the automated run)
- [ ] Pre-flight check said GO on the testnet (covered by the automated run)
- [ ] Deployed the router on the testnet, and recorded it (covered by the automated run)
- [ ] Ran the smoke run on the testnet, and recorded its transactions (covered by the automated run)
- [ ] Hosted the facilitator against the testnet, and did its checklist (restart drill, kill switch drill) (the automated run does both drills against a copy on one machine, not a hosted service)
- [ ] Hosted the tool server against the testnet, and did its checklist (the automated run starts a copy on one machine, not a hosted service)
- [ ] Made a paid call through the proxy to the hosted tool server, and recorded what the chain showed (the automated run makes three through a local copy)
- [ ] Tried Claude Code with the proxy ([REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md))
- [ ] Tried Cursor with the proxy ([REAL-CLIENT-TEST.md](REAL-CLIENT-TEST.md))

Mainnet:

- [ ] Made `deployer-mainnet.key` and `relayer-mainnet.key` (or my own keys) and noted both addresses
- [ ] Ran `pnpm live:funding` with the two addresses, and funded the deployer and the relayer to what it printed
- [ ] Ran `pnpm live:facts` and read what it said about QUSDC's roles against [RISKS.md](RISKS.md)
- [ ] Pre-flight check said GO on mainnet, before the deploy
- [ ] Dry-ran the deploy, and read what it would send
- [ ] Deployed the router with caps, and recorded it
- [ ] Wrote the settings files with `pnpm live:wire --network mainnet`, and filled in what it left empty
- [ ] Pre-flight check said GO with the deployment record
- [ ] Verified the router's source on the explorer, and recorded it (the vault has no evidence row: see EXPLORER-VAULT-INVESTIGATION.md)
- [ ] Ran `pnpm live:vaultcheck`, and noted the vault's code hash and the block it was read at
- [ ] Ran the smoke run, and recorded its transactions
- [ ] Hosted the facilitator against mainnet, and did its checklist
- [ ] Hosted the tool server against mainnet, and did its checklist
- [ ] Did the funded run of about 10 QUSDC, and recorded what the chain showed
- [ ] Withdrew the builder's earnings, and recorded it
- [ ] Ran `pnpm evidence:check` and `pnpm evidence:summary`, and read them

The live web app (nothing below has been done by Claude Code, and each box stays empty until you tick it):

- [ ] Set the web project's settings, including `NEXT_PUBLIC_TOOLS_URL` and a session cap I chose ([DEPLOY-WEB.md](DEPLOY-WEB.md))
- [ ] Added the web site's origin to the facilitator's and the tool server's lists of allowed sites
- [ ] Did the live demo once on the testnet with a small amount, from a real wallet, and wrote down what the wallet showed
- [ ] Did the live demo once on mainnet with the smallest deposit, and recorded it
- [ ] Checked `/status` and `/api/status` on the deployed site, and set the alert hooks and the daily checks in [OPERATIONS.md](OPERATIONS.md)
- [ ] Did the kill-switch drill and the journal restore drill from [OPERATIONS.md](OPERATIONS.md) on the hosted services
- [ ] Had a lawyer read the terms and the privacy notice ([TERMS.md](TERMS.md), [PRIVACY.md](PRIVACY.md)), changed them, and noted who and when
- [ ] Read `/security` against what I know of the deployment, and corrected anything that is not so

Other people:

- [ ] Sent the outreach messages I chose to send ([OUTREACH.md](OUTREACH.md)), and noted to whom
- [ ] Read each "I tried Sluice" report, and replied
