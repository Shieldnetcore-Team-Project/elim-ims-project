-- ============================================================================
-- COSTING CALCULATOR + DUAL CONTROL — schema
-- ----------------------------------------------------------------------------
-- Adds the calculation fields needed to automate the water/nylon worksheet
-- logic (percentage-based overhead, packaging/selling-unit step, candidate
-- selling-price comparison) and closes the dual-control gap: costing_officer
-- could previously create a sheet AND immediately overwrite the live
-- product's cost_price in one call, no second reviewer.
-- ============================================================================

-- ============ 1. Calculator fields ============
ALTER TABLE public.costing_sheets ADD COLUMN overhead_percent numeric(6,3);
ALTER TABLE public.costing_sheets ADD COLUMN pack_quantity numeric(14,3) NOT NULL DEFAULT 1 CHECK (pack_quantity > 0);
ALTER TABLE public.costing_sheets ADD COLUMN pack_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (pack_cost >= 0);
ALTER TABLE public.costing_sheets ADD COLUMN cost_per_pack numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_per_pack >= 0);

-- ============ 2. Dual-control columns (mirrors production's pattern --
-- reuse existing created_by/created_at as the submit actor/timestamp) ============
ALTER TABLE public.costing_sheets ADD COLUMN status public.workflow_status;
ALTER TABLE public.costing_sheets ADD COLUMN approved_by uuid REFERENCES auth.users(id);
ALTER TABLE public.costing_sheets ADD COLUMN approved_at timestamptz;
ALTER TABLE public.costing_sheets ADD COLUMN reject_reason text;

-- Backfill: every existing row was already atomically applied under the old RPC.
UPDATE public.costing_sheets SET status = 'posted', approved_by = created_by, approved_at = created_at
WHERE status IS NULL;

ALTER TABLE public.costing_sheets ALTER COLUMN status SET DEFAULT 'pending_approval';
ALTER TABLE public.costing_sheets ALTER COLUMN status SET NOT NULL;

-- ============ 3. applied_to_product (intent) vs is_applied (derived fact) --
-- don't let "was it actually applied" drift independently from status. ============
ALTER TABLE public.costing_sheets RENAME COLUMN applied_to_product TO apply_to_product;
ALTER TABLE public.costing_sheets ADD COLUMN is_applied boolean
  GENERATED ALWAYS AS (status = 'posted' AND apply_to_product) STORED;

-- ============ 4. workflow_configs seed -- no new workflow_transitions rows
-- needed: pending_approval -> posted/rejected/cancelled already exist. ============
INSERT INTO public.workflow_configs (module, transaction_type, maker_label, checker_label, final_status, required_approvals, description) VALUES
  ('costing', 'costing_sheet_approval', 'Costing Officer', 'Accountant / Chairman', 'posted', 1,
   'Costing sheet computed by the Costing Officer, reviewed by Accountant or Chairman before its unit cost is applied to the product.')
ON CONFLICT (module) DO NOTHING;

-- ============ 5. Candidate selling-price comparison, persisted (matches
-- both worksheets showing the actual comparison considered, not a
-- throwaway calc) ============
CREATE TABLE public.costing_price_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES public.costing_sheets(id) ON DELETE CASCADE,
  proposed_price numeric(14,2) NOT NULL CHECK (proposed_price >= 0),
  margin numeric(14,2) NOT NULL,
  margin_percent numeric(6,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.costing_price_options TO authenticated;
GRANT ALL ON public.costing_price_options TO service_role;
ALTER TABLE public.costing_price_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "costing price options read" ON public.costing_price_options FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'costing'::module_key, 'view'::action_key));
-- RPC-only writes, no INSERT/UPDATE/DELETE policy.

-- ============ 6. RLS lockdown: costing becomes RPC-only ============
REVOKE INSERT, UPDATE, DELETE ON public.costing_sheets FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.costing_sheet_items FROM authenticated;
DROP POLICY IF EXISTS "costing sheets write" ON public.costing_sheets;
DROP POLICY IF EXISTS "costing sheet items write" ON public.costing_sheet_items;
-- "costing sheets read" / "costing sheet items read" (SELECT) stay unchanged.
