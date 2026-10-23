-- ============================================================================
-- Acceptance tests: Preform Inventory (20261020190000_preform_inventory.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test; a failed assertion raises an exception naming what was wrong. Uses its
-- own factory, users, suppliers and materials; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f4000000-0000-0000-0000-000000000001', 'pitest', 'Preform Inventory Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a4000000-0000-0000-0000-000000000001', 'admin@pi'),
  ('a4000000-0000-0000-0000-000000000002', 'storekeeper@pi'),
  ('a4000000-0000-0000-0000-000000000003', 'qc@pi'),
  ('a4000000-0000-0000-0000-000000000004', 'storeofficer@pi'),
  ('a4000000-0000-0000-0000-000000000005', 'operator@pi'),
  ('a4000000-0000-0000-0000-000000000006', 'chairman@pi'),
  ('a4000000-0000-0000-0000-000000000007', 'auditor@pi'),
  ('a4000000-0000-0000-0000-000000000008', 'nobody@pi'),
  ('a4000000-0000-0000-0000-000000000009', 'accountant@pi');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'a4000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
UPDATE profiles SET full_name = split_part(email, '@', 1) WHERE id::text LIKE 'a4000000-%';

INSERT INTO roles(slug, label, is_system) VALUES ('pi_nobody', 'Nobody (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action) VALUES ('pi_nobody', 'dashboard', 'view') ON CONFLICT DO NOTHING;

INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a4000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('a4000000-0000-0000-0000-000000000002', 'store_keeper', 'f4000000-0000-0000-0000-000000000001'),
  ('a4000000-0000-0000-0000-000000000003', 'qc_officer', 'f4000000-0000-0000-0000-000000000001'),
  ('a4000000-0000-0000-0000-000000000004', 'store_officer', 'f4000000-0000-0000-0000-000000000001'),
  ('a4000000-0000-0000-0000-000000000005', 'production', 'f4000000-0000-0000-0000-000000000001'),
  ('a4000000-0000-0000-0000-000000000006', 'chairman', 'f4000000-0000-0000-0000-000000000001'),
  ('a4000000-0000-0000-0000-000000000007', 'auditor', 'f4000000-0000-0000-0000-000000000001'),
  ('a4000000-0000-0000-0000-000000000008', 'pi_nobody', 'f4000000-0000-0000-0000-000000000001'),
  ('a4000000-0000-0000-0000-000000000009', 'accountant', 'f4000000-0000-0000-0000-000000000001');

INSERT INTO suppliers(id, factory_id, name) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'Test Prima'),
  ('b4000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000001', 'Test Yuno Mold'),
  ('b4000000-0000-0000-0000-000000000003', 'f4000000-0000-0000-0000-000000000001', 'Preform 29mm');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'a4000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p text) RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM raw_materials WHERE id = pg_temp.id(p) $$;
GRANT ALL ON ids TO authenticated;

-- @@ Test 1 (acceptance 1): the Store registers a preform with a verified bag size; no stock comes with it
DO $$
DECLARE v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('8');
  e := pg_temp.err($q$SELECT public.save_preform_material('{"factory_id":"f4000000-0000-0000-0000-000000000001","name":"Test Preform 75cl 28mm","pieces_per_bag":1428}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'no rights, no registration: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('7');
  e := pg_temp.err($q$SELECT public.save_preform_material('{"factory_id":"f4000000-0000-0000-0000-000000000001","name":"Test Preform 75cl 28mm","pieces_per_bag":1428}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'auditor cannot register');

  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT public.save_preform_material('{"factory_id":"f4000000-0000-0000-0000-000000000001","name":"Test Preform 75cl 28mm","pieces_per_bag":1428.5}')$q$);
  PERFORM pg_temp.check(e LIKE '%whole number%', 'fractional bag size refused');
  v := public.save_preform_material(jsonb_build_object(
         'factory_id', 'f4000000-0000-0000-0000-000000000001', 'name', 'Test Preform 75cl 28mm',
         'specification', '28mm PCO, 18g, clear', 'pieces_per_bag', 1428, 'reorder_level', 20000,
         'storage_location', 'Store A', 'production_department', 'Preform Blowing',
         'preferred_supplier_id', 'b4000000-0000-0000-0000-000000000001',
         -- opening stock is never taken from the master form
         'opening_stock', 99999));
  INSERT INTO ids VALUES ('pf75', (v->>'id')::uuid);
  PERFORM pg_temp.check((v->>'material_code') LIKE 'PF-%', 'code generated: ' || (v->>'material_code'));
  PERFORM pg_temp.check((SELECT is_preform AND pieces_per_bag = 1428 AND unit = 'Piece' AND current_stock = 0
                                AND current_value = 0 AND approval_status = 'approved' AND storage_location = 'Store A'
                                AND supplier_id = 'b4000000-0000-0000-0000-000000000001'
                           FROM raw_materials WHERE id = pg_temp.id('pf75')), 'registered as a preform with no stock');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM raw_material_movements WHERE material_id = pg_temp.id('pf75')),
                        'registration posts no stock movement');
  e := pg_temp.err($q$SELECT public.save_preform_material('{"factory_id":"f4000000-0000-0000-0000-000000000001","name":"  test preform 75CL   28mm "}')$q$);
  PERFORM pg_temp.check(e LIKE '%already exists%', 'duplicate name refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format($q$SELECT public.save_preform_material('{"factory_id":"f4000000-0000-0000-0000-000000000001","name":"Other","material_code":"%s"}')$q$, v->>'material_code'));
  PERFORM pg_temp.check(e LIKE '%already in use%', 'duplicate code refused');

  -- A second specification (different neck) and a piece-only one with no bag size yet.
  v := public.save_preform_material('{"factory_id":"f4000000-0000-0000-0000-000000000001","name":"Test Preform 1.5L 29mm","specification":"29mm","pieces_per_bag":1152}');
  INSERT INTO ids VALUES ('pf15', (v->>'id')::uuid);
  v := public.save_preform_material('{"factory_id":"f4000000-0000-0000-0000-000000000001","name":"Test Preform Pentagon"}');
  INSERT INTO ids VALUES ('pfpent', (v->>'id')::uuid);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'register_preform' AND entity_id = pg_temp.id('pf75')::text),
                        'registration audited');
END $$;

-- @@ Test 2 (acceptance 2): one specification, several suppliers; one preferred
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.save_material_supplier('%s', 'b4000000-0000-0000-0000-000000000002', true)$q$, pg_temp.id('pf75')));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'QC cannot change supplier links');
  PERFORM pg_temp.as_user('2');
  PERFORM public.save_material_supplier(pg_temp.id('pf75'), 'b4000000-0000-0000-0000-000000000002', false, true, 'YM-28-18');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM material_suppliers WHERE material_id = pg_temp.id('pf75')) = 2, 'two suppliers linked');
  PERFORM public.save_material_supplier(pg_temp.id('pf75'), 'b4000000-0000-0000-0000-000000000002', true);
  PERFORM pg_temp.check((SELECT COUNT(*) FROM material_suppliers WHERE material_id = pg_temp.id('pf75') AND is_preferred) = 1,
                        'only one preferred supplier');
  PERFORM pg_temp.check((SELECT supplier_id FROM raw_materials WHERE id = pg_temp.id('pf75')) = 'b4000000-0000-0000-0000-000000000002',
                        'main supplier follows the preferred one');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM raw_materials WHERE factory_id = 'f4000000-0000-0000-0000-000000000001' AND is_preform) = 3,
                        'linking a supplier creates no new material');
  PERFORM public.save_material_supplier(pg_temp.id('pf75'), 'b4000000-0000-0000-0000-000000000001', true);
