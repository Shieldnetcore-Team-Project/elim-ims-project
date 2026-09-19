-- The Finance page's payment-channel breakdown reads cash_transactions; add it
-- to the realtime publication (idempotent) so the page refreshes live.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'cash_transactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cash_transactions;
  END IF;
END $$;
