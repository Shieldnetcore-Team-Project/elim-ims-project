
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM (
  'super_admin','factory_manager','sales_manager','sales_officer',
  'production_manager','production_officer','inventory_manager','store_keeper',
  'hr','payroll_officer','accountant','auditor','viewer'
);

CREATE TYPE public.payment_method AS ENUM ('cash','transfer','pos','card','cheque','credit');
CREATE TYPE public.debt_status AS ENUM ('paid','partial','unpaid');
CREATE TYPE public.movement_type AS ENUM ('received','issued','adjusted','transferred','produced','sold','damaged','returned');

-- ============ FACTORIES ============
CREATE TABLE public.factories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.factories TO authenticated;
GRANT ALL ON public.factories TO service_role;
ALTER TABLE public.factories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read factories" ON public.factories FOR SELECT TO authenticated USING (true);

INSERT INTO public.factories (code, name) VALUES
  ('water','Water Factory'),
  ('nylon','Nylon Factory');

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  email text,
  phone text,
  avatar_url text,
  active_factory_id uuid REFERENCES public.factories(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  factory_id uuid REFERENCES public.factories(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, role, factory_id)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('super_admin','factory_manager'));
$$;

-- ============ AUTO-CREATE PROFILE + FIRST-USER SUPER-ADMIN ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  user_count int;
  default_factory uuid;
BEGIN
  SELECT id INTO default_factory FROM public.factories WHERE code = 'water' LIMIT 1;
  INSERT INTO public.profiles (id, full_name, email, active_factory_id)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), NEW.email, default_factory);

  SELECT count(*) INTO user_count FROM auth.users;
  IF user_count = 1 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'super_admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'viewer');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ SHARED UPDATED_AT ============
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ============ SETTINGS (per factory) ============
CREATE TABLE public.settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  company_name text,
  address text,
  phone text,
  email text,
  logo_url text,
  vat_rate numeric(5,2) DEFAULT 7.5,
  currency text DEFAULT 'NGN',
  invoice_prefix text DEFAULT 'INV',
  receipt_prefix text DEFAULT 'RCP',
  production_prefix text DEFAULT 'PRD',
  employee_prefix text DEFAULT 'EMP',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(factory_id)
);
GRANT SELECT, INSERT, UPDATE ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read settings" ON public.settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin manage settings" ON public.settings FOR ALL TO authenticated
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));
CREATE TRIGGER settings_touch BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.settings (factory_id, company_name)
SELECT id, name FROM public.factories;

-- ============ PRODUCT CATEGORIES ============
CREATE TABLE public.product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_categories TO authenticated;
GRANT ALL ON public.product_categories TO service_role;
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage categories" ON public.product_categories FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ PRODUCTS (finished goods) ============
CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.product_categories(id),
  sku text,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'pcs',
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  cost_price numeric(14,2) NOT NULL DEFAULT 0,
  current_stock numeric(14,3) NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  reorder_level numeric(14,3) DEFAULT 0,
  barcode text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage products" ON public.products FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER products_touch BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ RAW MATERIALS ============
CREATE TABLE public.raw_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,
  unit text NOT NULL DEFAULT 'kg',
  opening_stock numeric(14,3) NOT NULL DEFAULT 0,
  current_stock numeric(14,3) NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  reorder_level numeric(14,3) DEFAULT 0,
  supplier_id uuid,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raw_materials TO authenticated;
GRANT ALL ON public.raw_materials TO service_role;
ALTER TABLE public.raw_materials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage raw materials" ON public.raw_materials FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER raw_materials_touch BEFORE UPDATE ON public.raw_materials FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ SUPPLIERS ============
CREATE TABLE public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  address text,
  materials_supplied text,
  outstanding_balance numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO authenticated;
GRANT ALL ON public.suppliers TO service_role;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage suppliers" ON public.suppliers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.raw_materials ADD CONSTRAINT raw_materials_supplier_fk FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);

-- ============ CUSTOMERS ============
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  address text,
  outstanding_balance numeric(14,2) NOT NULL DEFAULT 0,
  total_purchases numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage customers" ON public.customers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER customers_touch BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ EMPLOYEES ============
CREATE TABLE public.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  employee_code text UNIQUE,
  full_name text NOT NULL,
  phone text,
  email text,
  gender text,
  dob date,
  department text,
  position text,
  basic_salary numeric(14,2) NOT NULL DEFAULT 0,
  housing_allowance numeric(14,2) DEFAULT 0,
  transport_allowance numeric(14,2) DEFAULT 0,
  meal_allowance numeric(14,2) DEFAULT 0,
  medical_allowance numeric(14,2) DEFAULT 0,
  other_allowances numeric(14,2) DEFAULT 0,
  employment_date date,
  status text DEFAULT 'active',
  bank_name text,
  account_number text,
  emergency_contact text,
  photo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO authenticated;
