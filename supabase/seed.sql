-- Run automatically by `supabase db reset` after every migration in
-- supabase/migrations/ has applied. One seed source of truth — the actual
-- demo/transactional data lives in database/postgres/seed/seed.sql (design
-- documentation directory, see supabase/migrations/README.md) rather than
-- being duplicated here.
\i ../database/postgres/seed/seed.sql
