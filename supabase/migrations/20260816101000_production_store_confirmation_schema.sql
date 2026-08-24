-- ============================================================================
-- PRODUCTION -> STORE CONFIRMATION DUAL CONTROL — schema (spec 20/21)
-- ----------------------------------------------------------------------------
-- Splits create_production() (next migration) so Production can no longer
-- directly post finished goods into sale-able stock. Store must confirm
-- (with Actual Received / Damaged / Rejected quantities) before the
-- computed Accepted quantity posts to products.current_stock.
-- ============================================================================

-- ============ 1. New columns on production, no default yet ============
-- Column is added WITHOUT a table-level default first, so every
-- pre-existing row lands NULL (not 'pending_confirmation') until explicitly
-- backfilled below -- an ADD COLUMN ... DEFAULT would stamp every historical
-- (already-posted) row as unconfirmed, which is wrong and unsafe.
ALTER TABLE public.production ADD COLUMN status public.workflow_status;
ALTER TABLE public.production ADD COLUMN confirmed_by uuid REFERENCES auth.users(id);
ALTER TABLE public.production ADD COLUMN confirmed_at timestamptz;
ALTER TABLE public.production ADD COLUMN actual_quantity_received numeric(14,3);
ALTER TABLE public.production ADD COLUMN damaged_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0);
ALTER TABLE public.production ADD COLUMN rejected_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0);
ALTER TABLE public.production ADD COLUMN accepted_quantity numeric(14,3) CHECK (accepted_quantity IS NULL OR accepted_quantity >= 0);
ALTER TABLE public.production ADD COLUMN reject_reason text;

-- ============ 2. Backfill: every existing row was already posted atomically
-- under the OLD create_production() -- stamp it fully confirmed/posted so
-- nothing shows as pending and nothing can ever double-post it. ============
UPDATE public.production
SET status = 'posted', actual_quantity_received = quantity_produced, accepted_quantity = quantity_produced,
    confirmed_by = created_by, confirmed_at = created_at
WHERE status IS NULL;

-- ============ 3. Only now attach the default -- applies solely to rows
-- inserted from this point forward, via the new create_production(). ============
ALTER TABLE public.production ALTER COLUMN status SET DEFAULT 'pending_confirmation';
ALTER TABLE public.production ALTER COLUMN status SET NOT NULL;

-- ============ 4. workflow_transitions: defensive (shared table, likely
-- already present from goods-receiving; no-ops here, kept for clarity) ============
INSERT INTO public.workflow_transitions (from_status, to_status) VALUES ('pending_confirmation','cancelled')
ON CONFLICT DO NOTHING;

-- ============ 5. workflow_configs: 'production' has no existing row
-- (confirmed) -- safe to reuse this module directly, no new module_key
-- value needed. ============
INSERT INTO public.workflow_configs (module, transaction_type, maker_label, checker_label, final_status, required_approvals, description) VALUES
  ('production', 'production_batch_confirmation', 'Production', 'Store', 'posted', 1,
   'Production batch recorded by Production, confirmed with actual/damaged/rejected counts by Store before entering sale-able finished-goods stock.')
ON CONFLICT (module) DO NOTHING;

-- ============ 6. RLS lockdown: production becomes RPC-only ============
-- Closes the actual leak: today anyone holding production:write can
-- UPDATE public.production directly, bypassing the RPC's guard entirely.
REVOKE INSERT, UPDATE, DELETE ON public.production FROM authenticated;
DROP POLICY IF EXISTS "production write" ON public.production;
-- "production read" (SELECT, gated on has_permission(...,'production','read')) stays unchanged.
