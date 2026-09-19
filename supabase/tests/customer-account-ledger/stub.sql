-- Minimal stand-in for the parts of the Supabase schema the ledger migration touches.
-- Column sets mirror the real tables (see supabase/migrations + types.ts).
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.uid', true), '')::uuid $$;
CREATE PUBLICATION supabase_realtime;

CREATE TYPE public.payment_method AS ENUM ('cash','transfer','pos','card','cheque','credit');
CREATE TYPE public.debt_status AS ENUM ('paid','partial','unpaid');
CREATE DOMAIN public.workflow_status AS text CHECK (VALUE IN ('draft','submitted','pending_review','pending_approval','approved','rejected','processing','completed','pending_confirmation','confirmed','posted','cancelled','reversed'));
CREATE DOMAIN public.module_key AS text;
CREATE DOMAIN public.action_key AS text;

CREATE TABLE public.workflow_transitions (from_status public.workflow_status NOT NULL, to_status public.workflow_status NOT NULL, PRIMARY KEY (from_status, to_status));
INSERT INTO public.workflow_transitions VALUES
  ('draft','submitted'),('draft','cancelled'),('submitted','pending_review'),('submitted','pending_approval'),('submitted','cancelled'),
  ('pending_review','pending_approval'),('pending_review','rejected'),('pending_review','cancelled'),
  ('pending_approval','approved'),('pending_approval','rejected'),('pending_approval','cancelled'),('pending_approval','posted'),
  ('approved','processing'),('approved','posted'),('approved','cancelled'),('processing','completed'),('processing','cancelled'),
  ('completed','posted'),('pending_confirmation','confirmed'),('pending_confirmation','rejected'),
  ('confirmed','posted'),('confirmed','reversed'),('posted','reversed'),('rejected','submitted');
CREATE FUNCTION public.assert_valid_transition(p_from public.workflow_status, p_to public.workflow_status) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM public.workflow_transitions WHERE from_status = p_from AND to_status = p_to) THEN RAISE EXCEPTION 'Invalid status transition: % -> %', p_from, p_to; END IF; END; $$;

CREATE TABLE public.workflow_configs (module public.module_key PRIMARY KEY, transaction_type text NOT NULL, maker_label text NOT NULL, checker_label text NOT NULL, final_status public.workflow_status NOT NULL, required_approvals int NOT NULL DEFAULT 1, description text);
CREATE TABLE public.workflow_approval_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), module public.module_key NOT NULL, entity_id uuid NOT NULL, transaction_type text NOT NULL, action public.action_key NOT NULL, actor uuid NOT NULL, from_status public.workflow_status, to_status public.workflow_status NOT NULL, comment text, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.record_workflow_action(p_module public.module_key, p_entity_id uuid, p_action public.action_key, p_from_status public.workflow_status, p_to_status public.workflow_status, p_comment text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_uid uuid := auth.uid(); v_txn_type text; v_id uuid;
BEGIN IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT transaction_type INTO v_txn_type FROM public.workflow_configs WHERE module = p_module;
  INSERT INTO public.workflow_approval_history (module, entity_id, transaction_type, action, actor, from_status, to_status, comment) VALUES (p_module, p_entity_id, COALESCE(v_txn_type, p_module::text), p_action, v_uid, p_from_status, p_to_status, p_comment) RETURNING id INTO v_id;
  RETURN v_id; END; $$;

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
CREATE TABLE public.role_permissions (role text NOT NULL, module public.module_key NOT NULL, action public.action_key NOT NULL, PRIMARY KEY (role, module, action));
CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE FUNCTION public.has_permission(_user_id uuid, _module public.module_key, _action public.action_key DEFAULT 'view') RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _user_id IS NOT NULL AND (public.has_role(_user_id,'super_admin') OR public.has_role(_user_id,'chairman')
    OR EXISTS (SELECT 1 FROM public.role_permissions rp JOIN public.user_roles ur ON ur.role = rp.role
               WHERE ur.user_id = _user_id AND rp.module = _module AND (rp.action = _action OR (_action = 'write' AND rp.action IN ('create','edit','delete')))))
$$;

CREATE TABLE public.factories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.settings (factory_id uuid PRIMARY KEY, receipt_prefix text);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL REFERENCES public.factories(id), name text NOT NULL,
  outstanding_balance numeric(14,2) NOT NULL DEFAULT 0, total_purchases numeric(14,2) NOT NULL DEFAULT 0,
  credit_balance numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0), total_transactions int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid, name text, current_stock numeric NOT NULL DEFAULT 0, updated_at timestamptz DEFAULT now());
CREATE TABLE public.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, invoice_number text NOT NULL, sale_date date NOT NULL DEFAULT current_date,
  customer_id uuid REFERENCES public.customers(id), sales_rep_id uuid, grand_total numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0, balance numeric(14,2) NOT NULL DEFAULT 0, credit_applied numeric(14,2) NOT NULL DEFAULT 0,
  payment_method public.payment_method NOT NULL DEFAULT 'cash', status public.workflow_status NOT NULL DEFAULT 'pending_approval',
  is_pr boolean NOT NULL DEFAULT false, pending_payments jsonb, created_by uuid, approved_by uuid, approved_at timestamptz, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sale_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sale_id uuid NOT NULL REFERENCES public.sales(id), product_id uuid NOT NULL REFERENCES public.products(id), quantity numeric NOT NULL, unit_price numeric NOT NULL DEFAULT 0);
CREATE TABLE public.rep_stock (sales_rep_id uuid, product_id uuid, quantity numeric, updated_at timestamptz);
CREATE TABLE public.rep_stock_movements (factory_id uuid, sales_rep_id uuid, product_id uuid, movement_type text, quantity numeric, reference text, reason text, user_id uuid, quantity_before numeric, quantity_after numeric);
CREATE TABLE public.inventory_movements (factory_id uuid, product_id uuid, movement_type text, quantity numeric, reference text, reason text, user_id uuid, quantity_before numeric, quantity_after numeric);
CREATE TABLE public.payments_received (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, receipt_number text UNIQUE NOT NULL, customer_id uuid, sale_id uuid,
  amount numeric(14,2) NOT NULL, payment_method public.payment_method NOT NULL DEFAULT 'cash', payment_date date NOT NULL DEFAULT current_date,
  received_by uuid, remarks text, status public.workflow_status NOT NULL DEFAULT 'pending_confirmation', reviewed_by uuid, reviewed_at timestamptz, review_note text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, customer_id uuid, sale_id uuid, sales_rep_id uuid,
  total_amount numeric(14,2) NOT NULL, amount_paid numeric(14,2) NOT NULL DEFAULT 0, outstanding numeric(14,2) NOT NULL,
  status public.debt_status NOT NULL DEFAULT 'unpaid', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  writeoff_status public.workflow_status, writeoff_requested_by uuid, writeoff_amount numeric);
CREATE TABLE public.debt_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), debt_id uuid NOT NULL REFERENCES public.debts(id), amount numeric NOT NULL, payment_method public.payment_method, payment_date date, received_by uuid, remarks text);
CREATE TABLE public.audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, factory_id uuid, action text NOT NULL, entity text, entity_id text, old_value jsonb, new_value jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.delete_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid, table_name text, entity_id uuid, entity_label text, reason text, requested_by uuid, payload jsonb, review_status text DEFAULT 'pending', reviewed_by uuid, reviewed_at timestamptz);
CREATE TABLE public.notifications (user_id uuid, factory_id uuid, title text, body text);
