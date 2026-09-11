-- ============================================================================
-- DISTRIBUTION (Sales Reps) — schema
-- ----------------------------------------------------------------------------
-- Store -> Sales Rep (van stock) -> Sale.
--
--   sales_reps            directory of field reps (no login required)
--   stock_dispatches      Store issues goods OUT to a rep (single step:
--   + stock_dispatch_items   store stock drops immediately, rep stock rises)
--   rep_stock             the rep's current van-stock balance, per product
--   rep_stock_movements   per-rep stock audit trail (mirrors inventory_movements)
--   rep_returns           rep hands unsold/damaged goods back -> staged
--   + rep_return_items       received -> inspected (accept/damage/reject split),
--                            only the accepted portion re-enters store stock
--   rep_remittances       cash the rep hands in (reconciliation record only)
--
-- Plus sales.sales_rep_id / debts.sales_rep_id so a rep sale and the credit
-- it books are attributable to the rep for their account.
--
-- Write access: sales_reps is a plain-CRUD directory table (like customers).
-- Every other table here is RPC-only (no INSERT/UPDATE policy) exactly like
-- sales_returns / damage_records in 20260820090000 — quantities only ever
-- move through the SECURITY DEFINER functions in the next migration.
-- ============================================================================

-- ============ 1. sales_reps ============
CREATE TABLE public.sales_reps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  code text,
  full_name text NOT NULL,
  phone text,
  user_id uuid REFERENCES auth.users(id),
  employee_id uuid REFERENCES public.employees(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (factory_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_reps TO authenticated;
GRANT ALL ON public.sales_reps TO service_role;
ALTER TABLE public.sales_reps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sales reps read" ON public.sales_reps FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));
CREATE POLICY "sales reps insert" ON public.sales_reps FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'distribution'::module_key, 'create'::action_key));
CREATE POLICY "sales reps update" ON public.sales_reps FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'edit'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'distribution'::module_key, 'edit'::action_key));
CREATE POLICY "sales reps delete" ON public.sales_reps FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'delete'::action_key));
CREATE TRIGGER sales_reps_touch BEFORE UPDATE ON public.sales_reps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ 2. stock_dispatches (+ items) ============
CREATE TABLE public.stock_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  dispatch_number text UNIQUE NOT NULL,
  dispatch_date date NOT NULL DEFAULT current_date,
  sales_rep_id uuid NOT NULL REFERENCES public.sales_reps(id),
  vehicle_id uuid REFERENCES public.vehicles(id),
  driver_id uuid REFERENCES public.drivers(id),
  route_id uuid REFERENCES public.delivery_routes(id),
  total_value numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  notes text,
  reversed_by uuid REFERENCES auth.users(id),
  reversed_at timestamptz,
  reverse_reason text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.stock_dispatches TO authenticated;
GRANT ALL ON public.stock_dispatches TO service_role;
ALTER TABLE public.stock_dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock dispatches read" ON public.stock_dispatches FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));
-- No INSERT/UPDATE policy: RPC-only.

CREATE TABLE public.stock_dispatch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.stock_dispatches(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  line_value numeric(14,2) NOT NULL DEFAULT 0
);
GRANT SELECT ON public.stock_dispatch_items TO authenticated;
GRANT ALL ON public.stock_dispatch_items TO service_role;
ALTER TABLE public.stock_dispatch_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock dispatch items read" ON public.stock_dispatch_items FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));

-- ============ 3. rep_stock — the rep's van-stock balance ============
CREATE TABLE public.rep_stock (
  sales_rep_id uuid NOT NULL REFERENCES public.sales_reps(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sales_rep_id, product_id)
);
GRANT SELECT ON public.rep_stock TO authenticated;
GRANT ALL ON public.rep_stock TO service_role;
ALTER TABLE public.rep_stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rep stock read" ON public.rep_stock FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));

-- ============ 4. rep_stock_movements — per-rep audit trail ============
-- movement_type is a plain text CHECK (not the inventory_movements ENUM) so
-- the rep-side vocabulary can evolve on its own.
CREATE TABLE public.rep_stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  sales_rep_id uuid NOT NULL REFERENCES public.sales_reps(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  movement_type text NOT NULL CHECK (movement_type IN
    ('dispatch_in','sold','returned_out','damaged_out','reversal','adjustment')),
  quantity numeric(14,3) NOT NULL,
  reference text,
  reason text,
  user_id uuid REFERENCES auth.users(id),
  quantity_before numeric(14,3),
  quantity_after numeric(14,3),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.rep_stock_movements TO authenticated;
GRANT ALL ON public.rep_stock_movements TO service_role;
ALTER TABLE public.rep_stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rep stock movements read" ON public.rep_stock_movements FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));
CREATE INDEX idx_rep_stock_movements_rep ON public.rep_stock_movements(sales_rep_id, created_at);

-- ============ 5. rep_returns (+ items) — staged received -> inspected ============
CREATE TABLE public.rep_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  return_number text UNIQUE NOT NULL,
  sales_rep_id uuid NOT NULL REFERENCES public.sales_reps(id),
  return_date date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','completed','cancelled')),
  received_by uuid NOT NULL REFERENCES auth.users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  inspected_by uuid REFERENCES auth.users(id),
  inspected_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.rep_returns TO authenticated;
GRANT ALL ON public.rep_returns TO service_role;
ALTER TABLE public.rep_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rep returns read" ON public.rep_returns FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));

CREATE TABLE public.rep_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_return_id uuid NOT NULL REFERENCES public.rep_returns(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity_returned numeric(14,3) NOT NULL CHECK (quantity_returned > 0),
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  accepted_quantity numeric(14,3),
  damaged_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  rejected_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  -- When true (default) the rep stays liable for the damaged/rejected value
  -- (it is NOT credited to their account). The inspector can flip it to
  -- write the damage off to the company.
  charge_rep boolean NOT NULL DEFAULT true
);
GRANT SELECT ON public.rep_return_items TO authenticated;
GRANT ALL ON public.rep_return_items TO service_role;
ALTER TABLE public.rep_return_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rep return items read" ON public.rep_return_items FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));

-- ============ 6. rep_remittances — cash the rep hands in ============
-- Reconciliation record only. The cash itself was already recognised in
-- payments_received when the rep sold (create_sale), so this is NOT posted
-- to cash_transactions (that table exists precisely to avoid double-booking
-- money that already has a home elsewhere — see 20260724090000).
CREATE TABLE public.rep_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  remittance_number text UNIQUE NOT NULL,
  sales_rep_id uuid NOT NULL REFERENCES public.sales_reps(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_method public.payment_method NOT NULL DEFAULT 'cash',
  remittance_date date NOT NULL DEFAULT current_date,
  received_by uuid REFERENCES auth.users(id),
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.rep_remittances TO authenticated;
GRANT ALL ON public.rep_remittances TO service_role;
ALTER TABLE public.rep_remittances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rep remittances read" ON public.rep_remittances FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));

-- ============ 7. attribute a sale + its credit to the rep ============
ALTER TABLE public.sales ADD COLUMN sales_rep_id uuid REFERENCES public.sales_reps(id);
ALTER TABLE public.debts ADD COLUMN sales_rep_id uuid REFERENCES public.sales_reps(id);
CREATE INDEX idx_sales_sales_rep ON public.sales(sales_rep_id);
CREATE INDEX idx_debts_sales_rep ON public.debts(sales_rep_id);
