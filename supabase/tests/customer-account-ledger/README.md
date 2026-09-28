# Customer account ledger tests

Two suites run the customer-account migrations
(`20260924110000_customer_account_ledger.sql`, `20260924120000_customer_ledger_reversal_audit.sql`,
`20260924130000_customer_account_rpc_hardening.sql`, `20260928110000_customer_account_ledger_gaps.sql`)
against `stub.sql`, a minimal stand-in for the
Supabase schema (users, roles, `has_permission`, sales/payments/debts tables, workflow engine).

## 1. Functional suite — `test.mjs` (PGlite, no Docker needed)

The ten scenarios from the feature spec plus reversals, write-offs, idempotency, maker-checker
adjustments, permissions and reconciliation. The gaps migration adds full replay of a repeated
idempotency key, refusing to restore a reversed sale, and the void lock-order rewrite.

    mkdir /tmp/pgt && cd /tmp/pgt && npm i @electric-sql/pglite
    cp <repo>/supabase/tests/customer-account-ledger/{stub.sql,test.mjs} .
    node test.mjs <m1.sql> <m2.sql> <m3.sql> <m4.sql>

## 2. Security + concurrency suite — `real.mjs` (real Postgres 16)

Needs Docker. Real `anon` / `authenticated` roles, real row-level security, and many parallel
sessions (PGlite is single-connection, so it cannot test this).

    docker run -d --name pgc -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
    mkdir /tmp/pgr && cd /tmp/pgr && npm i pg
    cp <repo>/supabase/tests/customer-account-ledger/{stub.sql,real.mjs} .
    node real.mjs <m1.sql> <m2.sql> <m3.sql> <m4.sql>

Covers: anonymous access denied; row-level security on the ledger and summary view; no direct
writes to the ledger, adjustments or cached balances; internal helper functions not callable by
clients; who may record / request / approve / cancel; tenant isolation; input validation;
all-or-nothing behaviour of a failing sale; 12 sales racing for one advance; the same sale
approved 8 times at once; duplicate submits with one idempotency key; 40 mixed operations on one
customer; a deadlock probe (approvals, payments, advances, adjustments, write-offs, reversals);
independent customers not blocking each other; and a whole-database consistency check
(cached balance = ledger = per-invoice debts, no negative balance, unbroken balance chain).

To stress harder, raise the round count in the deadlock probe (`round < 6`).

## 3. Credit terms — `credit-terms.mjs` (PGlite)

Runs the four migrations above plus `20260928120000_customer_credit_terms.sql`: due dates from the
customer's payment terms, the recovery date following the debt's status (including a reversed
payment reopening it), credit-limit enforcement on sale approval (admin override, limit 0, no
limit), who may set terms, and the customers column lockdown (balances and credit terms not
directly writable; the Customers form's own fields still are).

    node credit-terms.mjs <m1.sql> <m2.sql> <m3.sql> <m4.sql> <credit-terms.sql>

## 4. Marketer commission — `commission.mjs` (PGlite)

Adds `20260928130000_marketer_commission.sql` on top of the five above (and minimal sales-rep,
remittance and sales-return tables): who may set a rate, rates captured on approval and not
rewritten by later rate changes, accepted returns taking commission back, deleted and non-rep
sales earning none, period filtering, remittance totals and access.

    node commission.mjs <m1.sql> <m2.sql> <m3.sql> <m4.sql> <credit-terms.sql> <commission.sql>

## 5. Bottle tracking — `containers.mjs` (PGlite)

Adds `20260928140000_container_tracking.sql` on top of the six above (with minimal dispatch,
rep-return and sales-return tables): containers moving automatically on dispatch, direct and
marketer sales, rep and customer returns, and undone on dispatch reversal, cancelled returns and
deleted sales; manual returns, issues, write-offs and purchases with their permissions; every
container accounted for; no edits or direct writes.

    node containers.mjs <m1.sql> <m2.sql> <m3.sql> <m4.sql> <credit-terms.sql> <commission.sql> <containers.sql>

## 6. Marketer's customers — `rep-customers.mjs` (PGlite)

Adds `20260928150000_rep_customer_accounts.sql` on top of the five customer-account and credit-terms
migrations: only the marketer's own approved sales, later payments and advance counted as paid,
outstanding per invoice, walk-in names, period filter, deleted sales left out, and access.

    node rep-customers.mjs <m1.sql> <m2.sql> <m3.sql> <m4.sql> <credit-terms.sql> <rep-customers.sql>

## 7. Assigned customers and marketer collections — `rep-collections.mjs` (PGlite)

Adds `20260928160000_rep_customer_assignment_and_collections.sql` on top of the six above (with
minimal dispatch, return and remittance tables): assigning a marketer from the Customers form,
same-factory checks, assigned customers listed before a first sale, the collecting marketer stored
on the payment, the marketer's balance unchanged by collections and office payments on their
credit (and by reversals), walk-in collections, invoices of assigned customers sold by the
warehouse, and approved-only sales counts.

    node rep-collections.mjs <m1.sql> <m2.sql> <m3.sql> <m4.sql> <credit-terms.sql> <rep-customers.sql> <collections.sql>
