# Migration history

`20260101000001` … `20260101000016` are the 16 original hand-authored migrations from
`database/postgres/migrations/`, copied in verbatim (one added provenance comment per
file, no other changes) as the starting point for this Supabase-CLI-managed history.
Everything from `20260803120000` onward is new work layered on top — auth linkage,
audit-actor columns, Row Level Security, storage, realtime, and notifications.

**This directory (`supabase/migrations/`) is the canonical migration history going
forward.** `database/postgres/` is not applied to any environment anymore — it remains
the original design documentation:

- `database/postgres/docs/ERD.md` — entity-relationship diagram
- `database/postgres/docs/RELATIONSHIPS.md` — business-process flow + full FK/trigger inventory
- `database/postgres/docs/NORMALIZATION.md` — the 1NF→3NF/BCNF walkthrough and every
  documented trade-off (append-only ledgers, polymorphic references, cached
  `sales_orders.total_amount`, why there's no `is_active` column, etc.) that the
  migrations in this directory still follow.

Run `supabase db reset` (local) or `supabase db push` (remote) from the repo root —
never run these files directly against a database with `psql`; let the CLI track what's
already applied.
