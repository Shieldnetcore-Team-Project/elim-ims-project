-- ============================================================================
-- The Store can issue to Ranshak (production manager)
-- ----------------------------------------------------------------------------
-- User (2026-11-04): "enable ranshak to receive issued material from store"
-- (Austin issues from the Store). The Store's "Issued to" list
-- (issue_recipients, 20261020160000) only offered people with the Production
-- or a production-manager ROLE; Ranshak, Gideon and Grand Joy have their
-- Production rights per account (permission_overrides, 20261104110000 /
-- 20261102220000 / 20261031180000), so they never appeared.
--
-- _issue_department_member: Production now also means a granted per-account
-- right to record or release batches (production create or submit). Admin /
-- Chairman are still not listed. Everything else as 20261020160000;
-- issue_raw_material checks the person with this same function.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._issue_department_member(p_user uuid, p_department text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur LEFT JOIN roles r ON r.slug = ur.role
     WHERE ur.user_id = p_user
       AND CASE p_department
             WHEN 'production' THEN ur.role = 'production' OR ur.role ILIKE '%production%manager%'
                                    OR COALESCE(r.label, '') ILIKE '%production%manager%'
             WHEN 'quality_control' THEN ur.role = 'qc_officer'
             ELSE false
           END)
  OR (p_department = 'production'
      AND NOT (public.has_role(p_user, 'super_admin') OR public.has_role(p_user, 'chairman'))
      AND EXISTS (SELECT 1 FROM permission_overrides po
                   WHERE po.user_id = p_user AND po.granted AND po.module = 'production'::module_key
                     AND po.action IN ('create'::action_key, 'submit'::action_key)));
$$;
REVOKE ALL ON FUNCTION public._issue_department_member(uuid, text) FROM PUBLIC, anon, authenticated;

-- Ranshak must have those rights (20261104110000 gives them); say so either way.
DO $$
DECLARE v_n int; v_user uuid; v_name text;
BEGIN
  v_n := (SELECT count(*) FROM profiles WHERE full_name ILIKE '%ranshak%' OR email ILIKE '%ranshak%');
  IF v_n <> 1 THEN
    RAISE NOTICE '% accounts match "ranshak" -- give him Production record / release rights in Admin Panel -> Users and he will appear', v_n;
    RETURN;
  END IF;
  SELECT id, COALESCE(full_name, email) INTO v_user, v_name FROM profiles
   WHERE full_name ILIKE '%ranshak%' OR email ILIKE '%ranshak%';
  IF public._issue_department_member(v_user, 'production') THEN
    RAISE NOTICE '% now appears under Production in the Store''s Issued to list', v_name;
  ELSE
    RAISE NOTICE '% has no Production record / release rights yet -- run 20261104110000 first', v_name;
  END IF;
END $$;
