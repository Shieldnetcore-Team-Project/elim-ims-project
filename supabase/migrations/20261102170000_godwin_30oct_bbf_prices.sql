-- ============================================================================
-- Godwin's 30 Oct 2026 load-outs: the old system's figures, brought forward
-- ----------------------------------------------------------------------------
-- User (2026-11-02): Godwin's load-outs of 30/10/2026 are his account
-- migrated from the old system -- the balance brought forward -- at the old
-- system's totals:
--   1) 50cl 100, 75cl 150   N520,000
--   2) 75cl 60              N102,000
--   3) 75cl 200             N340,000
--   4) 50cl 16              N42,400
--   His return: 75cl 4, 50cl 16
-- i.e. 50cl at N2,650 a pack and 75cl at N1,700 a pack (100 x 2,650 +
-- 150 x 1,700 = 520,000). 20261102100000 recorded them at the products'
-- prices of the day; this re-prices the four postings and the return at the
-- old system's prices, so his account shows:
--   supplied N1,004,400 - returned N49,200 (75cl 4 = 6,800; 50cl 16 = 42,400)
-- and notes each as the balance brought forward from the old system.
--
-- Only those records (notes "... of 30/10/2026 (WhatsApp message) ..."), and
-- only when all four postings and the return are found with the quantities
-- above; otherwise nothing changes and it says why. Does nothing where
-- 20261102100000 recorded nothing (a fresh database). Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._godwin_30oct_bbf_prices()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_n int;
  v_d record;
  v_expect numeric;
  v_total numeric;
  v_ret rep_returns%ROWTYPE;
  v_price50 numeric := 2650;
  v_price75 numeric := 1700;
  v_done jsonb := '[]'::jsonb;
BEGIN
  v_n := (SELECT count(*) FROM sales_reps WHERE kind = 'rep' AND full_name ~* '\mgodwin\M');
  IF v_n <> 1 THEN
    RAISE NOTICE 'Found % marketers named Godwin -- nothing changed', v_n;
    RETURN;
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE kind = 'rep' AND full_name ~* '\mgodwin\M';
  IF NOT EXISTS (SELECT 1 FROM stock_dispatches
                  WHERE sales_rep_id = v_rep.id AND dispatch_date = DATE '2026-10-30'
                    AND notes ~ 'Load out \d of 30/10/2026 \(WhatsApp message\)') THEN
    RAISE NOTICE 'Godwin has no 30 Oct load-outs recorded -- run 20261102100000 first; nothing changed';
    RETURN;
  END IF;

  -- The four postings, each checked against the old system's quantities.
  FOR v_d IN
    SELECT d.id, d.dispatch_number, d.total_value,
           substring(d.notes FROM 'Load out (\d) of 30/10/2026')::int AS n,
           COALESCE(SUM(i.quantity) FILTER (WHERE p.name ~* '^50 ?cl'), 0) AS q50,
           COALESCE(SUM(i.quantity) FILTER (WHERE p.name ~* '^75 ?cl'), 0) AS q75
      FROM stock_dispatches d
      JOIN stock_dispatch_items i ON i.dispatch_id = d.id
      JOIN products p ON p.id = i.product_id
     WHERE d.sales_rep_id = v_rep.id AND d.dispatch_date = DATE '2026-10-30' AND d.status = 'posted'
       AND d.notes ~ 'Load out \d of 30/10/2026 \(WhatsApp message\)'
     GROUP BY d.id
     ORDER BY 4
  LOOP
    v_expect := CASE v_d.n WHEN 1 THEN 520000 WHEN 2 THEN 102000 WHEN 3 THEN 340000 WHEN 4 THEN 42400 END;
    IF (v_d.n, v_d.q50, v_d.q75) NOT IN ((1, 100, 150), (2, 0, 60), (3, 0, 200), (4, 16, 0)) THEN
      RAISE EXCEPTION 'Posting % (load out %) is 50cl % / 75cl % -- not the sheet''s quantities; nothing changed',
        v_d.dispatch_number, v_d.n, v_d.q50, v_d.q75;
    END IF;
    v_total := v_d.q50 * v_price50 + v_d.q75 * v_price75;
    IF v_total <> v_expect THEN
      RAISE EXCEPTION 'Load out % works out at % not % -- nothing changed', v_d.n, v_total, v_expect;
    END IF;
    UPDATE stock_dispatch_items i
       SET unit_price = CASE WHEN p.name ~* '^50 ?cl' THEN v_price50 ELSE v_price75 END,
           line_value = i.quantity * CASE WHEN p.name ~* '^50 ?cl' THEN v_price50 ELSE v_price75 END
      FROM products p
     WHERE p.id = i.product_id AND i.dispatch_id = v_d.id;
    UPDATE stock_dispatches
       SET total_value = v_total,
           notes = CASE WHEN notes LIKE 'Balance brought forward from the old system%' THEN notes
                        ELSE 'Balance brought forward from the old system (30/10/2026, N'
                             || trim(to_char(v_total, 'FM999G999G990')) || '). ' || notes END
     WHERE id = v_d.id;
    v_done := v_done || jsonb_build_object('posting', v_d.dispatch_number, 'load_out', v_d.n,
                                           'was', v_d.total_value, 'now', v_total);
  END LOOP;
  IF jsonb_array_length(v_done) <> 4 THEN
    RAISE EXCEPTION 'Found % of Godwin''s four 30 Oct load-outs -- nothing changed', jsonb_array_length(v_done);
  END IF;

  -- His return at the same prices.
  v_n := (SELECT count(*) FROM rep_returns
           WHERE sales_rep_id = v_rep.id AND return_date = DATE '2026-10-30' AND status = 'completed'
             AND notes ~ 'Return of 30/10/2026 \(WhatsApp message\)');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Found % of Godwin''s 30 Oct returns -- nothing changed', v_n;
  END IF;
  SELECT * INTO v_ret FROM rep_returns
   WHERE sales_rep_id = v_rep.id AND return_date = DATE '2026-10-30' AND status = 'completed'
     AND notes ~ 'Return of 30/10/2026 \(WhatsApp message\)';
  UPDATE rep_return_items i
     SET unit_price = CASE WHEN p.name ~* '^50 ?cl' THEN v_price50 ELSE v_price75 END
    FROM products p
   WHERE p.id = i.product_id AND i.rep_return_id = v_ret.id;
  UPDATE rep_returns
     SET notes = CASE WHEN notes LIKE 'Balance brought forward from the old system%' THEN notes
                      ELSE 'Balance brought forward from the old system (30/10/2026, N49,200). ' || notes END
   WHERE id = v_ret.id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (NULL, v_rep.factory_id, 'godwin_30oct_bbf_prices', 'sales_reps', v_rep.id::text,
          jsonb_build_object('postings', v_done, 'return', v_ret.return_number,
                             'price_50cl', v_price50, 'price_75cl', v_price75,
                             'supplied', 1004400, 'returned', 49200));
  RAISE NOTICE 'Godwin brought forward: supplied N1,004,400, returned N49,200 (%)', v_done;
END;
$$;
REVOKE ALL ON FUNCTION public._godwin_30oct_bbf_prices() FROM PUBLIC, anon, authenticated;

SELECT public._godwin_30oct_bbf_prices();
