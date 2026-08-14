
-- ============================================================
-- Replaces every blanket "TO authenticated USING (true)" policy (and the
-- anon-open workaround policies layered on top of them) with policies that
-- call has_permission(auth.uid(), '<module>', 'read'|'write') -- the same
-- function RPC guards and the frontend now consume. This supersedes
-- supabase/deferred_migrations/20260813120000_revoke_anon_access.sql: it
-- does the same anon revocation, plus the role-based rewrite, in one
-- coherent migration.
-- ============================================================

-- ---------- anon revocation ----------
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ---------- factories ----------
DROP POLICY IF EXISTS "manage factories" ON public.factories;
CREATE POLICY "settings write factories" ON public.factories FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'settings', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'settings', 'write'));

-- ---------- user_roles ----------
DROP POLICY IF EXISTS "manage user roles" ON public.user_roles;
CREATE POLICY "users write roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'users', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'users', 'write'));

-- ---------- settings ----------
DROP POLICY IF EXISTS "admin manage settings" ON public.settings;
DROP POLICY IF EXISTS "anon manage settings" ON public.settings;
CREATE POLICY "settings write" ON public.settings FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'settings', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'settings', 'write'));

-- ---------- finished-goods (product_categories, products) ----------
DROP POLICY IF EXISTS "auth manage categories" ON public.product_categories;
CREATE POLICY "finished-goods read categories" ON public.product_categories FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'finished-goods', 'read'));
CREATE POLICY "finished-goods write categories" ON public.product_categories FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'finished-goods', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'finished-goods', 'write'));

DROP POLICY IF EXISTS "auth manage products" ON public.products;
CREATE POLICY "finished-goods read products" ON public.products FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'finished-goods', 'read'));
CREATE POLICY "finished-goods write products" ON public.products FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'finished-goods', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'finished-goods', 'write'));

-- ---------- raw-materials (raw_materials, raw_material_movements) ----------
DROP POLICY IF EXISTS "auth manage raw materials" ON public.raw_materials;
CREATE POLICY "raw-materials read" ON public.raw_materials FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials', 'read'));
CREATE POLICY "raw-materials write" ON public.raw_materials FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'raw-materials', 'write'));

DROP POLICY IF EXISTS "auth manage rmm" ON public.raw_material_movements;
CREATE POLICY "raw-materials read movements" ON public.raw_material_movements FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials', 'read'));
CREATE POLICY "raw-materials write movements" ON public.raw_material_movements FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'raw-materials', 'write'));

-- ---------- suppliers ----------
DROP POLICY IF EXISTS "auth manage suppliers" ON public.suppliers;
CREATE POLICY "suppliers read" ON public.suppliers FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'suppliers', 'read'));
CREATE POLICY "suppliers write" ON public.suppliers FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'suppliers', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'suppliers', 'write'));

-- ---------- customers ----------
DROP POLICY IF EXISTS "auth manage customers" ON public.customers;
CREATE POLICY "customers read" ON public.customers FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'customers', 'read'));
CREATE POLICY "customers write" ON public.customers FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'customers', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'customers', 'write'));

-- ---------- employees (employees, employee_documents) ----------
DROP POLICY IF EXISTS "auth manage employees" ON public.employees;
CREATE POLICY "employees read" ON public.employees FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'employees', 'read'));
CREATE POLICY "employees write" ON public.employees FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'employees', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'employees', 'write'));

DROP POLICY IF EXISTS "auth manage employee documents" ON public.employee_documents;
CREATE POLICY "employees read documents" ON public.employee_documents FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'employees', 'read'));
CREATE POLICY "employees write documents" ON public.employee_documents FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'employees', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'employees', 'write'));

-- ---------- production (production, production_requests, production_request_items) ----------
DROP POLICY IF EXISTS "auth manage production" ON public.production;
CREATE POLICY "production read" ON public.production FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production', 'read'));
CREATE POLICY "production write" ON public.production FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'production', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'production', 'write'));

DROP POLICY IF EXISTS "manage production requests" ON public.production_requests;
CREATE POLICY "production-requests read" ON public.production_requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production-requests', 'read'));
CREATE POLICY "production-requests write" ON public.production_requests FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'production-requests', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'production-requests', 'write'));

DROP POLICY IF EXISTS "manage production request items" ON public.production_request_items;
CREATE POLICY "production-requests read items" ON public.production_request_items FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production-requests', 'read'));
CREATE POLICY "production-requests write items" ON public.production_request_items FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'production-requests', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'production-requests', 'write'));

