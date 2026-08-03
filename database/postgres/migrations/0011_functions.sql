-- =============================================================================
-- 0011_functions.sql
-- Stored procedures / functions. Two kinds:
--   1. Trigger functions (fn_*_trigger-shaped, RETURNS TRIGGER) — wired up
--      in 0012_triggers.sql.
--   2. Business-transaction functions — the write API each workflow step
--      should go through so multi-table effects (an inventory movement, a
--      status transition, a recalculated total) happen atomically instead
--      of being re-implemented ad hoc by every caller.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- fn_next_code: atomic human-readable code generator, e.g. fn_next_code('PO-2026-', 4)
-- -> 'PO-2026-0001'. Replaces the original SQLite approach of
-- `SELECT id FROM t WHERE id LIKE 'PO-%' ORDER BY id DESC LIMIT 1` + parse +
-- increment, which races under concurrent writers; this uses a single
-- atomic UPDATE ... RETURNING against code_sequences (0002).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_next_code(p_prefix TEXT, p_width INT DEFAULT 4)
RETURNS TEXT AS $$
DECLARE
  v_next BIGINT;
BEGIN
  INSERT INTO code_sequences (prefix, current_value) VALUES (p_prefix, 1)
  ON CONFLICT (prefix) DO UPDATE SET current_value = code_sequences.current_value + 1
  RETURNING current_value INTO v_next;
  RETURN p_prefix || lpad(v_next::TEXT, p_width, '0');
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_set_updated_at: generic BEFORE UPDATE trigger function for every table
-- carrying an updated_at column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_item_balance: current on-hand quantity for an item, derived from the
-- append-only inventory_transactions ledger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_item_balance(p_item_id UUID)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0)
  FROM inventory_transactions
  WHERE item_id = p_item_id;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- fn_post_inventory_transaction: the single write path onto the inventory
-- ledger. trg_inventory_prevent_negative (0012) still enforces the
-- non-negative-balance invariant at the row level for any direct insert;
-- this function is the convenience API the workflow functions below call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_post_inventory_transaction(
  p_item_id      UUID,
  p_direction    inventory_direction_enum,
  p_quantity     NUMERIC,
  p_unit_cost    NUMERIC,
  p_source_type  inventory_source_enum,
  p_source_id    UUID,
  p_note         TEXT,
  p_actor_employee_id UUID
) RETURNS inventory_transactions AS $$
DECLARE
  v_row inventory_transactions;
BEGIN
  INSERT INTO inventory_transactions (item_id, direction, quantity, unit_cost, source_type, source_id, note, actor_employee_id)
  VALUES (p_item_id, p_direction, p_quantity, COALESCE(p_unit_cost, 0), p_source_type, p_source_id, p_note, p_actor_employee_id)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_approve_purchase_order: DRAFT/AWAITING_APPROVAL -> APPROVED only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_approve_purchase_order(p_po_id UUID)
RETURNS purchase_orders AS $$
DECLARE
  v_row purchase_orders;
BEGIN
  UPDATE purchase_orders
  SET status = 'APPROVED'
  WHERE id = p_po_id AND status IN ('DRAFT','AWAITING_APPROVAL')
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_order % is not in a state that can be approved', p_po_id;
  END IF;
  RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_receive_goods: records a GRN + its lines for an approved PO and posts
-- one inventory IN transaction per line, atomically. p_items is
-- [{"item_id": "...", "quantity": 123}, ...]. Auto-advances the PO to
-- RECEIVED once every ordered line has been received in full.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_receive_goods(
  p_po_id UUID,
  p_received_by_employee_id UUID,
  p_items JSONB
) RETURNS UUID AS $$
DECLARE
  v_grn_id UUID;
  v_line JSONB;
  v_item_id UUID;
  v_qty NUMERIC;
  v_unit_cost NUMERIC;
  v_fully_received BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM purchase_orders WHERE id = p_po_id AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'purchase_order % must be APPROVED before goods can be received', p_po_id;
  END IF;

  INSERT INTO goods_received (code, po_id, received_by_employee_id, status)
  VALUES (fn_next_code('GRN-'), p_po_id, p_received_by_employee_id, 'PENDING_QC')
  RETURNING id INTO v_grn_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_item_id := (v_line->>'item_id')::UUID;
    v_qty     := (v_line->>'quantity')::NUMERIC;

    SELECT unit_price INTO v_unit_cost
    FROM purchase_order_items WHERE po_id = p_po_id AND item_id = v_item_id;

    INSERT INTO goods_received_items (grn_id, item_id, quantity) VALUES (v_grn_id, v_item_id, v_qty);

    PERFORM fn_post_inventory_transaction(
      v_item_id, 'IN', v_qty, COALESCE(v_unit_cost, 0), 'PURCHASE', p_po_id,
      'Received against ' || (SELECT code FROM purchase_orders WHERE id = p_po_id), NULL
    );
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM purchase_order_items poi
    WHERE poi.po_id = p_po_id
      AND poi.quantity > COALESCE((
        SELECT SUM(gri.quantity) FROM goods_received_items gri
        JOIN goods_received gr ON gr.id = gri.grn_id
        WHERE gr.po_id = p_po_id AND gri.item_id = poi.item_id
      ), 0)
  ) INTO v_fully_received;

  IF v_fully_received THEN
    UPDATE purchase_orders SET status = 'RECEIVED' WHERE id = p_po_id;
  END IF;

  RETURN v_grn_id;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_issue_material_request: approves a PENDING request and, for each
