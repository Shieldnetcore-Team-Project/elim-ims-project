-- ============================================================================
-- Chairman's gifts: products the Warehouse gives out on the chairman's request
-- ----------------------------------------------------------------------------
-- Warehouse → Post → Others → Chairman's gift. The warehouse manager records
-- the products and quantities; each line's unit cost is taken from the
-- product (products.cost_price) and the gift is posted straight away:
--   * stock leaves the Warehouse (products.current_stock, inventory_movements)
--   * nothing is billed or owed and it is never revenue -- no sale is created
--   * it reaches the Accountant page (Postings tab) as a "Chairman's gift"
--     posting for Accounting to review and record (assess_posting), with no
--     payment to enter
-- ============================================================================

-- ============ Tables ============
CREATE TABLE IF NOT EXISTS public.chairmans_gifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  gift_number text NOT NULL UNIQUE,
  gift_date date NOT NULL DEFAULT CURRENT_DATE,
  recipient text,
  notes text,
  total_value numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
  created_by uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chairmans_gifts_factory_idx ON public.chairmans_gifts(factory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.chairmans_gift_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_id uuid NOT NULL REFERENCES public.chairmans_gifts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit_cost numeric NOT NULL DEFAULT 0,
  line_value numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chairmans_gift_items_gift_idx ON public.chairmans_gift_items(gift_id);

GRANT SELECT ON public.chairmans_gifts, public.chairmans_gift_items TO authenticated;
GRANT ALL ON public.chairmans_gifts, public.chairmans_gift_items TO service_role;
ALTER TABLE public.chairmans_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chairmans_gift_items ENABLE ROW LEVEL SECURITY;

-- Readable by the Warehouse (finished goods) and by Accounting (finance).
DROP POLICY IF EXISTS "chairmans gifts read" ON public.chairmans_gifts;
CREATE POLICY "chairmans gifts read" ON public.chairmans_gifts FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key));
DROP POLICY IF EXISTS "chairmans gift items read" ON public.chairmans_gift_items;
CREATE POLICY "chairmans gift items read" ON public.chairmans_gift_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.chairmans_gifts g WHERE g.id = gift_id));

