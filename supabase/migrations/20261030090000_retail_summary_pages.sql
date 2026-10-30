-- Retail › Transaction Summary and Retail › Posting Log (src/routes/_app.retail-summary.tsx):
-- the shop's day summary and who posted what, when. Ticked for every account
-- that already has the Retail Outlet page, so the retail staff see them in
-- Page access as granted, like POS / Retail Outlet / Sales Returns.
INSERT INTO public.user_page_access (user_id, page_id, granted)
SELECT a.user_id, p.page_id, true
  FROM public.user_page_access a
 CROSS JOIN (VALUES ('Retail › Transaction Summary'), ('Retail › Posting Log')) AS p(page_id)
 WHERE a.page_id = 'Retail › Retail Outlet' AND a.granted
ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();
