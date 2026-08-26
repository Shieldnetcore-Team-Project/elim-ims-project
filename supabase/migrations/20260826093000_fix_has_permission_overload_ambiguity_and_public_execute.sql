-- ============================================================================
-- FIX: has_permission() overload ambiguity (live, reachable) + PUBLIC EXECUTE
-- ----------------------------------------------------------------------------
-- Found by actually executing RPCs against this project (spec section 67
-- testing), not by reading source: calling submit_goods_receipt() fails with
-- "function has_permission(uuid, unknown, action_key) is not unique" — the
-- exact bug 20260816108000/109000 fixed for 13 named functions, but this
-- codebase has grown since, and 14 CURRENTLY LIVE, reachable functions carry
-- the same unfixed pattern: has_permission(v_uid, 'module-literal', ...) with
-- no ::module_key cast, which is ambiguous whenever the old
-- has_permission(uuid, module_key, access_level) sibling overload still
-- exists (it does, and can't be dropped -- ~60 RLS policies are bound to it
-- by OID). This breaks submit_goods_receipt, confirm_goods_receipt,
-- confirm_production_batch, create_purchase_order, and 10 others outright.
--
-- Fix pulls each function's CURRENT live definition via pg_get_functiondef()
-- and patches only the ambiguous call sites (adds ::module_key immediately
-- after the module literal), then re-runs the corrected CREATE OR REPLACE.
-- This guarantees every other fix already made to these functions over the
-- project's history is preserved byte-for-byte -- nothing is hand-retyped.
--
-- Second, unrelated bug found while investigating: REVOKE EXECUTE ... FROM
-- authenticated (used throughout this project's history to retire
-- superseded functions -- adjust_raw_material/adjust_finished_stock in
-- 20260816096000, receive_raw_material in 20260816098000, delete_production
-- in 20260816102000, create_costing_sheet in 20260816105000) never actually
-- locked them down: Postgres grants EXECUTE to PUBLIC by default at CREATE
-- FUNCTION time, and none of these migrations revoked from PUBLIC too.
-- Confirmed directly against pg_proc.proacl: all five still carry
-- "=X/postgres" (the PUBLIC grant). All five are also confirmed to have zero
-- frontend callers (grepped the whole src tree) -- each was superseded by a
-- dual-control replacement (post_stock_adjustment, confirm_goods_receipt,
-- confirm_production_batch's no delete-production RPC replaces it by design,
-- submit_costing_sheet). Closing the PUBLIC grant now actually retires them.
-- ============================================================================

DO $$
DECLARE
  v_name text;
  v_names text[] := ARRAY[
    'adjust_finished_stock','adjust_raw_material','approve_production_request','cancel_purchase_order',
    'confirm_goods_receipt','confirm_production_batch','create_costing_sheet','create_production_request',
    'create_purchase_order','delete_production','issue_production_request_materials','receive_raw_material',
    'reject_production_request','submit_goods_receipt'
  ];
  v_oid oid;
  v_def text;
  v_fixed text;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    FOR v_oid IN SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name LOOP
      v_def := pg_get_functiondef(v_oid);
      v_fixed := regexp_replace(v_def, E'(has_permission\\(v_uid, ''[a-z-]+'')', E'\\1::module_key', 'g');
      IF v_fixed = v_def THEN
        RAISE EXCEPTION 'No ambiguous has_permission call found in % -- expected at least one substitution', v_name;
      END IF;
      EXECUTE v_fixed;
      RAISE NOTICE 'Patched %', v_name;
    END LOOP;
  END LOOP;
END $$;

-- Close the PUBLIC-execute loophole on the five confirmed-dead functions.
REVOKE EXECUTE ON FUNCTION public.adjust_raw_material(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.adjust_finished_stock(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.receive_raw_material(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_production(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_costing_sheet(jsonb) FROM PUBLIC;
