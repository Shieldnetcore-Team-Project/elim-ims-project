-- ============================================================================
-- FIX: customers.credit_balance was left directly UPDATE-able by any
-- authenticated client
-- ----------------------------------------------------------------------------
-- 20260816107000_close_direct_write_gaps.sql already column-locked
-- outstanding_balance/total_purchases for exactly this reason (protected
-- balance columns sharing a row with legitimately client-editable master
-- data like name/phone/address); credit_balance (added in
-- 20260923130000_sales_customer_credit_and_soft_delete.sql) is the same
-- kind of column -- only record_customer_advance()/create_sale()/
-- approve_sale() should ever move it -- and was missed in that migration.
-- ============================================================================

REVOKE UPDATE (credit_balance) ON public.customers FROM authenticated;
