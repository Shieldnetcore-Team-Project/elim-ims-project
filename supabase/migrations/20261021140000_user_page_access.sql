-- ============================================================================
-- Per-user page access: each page ticked or unticked on its own
-- ----------------------------------------------------------------------------
-- Admin Panel → Users → Page access used to tick permission AREAS (modules),
-- and many pages share one area (Production and Products Report are both
-- "production"; Reps & outlet stock, Dispenser & jugs, Bottle tracking and
-- Distribution are all "distribution"), so ticking one page ticked the others
-- and unticking one took the others away.
--
-- This table records the admin's decision per PAGE -- one row per user and
-- menu page (a sidebar entry, or one tab of it), keyed by the page's id in
-- src/lib/page-access.ts ("Production › Products Report"). A row overrides
-- what the user's role and module rights would show for that one page only:
--   granted = true    the page shows (its module's view right is also granted,
--                     so it can load its data)
--   granted = false   the page is hidden and cannot be opened by its address
--   no row            as before: the page shows when the module allows it
-- The menu, the tab bars and the page guard all read it.
--
-- What a user can read or change is still decided by module rights and the
-- server-side checks, unchanged; this table decides which pages they get.
--
-- Same rights as permission_overrides: a user reads their own rows; admins,
-- the chairman and anyone with permissions view read all; editing needs
-- permissions edit (or admin / chairman).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_page_access (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id text NOT NULL CHECK (length(btrim(page_id)) > 0),
  granted boolean NOT NULL,
  granted_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);

ALTER TABLE public.user_page_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user page access read" ON public.user_page_access;
CREATE POLICY "user page access read" ON public.user_page_access FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'view'::action_key));

DROP POLICY IF EXISTS "user page access write" ON public.user_page_access;
CREATE POLICY "user page access write" ON public.user_page_access FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key));

REVOKE ALL ON public.user_page_access FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_page_access TO authenticated;

-- Who changed a page for whom, in the audit log.
CREATE OR REPLACE FUNCTION public._audit_user_page_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_logs(user_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), 'page_access', 'user_page_access',
          COALESCE(NEW.user_id, OLD.user_id)::text,
          CASE WHEN TG_OP <> 'INSERT' THEN jsonb_build_object('page', OLD.page_id, 'granted', OLD.granted) END,
          CASE WHEN TG_OP <> 'DELETE' THEN jsonb_build_object('page', NEW.page_id, 'granted', NEW.granted) END);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_user_page_access ON public.user_page_access;
CREATE TRIGGER trg_audit_user_page_access AFTER INSERT OR UPDATE OR DELETE ON public.user_page_access
  FOR EACH ROW EXECUTE FUNCTION public._audit_user_page_access();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'user_page_access') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_page_access;
  END IF;
END $$;