-- ============ Post a gift ============
CREATE OR REPLACE FUNCTION public.post_chairmans_gift(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'gift_date','')::date, CURRENT_DATE);
  v_recipient text := NULLIF(btrim(COALESCE(payload->>'recipient','')), '');
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes','')), '');
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_product public.products%ROWTYPE;
  v_qty numeric;
  v_cost numeric;
  v_total numeric := 0;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'Add at least one product'; END IF;

  -- Validate every line first (all-or-nothing).
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_product.current_stock < v_qty THEN
      RAISE EXCEPTION 'Insufficient warehouse stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
    END IF;
  END LOOP;

  v_number := 'CGF-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO chairmans_gifts(factory_id, gift_number, gift_date, recipient, notes, created_by)
  VALUES (v_factory, v_number, v_date, v_recipient, v_notes, v_uid)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    v_qty := (v_item->>'quantity')::numeric;
    -- Unit cost is the product's own, never typed in.
    v_cost := COALESCE(v_product.cost_price, 0);
    v_total := v_total + v_qty * v_cost;

    INSERT INTO chairmans_gift_items(gift_id, product_id, quantity, unit_cost, line_value)
    VALUES (v_id, v_product.id, v_qty, v_cost, v_qty * v_cost);

    UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product.id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_product.id, 'issued', v_qty, v_number,
            'Chairman''s gift' || COALESCE(' to ' || v_recipient, ''), v_uid,
            v_product.current_stock, v_product.current_stock - v_qty);
  END LOOP;

  UPDATE chairmans_gifts SET total_value = v_total WHERE id = v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'post_chairmans_gift', 'chairmans_gift', v_id::text,
          jsonb_build_object('gift_number', v_number, 'recipient', v_recipient, 'total_value', v_total));

  RETURN jsonb_build_object('id', v_id, 'gift_number', v_number, 'total_value', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.post_chairmans_gift(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_chairmans_gift(jsonb) TO authenticated;

-- ============ Accounting: gifts are postings too ============
ALTER TABLE public.posting_assessments DROP CONSTRAINT IF EXISTS posting_assessments_posting_kind_check;
ALTER TABLE public.posting_assessments ADD CONSTRAINT posting_assessments_posting_kind_check
  CHECK (posting_kind IN ('dispatch', 'sale', 'gift'));

CREATE OR REPLACE FUNCTION public.assess_posting(p_kind text, p_id uuid, p_remarks text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_factory uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
     OR NOT (public.has_permission(auth.uid(), 'payments'::module_key, 'write'::action_key)
          OR public.has_permission(auth.uid(), 'debts'::module_key, 'write'::action_key)
          OR public.has_permission(auth.uid(), 'distribution'::module_key, 'post'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_kind = 'dispatch' THEN
    SELECT factory_id INTO v_factory FROM stock_dispatches WHERE id = p_id;
  ELSIF p_kind = 'sale' THEN
    SELECT factory_id INTO v_factory FROM sales WHERE id = p_id AND deleted_at IS NULL;
  ELSIF p_kind = 'gift' THEN
    SELECT factory_id INTO v_factory FROM chairmans_gifts WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Unknown posting kind %', p_kind;
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'Posting not found'; END IF;

  INSERT INTO posting_assessments (factory_id, posting_kind, posting_id, remarks, assessed_by, assessed_at)
  VALUES (v_factory, p_kind, p_id, NULLIF(btrim(COALESCE(p_remarks, '')), ''), auth.uid(), now())
  ON CONFLICT (posting_kind, posting_id) DO UPDATE
     SET remarks = EXCLUDED.remarks, assessed_by = EXCLUDED.assessed_by, assessed_at = EXCLUDED.assessed_at
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.assess_posting(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assess_posting(text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.accounting_postings(p_factory uuid, p_limit int DEFAULT 300)
RETURNS TABLE(kind text, posting_kind text, posting_id uuid, reference text, at timestamptz,
              party_id uuid, party text, items text, value numeric, paid numeric,
              balance numeric, status text, assessed_at timestamptz, assessed_by text,
              assessment_remarks text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT a.*, pa.assessed_at, pf.full_name, pa.remarks
    FROM (
      SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END AS kind,
             'dispatch'::text AS posting_kind,
             d.id AS posting_id,
             d.dispatch_number AS reference,
             d.created_at AS at,
             sr.id AS party_id,
             sr.full_name AS party,
             (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
                FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
               WHERE i.dispatch_id = d.id) AS items,
             COALESCE((SELECT SUM(i.line_value) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
                      d.total_value)::numeric AS value,
             NULL::numeric AS paid,
             NULL::numeric AS balance,
             d.status AS status
        FROM stock_dispatches d
        JOIN sales_reps sr ON sr.id = d.sales_rep_id
       WHERE d.factory_id = p_factory

      UNION ALL
      SELECT 'distributor', 'sale', s.id, s.invoice_number, s.created_at,
             c.id, c.name,
             (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
                FROM sale_items i JOIN products p ON p.id = i.product_id
               WHERE i.sale_id = s.id),
             s.grand_total::numeric, s.amount_paid::numeric, s.balance::numeric, s.status::text
        FROM sales s
        JOIN customers c ON c.id = s.customer_id AND c.registered
       WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
         AND NOT COALESCE(s.is_pr, false)

      -- Chairman's gifts: value at cost, nothing to pay.
      UNION ALL
      SELECT 'chairmans_gift', 'gift', g.id, g.gift_number, g.created_at,
             NULL::uuid, COALESCE(g.recipient, 'Chairman''s request'),
             (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
                FROM chairmans_gift_items i JOIN products p ON p.id = i.product_id
               WHERE i.gift_id = g.id),
             g.total_value::numeric, NULL::numeric, NULL::numeric, g.status
        FROM chairmans_gifts g
       WHERE g.factory_id = p_factory
    ) a
    LEFT JOIN posting_assessments pa ON pa.posting_kind = a.posting_kind AND pa.posting_id = a.posting_id
    LEFT JOIN profiles pf ON pf.id = pa.assessed_by
   ORDER BY a.at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 300), 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION public.accounting_postings(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accounting_postings(uuid, int) TO authenticated;
