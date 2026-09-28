-- ============================================================================
-- Bottle tracking: returnable containers (bottles, crates, dispensers)
-- ----------------------------------------------------------------------------
-- Backs Warehouse -> "Bottle tracking". Counts where every returnable
-- container is: in the warehouse, with a customer, with a marketer (sales
-- rep), gone out with walk-in sales, or written off.
--
--   container_types        what is tracked (19L bottle, crate, dispenser...)
--   product_containers     how many of each container go out with one unit of
--                          a product (19L refill -> 1 x 19L bottle)
--   container_movements    append-only: every move is FROM one holder TO
--                          another, so a holder's balance is what came in
--                          minus what went out. Corrections are new rows.
--   container_balances     view: current balance per holder and container
--
-- Holders: 'warehouse', 'customer' (holder_id = customer), 'sales_rep'
-- (holder_id = rep), 'walk_in' (sales with no registered customer) and
-- 'external' (new containers bought in, containers written off).
--
-- Posted automatically, in the same transaction as the business event:
--   stock dispatch to a rep      warehouse -> rep
--   dispatch reversed            rep -> warehouse
--   sale approved, no rep        warehouse -> customer / walk-in
--   sale approved, through rep   rep -> customer / walk-in
--   posted sale deleted          the sale's moves undone
--   rep returns unsold stock     rep -> warehouse (cancelled: undone)
--   customer returns a product   customer / walk-in -> warehouse (cancelled: undone)
-- Recorded by hand (record_container_movement): empties brought back,
-- containers issued (opening balances, dispensers on loan), lost or damaged
-- containers written off, new containers bought in.
--
-- Balances can go negative when tracking starts part-way (a customer returns
-- bottles they got before tracking began). That's shown, not blocked; record
-- opening balances with an 'issue' to avoid it.
-- ============================================================================

-- ============ 1. Tables ============
CREATE TABLE public.container_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (factory_id, name)
);

CREATE TABLE public.product_containers (
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  container_type_id uuid NOT NULL REFERENCES public.container_types(id) ON DELETE CASCADE,
  quantity_per_unit numeric(10,3) NOT NULL CHECK (quantity_per_unit > 0),
  PRIMARY KEY (product_id, container_type_id)
);

