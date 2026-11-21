-- ============================================================================
-- Cash requisition: the Chairman may decide without Accounts
-- ----------------------------------------------------------------------------
-- The user asked (2026-11-21) that the Chairman can approve or reject a
-- requisition still waiting for Accounts. Then it goes straight to approved
-- (or rejected), recorded as the Chairman's decision; the Accounts line stays
-- empty. Accounts still act first when they get to it, and the Admin (who is
-- both) acts as Accounts at that stage.
-- Needs 20261121110000 first. Idempotent.
-- ============================================================================

-- ---------- approve / reject: Accounts, then the Chairman ----------
CREATE OR REPLACE FUNCTION public.decide_maintenance_request(p_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := (SELECT full_name FROM profiles WHERE id = v_uid);
  v_row maintenance_requests%ROWTYPE;
  v_note text := NULLIF(btrim(p_note),'');
  v_status text;
BEGIN
  IF NOT p_approve AND v_note IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reject';
  END IF;

  SELECT * INTO v_row FROM maintenance_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot decide on your own request';
  END IF;

  IF v_row.status = 'pending_approval' AND public.is_requisition_accounts(v_uid) THEN
    v_status := CASE WHEN p_approve THEN 'accounts_approved' ELSE 'rejected' END;
    UPDATE maintenance_requests SET
      status = v_status,
      accounts_by = v_uid, accounts_by_name = v_name, accounts_at = now(), accounts_note = v_note,
      decided_by = CASE WHEN p_approve THEN decided_by ELSE v_uid END,
      decided_by_name = CASE WHEN p_approve THEN decided_by_name ELSE v_name END,
      decided_at = CASE WHEN p_approve THEN decided_at ELSE now() END,
      decision_note = CASE WHEN p_approve THEN decision_note ELSE v_note END,
      updated_at = now()
    WHERE id = p_id;
  -- The Chairman: after Accounts, or straight away without them.
  ELSIF v_row.status IN ('pending_approval','accounts_approved')
        AND public.is_requisition_chairman(v_uid) THEN
    v_status := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
    UPDATE maintenance_requests SET
      status = v_status,
      chairman_by = v_uid, chairman_by_name = v_name, chairman_at = now(), chairman_note = v_note,
      decided_by = v_uid, decided_by_name = v_name, decided_at = now(), decision_note = v_note,
      updated_at = now()
    WHERE id = p_id;
  ELSIF v_row.status = 'pending_approval' THEN
    RAISE EXCEPTION 'This request is waiting for Accounts or the Chairman';
  ELSIF v_row.status = 'accounts_approved' THEN
    RAISE EXCEPTION 'Accounts have accepted it; it is waiting for the Chairman';
  ELSE
    RAISE EXCEPTION 'Request is already %', replace(v_row.status, '_', ' ');
  END IF;

  RETURN jsonb_build_object('id', p_id, 'status', v_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.decide_maintenance_request(uuid, boolean, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
