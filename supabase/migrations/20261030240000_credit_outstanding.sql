-- ============================================================================
-- Credits / Outstandings: every debtor, by marketer and by distributor
-- ----------------------------------------------------------------------------
-- User request (2026-10-30): Marketer & Retail Accounts › "Credit sales
-- (distributors)" becomes "Credits/Outstandings", with a Marketers and a
-- Distributors tab listing every customer who owes -- name, total
-- outstanding, phone -- under their marketer, printable for one marketer or
-- all (as the factory's "<MARKETER> TOTAL CREDIT OUTSTANDING" sheets).
--
-- credit_outstanding(factory): each customer with an outstanding balance
-- (customers.outstanding_balance -- the "owes" the marketer account shows),
-- not removed:
--   kind 'marketer'    the customer's marketer is a marketer (sales_reps.kind
--                      'rep'): marketer_id / marketer_name / marketer_phone
--   kind 'distributor' a registered customer with no marketer
-- For anyone who can see credit or the account pages (debts, finance,
-- marketer-accounts or distributor-accounts view), in their own factory.
--
-- The page's id is its place in the menu, so the existing page-access
-- decisions move to the new name.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.credit_outstanding(p_factory uuid)
RETURNS TABLE(customer_id uuid, customer text, phone text, kind text, marketer_id uuid,
              marketer_name text, marketer_phone text, outstanding numeric, credit_limit numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'debts'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distributor-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name::text, c.phone::text,
         CASE WHEN r.kind = 'rep' THEN 'marketer' ELSE 'distributor' END,
         CASE WHEN r.kind = 'rep' THEN r.id END,
         CASE WHEN r.kind = 'rep' THEN r.full_name::text END,
         CASE WHEN r.kind = 'rep' THEN r.phone::text END,
         c.outstanding_balance, c.credit_limit
    FROM customers c
    LEFT JOIN sales_reps r ON r.id = c.sales_rep_id
   WHERE c.factory_id = p_factory
     AND c.removed_at IS NULL
     AND COALESCE(c.outstanding_balance, 0) > 0
     AND (r.kind = 'rep' OR (c.sales_rep_id IS NULL AND c.registered))
   ORDER BY 6 NULLS LAST, c.name;
END;
$$;
REVOKE ALL ON FUNCTION public.credit_outstanding(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.credit_outstanding(uuid) TO authenticated;

-- The tab is renamed: keep everyone's access to it.
DELETE FROM public.user_page_access o
 WHERE o.page_id = 'Marketer & Retail Accounts › Credit sales (distributors)'
   AND EXISTS (SELECT 1 FROM public.user_page_access n
                WHERE n.user_id = o.user_id AND n.page_id = 'Marketer & Retail Accounts › Credits/Outstandings');
UPDATE public.user_page_access SET page_id = 'Marketer & Retail Accounts › Credits/Outstandings'
 WHERE page_id = 'Marketer & Retail Accounts › Credit sales (distributors)';
