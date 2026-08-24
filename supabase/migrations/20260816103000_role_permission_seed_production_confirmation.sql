-- ============================================================================
-- ROLE PERMISSIONS — production batch confirmation (spec 20/21)
-- ============================================================================

-- Production keeps its existing create/edit bundle and gains the maker-side
-- 'cancel' for its own still-pending batches (module/role/action are all
-- plain text now, no casts needed).
INSERT INTO public.role_permissions (role, module, action) VALUES ('production','production','cancel')
ON CONFLICT DO NOTHING;

-- Store confirms/rejects what Production submits; chairman is a fallback/
-- escalation checker, matching the goods-receiving dual-checker pattern.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'store_officer','production', a FROM unnest(ARRAY['confirm','reject']::action_key[]) a
UNION ALL
SELECT 'chairman','production', a FROM unnest(ARRAY['confirm','reject']::action_key[]) a
ON CONFLICT DO NOTHING;
