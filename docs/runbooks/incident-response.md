# Runbook — Security incident and personal-data breach response

**Owner:** the operator (there is one).
**Satisfies:** SPEC-004 BR-004-19 and its acceptance criterion.
**Legal basis for the deadlines below:** LGPD arts. 46–48 and ANPD Resolução
CD/ANPD nº 15/2024, which fixes the notification window this runbook counts
from.

This is written to be usable at 3am by someone who is frightened. It is
deliberately short, ordered, and states what *not* to do as often as what to do.

---

## 0. What counts

An **incident** is any unauthorised access to, loss of, alteration of, or
disclosure of personal data — accidental or not. It does not require an
attacker. The three most likely ones here are:

| | Looks like |
|---|---|
| **Cross-tenant leak** | one user sees another's holdings — an RLS policy missing, or a query that ran outside `withTenant` |
| **PII in a log or error report** | a CPF, an e-mail or a raw extract row reaching Pino output or Sentry |
| **Database or host compromise** | credentials leaked, unexpected superuser session, the VPS itself |

A **near miss** — a defect found before any data moved — is not a breach and
is not notifiable. Record it anyway (§6); the distinction is decided by
evidence, not by hope, so do §1 and §2 first and classify afterwards.

---

## 1. Contain — first 30 minutes

Do these in order. Do not skip ahead to diagnosis.

1. **Stop the bleeding without destroying evidence.** Prefer taking the
   application offline to deleting anything:
   - `docker compose stop web worker` on the VPS, leaving Postgres running.
   - Caddy will serve its error page; that is an acceptable outcome and a far
     better one than continuing to serve wrong data.
2. **Do not `docker compose down -v`, do not truncate a table, do not rotate
   away the logs.** Volumes and logs are the only record of what happened, and
   an ANPD notification requires you to describe scope. Destroying it is worse
   than the incident.
3. **Snapshot the evidence before you change anything else**:
   - `docker compose logs --no-color --since 72h > incident-<date>.log`
   - `pg_dump` the affected tables if a data defect is suspected.
   - Copy both off the VPS immediately.
4. **Revoke credentials only if they are implicated.** If they are, rotate in
   this order: database role password → `AUTH_SECRET` (this signs out every
   user, which is the point) → Google OAuth client secret → Sentry DSN → brapi
   token. Rotating `AUTH_SECRET` is cheap and should be the default when there
   is any doubt about session integrity.
5. **Note the clock.** Write down the time you became aware. Every deadline
   below counts from that moment, not from when you finished investigating.

---

## 2. Assess — what actually moved

Answer these five, in writing, before deciding whether to notify. The ANPD
form asks for all of them.

1. **What categories of data?** For this product: identity (name, e-mail,
   Google profile picture), and financial holdings — transactions, positions,
   wallets, valuations. **CPF should never appear**: it is stripped at parse
   time and never persisted (SPEC-004 BR-004-02). *If a CPF is found anywhere,
   that is itself a second incident* — the stripping failed — and it raises the
   severity, because financial identifiers materially increase the risk to the
   data subject.
2. **How many data subjects?** Count rows, do not estimate.
3. **Which users?** Get the list of `users.id` and their e-mails; §4 needs it.
4. **Was the data readable?** At rest in Postgres it is not encrypted at the
   column level, so assume readable unless you can prove otherwise.
5. **Is it ongoing?** If you cannot answer, the service stays down.

**Financial holdings are sensitive in effect if not in the letter of art. 5.**
A leak here tells someone what a named person owns and how much they have. Do
not talk yourself into a low-risk classification because no "dado sensível"
category is formally implicated.

---

## 3. Notify the ANPD

**Deadline: 3 business days from becoming aware**, when the incident may pose
relevant risk or damage to data subjects (Res. CD/ANPD nº 15/2024).

- **Channel:** the ANPD's *Comunicação de Incidente de Segurança* electronic
  form, via gov.br. Do not e-mail it; the form is the record.
- **Notify on incomplete information rather than late.** The regulation
  expects a complete-as-possible first communication and permits supplementing
  it. A late complete notification is a second violation on top of the first.
- **When in doubt, notify.** The cost of an unnecessary notification is
  paperwork. The cost of a missed one is a sanction plus the finding that the
  controller concealed it.

The form needs: what happened, when, the categories and volume from §2, the
risk to data subjects, the containment already performed, and the mitigation
planned. §2's written answers are that document.

---

## 4. Notify the affected users

**Deadline: the same 3 business days**, in the same reasonable period as the
ANPD, to each affected data subject.

- **Who sends it:** the operator, from the published privacy channel
  (`DATA_PROTECTION_CONTACT` in `src/app/privacy-policy/contact.ts`). Note that
  this address is still a placeholder — an incident before the domain is
  registered means sending from whatever address the operator can actually
  prove control of, and saying so in the message.
- **Language: pt-BR, plain.** The reader is not a lawyer and is worried about
  their money.
- **Say, in this order:** what happened; what data of *theirs* was involved;
  what the risk to them is; what has already been done; what they should do
  (in practice: review their Google account's connected apps, and be alert to
  phishing that names their actual holdings); and how to reach you.
- **Do not** minimise, do not promise a cause before you have one, and do not
  send a single vague notice to everyone when only some users were affected —
  over-notifying erodes the notice's meaning for the people who matter.
- **Consent status is irrelevant here.** A user who declined reminder e-mails
  still gets a breach notification; it is a legal obligation, not marketing.

---

## 5. Recover

1. Fix the defect. If it is a cross-tenant leak, the fix is **not** a query
   filter — it is the missing RLS policy plus the `withTenant` wrapper (AR-11,
   AR-14), because a filter is one refactor away from being dropped again.
2. **Add the test that would have caught it, before redeploying.** For an
   isolation defect that means a two-tenant test in `tests/isolation/`; for PII
   in logs, an assertion in `tests/integration/pii-log-scan.test.ts`. A fix
   without a regression test is a scheduled recurrence.
3. Run the full gate — including `pnpm test:isolation` — then deploy and bring
   `web` and `worker` back up.
4. Verify with real data that the leak is closed before announcing recovery.

---

## 6. Record

- **`AuditLog`** captures operator access to personal data (BR-004-17). Any
  querying you did during §2 is operator access and belongs there.
- **Open a GitHub issue** with the §2 answers, the timeline, the fix and the
  test. Mark it clearly; it is the evidence of compliance if the ANPD asks.
- **Update this runbook** if any step was wrong or missing when you needed it.

---

## Known gaps, stated rather than hidden

- **There are no backups yet** ([BL-001](https://github.com/rafaelfqueiroz/allmywallet/issues/1)).
  A destructive incident is currently unrecoverable, and the trigger for fixing
  that is the first real user account — earlier than launch.
- **There is no staging environment** ([BL-003](https://github.com/rafaelfqueiroz/allmywallet/issues/3)),
  so a fix under incident conditions goes straight to production. That raises
  the value of step 5.2 considerably: the regression test is the only
  rehearsal available.
- **The privacy contact address is a placeholder** until a domain is registered
  ([#47](https://github.com/rafaelfqueiroz/allmywallet/issues/47)). §4 says what
  to do in the meantime.
