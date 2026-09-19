-- ============================================================================
-- Defence in depth for the customer-account RPCs
-- ----------------------------------------------------------------------------
-- Every one of these already refuses a caller with no permission (an anonymous
-- request has no user id, so has_permission() is false). But Postgres grants
-- EXECUTE on a new function to PUBLIC, and Supabase additionally grants it to
-- the `anon` role, so an unauthenticated request could still reach the function
-- body. None of them is ever meant to be called before sign-in, so take the
-- privilege away outright and leave it with signed-in users only.
-- ============================================================================
REVOKE ALL ON FUNCTION public.record_customer_advance(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_payment(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_customer_adjustment(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_customer_adjustment(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_customer_adjustment(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_customer_adjustment(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reconcile_customer_account(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_customer_advance(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_customer_adjustment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_customer_adjustment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_customer_adjustment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_customer_adjustment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_customer_account(uuid) TO authenticated;