END $$;

-- @@ Test 3 (acceptance 3): 74 bags at 1,428 = 105,672 pieces; stock moves only when the Store confirms
DO $$
DECLARE v jsonb; v2 jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.submit_goods_receipt('{"material_id":"%s","bags":74,"pieces_per_bag":1500,"unit_cost":30}')$q$, pg_temp.id('pf75')));
  PERFORM pg_temp.check(e LIKE '%reopen the form%', 'a stale bag size on the form is refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format($q$SELECT public.submit_goods_receipt('{"material_id":"%s","bags":74,"quantity":100000,"unit_cost":30}')$q$, pg_temp.id('pf75')));
  PERFORM pg_temp.check(e LIKE '%does not match%', 'quantity must equal bags x size');
  e := pg_temp.err(format($q$SELECT public.submit_goods_receipt('{"material_id":"%s","bags":2}')$q$, pg_temp.id('pfpent')));
  PERFORM pg_temp.check(e LIKE '%Set pieces per bag%', 'no bag size, no bag receipt');

  v := public.submit_goods_receipt(jsonb_build_object(
         'material_id', pg_temp.id('pf75'), 'supplier_id', 'b4000000-0000-0000-0000-000000000001',
         'bags', 74, 'pieces_per_bag', 1428, 'unit_cost', 30, 'supplier_invoice', 'INV-001',
         'delivery_reference', 'WB-1', 'batch_number', 'LOT-A', 'delivery_date', '2026-10-01',
         'client_ref', 'c4000000-0000-0000-0000-000000000001'));
  INSERT INTO ids VALUES ('gr1', (v->>'id')::uuid);
  PERFORM pg_temp.check((v->>'quantity')::numeric = 105672, '74 x 1428 = 105672');
  v2 := public.submit_goods_receipt(jsonb_build_object(
         'material_id', pg_temp.id('pf75'), 'bags', 74, 'unit_cost', 30, 'client_ref', 'c4000000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check(v2->>'id' = v->>'id' AND (v2->>'duplicate')::boolean, 'double submit returns the same receipt');
  PERFORM pg_temp.check((SELECT bags = 74 AND pieces_per_bag = 1428 AND loose_pieces = 0 AND quantity = 105672
                                AND supplier_invoice = 'INV-001' AND batch_number = 'LOT-A' AND storage_location = 'Store A'
                           FROM goods_receipts WHERE id = pg_temp.id('gr1')), 'receipt keeps bags, size, invoice, lot');
  PERFORM pg_temp.check(pg_temp.stock('pf75') = 0, 'nothing in stock before the Store confirms');

  PERFORM pg_temp.as_user('4');
  PERFORM public.confirm_goods_receipt(pg_temp.id('gr1'));
  PERFORM pg_temp.check(pg_temp.stock('pf75') = 105672, 'confirmed: 105672 pieces in stock');
  PERFORM pg_temp.check((SELECT current_value FROM raw_materials WHERE id = pg_temp.id('pf75')) = 105672 * 30, 'valued at 30 a piece');
  e := pg_temp.err(format($q$SELECT public.confirm_goods_receipt('%s')$q$, pg_temp.id('gr1')));
  PERFORM pg_temp.check(e IS NOT NULL, 'a receipt cannot be posted twice');
  PERFORM pg_temp.check(pg_temp.stock('pf75') = 105672, 'second confirm moved nothing');
END $$;

-- @@ Test 4 (acceptance 4): a piece-based receipt is not converted again
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_user('3');
  v := public.submit_goods_receipt(jsonb_build_object('material_id', pg_temp.id('pf75'), 'quantity', 500,
         'unit_cost', 30, 'supplier_id', 'b4000000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check((v->>'quantity')::numeric = 500, '500 pieces stay 500 pieces');
  PERFORM pg_temp.check((SELECT bags IS NULL AND pieces_per_bag IS NULL AND quantity = 500
                           FROM goods_receipts WHERE id = (v->>'id')::uuid), 'no bag conversion recorded');
  PERFORM pg_temp.as_user('4');
  PERFORM public.confirm_goods_receipt((v->>'id')::uuid);
  PERFORM pg_temp.check(pg_temp.stock('pf75') = 106172, '+500 pieces');
  -- Bags plus loose pieces.
  PERFORM pg_temp.as_user('3');
  v := public.submit_goods_receipt(jsonb_build_object('material_id', pg_temp.id('pf15'), 'bags', 40, 'loose_pieces', 420,
         'unit_cost', 50, 'supplier_id', 'b4000000-0000-0000-0000-000000000002'));
  PERFORM pg_temp.check((v->>'quantity')::numeric = 46500, '40 x 1152 + 420 = 46500');
  PERFORM pg_temp.as_user('4');
  PERFORM public.confirm_goods_receipt((v->>'id')::uuid);
END $$;

-- @@ Test 5 (acceptance 5): a partly rejected delivery adds only the accepted pieces
DO $$
DECLARE v jsonb; before numeric := pg_temp.stock('pf75');
BEGIN
  PERFORM pg_temp.as_user('3');
  v := public.submit_goods_receipt(jsonb_build_object(
         'material_id', pg_temp.id('pf75'), 'supplier_id', 'b4000000-0000-0000-0000-000000000002',
         'bags', 74, 'damaged_quantity', 1428 + 28, 'unit_cost', 32,
         'rejection_reason', 'Deformed necks', 'rejected_disposition', 'return_to_supplier'));
  INSERT INTO ids VALUES ('gr_rej', (v->>'id')::uuid);
  PERFORM pg_temp.check((SELECT quantity = 105672 AND damaged_quantity = 1456 AND accepted_quantity = 104216
                                AND rejection_reason = 'Deformed necks' AND rejected_disposition = 'return_to_supplier'
                           FROM goods_receipts WHERE id = pg_temp.id('gr_rej')), 'delivered, accepted and rejected kept apart');
  PERFORM pg_temp.as_user('4');
  PERFORM public.confirm_goods_receipt(pg_temp.id('gr_rej'));
  PERFORM pg_temp.check(pg_temp.stock('pf75') = before + 104216, 'only accepted pieces in stock');
  PERFORM pg_temp.check((SELECT quantity FROM damage_records WHERE source_reference =
                           (SELECT receipt_number FROM goods_receipts WHERE id = pg_temp.id('gr_rej'))) = 1456,
                        'rejected pieces recorded separately');
END $$;

-- @@ Test 6 (acceptance 6): supplier history keeps supplier, price, date and GRN
DO $$
DECLARE n int; r record;
BEGIN
  PERFORM pg_temp.as_user('9');  -- the accountant has no goods-receiving rights, but sees the history
  SELECT COUNT(*) INTO n FROM public.preform_receipts('f4000000-0000-0000-0000-000000000001', pg_temp.id('pf75'));
  PERFORM pg_temp.check(n = 3, 'three deliveries of the 75cl preform: ' || n);
  SELECT * INTO r FROM public.preform_receipts('f4000000-0000-0000-0000-000000000001', pg_temp.id('pf75'),
                                               'b4000000-0000-0000-0000-000000000002');
  PERFORM pg_temp.check(r.supplier_name = 'Test Yuno Mold' AND r.unit_cost = 32 AND r.accepted_quantity = 104216
                        AND r.accepted_value = 104216 * 32 AND r.status = 'posted' AND r.receipt_number LIKE 'GR-%'
                        AND r.submitted_by_name = 'qc' AND r.confirmed_by_name = 'storeofficer',
                        'filtered by supplier: the Yuno delivery with its price and people');
  SELECT * INTO r FROM public.preform_receipts('f4000000-0000-0000-0000-000000000001', pg_temp.id('pf75'),
                                               'b4000000-0000-0000-0000-000000000001', '2026-10-01', '2026-10-01');
  PERFORM pg_temp.check(r.delivery_date = '2026-10-01' AND r.supplier_invoice = 'INV-001' AND r.bags = 74,
                        'delivery date filter and invoice');
  PERFORM pg_temp.as_user('8');
  PERFORM pg_temp.check(pg_temp.err($q$SELECT * FROM public.preform_receipts('f4000000-0000-0000-0000-000000000001')$q$)
                        LIKE '%Insufficient%', 'no rights, no history');
END $$;

-- @@ Test 7 (acceptance 7): the overview gives pieces and bag size, so 46,500 at 1,152 shows 40 bags + 420
DO $$
DECLARE r record;
BEGIN
  PERFORM pg_temp.as_user('7');
  SELECT * INTO r FROM public.preform_inventory_overview('f4000000-0000-0000-0000-000000000001') WHERE id = pg_temp.id('pf15');
  PERFORM pg_temp.check(r.current_stock = 46500 AND r.pieces_per_bag = 1152, 'pieces and factor from the server');
  PERFORM pg_temp.check(floor(r.current_stock / r.pieces_per_bag) = 40
                        AND r.current_stock - floor(r.current_stock / r.pieces_per_bag) * r.pieces_per_bag = 420,
                        '40 full bags + 420 loose');
  SELECT * INTO r FROM public.preform_inventory_overview('f4000000-0000-0000-0000-000000000001') WHERE id = pg_temp.id('pf75');
  PERFORM pg_temp.check(r.material_code LIKE 'PF-%' AND jsonb_array_length(r.suppliers) = 2
                        AND (r.suppliers->0->>'preferred')::boolean AND r.last_purchase_cost = 32
                        AND r.last_movement_type = 'received', 'suppliers, last price and last movement: ' || r.suppliers::text);
  PERFORM pg_temp.check((SELECT COUNT(*) FROM public.preform_inventory_overview('f4000000-0000-0000-0000-000000000001')) = 3,
                        'only preforms listed');
END $$;

-- @@ Test 8 (acceptance 8-10): issue to production -- stock down once, operator sees it, too much refused
DO $$
DECLARE v jsonb; v2 jsonb; e text; before numeric := pg_temp.stock('pf75'); s jsonb; r record;
BEGIN
  PERFORM pg_temp.as_user('4');
  e := pg_temp.err(format($q$SELECT public.issue_preforms('{"material_id":"%s","operator_id":"a4000000-0000-0000-0000-000000000005","bags":1000}')$q$, pg_temp.id('pf75')));
  PERFORM pg_temp.check(e LIKE '%Not enough%', 'issue above stock refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check(pg_temp.stock('pf75') = before, 'refused issue moved nothing');
  v := public.issue_preforms(jsonb_build_object('material_id', pg_temp.id('pf75'),
         'operator_id', 'a4000000-0000-0000-0000-000000000005', 'bags', 10, 'loose_pieces', 20,
         'client_ref', 'c4000000-0000-0000-0000-000000000002'));
  v2 := public.issue_preforms(jsonb_build_object('material_id', pg_temp.id('pf75'),
         'operator_id', 'a4000000-0000-0000-0000-000000000005', 'bags', 10, 'loose_pieces', 20,
         'client_ref', 'c4000000-0000-0000-0000-000000000002'));
  PERFORM pg_temp.check(v2->>'id' = v->>'id', 'duplicate issue returns the first');
  PERFORM pg_temp.check(pg_temp.stock('pf75') = before - 14300, 'store down 10 x 1428 + 20 once');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM raw_material_movements WHERE reference = v->>'reference') = 1, 'one ledger line');

  PERFORM pg_temp.as_user('5');
  s := public.preform_day_summary('a4000000-0000-0000-0000-000000000005', pg_temp.id('pf75'), public._pf_today());
  PERFORM pg_temp.check((s->>'pending_pieces')::numeric = 14300, 'operator sees the issue waiting');
  PERFORM pg_temp.as_user('7');
  SELECT * INTO r FROM public.preform_inventory_overview('f4000000-0000-0000-0000-000000000001') WHERE id = pg_temp.id('pf75');
  PERFORM pg_temp.check(r.awaiting_ack_qty = 14300 AND r.issued_since_qty = 14300 AND r.production_held_qty = 0,
                        'overview: awaiting acknowledgement, not yet held');
  PERFORM pg_temp.as_user('5');
  PERFORM public.respond_preform_issue((v->>'id')::uuid, true);
  PERFORM pg_temp.as_user('7');
  SELECT * INTO r FROM public.preform_inventory_overview('f4000000-0000-0000-0000-000000000001') WHERE id = pg_temp.id('pf75');
  PERFORM pg_temp.check(r.awaiting_ack_qty = 0 AND r.production_held_qty = 14300, 'accepted: held by production');
END $$;

-- @@ Test 9 (acceptance 12): a new price changes the average, never past receipts or issues
DO $$
DECLARE v jsonb; old_issue_cost numeric; old_mv_cost numeric;
BEGIN
  SELECT unit_cost INTO old_issue_cost FROM preform_issues WHERE material_id = pg_temp.id('pf75') LIMIT 1;
  SELECT unit_cost INTO old_mv_cost FROM raw_material_movements
   WHERE reference = (SELECT receipt_number FROM goods_receipts WHERE id = pg_temp.id('gr1'));
  PERFORM pg_temp.as_user('3');
  v := public.submit_goods_receipt(jsonb_build_object('material_id', pg_temp.id('pf75'), 'bags', 1, 'unit_cost', 45,
         'supplier_id', 'b4000000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.as_user('4');
  PERFORM public.confirm_goods_receipt((v->>'id')::uuid);
  PERFORM pg_temp.check((SELECT unit_cost FROM goods_receipts WHERE id = pg_temp.id('gr1')) = 30, 'first receipt still at 30');
  PERFORM pg_temp.check((SELECT unit_cost FROM raw_material_movements
                          WHERE reference = (SELECT receipt_number FROM goods_receipts WHERE id = pg_temp.id('gr1'))) = old_mv_cost,
                        'its ledger cost unchanged');
  PERFORM pg_temp.check((SELECT unit_cost FROM preform_issues WHERE material_id = pg_temp.id('pf75') LIMIT 1) = old_issue_cost,
                        'issue cost unchanged');
  PERFORM pg_temp.check((SELECT avg_unit_cost < 45 AND avg_unit_cost > 30 AND last_purchase_cost = 45
                           FROM public.preform_inventory_overview('f4000000-0000-0000-0000-000000000001')
                          WHERE id = pg_temp.id('pf75')), 'average cost is not the latest price');
END $$;

-- @@ Test 10: opening balance and physical count -- posted at once, no approval (20261023130000)
DO $$
DECLARE v jsonb; e text; rq uuid;
BEGIN
  PERFORM pg_temp.as_user('7');
  e := pg_temp.err(format($q$SELECT public.request_stock_count('{"material_id":"%s","kind":"opening_balance","counted_quantity":100,"supporting_reference":"CS-1","reason":"Opening stock count"}')$q$, pg_temp.id('pfpent')));
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'auditor cannot count');
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format($q$SELECT public.request_stock_count('{"material_id":"%s","kind":"opening_balance","counted_quantity":100,"reason":"Opening stock count"}')$q$, pg_temp.id('pfpent')));
  PERFORM pg_temp.check(e LIKE '%supporting reference%', 'a reference is required');
  e := pg_temp.err(format($q$SELECT public.request_stock_count('{"material_id":"%s","kind":"opening_balance","counted_bags":2,"supporting_reference":"CS-1","reason":"Opening stock count"}')$q$, pg_temp.id('pfpent')));
  PERFORM pg_temp.check(e LIKE '%pieces per bag%', 'no bag size, count in pieces');
  v := public.request_stock_count(jsonb_build_object('material_id', pg_temp.id('pfpent'), 'kind', 'opening_balance',
         'counted_quantity', 1250, 'unit_cost', 40, 'supporting_reference', 'CS-1', 'reason', 'Opening stock count, Store A'));
  rq := (v->>'id')::uuid;
  PERFORM pg_temp.check((v->>'variance')::numeric = 1250 AND (v->>'posted')::boolean, 'count posted at once');
  PERFORM pg_temp.check(pg_temp.stock('pfpent') = 1250, 'opening balance in stock');
  PERFORM pg_temp.check((SELECT status = 'posted' AND reviewed_by = submitted_by FROM stock_adjustment_requests WHERE id = rq),
                        'request posted by the counter, nobody else');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM notifications WHERE body LIKE
                          (SELECT reference_number FROM stock_adjustment_requests WHERE id = rq) || '%'),
                        'no awaiting-approval notification');
  PERFORM pg_temp.check((SELECT current_value FROM raw_materials WHERE id = pg_temp.id('pfpent')) = 1250 * 40, 'valued at the entered cost');
  PERFORM pg_temp.check((SELECT movement_type = 'opening_balance' AND quantity_before = 0 AND quantity_after = 1250
                           FROM raw_material_movements WHERE material_id = pg_temp.id('pfpent')
                            AND reference = (SELECT reference_number FROM stock_adjustment_requests WHERE id = rq)),
                        'ledger line carries the request reference');

  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format($q$SELECT public.request_stock_count('{"material_id":"%s","kind":"opening_balance","counted_quantity":5,"supporting_reference":"CS-3","reason":"Another opening balance"}')$q$, pg_temp.id('pfpent')));
  PERFORM pg_temp.check(e LIKE '%already has an opening balance%', 'only one opening balance');
  v := public.request_stock_count(jsonb_build_object('material_id', pg_temp.id('pfpent'), 'counted_quantity', 1250,
         'supporting_reference', 'CS-4', 'reason', 'Monthly count matches'));
  PERFORM pg_temp.check(NOT (v->>'request')::boolean, 'matching count raises no request');
  v := public.request_stock_count(jsonb_build_object('material_id', pg_temp.id('pfpent'), 'counted_quantity', 1200,
         'supporting_reference', 'CS-5', 'reason', 'Month-end count short by 50'));
  PERFORM pg_temp.check((v->>'variance')::numeric = -50, 'variance = counted - system');
  PERFORM pg_temp.check(pg_temp.stock('pfpent') = 1200, 'count posted at once: 1200');
  PERFORM pg_temp.as_user('9');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM public.preform_adjustments('f4000000-0000-0000-0000-000000000001')
                          WHERE material_id = pg_temp.id('pfpent') AND status = 'posted' AND counted_quantity IS NOT NULL) = 2,
                        'adjustment report lists both, with counted quantities');
