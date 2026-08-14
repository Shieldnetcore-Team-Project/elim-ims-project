
-- ============ PAYROLL: itemized allowances + payment-time bank snapshot ============
-- The payroll table has never shipped a UI and holds zero rows, so this reshape is safe.
ALTER TABLE public.payroll DROP COLUMN IF EXISTS allowances;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS housing_allowance numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS transport_allowance numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS meal_allowance numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS medical_allowance numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS other_allowances numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS account_number text;

-- ============ EMPLOYEE DOCUMENTS ============
CREATE TABLE IF NOT EXISTS public.employee_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_path text NOT NULL,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.employee_documents TO authenticated;
GRANT ALL ON public.employee_documents TO service_role;
ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage employee documents" ON public.employee_documents FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ EMPLOYEE FILES STORAGE (photos + documents) ============
INSERT INTO storage.buckets (id, name, public)
VALUES ('employee-files', 'employee-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "auth read employee files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'employee-files');
CREATE POLICY "auth upload employee files" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'employee-files');
CREATE POLICY "auth delete employee files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'employee-files');
