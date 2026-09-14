-- ============================================================================
-- Accountant/cashier couldn't open the Cash & Receivables "Overview" tab
-- ----------------------------------------------------------------------------
-- _app.cash-ledger.index.tsx (the Overview tab) gates on module 'cash-flow',
-- while the Ledger and Debts tabs of the same feature gate on
-- 'receipts-payments' and 'debts'. accountant and cashier already hold full
-- receipts-payments/debts/payments access (they run this feature day to day)
-- but were never granted cash-flow:view, so only 'chairman' could see the
-- Overview tab -- a seeding gap, not an intentional restriction.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
VALUES
  ('accountant', 'cash-flow', 'view'),
  ('cashier', 'cash-flow', 'view')
ON CONFLICT (role, module, action) DO NOTHING;
