-- ============================================================================
-- WORKFLOW / APPROVAL ENGINE — CORE (Section 6 of the redesign spec)
-- ----------------------------------------------------------------------------
-- A reusable engine instead of hand-rolled approval logic per page:
--   - workflow_configs: one row per transaction type — maker/checker labels,
--     the status that means "done", and how many distinct approvers are
--     required. Configurable, not hardcoded: raising a module's
--     required_approvals from 1 to 2 is a single UPDATE, and every RPC that
--     calls workflow_approval_progress() picks it up automatically.
--   - workflow_approval_history: one row per transition (submit / approve /
--     reject / confirm / post / cancel / reverse), with actor, from/to
--     status, a free-text comment, and a timestamp — the single place the
--     full trail of any transaction lives, queryable generically by
--     (module, entity_id) regardless of which table the entity is on.
--   - record_workflow_action(): the one function every flow's RPC calls to
--     write a history row, instead of each RPC growing its own bespoke
--     logging.
--   - workflow_approval_progress(): counts distinct approvers recorded since
--     the entity's current review cycle started, and reports whether the
--     configured required_approvals count has been met. All 6 existing
--     flows are seeded at required_approvals = 1, so behavior is identical
--     to before this migration — the engine is real and load-bearing, not
--     decorative, but nothing regresses.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.workflow_configs (
  module public.module_key PRIMARY KEY,
  transaction_type text NOT NULL,
  maker_label text NOT NULL,
  checker_label text NOT NULL,
  final_status public.workflow_status NOT NULL,
  required_approvals int NOT NULL DEFAULT 1 CHECK (required_approvals >= 1),
  description text
);
GRANT SELECT ON public.workflow_configs TO authenticated;
GRANT ALL ON public.workflow_configs TO service_role;
ALTER TABLE public.workflow_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflow configs read" ON public.workflow_configs;
CREATE POLICY "workflow configs read" ON public.workflow_configs FOR SELECT TO authenticated USING (true);

INSERT INTO public.workflow_configs (module, transaction_type, maker_label, checker_label, final_status, required_approvals, description) VALUES
  ('expenses', 'expense_approval', 'Accountant', 'Chairman', 'posted', 1, 'Operating expense claim, reviewed then posted to the books.'),
  ('debts', 'debt_writeoff', 'Accountant', 'Chairman', 'posted', 1, 'Write-off of an uncollectable customer debt.'),
  ('payments', 'payment_confirmation', 'Cashier', 'Accountant / Chairman', 'confirmed', 1, 'Post-receipt reconciliation review of a recorded payment.'),
  ('payroll', 'payroll_approval', 'Payroll Officer', 'Chairman', 'posted', 1, 'Monthly payroll run, computed then approved for payment.'),
  ('raw-materials', 'stock_writeoff', 'Inventory Officer', 'Chairman', 'posted', 1, 'Reduction write-off of raw material stock (damage/loss).'),
  ('finished-goods', 'stock_writeoff', 'Store Officer', 'Chairman', 'posted', 1, 'Reduction write-off of finished goods stock (damage/loss).'),
  ('users', 'role_grant', 'Chairman', 'Super Admin', 'posted', 1, 'Grant or revoke of a user role.')
ON CONFLICT (module) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.workflow_approval_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module public.module_key NOT NULL,
  entity_id uuid NOT NULL,
  transaction_type text NOT NULL,
  action public.action_key NOT NULL,
  actor uuid NOT NULL REFERENCES auth.users(id),
  from_status public.workflow_status,
  to_status public.workflow_status NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_approval_history_entity ON public.workflow_approval_history(module, entity_id, created_at);
GRANT SELECT ON public.workflow_approval_history TO authenticated;
GRANT ALL ON public.workflow_approval_history TO service_role;
ALTER TABLE public.workflow_approval_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflow history read" ON public.workflow_approval_history;
CREATE POLICY "workflow history read" ON public.workflow_approval_history FOR SELECT TO authenticated
  USING (actor = auth.uid() OR public.has_permission(auth.uid(), module, 'view'::action_key));
