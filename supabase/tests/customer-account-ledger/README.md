# Customer account ledger tests

Two suites run the customer-account migrations
(`20260924110000_customer_account_ledger.sql`, `20260924120000_customer_ledger_reversal_audit.sql`,
`20260924130000_customer_account_rpc_hardening.sql`) against `stub.sql`, a minimal stand-in for the
Supabase schema (users, roles, `has_permission`, sales/payments/debts tables, workflow engine).

## 1. Functional suite — `test.mjs` (PGlite, no Docker needed)

The ten scenarios from the feature spec plus reversals, write-offs, idempotency, maker-checker
adjustments, permissions and reconciliation.

    mkdir /tmp/pgt && cd /tmp/pgt && npm i @electric-sql/pglite
    cp <repo>/supabase/tests/customer-account-ledger/{stub.sql,test.mjs} .
    node test.mjs <m1.sql> <m2.sql> <m3.sql>

## 2. Security + concurrency suite — `real.mjs` (real Postgres 16)

Needs Docker. Real `anon` / `authenticated` roles, real row-level security, and many parallel
sessions (PGlite is single-connection, so it cannot test this).

    docker run -d --name pgc -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
    mkdir /tmp/pgr && cd /tmp/pgr && npm i pg
    cp <repo>/supabase/tests/customer-account-ledger/{stub.sql,real.mjs} .
    node real.mjs <m1.sql> <m2.sql> <m3.sql>

Covers: anonymous access denied; row-level security on the ledger and summary view; no direct
writes to the ledger, adjustments or cached balances; internal helper functions not callable by
clients; who may record / request / approve / cancel; tenant isolation; input validation;
all-or-nothing behaviour of a failing sale; 12 sales racing for one advance; the same sale
approved 8 times at once; duplicate submits with one idempotency key; 40 mixed operations on one
customer; a deadlock probe (approvals, payments, advances, adjustments, write-offs, reversals);
independent customers not blocking each other; and a whole-database consistency check
(cached balance = ledger = per-invoice debts, no negative balance, unbroken balance chain).

To stress harder, raise the round count in the deadlock probe (`round < 6`).