END $$;

-- @@ Test 11 (acceptance 11): reconciliation flags problems and changes nothing
DO $$
DECLARE n int; before numeric := pg_temp.stock('pf15');
BEGIN
  PERFORM pg_temp.as_user('7');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001')
                                     WHERE severity = 'error'),
                        'clean ledger, no errors: ' || COALESCE((SELECT string_agg(check_code || ' ' || COALESCE(reference, '') || ' ' || detail, '; ')
                           FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001') WHERE severity = 'error'), ''));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001')
                                 WHERE check_code = 'supplier_looks_like_material' AND reference = 'Preform 29mm'),
                        'a supplier named like a material is flagged');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001')
                                     WHERE check_code = 'supplier_looks_like_material' AND reference = 'Test Prima'),
                        'a real supplier is not');

  -- Legacy-style damage made behind the system's back (as a migration might):
  -- a ledger line that went negative and a balance that no longer matches.
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, reference, reason, quantity_before, quantity_after)
  VALUES ('f4000000-0000-0000-0000-000000000001', pg_temp.id('pf15'), 'issued', 50000, NULL, 'legacy import', 46500, -3500);
  SELECT COUNT(*) INTO n FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001')
   WHERE material_id = pg_temp.id('pf15') AND check_code IN ('negative_balance', 'ledger_mismatch', 'missing_reference');
  PERFORM pg_temp.check(n = 3, 'negative line, mismatch and missing reference flagged: ' || n);
  PERFORM pg_temp.check(pg_temp.stock('pf15') = before, 'reconciliation changed nothing');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001')
                                 WHERE check_code = 'missing_bag_factor' AND material_id = pg_temp.id('pfpent')), 'missing bag size flagged');
  DELETE FROM raw_material_movements WHERE material_id = pg_temp.id('pf15') AND reason = 'legacy import';

  -- Stock can never actually go negative.
  PERFORM pg_temp.check(pg_temp.err(format('UPDATE raw_materials SET current_stock = -1 WHERE id = %L', pg_temp.id('pf15'))) IS NOT NULL,
                        'negative stock is impossible');

  PERFORM pg_temp.as_user('8');
  PERFORM pg_temp.check(pg_temp.err($q$SELECT * FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001')$q$)
                        LIKE '%Insufficient%', 'no rights, no reconciliation');
END $$;

-- @@ Test 12 (acceptance 13, 14): app users cannot edit or delete posted records, or write stock directly
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.as_user('6');  -- even the chairman, from the app
  PERFORM pg_temp.check(pg_temp.err(format('UPDATE raw_material_movements SET quantity = 1 WHERE material_id = %L', pg_temp.id('pf75'))) LIKE '%denied%',
                        'ledger lines cannot be edited');
  PERFORM pg_temp.check(pg_temp.err(format('DELETE FROM raw_material_movements WHERE material_id = %L', pg_temp.id('pf75'))) LIKE '%denied%',
                        'ledger lines cannot be deleted');
  PERFORM pg_temp.check(pg_temp.err(format('UPDATE goods_receipts SET accepted_quantity = 1, unit_cost = 1 WHERE id = %L', pg_temp.id('gr1'))) IS NOT NULL,
                        'posted receipts cannot be edited');
  PERFORM pg_temp.check(pg_temp.err(format('DELETE FROM goods_receipts WHERE id = %L', pg_temp.id('gr1'))) LIKE '%denied%',
                        'posted receipts cannot be deleted');
  PERFORM pg_temp.check(pg_temp.err(format('UPDATE raw_materials SET current_stock = 1 WHERE id = %L', pg_temp.id('pf75'))) LIKE '%denied%',
                        'stock cannot be typed in');
  PERFORM pg_temp.check(pg_temp.err(format('UPDATE material_suppliers SET is_preferred = false WHERE material_id = %L', pg_temp.id('pf75'))) LIKE '%denied%',
                        'supplier links change only through the function');
  PERFORM pg_temp.check(pg_temp.err(format('UPDATE preform_issues SET pieces = 1 WHERE material_id = %L', pg_temp.id('pf75'))) LIKE '%denied%',
                        'issues cannot be edited');
END $$;
RESET ROLE;

-- @@ Test 13: changing a bag size needs the right and a reason, and leaves past receipts alone
DO $$
DECLARE e text; r record;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.save_preform_material('{"id":"%s","name":"Test Preform 75cl 28mm","pieces_per_bag":1500,"pieces_per_bag_reason":"x"}')$q$, pg_temp.id('pf75')));
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'QC cannot edit a preform');
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format($q$SELECT public.save_preform_material('{"id":"%s","name":"Test Preform 75cl 28mm","pieces_per_bag":1500}')$q$, pg_temp.id('pf75')));
  PERFORM pg_temp.check(e LIKE '%reason%', 'a reason is required: ' || COALESCE(e, 'no error'));
  PERFORM public.save_preform_material(jsonb_build_object('id', pg_temp.id('pf75'), 'name', 'Test Preform 75cl 28mm',
            'specification', '28mm PCO, 18g, clear', 'pieces_per_bag', 1500,
            'pieces_per_bag_reason', 'Supplier changed bag size from Nov', 'reorder_level', 20000, 'storage_location', 'Store B'));
  PERFORM pg_temp.check((SELECT pieces_per_bag = 1500 AND storage_location = 'Store B' FROM raw_materials WHERE id = pg_temp.id('pf75')),
                        'saved');
  PERFORM pg_temp.check((SELECT pieces_per_bag = 1428 AND quantity = 105672 FROM goods_receipts WHERE id = pg_temp.id('gr1')),
                        'old receipt keeps 1428 per bag');
  PERFORM pg_temp.as_user('7');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001')
                                 WHERE check_code = 'factor_changed' AND material_id = pg_temp.id('pf75')),
                        'receipts at the old size are listed for information');
