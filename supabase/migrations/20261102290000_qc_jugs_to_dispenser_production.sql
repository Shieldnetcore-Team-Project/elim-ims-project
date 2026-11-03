-- ============================================================================
-- Empty jugs from QC go to dispenser production only
-- ----------------------------------------------------------------------------
-- User (2026-11-02): the dispenser flow -- Gideon posts dispensers to
-- marketers and Distributor/Office Delivery and takes the unsold back; the
-- empty jugs are counted by QC, verified and posted to PM -- "should only be
-- for dispenser production".
--
-- QC's good jugs (qc_jug_batches, 20261021100000) could be confirmed by
-- anyone with Production rights, bottle production included. Now only
-- someone who handles dispensers confirms them:
--   _user_handles_dispensers(user)  no product rule (Admin, Chairman, anyone
--       not limited) or a rule covering "Dispenser+Water" -- Gideon yes,
--       Ruth / Blessing (bottle water) no.
--   trg_qc_jugs_dispenser_production  refuses marking a batch 'received' by
--       anyone else, whichever screen or function does it.
-- Without the jug tables (live database lacking 20261021100000) the trigger
-- is skipped with a notice; run this again once they are in. Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._user_handles_dispensers(p_user uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ok boolean;
BEGIN
  IF p_user IS NULL OR public.has_role(p_user, 'super_admin') OR public.has_role(p_user, 'chairman') THEN
    RETURN true;
  END IF;
  IF to_regclass('public.user_product_rules') IS NULL THEN RETURN true; END IF;
  EXECUTE 'SELECT NOT EXISTS (SELECT 1 FROM user_product_rules WHERE user_id = $1)
              OR EXISTS (SELECT 1 FROM user_product_rules
                          WHERE user_id = $1 AND ''Dispenser+Water'' ~* name_pattern)'
     INTO v_ok USING p_user;
  RETURN v_ok;
END;
$$;
REVOKE ALL ON FUNCTION public._user_handles_dispensers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._user_handles_dispensers(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public._qc_jugs_dispenser_production()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'received' AND OLD.status IS DISTINCT FROM 'received'
     AND NOT public._user_handles_dispensers(auth.uid()) THEN
    RAISE EXCEPTION 'Empty jugs from QC go to dispenser production -- the dispenser production person confirms them';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.qc_jug_batches') IS NULL THEN
    RAISE NOTICE 'qc_jug_batches is not in this database (20261021100000 not applied) -- trigger skipped; run this again after it';
    RETURN;
  END IF;
  EXECUTE 'DROP TRIGGER IF EXISTS trg_qc_jugs_dispenser_production ON public.qc_jug_batches';
  EXECUTE 'CREATE TRIGGER trg_qc_jugs_dispenser_production BEFORE UPDATE OF status ON public.qc_jug_batches
             FOR EACH ROW EXECUTE FUNCTION public._qc_jugs_dispenser_production()';
END $$;

NOTIFY pgrst, 'reload schema';