-- ---------- inventory (inventory_movements) ----------
DROP POLICY IF EXISTS "auth manage inv movements" ON public.inventory_movements;
CREATE POLICY "inventory read movements" ON public.inventory_movements FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'inventory', 'read'));
CREATE POLICY "inventory write movements" ON public.inventory_movements FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'inventory', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'inventory', 'write'));

-- ---------- sales (sales, sale_items) ----------
DROP POLICY IF EXISTS "auth manage sales" ON public.sales;
CREATE POLICY "sales read" ON public.sales FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales', 'read'));
CREATE POLICY "sales write" ON public.sales FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'sales', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'sales', 'write'));

DROP POLICY IF EXISTS "auth manage sale items" ON public.sale_items;
CREATE POLICY "sales read items" ON public.sale_items FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales', 'read'));
CREATE POLICY "sales write items" ON public.sale_items FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'sales', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'sales', 'write'));

-- ---------- expenses (expense_categories, expenses) ----------
DROP POLICY IF EXISTS "auth manage expense categories" ON public.expense_categories;
CREATE POLICY "expenses read categories" ON public.expense_categories FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses', 'read'));
CREATE POLICY "expenses write categories" ON public.expense_categories FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'expenses', 'write'));

DROP POLICY IF EXISTS "auth manage expenses" ON public.expenses;
CREATE POLICY "expenses read" ON public.expenses FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses', 'read'));
CREATE POLICY "expenses write" ON public.expenses FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'expenses', 'write'));

-- ---------- payroll ----------
DROP POLICY IF EXISTS "auth manage payroll" ON public.payroll;
CREATE POLICY "payroll read" ON public.payroll FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'payroll', 'read'));
CREATE POLICY "payroll write" ON public.payroll FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'payroll', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'payroll', 'write'));

-- ---------- payments (payments_received) ----------
DROP POLICY IF EXISTS "auth manage payments received" ON public.payments_received;
CREATE POLICY "payments read" ON public.payments_received FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'payments', 'read'));
CREATE POLICY "payments write" ON public.payments_received FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'payments', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'payments', 'write'));

-- ---------- debts (debts, debt_payments) ----------
DROP POLICY IF EXISTS "auth manage debts" ON public.debts;
CREATE POLICY "debts read" ON public.debts FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'debts', 'read'));
CREATE POLICY "debts write" ON public.debts FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'debts', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'debts', 'write'));

DROP POLICY IF EXISTS "auth manage debt payments" ON public.debt_payments;
CREATE POLICY "debts read payments" ON public.debt_payments FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'debts', 'read'));
CREATE POLICY "debts write payments" ON public.debt_payments FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'debts', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'debts', 'write'));

-- ---------- receipts-payments (cash_transactions) ----------
DROP POLICY IF EXISTS "manage cash transactions" ON public.cash_transactions;
CREATE POLICY "receipts-payments read" ON public.cash_transactions FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'receipts-payments', 'read'));
CREATE POLICY "receipts-payments write" ON public.cash_transactions FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'receipts-payments', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'receipts-payments', 'write'));

-- ---------- audit-logs ----------
DROP POLICY IF EXISTS "anon read audit logs" ON public.audit_logs;
DROP POLICY IF EXISTS "read audit logs" ON public.audit_logs;
CREATE POLICY "audit-logs read" ON public.audit_logs FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'audit-logs', 'read'));
-- "insert audit logs" (open insert, any authenticated caller) is unchanged --
-- logging must never be blocked by the permission system it's recording.

-- ---------- storage ----------
-- company-logos stays publicly readable; only the anon write/admin policies
-- added alongside it are reverted to authenticated-only.
DROP POLICY IF EXISTS "anon upload company logos" ON storage.objects;
DROP POLICY IF EXISTS "anon update company logos" ON storage.objects;
DROP POLICY IF EXISTS "anon delete company logos" ON storage.objects;
CREATE POLICY "auth upload company logos" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'company-logos');
CREATE POLICY "auth update company logos" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'company-logos');
CREATE POLICY "auth delete company logos" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'company-logos');

DROP POLICY IF EXISTS "anon delete expense attachments" ON storage.objects;
ALTER POLICY "auth read expense attachments" ON storage.objects TO authenticated;
ALTER POLICY "auth upload expense attachments" ON storage.objects TO authenticated;
ALTER POLICY "auth read employee files" ON storage.objects TO authenticated;
ALTER POLICY "auth upload employee files" ON storage.objects TO authenticated;
ALTER POLICY "auth delete employee files" ON storage.objects TO authenticated;