GRANT ALL ON public.employees TO service_role;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage employees" ON public.employees FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER employees_touch BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ PRODUCTION ============
CREATE TABLE public.production (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  production_number text UNIQUE NOT NULL,
  production_date date NOT NULL DEFAULT current_date,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity_produced numeric(14,3) NOT NULL CHECK (quantity_produced > 0),
  unit text,
  production_cost numeric(14,2) DEFAULT 0,
  supervisor text,
  batch_number text,
  remarks text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.production TO authenticated;
GRANT ALL ON public.production TO service_role;
ALTER TABLE public.production ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage production" ON public.production FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ SALES ============
CREATE TABLE public.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  invoice_number text UNIQUE NOT NULL,
  sale_date date NOT NULL DEFAULT current_date,
  customer_id uuid REFERENCES public.customers(id),
  customer_name text,
  customer_phone text,
  customer_address text,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount numeric(14,2) NOT NULL DEFAULT 0,
  vat numeric(14,2) NOT NULL DEFAULT 0,
  grand_total numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  balance numeric(14,2) NOT NULL DEFAULT 0,
  payment_method payment_method NOT NULL DEFAULT 'cash',
  sales_person text,
  remarks text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales TO authenticated;
GRANT ALL ON public.sales TO service_role;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage sales" ON public.sales FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL,
  line_total numeric(14,2) NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_items TO authenticated;
GRANT ALL ON public.sale_items TO service_role;
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage sale items" ON public.sale_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ EXPENSES ============
CREATE TABLE public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_categories TO authenticated;
GRANT ALL ON public.expense_categories TO service_role;
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage expense categories" ON public.expense_categories FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  expense_date date NOT NULL DEFAULT current_date,
  category_id uuid REFERENCES public.expense_categories(id),
  description text,
  vendor text,
  receipt_number text,
  payment_method payment_method NOT NULL DEFAULT 'cash',
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  approved_by text,
  recorded_by uuid REFERENCES auth.users(id),
  attachment_url text,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses TO authenticated;
GRANT ALL ON public.expenses TO service_role;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage expenses" ON public.expenses FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ PAYROLL ============
CREATE TABLE public.payroll (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  period_month int NOT NULL,
  period_year int NOT NULL,
  basic_salary numeric(14,2) NOT NULL DEFAULT 0,
  allowances numeric(14,2) NOT NULL DEFAULT 0,
  overtime numeric(14,2) NOT NULL DEFAULT 0,
  gross_salary numeric(14,2) NOT NULL DEFAULT 0,
  paye numeric(14,2) NOT NULL DEFAULT 0,
  pension numeric(14,2) NOT NULL DEFAULT 0,
  loans numeric(14,2) NOT NULL DEFAULT 0,
  advance numeric(14,2) NOT NULL DEFAULT 0,
  other_deductions numeric(14,2) NOT NULL DEFAULT 0,
  net_salary numeric(14,2) NOT NULL DEFAULT 0,
  payment_method payment_method DEFAULT 'transfer',
  payment_date date,
  status text DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll TO authenticated;
GRANT ALL ON public.payroll TO service_role;
ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage payroll" ON public.payroll FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ PAYMENTS RECEIVED ============
CREATE TABLE public.payments_received (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  receipt_number text UNIQUE NOT NULL,
  customer_id uuid REFERENCES public.customers(id),
  sale_id uuid REFERENCES public.sales(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_method payment_method NOT NULL DEFAULT 'cash',
  payment_date date NOT NULL DEFAULT current_date,
  received_by uuid REFERENCES auth.users(id),
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments_received TO authenticated;
GRANT ALL ON public.payments_received TO service_role;
ALTER TABLE public.payments_received ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage payments received" ON public.payments_received FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ DEBTS + DEBT PAYMENTS ============
CREATE TABLE public.debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id),
  sale_id uuid REFERENCES public.sales(id),
  total_amount numeric(14,2) NOT NULL,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  outstanding numeric(14,2) NOT NULL DEFAULT 0,
  status debt_status NOT NULL DEFAULT 'unpaid',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.debts TO authenticated;
GRANT ALL ON public.debts TO service_role;
ALTER TABLE public.debts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage debts" ON public.debts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER debts_touch BEFORE UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.debt_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id uuid NOT NULL REFERENCES public.debts(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_method payment_method NOT NULL DEFAULT 'cash',
  payment_date date NOT NULL DEFAULT current_date,
  received_by uuid REFERENCES auth.users(id),
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.debt_payments TO authenticated;
GRANT ALL ON public.debt_payments TO service_role;
ALTER TABLE public.debt_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage debt payments" ON public.debt_payments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ RAW MATERIAL MOVEMENTS ============
CREATE TABLE public.raw_material_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,
  movement_type movement_type NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit_cost numeric(14,2),
  reference text,
  reason text,
  user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raw_material_movements TO authenticated;
GRANT ALL ON public.raw_material_movements TO service_role;
ALTER TABLE public.raw_material_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage rmm" ON public.raw_material_movements FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ INVENTORY MOVEMENTS (finished goods) ============
CREATE TABLE public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  movement_type movement_type NOT NULL,
  quantity numeric(14,3) NOT NULL,
  reference text,
  reason text,
  user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_movements TO authenticated;
GRANT ALL ON public.inventory_movements TO service_role;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage inv movements" ON public.inventory_movements FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ NOTIFICATIONS ============
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  factory_id uuid REFERENCES public.factories(id),
  title text NOT NULL,
  body text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own notifications" ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid() OR user_id IS NULL);
CREATE POLICY "update own notifications" ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- ============ AUDIT LOGS ============
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  factory_id uuid REFERENCES public.factories(id),
  action text NOT NULL,
  entity text,
  entity_id text,
  old_value jsonb,
  new_value jsonb,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read audit logs" ON public.audit_logs FOR SELECT TO authenticated USING (public.is_admin(auth.uid()) OR public.has_role(auth.uid(),'auditor'));
CREATE POLICY "insert audit logs" ON public.audit_logs FOR INSERT TO authenticated WITH CHECK (true);
