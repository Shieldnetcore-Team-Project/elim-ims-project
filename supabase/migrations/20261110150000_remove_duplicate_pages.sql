-- ============================================================================
-- One place for each page: duplicate menu entries removed
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "remove any duplicate of pages ... take off any tab that
-- appears multiple times in the system". Kept (the user's choices):
--   Store Requests        Store › Requests        (off Production and Warehouse)
--   Sales Returns         Warehouse › Returns     (off Retail)
--   Postings to assess, Retail cash-up, Cash remitted, Reps & outlets,
--   Customers             the Accountant page     (off Marketer & Retail Accounts)
--   Reports               All Reports             (Financial Reports off)
--   Dispenser & jugs, Jugs collected
--                         Quality Control › Dispenser (one tab)
-- Nobody loses a page they could use: whoever could see a removed copy (ticked
-- for it, or not unticked and holding its module) and is unticked on the kept
-- page is ticked for the kept page. Then the removed copies' rows go.
-- Data only; safe to re-run.
-- ============================================================================

DO $$
DECLARE
  m record;
BEGIN
  FOR m IN SELECT * FROM (VALUES
    ('Production › Store Requests',                       'Store › Requests',            'production-requests'),
    ('Warehouse › Store requests',                        'Store › Requests',            'production-requests'),
    ('Retail › Sales Returns',                            'Warehouse › Returns',         'sales-returns'),
    ('Marketer & Retail Accounts › Postings to assess',   'Accountant',                  'finance'),
    ('Marketer & Retail Accounts › Retail cash-up',       'Accountant',                  'finance'),
    ('Marketer & Retail Accounts › Cash remitted',        'Accountant',                  'finance'),
    ('Marketer & Retail Accounts › Reps & outlets',       'Accountant',                  'finance'),
    ('Marketer & Retail Accounts › Customers',            'Accountant',                  'customers'),
    ('Financial Reports',                                 'All Reports',                 'reports'),
    ('Quality Control › Dispenser & jugs',                'Quality Control › Dispenser', 'distribution')
  ) AS t(old_id, new_id, module)
  LOOP
    -- Could see the removed copy, but is unticked on the kept page: tick it.
    UPDATE public.user_page_access k
       SET granted = true, granted_at = now()
     WHERE k.page_id = m.new_id AND NOT k.granted
       AND (EXISTS (SELECT 1 FROM public.user_page_access o
                     WHERE o.user_id = k.user_id AND o.page_id = m.old_id AND o.granted)
            OR (NOT EXISTS (SELECT 1 FROM public.user_page_access o
                             WHERE o.user_id = k.user_id AND o.page_id = m.old_id)
                AND public.has_permission(k.user_id, m.module::module_key, 'view'::action_key)));
    -- Ticked for the removed copy only: tick the kept page.
    INSERT INTO public.user_page_access (user_id, page_id, granted, granted_by, granted_at)
    SELECT o.user_id, m.new_id, true, o.granted_by, now()
      FROM public.user_page_access o
     WHERE o.page_id = m.old_id AND o.granted
    ON CONFLICT (user_id, page_id) DO NOTHING;
    DELETE FROM public.user_page_access WHERE page_id = m.old_id;
  END LOOP;
END $$;