END $$;

-- @@ Test 14: one specification, two suppliers, two bag sizes -- one stock, each receipt keeps its own size
DO $$
DECLARE v jsonb; e text; before numeric; r record;
BEGIN
  PERFORM pg_temp.as_user('2');
  -- The 75cl spec now defaults to 1500/bag (Test 13). Yuno packs the same preform in 1600s.
  PERFORM public.save_material_supplier(pg_temp.id('pf75'), 'b4000000-0000-0000-0000-000000000002', false, true, 'YM-28-18', NULL, 1600);
  PERFORM pg_temp.check((SELECT pieces_per_bag = 1600 AND supplier_item_code = 'YM-28-18' FROM material_suppliers
                          WHERE material_id = pg_temp.id('pf75') AND supplier_id = 'b4000000-0000-0000-0000-000000000002'),
                        'supplier bag size saved');
  -- Re-saving without a bag size keeps it.
  PERFORM public.save_material_supplier(pg_temp.id('pf75'), 'b4000000-0000-0000-0000-000000000002', false, true, 'YM-28-18');
  PERFORM pg_temp.check(public.receipt_pieces_per_bag(pg_temp.id('pf75'), 'b4000000-0000-0000-0000-000000000002') = 1600,
                        'bag size kept when not given');
  PERFORM pg_temp.check(public.receipt_pieces_per_bag(pg_temp.id('pf75'), 'b4000000-0000-0000-0000-000000000001') = 1500,
                        'other supplier uses the specification default');
  -- Editing the preform keeps the preferred supplier's item code.
  PERFORM public.save_material_supplier(pg_temp.id('pf75'), 'b4000000-0000-0000-0000-000000000001', true, true, 'PR-75', NULL);
  PERFORM public.save_preform_material(jsonb_build_object('id', pg_temp.id('pf75'), 'name', 'Test Preform 75cl 28mm',
            'specification', '28mm PCO, 18g, clear', 'reorder_level', 20000, 'storage_location', 'Store B',
            'preferred_supplier_id', 'b4000000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check((SELECT supplier_item_code = 'PR-75' FROM material_suppliers
                          WHERE material_id = pg_temp.id('pf75') AND supplier_id = 'b4000000-0000-0000-0000-000000000001'),
                        'editing the preform does not wipe the supplier item code');

  before := pg_temp.stock('pf75');
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.submit_goods_receipt('{"material_id":"%s","supplier_id":"b4000000-0000-0000-0000-000000000002","bags":2,"pieces_per_bag":1500}')$q$, pg_temp.id('pf75')));
  PERFORM pg_temp.check(e LIKE '%from this supplier is 1600%', 'form using the wrong size refused: ' || COALESCE(e, 'no error'));
  v := public.submit_goods_receipt(jsonb_build_object('material_id', pg_temp.id('pf75'),
         'supplier_id', 'b4000000-0000-0000-0000-000000000002', 'bags', 2, 'loose_pieces', 7, 'unit_cost', 31));
  PERFORM pg_temp.check((v->>'quantity')::numeric = 3207, '2 x 1600 + 7');
  PERFORM pg_temp.as_user('4');
  PERFORM public.confirm_goods_receipt((v->>'id')::uuid);
  PERFORM pg_temp.as_user('3');
  v := public.submit_goods_receipt(jsonb_build_object('material_id', pg_temp.id('pf75'),
         'supplier_id', 'b4000000-0000-0000-0000-000000000001', 'bags', 2, 'unit_cost', 30));
  PERFORM pg_temp.check((v->>'quantity')::numeric = 3000, '2 x 1500 from the other supplier');
  PERFORM pg_temp.as_user('4');
  PERFORM public.confirm_goods_receipt((v->>'id')::uuid);
  PERFORM pg_temp.check(pg_temp.stock('pf75') = before + 6207, 'one pooled stock for the one specification');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM raw_materials WHERE factory_id = 'f4000000-0000-0000-0000-000000000001' AND is_preform) = 3,
                        'no extra material created per supplier');
  PERFORM pg_temp.check((SELECT array_agg(DISTINCT pieces_per_bag ORDER BY pieces_per_bag) FROM goods_receipts
                          WHERE material_id = pg_temp.id('pf75') AND pieces_per_bag IS NOT NULL) = ARRAY[1428, 1500, 1600]::numeric[],
                        'each receipt keeps the size it was received at');
  PERFORM pg_temp.as_user('7');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.inventory_reconciliation('f4000000-0000-0000-0000-000000000001')
                                     WHERE check_code = 'factor_changed' AND actual = 1600),
                        'a supplier''s own size is not reported as a change');
  SELECT * INTO r FROM public.preform_receipts('f4000000-0000-0000-0000-000000000001', pg_temp.id('pf75'),
                                               'b4000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(r.pieces_per_bag = 1500 AND r.unit_cost = 30, 'supplier price comparison per receipt');
END $$;

-- @@ Test 15: a count in bags keeps the bag size it was counted at
DO $$
DECLARE v jsonb; a record;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := public.request_stock_count(jsonb_build_object('material_id', pg_temp.id('pf15'), 'counted_bags', 40,
         'counted_loose', 300, 'supporting_reference', 'CS-9', 'reason', 'Month-end count, Store A'));
  PERFORM pg_temp.as_user('9');
  SELECT * INTO a FROM public.preform_adjustments('f4000000-0000-0000-0000-000000000001') WHERE id = (v->>'id')::uuid;
  PERFORM pg_temp.check(a.counted_bags = 40 AND a.counted_loose = 300 AND a.counted_pieces_per_bag = 1152
                        AND a.counted_quantity = 46380, 'count keeps 40 x 1152 + 300');
  PERFORM pg_temp.check(pg_temp.stock('pf15') = 46380, 'count posted at once');
  PERFORM pg_temp.as_user('2');
  -- Bags of another size on the same shelf are counted at their own size.
  v := public.request_stock_count(jsonb_build_object('material_id', pg_temp.id('pf15'), 'counted_bags', 30,
         'counted_pieces_per_bag', 1250, 'supporting_reference', 'CS-10', 'reason', 'Count of Pentagon-packed bags'));
  PERFORM pg_temp.as_user('9');
  SELECT * INTO a FROM public.preform_adjustments('f4000000-0000-0000-0000-000000000001') WHERE id = (v->>'id')::uuid;
  PERFORM pg_temp.check(a.counted_quantity = 37500 AND a.counted_pieces_per_bag = 1250, 'count at an explicit bag size');
  PERFORM pg_temp.check((SELECT pieces_per_bag FROM raw_materials WHERE id = pg_temp.id('pf15')) = 1152,
                        'the specification default is unchanged');
END $$;
