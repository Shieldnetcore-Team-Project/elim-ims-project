-- ============================================================================
-- EMPLOYEES: AUTO-GENERATE EMPLOYEE ID
-- ----------------------------------------------------------------------------
-- The Employee ID was a free-text field a person had to type in themselves
-- (and easily collided, since employee_code is UNIQUE). Auto-generate it on
-- insert instead, following the same PREFIX-YYYYMMDD-XXXXX convention already
-- used for every other auto-numbered document in this schema (PR-, PO-, GR-,
-- CST-, DEL-, etc). Runs as a BEFORE INSERT trigger (same shape as
-- set_created_by in 20260821090000) so it applies no matter which code path
-- inserts a row, not just the Employees page form.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_employee_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.employee_code IS NULL OR btrim(NEW.employee_code) = '' THEN
    NEW.employee_code := 'EMP-' || to_char(now(), 'YYYYMMDD') || '-' ||
      lpad(((floor(random() * 99999))::int)::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employees_set_code ON public.employees;
CREATE TRIGGER employees_set_code BEFORE INSERT ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.set_employee_code();
