-- ============================================================================
-- FIX: duplicate user_roles rows for factory-less roles
-- ----------------------------------------------------------------------------
-- user_roles was created with UNIQUE(user_id, role, factory_id). Postgres
-- treats NULLs as DISTINCT in a unique constraint, so for the factory-less
-- roles this app actually grants (handle_new_user inserts (user_id, role) with
-- factory_id NULL, and approve_user/admin_provision_user pass a NULL
-- requested_factory_id for most accounts) the constraint never applied at all:
-- the same (user_id, role) pair could be inserted any number of times, and the
-- `ON CONFLICT (user_id, role, factory_id) DO NOTHING` guards in those RPCs
-- silently deduped nothing.
--
-- Observed fallout: the first admin account had two identical 'super_admin'
-- rows, which broke useIsSuperAdmin() — it read the role with .maybeSingle(),
-- which errors on more than one row, so the query threw, the hook returned
-- undefined, and every admin-only control (the Role x Action matrix, the
-- per-user page-access grid) rendered permanently disabled. The client-side
-- half of that is fixed in src/lib/permissions.ts; this migration fixes the
-- data and stops it recurring.
--
-- Step 1 removes duplicates, keeping the earliest row of each group. Note
-- PARTITION BY groups NULLs together, which is exactly the grouping the unique
-- constraint failed to apply.
--
-- Step 2 swaps in UNIQUE NULLS NOT DISTINCT (Postgres 15+; this project runs
-- 17). The column list is deliberately unchanged so the existing
-- `ON CONFLICT (user_id, role, factory_id)` inference in approve_user and
-- admin_provision_user still resolves to this constraint — and now genuinely
-- dedupes instead of being a no-op.
-- ============================================================================

-- ============ 1. drop duplicates, keep the earliest ============
DELETE FROM public.user_roles
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY user_id, role, factory_id
             ORDER BY created_at, id
           ) AS rn
    FROM public.user_roles
  ) ranked
  WHERE ranked.rn > 1
);

-- ============ 2. make the uniqueness NULL-safe ============
DO $$
DECLARE
  v_name text;
BEGIN
  -- Find the existing unique constraint on exactly (user_id, role, factory_id)
  -- by its columns rather than assuming the auto-generated name.
  SELECT con.conname INTO v_name
  FROM pg_constraint con
  WHERE con.conrelid = 'public.user_roles'::regclass
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname)
      FROM unnest(con.conkey) AS k(attnum)
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    ) = ARRAY['factory_id','role','user_id']
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_roles DROP CONSTRAINT %I', v_name);
  END IF;

  ALTER TABLE public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_factory_id_key
    UNIQUE NULLS NOT DISTINCT (user_id, role, factory_id);
END $$;
