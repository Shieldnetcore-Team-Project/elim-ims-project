-- ============================================================================
-- FIX: 'sales' role couldn't see payments_received at all — advance
-- deposits silently dropped out of the customer account ledger
-- ----------------------------------------------------------------------------
-- payments_received's RLS SELECT policy ("payments read",
-- 20260814093000_rls_permission_rewrite.sql:167-168) is gated on module
-- 'payments'. 'cashier' already holds payments:view; the 'sales' role never
-- did, despite already having full sales:* access and being exactly who
-- records sales for named customers. In practice this meant every
-- payments_received row — including advance-payment "Deposited" entries
-- (record_customer_advance) — was invisible to a sales-role account: not an
-- arithmetic bug in the account-ledger merge, the deposit rows just never
-- came back from the query, so the running balance only ever subtracted
-- goods and never added deposits. Same class of gap as
-- 20260923120000_cashier_customers_grant.sql (that one was 'cashier'
-- missing 'customers'; this is 'sales' missing 'payments').
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
VALUES ('sales', 'payments', 'view')
ON CONFLICT (role, module, action) DO NOTHING;
