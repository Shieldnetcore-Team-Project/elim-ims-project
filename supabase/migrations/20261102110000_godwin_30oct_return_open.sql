-- ============================================================================
-- Godwin's 30 Oct return shows on his next posting
-- ----------------------------------------------------------------------------
-- User report (2026-11-02): Warehouse -> Marketers -> Post products for
-- Godwin doesn't show his return of 30 Oct (75cl 4, 50cl 16).
-- 20261102100000 linked that return to load-out 4 so it would not be carried
-- again; the user wants it carried like any return. So:
--   * the link (carried_dispatch_id) is taken off, and the posting form
--     adds the return to his next posting automatically (20261031150000);
--   * Warehouse stock is NOT changed (user, "do it like Malla"): the packs
--     came back on 30 Oct and are in the 31 Oct count; the posting that
--     carries them takes them out when they leave again.
-- Only that return (RRN-20261030-..., noted "WhatsApp message"). Does
-- nothing if 20261102100000 hasn't run. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._godwin_30oct_return_open()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ret rep_returns%ROWTYPE;
  v_it record;
  v_before numeric;
  v_rep text;
BEGIN
  SELECT * INTO v_ret FROM rep_returns
   WHERE return_number LIKE 'RRN-20261030-%' AND return_date = DATE '2026-10-30' AND status = 'completed'
     AND notes LIKE 'Return of 30/10/2026 (WhatsApp message)%'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'Godwin''s 30 Oct return is not recorded -- nothing changed';
    RETURN;
  END IF;
  v_rep := (SELECT full_name FROM sales_reps WHERE id = v_ret.sales_rep_id);

  UPDATE rep_returns
     SET carried_dispatch_id = NULL,
         notes = 'Return of 30/10/2026 (WhatsApp message), recorded 2 Nov 2026. In the Warehouse''s '
                 || '31 Oct count; carried onto the next posting.'
   WHERE id = v_ret.id;

  -- No Warehouse stock line (changed 2026-11-02, "do it like Malla"): the
  -- returned packs came back on 30 Oct and are already in the 31 Oct count;
  -- the next posting that carries them takes them out, as they leave then.

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (NULL, v_ret.factory_id, 'reopen_rep_return', 'rep_return', v_ret.id::text,
          jsonb_build_object('carried_dispatch_id', v_ret.carried_dispatch_id),
          jsonb_build_object('return_number', v_ret.return_number, 'carried_dispatch_id', NULL,
                             'note', 'Shown on the next posting; Warehouse stock not changed'));
  RAISE NOTICE '% (%) will show on %''s next posting', v_ret.return_number, v_rep, v_rep;
END;
$$;
REVOKE ALL ON FUNCTION public._godwin_30oct_return_open() FROM PUBLIC, anon, authenticated;

SELECT public._godwin_30oct_return_open();