-- No INSERT/UPDATE/DELETE policy: history rows are written exclusively via
-- record_workflow_action() (SECURITY DEFINER) or the submit-logging triggers
-- below — never directly by a client.

CREATE OR REPLACE FUNCTION public.record_workflow_action(
  p_module public.module_key,
  p_entity_id uuid,
  p_action public.action_key,
  p_from_status public.workflow_status,
  p_to_status public.workflow_status,
  p_comment text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid(); v_txn_type text; v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT transaction_type INTO v_txn_type FROM public.workflow_configs WHERE module = p_module;
  INSERT INTO public.workflow_approval_history
    (module, entity_id, transaction_type, action, actor, from_status, to_status, comment)
  VALUES
    (p_module, p_entity_id, COALESCE(v_txn_type, p_module::text), p_action, v_uid, p_from_status, p_to_status, p_comment)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_workflow_action(public.module_key, uuid, public.action_key, public.workflow_status, public.workflow_status, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.workflow_approval_progress(p_module public.module_key, p_entity_id uuid)
RETURNS TABLE(approvals_so_far int, required_approvals int, satisfied boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_required int; v_cycle_start timestamptz; v_count int;
BEGIN
  SELECT wc.required_approvals INTO v_required FROM public.workflow_configs wc WHERE wc.module = p_module;
  v_required := COALESCE(v_required, 1);

  -- The review cycle restarts every time the entity re-enters a pending
  -- state (first submission, or resubmission after rejection) — only
  -- approvals recorded since that point count toward the current cycle.
  SELECT h.created_at INTO v_cycle_start FROM public.workflow_approval_history h
   WHERE h.module = p_module AND h.entity_id = p_entity_id
     AND h.to_status IN ('submitted','pending_review','pending_approval','pending_confirmation')
   ORDER BY h.created_at DESC LIMIT 1;

  SELECT COUNT(DISTINCT h.actor) INTO v_count FROM public.workflow_approval_history h
   WHERE h.module = p_module AND h.entity_id = p_entity_id
     AND h.action IN ('approve','confirm')
     AND (v_cycle_start IS NULL OR h.created_at >= v_cycle_start);

  approvals_so_far := COALESCE(v_count, 0);
  required_approvals := v_required;
  satisfied := COALESCE(v_count, 0) >= v_required;
  RETURN NEXT;
END;
$$;
GRANT EXECUTE ON FUNCTION public.workflow_approval_progress(public.module_key, uuid) TO authenticated;

-- ============ submit-logging triggers for the 2 flows with no submit RPC ============
-- expenses and payments_received are created via a raw client insert /
-- an existing untouched RPC (record_payment/create_sale) respectively, so
-- there's no single call site to add record_workflow_action() to. A thin
-- AFTER INSERT trigger captures the "submit" step for these two without
-- touching that existing code.
CREATE OR REPLACE FUNCTION public.log_workflow_submit_expenses()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := COALESCE(NEW.submitted_by, auth.uid());
BEGIN
  IF v_actor IS NOT NULL THEN
    INSERT INTO public.workflow_approval_history (module, entity_id, transaction_type, action, actor, from_status, to_status, comment)
    VALUES ('expenses', NEW.id, 'expense_approval', 'submit', v_actor, NULL, NEW.status, NEW.description);
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_log_workflow_submit_expenses ON public.expenses;
CREATE TRIGGER trg_log_workflow_submit_expenses AFTER INSERT ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.log_workflow_submit_expenses();

CREATE OR REPLACE FUNCTION public.log_workflow_submit_payments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := COALESCE(NEW.received_by, auth.uid());
BEGIN
  IF v_actor IS NOT NULL THEN
    INSERT INTO public.workflow_approval_history (module, entity_id, transaction_type, action, actor, from_status, to_status, comment)
    VALUES ('payments', NEW.id, 'payment_confirmation', 'submit', v_actor, NULL, NEW.status, 'Payment recorded: ' || COALESCE(NEW.receipt_number, ''));
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_log_workflow_submit_payments ON public.payments_received;
CREATE TRIGGER trg_log_workflow_submit_payments AFTER INSERT ON public.payments_received
FOR EACH ROW EXECUTE FUNCTION public.log_workflow_submit_payments();