CREATE TABLE public.container_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  container_type_id uuid NOT NULL REFERENCES public.container_types(id),
  from_type text NOT NULL CHECK (from_type IN ('warehouse','customer','sales_rep','walk_in','external')),
  from_id uuid,
  to_type text NOT NULL CHECK (to_type IN ('warehouse','customer','sales_rep','walk_in','external')),
  to_id uuid,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  source text NOT NULL CHECK (source IN (
    'dispatch','dispatch_reversal','sale','sale_reversal','rep_return','rep_return_cancelled',
    'sales_return','sales_return_cancelled','return','issue','lost','purchase','damaged')),
  reference text,
  -- Not foreign keys: history must outlive the rows it points at.
  sale_id uuid,
  dispatch_id uuid,
  rep_return_id uuid,
  sales_return_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((from_type IN ('customer','sales_rep')) = (from_id IS NOT NULL)),
  CHECK ((to_type IN ('customer','sales_rep')) = (to_id IS NOT NULL)),
  CHECK (NOT (from_type = to_type AND from_id IS NOT DISTINCT FROM to_id))
);
CREATE INDEX idx_cm_factory_seq ON public.container_movements (factory_id, seq);
CREATE INDEX idx_cm_from ON public.container_movements (from_type, from_id);
CREATE INDEX idx_cm_to ON public.container_movements (to_type, to_id);
CREATE INDEX idx_cm_sale ON public.container_movements (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX idx_cm_dispatch ON public.container_movements (dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE INDEX idx_cm_rep_return ON public.container_movements (rep_return_id) WHERE rep_return_id IS NOT NULL;
CREATE INDEX idx_cm_sales_return ON public.container_movements (sales_return_id) WHERE sales_return_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public._container_movements_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'container_movements is append-only; record a correcting movement instead';
END;
$$;
CREATE TRIGGER trg_cm_immutable BEFORE UPDATE OR DELETE ON public.container_movements
  FOR EACH ROW EXECUTE FUNCTION public._container_movements_immutable();

-- ============ 2. Access: read with distribution or stock access; write via RPC only ============
ALTER TABLE public.container_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.container_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.container_types, public.product_containers, public.container_movements FROM anon, authenticated;
GRANT SELECT ON public.container_types, public.product_containers, public.container_movements TO authenticated;
GRANT ALL ON public.container_types, public.product_containers, public.container_movements TO service_role;

CREATE OR REPLACE FUNCTION public._can_view_containers()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
$$;
CREATE POLICY "container types read" ON public.container_types FOR SELECT TO authenticated USING (public._can_view_containers());
CREATE POLICY "product containers read" ON public.product_containers FOR SELECT TO authenticated USING (public._can_view_containers());
CREATE POLICY "container movements read" ON public.container_movements FOR SELECT TO authenticated USING (public._can_view_containers());

CREATE OR REPLACE VIEW public.container_balances WITH (security_invoker = true) AS
SELECT factory_id, container_type_id, holder_type, holder_id, SUM(delta) AS balance
  FROM (
    SELECT factory_id, container_type_id, to_type AS holder_type, to_id AS holder_id, quantity AS delta FROM public.container_movements
    UNION ALL
    SELECT factory_id, container_type_id, from_type, from_id, -quantity FROM public.container_movements
  ) m
 GROUP BY factory_id, container_type_id, holder_type, holder_id
HAVING SUM(delta) <> 0;
GRANT SELECT ON public.container_balances TO authenticated;

-- ============ 3. Automatic moves ============
-- One move per container type the product carries.
CREATE OR REPLACE FUNCTION public._container_move_for_product(
  p_factory uuid, p_product uuid, p_units numeric,
  p_from_type text, p_from_id uuid, p_to_type text, p_to_id uuid,
  p_source text, p_reference text, p_sale uuid, p_dispatch uuid, p_rep_return uuid, p_sales_return uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, sale_id, dispatch_id, rep_return_id, sales_return_id, created_by)
  SELECT p_factory, pc.container_type_id, p_from_type, p_from_id, p_to_type, p_to_id, p_units * pc.quantity_per_unit,
         p_source, p_reference, p_sale, p_dispatch, p_rep_return, p_sales_return, auth.uid()
    FROM product_containers pc
    JOIN container_types ct ON ct.id = pc.container_type_id AND ct.active
   WHERE pc.product_id = p_product AND p_units > 0;
END;
$$;
REVOKE ALL ON FUNCTION public._container_move_for_product(uuid,uuid,numeric,text,uuid,text,uuid,text,text,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;

-- Undo: the same moves, reversed, under a new source.
CREATE OR REPLACE FUNCTION public._container_undo(p_column text, p_id uuid, p_source text, p_new_source text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  EXECUTE format(
    'INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                     source, reference, sale_id, dispatch_id, rep_return_id, sales_return_id, created_by)
     SELECT factory_id, container_type_id, to_type, to_id, from_type, from_id, quantity,
            $2, reference, sale_id, dispatch_id, rep_return_id, sales_return_id, auth.uid()
       FROM container_movements WHERE %I = $1 AND source = $3', p_column)
  USING p_id, p_new_source, p_source;
END;
$$;
REVOKE ALL ON FUNCTION public._container_undo(text, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Dispatch: items are inserted after the (already posted) header.
CREATE OR REPLACE FUNCTION public._containers_on_dispatch_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_d stock_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM stock_dispatches WHERE id = NEW.dispatch_id;
  IF FOUND AND v_d.status = 'posted' THEN
    PERFORM public._container_move_for_product(v_d.factory_id, NEW.product_id, NEW.quantity,
      'warehouse', NULL, 'sales_rep', v_d.sales_rep_id, 'dispatch', v_d.dispatch_number, NULL, v_d.id, NULL, NULL);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_containers_dispatch_item AFTER INSERT ON public.stock_dispatch_items
  FOR EACH ROW EXECUTE FUNCTION public._containers_on_dispatch_item();

CREATE OR REPLACE FUNCTION public._containers_on_dispatch_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed' THEN
    PERFORM public._container_undo('dispatch_id', NEW.id, 'dispatch', 'dispatch_reversal');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_containers_dispatch_status AFTER UPDATE OF status ON public.stock_dispatches
  FOR EACH ROW EXECUTE FUNCTION public._containers_on_dispatch_status();

-- Sale approved -> containers go to the customer; posted sale deleted -> undone.
CREATE OR REPLACE FUNCTION public._containers_on_sale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item RECORD;
BEGIN
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' AND NEW.deleted_at IS NULL THEN
    FOR v_item IN SELECT product_id, quantity FROM sale_items WHERE sale_id = NEW.id LOOP
      PERFORM public._container_move_for_product(NEW.factory_id, v_item.product_id, v_item.quantity,
        CASE WHEN NEW.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'warehouse' END, NEW.sales_rep_id,
        CASE WHEN NEW.customer_id IS NOT NULL THEN 'customer' ELSE 'walk_in' END, NEW.customer_id,
        'sale', NEW.invoice_number, NEW.id, NULL, NULL, NULL);
    END LOOP;
  ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.status = 'posted' THEN
    PERFORM public._container_undo('sale_id', NEW.id, 'sale', 'sale_reversal');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_containers_sale AFTER UPDATE OF status, deleted_at ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public._containers_on_sale();

-- Rep brings unsold stock back: its containers come back with it.
CREATE OR REPLACE FUNCTION public._containers_on_rep_return_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r rep_returns%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM rep_returns WHERE id = NEW.rep_return_id;
  IF FOUND AND v_r.status <> 'cancelled' THEN
    PERFORM public._container_move_for_product(v_r.factory_id, NEW.product_id, NEW.quantity_returned,
      'sales_rep', v_r.sales_rep_id, 'warehouse', NULL, 'rep_return', v_r.return_number, NULL, NULL, v_r.id, NULL);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_containers_rep_return_item AFTER INSERT ON public.rep_return_items
  FOR EACH ROW EXECUTE FUNCTION public._containers_on_rep_return_item();

CREATE OR REPLACE FUNCTION public._containers_on_rep_return_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    PERFORM public._container_undo('rep_return_id', NEW.id, 'rep_return', 'rep_return_cancelled');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_containers_rep_return_status AFTER UPDATE OF status ON public.rep_returns
  FOR EACH ROW EXECUTE FUNCTION public._containers_on_rep_return_status();

-- Customer returns a product: its containers come back.
CREATE OR REPLACE FUNCTION public._containers_on_sales_return()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'cancelled' THEN
    PERFORM public._container_move_for_product(NEW.factory_id, NEW.product_id, NEW.quantity_returned,
      CASE WHEN NEW.customer_id IS NOT NULL THEN 'customer' ELSE 'walk_in' END, NEW.customer_id,
      'warehouse', NULL, 'sales_return', NEW.return_number, NEW.sale_id, NULL, NULL, NEW.id);
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    PERFORM public._container_undo('sales_return_id', NEW.id, 'sales_return', 'sales_return_cancelled');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_containers_sales_return AFTER INSERT OR UPDATE OF status ON public.sales_returns
  FOR EACH ROW EXECUTE FUNCTION public._containers_on_sales_return();

-- ============ 4. Setup (distribution:approve) ============
CREATE OR REPLACE FUNCTION public.save_container_type(p_factory uuid, p_id uuid, p_name text, p_active boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'A name is required'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO container_types(factory_id, name, active) VALUES (p_factory, btrim(p_name), COALESCE(p_active, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE container_types SET name = btrim(p_name), active = COALESCE(p_active, active)
     WHERE id = p_id AND factory_id = p_factory RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Container type not found'; END IF;
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), p_factory, 'save_container_type', 'container_types', v_id::text,
          jsonb_build_object('name', btrim(p_name), 'active', COALESCE(p_active, true)));
  RETURN v_id;
END;
$$;

-- p_quantity 0 (or NULL) removes the link.
CREATE OR REPLACE FUNCTION public.set_product_container(p_product uuid, p_container_type uuid, p_quantity numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_factory uuid;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT factory_id INTO v_factory FROM container_types WHERE id = p_container_type;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'Container type not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_product AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Product not found for this factory';
  END IF;
  IF COALESCE(p_quantity, 0) <= 0 THEN
    DELETE FROM product_containers WHERE product_id = p_product AND container_type_id = p_container_type;
  ELSE
    INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit)
    VALUES (p_product, p_container_type, p_quantity)
    ON CONFLICT (product_id, container_type_id) DO UPDATE SET quantity_per_unit = EXCLUDED.quantity_per_unit;
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'set_product_container', 'products', p_product::text,
          jsonb_build_object('container_type_id', p_container_type, 'quantity_per_unit', COALESCE(p_quantity, 0)));
END;
$$;

-- ============ 5. Manual moves ============
--   return   customer / rep / walk-in -> warehouse   (distribution:create)
--   issue    warehouse -> customer / rep             (distribution:create; opening balances, loans)
--   purchase external -> warehouse                   (distribution:approve)
--   lost     customer / rep / walk-in -> external    (distribution:approve; written off)
--   damaged  warehouse -> external                   (distribution:approve; written off)
CREATE OR REPLACE FUNCTION public.record_container_movement(payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_type uuid := (payload->>'container_type_id')::uuid;
  v_kind text := payload->>'kind';
  v_holder_type text := NULLIF(payload->>'holder_type', '');
  v_holder_id uuid := NULLIF(payload->>'holder_id', '')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_from_type text; v_from_id uuid; v_to_type text; v_to_id uuid;
  v_id uuid;
BEGIN
  IF v_kind NOT IN ('return','issue','purchase','lost','damaged') THEN RAISE EXCEPTION 'Unknown movement type'; END IF;
  IF NOT public.has_permission(v_uid, 'distribution'::module_key,
       (CASE WHEN v_kind IN ('return','issue') THEN 'create' ELSE 'approve' END)::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be more than 0'; END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = v_type AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Container type not found for this factory';
  END IF;
  IF v_kind IN ('return','issue','lost') THEN
    IF v_holder_type NOT IN ('customer','sales_rep','walk_in') OR (v_kind = 'issue' AND v_holder_type = 'walk_in') THEN
      RAISE EXCEPTION 'Choose who holds the containers';
    END IF;
    IF v_holder_type = 'walk_in' THEN v_holder_id := NULL;
    ELSIF v_holder_id IS NULL THEN RAISE EXCEPTION 'Choose the customer or marketer';
    ELSIF v_holder_type = 'customer' AND NOT EXISTS (SELECT 1 FROM customers WHERE id = v_holder_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Customer not found for this factory';
    ELSIF v_holder_type = 'sales_rep' AND NOT EXISTS (SELECT 1 FROM sales_reps WHERE id = v_holder_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Marketer not found for this factory';
    END IF;
  END IF;
  IF v_kind IN ('lost','damaged') AND v_notes IS NULL THEN RAISE EXCEPTION 'Say what happened to the containers'; END IF;

  CASE v_kind
    WHEN 'return'   THEN v_from_type := v_holder_type; v_from_id := v_holder_id; v_to_type := 'warehouse';
    WHEN 'issue'    THEN v_from_type := 'warehouse'; v_to_type := v_holder_type; v_to_id := v_holder_id;
    WHEN 'purchase' THEN v_from_type := 'external'; v_to_type := 'warehouse';
    WHEN 'lost'     THEN v_from_type := v_holder_type; v_from_id := v_holder_id; v_to_type := 'external';
    WHEN 'damaged'  THEN v_from_type := 'warehouse'; v_to_type := 'external';
  END CASE;

  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, notes, created_by)
  VALUES (v_factory, v_type, v_from_type, v_from_id, v_to_type, v_to_id, v_qty,
          v_kind, NULLIF(btrim(COALESCE(payload->>'reference', '')), ''), v_notes, v_uid)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'record_container_movement', 'container_movements', v_id::text,
          jsonb_build_object('kind', v_kind, 'container_type_id', v_type, 'holder_type', v_holder_type,
                             'holder_id', v_holder_id, 'quantity', v_qty, 'notes', v_notes));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_container_type(uuid, uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_product_container(uuid, uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_container_movement(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_container_type(uuid, uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_product_container(uuid, uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_container_movement(jsonb) TO authenticated;