-- requested line, posts an inventory OUT transaction and a matching
-- stock_movement from a source warehouse location to the requesting
-- department's floor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_issue_material_request(
  p_request_id UUID,
  p_actor_employee_id UUID,
  p_from_location_id UUID,
  p_to_location_id UUID
) RETURNS material_requests AS $$
DECLARE
  v_row material_requests;
  v_line RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM material_requests WHERE id = p_request_id AND status = 'PENDING') THEN
    RAISE EXCEPTION 'material_request % is not PENDING', p_request_id;
  END IF;

  FOR v_line IN SELECT item_id, quantity FROM material_request_items WHERE request_id = p_request_id LOOP
    PERFORM fn_post_inventory_transaction(
      v_line.item_id, 'OUT', v_line.quantity, NULL, 'MATERIAL_ISSUE', p_request_id, 'Issued against material request', p_actor_employee_id
    );
    INSERT INTO stock_movements (request_id, item_id, quantity, from_location_id, to_location_id, moved_by_employee_id)
    VALUES (p_request_id, v_line.item_id, v_line.quantity, p_from_location_id, p_to_location_id, p_actor_employee_id);
  END LOOP;

  UPDATE material_requests SET status = 'ISSUED' WHERE id = p_request_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_complete_production_batch: IN_PROGRESS -> COMPLETED, stamping completed_at.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_complete_production_batch(p_batch_id UUID)
RETURNS production_batches AS $$
DECLARE
  v_row production_batches;
BEGIN
  UPDATE production_batches
  SET status = 'COMPLETED', completed_at = now()
  WHERE id = p_batch_id AND status = 'IN_PROGRESS'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production_batch % is not IN_PROGRESS', p_batch_id;
  END IF;
  RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_create_sales_order: creates the header + lines; total_amount is left to
-- trg_sales_orders_recalc_total (0012). Posts one inventory OUT transaction
-- per line — trg_inventory_prevent_negative (0012) rejects the whole
-- transaction if stock is insufficient. p_items is
-- [{"item_id": "...", "quantity": 1, "unit_price": 1}, ...].
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_create_sales_order(
  p_customer_id UUID,
  p_channel sales_channel_enum,
  p_rep_employee_id UUID,
  p_items JSONB
) RETURNS UUID AS $$
DECLARE
  v_order_id UUID;
  v_line JSONB;
BEGIN
  INSERT INTO sales_orders (code, customer_id, channel, rep_employee_id, status)
  VALUES (fn_next_code('SO-'), p_customer_id, p_channel, p_rep_employee_id, 'PENDING')
  RETURNING id INTO v_order_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO sales_order_items (sales_order_id, item_id, quantity, unit_price)
    VALUES (v_order_id, (v_line->>'item_id')::UUID, (v_line->>'quantity')::NUMERIC, (v_line->>'unit_price')::NUMERIC);

    PERFORM fn_post_inventory_transaction(
      (v_line->>'item_id')::UUID, 'OUT', (v_line->>'quantity')::NUMERIC, NULL, 'SALES', v_order_id,
      'Sold on ' || (SELECT code FROM sales_orders WHERE id = v_order_id), p_rep_employee_id
    );
  END LOOP;

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_dispatch_delivery / fn_mark_delivered: fleet workflow.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_dispatch_delivery(
  p_sales_order_id UUID,
  p_vehicle_id UUID,
  p_driver_employee_id UUID,
  p_route TEXT
) RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO delivery_runs (code, sales_order_id, vehicle_id, driver_employee_id, route, status)
  VALUES (fn_next_code('DR-'), p_sales_order_id, p_vehicle_id, p_driver_employee_id, p_route, 'ACTIVE')
  RETURNING id INTO v_id;

  UPDATE sales_orders SET status = 'PROCESSING' WHERE id = p_sales_order_id AND status = 'PENDING';
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_mark_delivered(p_delivery_run_id UUID)
RETURNS delivery_runs AS $$
DECLARE
  v_row delivery_runs;
BEGIN
  UPDATE delivery_runs SET status = 'DELIVERED', delivered_at = now()
  WHERE id = p_delivery_run_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_run % not found', p_delivery_run_id;
  END IF;

  UPDATE sales_orders SET status = 'DELIVERED' WHERE id = v_row.sales_order_id;
  RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- fn_customer_outstanding_balance / fn_supplier_outstanding_balance:
-- AR/AP helpers — invoiced (or ordered) value minus cash actually
-- collected (or paid), by counterparty.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_customer_outstanding_balance(p_customer_id UUID)
RETURNS NUMERIC AS $$
  SELECT COALESCE((SELECT SUM(total_amount) FROM sales_orders
                    WHERE customer_id = p_customer_id AND status <> 'CANCELLED' AND deleted_at IS NULL), 0)
       - COALESCE((SELECT SUM(amount) FROM receipts
                    WHERE counterparty_type = 'CUSTOMER' AND counterparty_id = p_customer_id AND status = 'CLEARED'), 0);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fn_supplier_outstanding_balance(p_supplier_id UUID)
RETURNS NUMERIC AS $$
  SELECT COALESCE((SELECT SUM(poi.quantity * poi.unit_price)
                    FROM purchase_order_items poi
                    JOIN purchase_orders po ON po.id = poi.po_id
                    WHERE po.supplier_id = p_supplier_id AND po.status IN ('APPROVED','RECEIVED') AND po.deleted_at IS NULL), 0)
       - COALESCE((SELECT SUM(amount) FROM payments
                    WHERE counterparty_type = 'SUPPLIER' AND counterparty_id = p_supplier_id AND status = 'CLEARED'), 0);
$$ LANGUAGE sql STABLE;
