-- Record the first Warehouse print so later prints are labelled Reprint.
CREATE TABLE IF NOT EXISTS public.warehouse_slip_prints (
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  document_kind text NOT NULL CHECK (document_kind IN ('dispatch', 'sale')),
  document_id uuid NOT NULL,
  printed_at timestamptz NOT NULL DEFAULT now(),
  printed_by uuid REFERENCES auth.users(id),
  PRIMARY KEY (factory_id, document_kind, document_id)
);
ALTER TABLE public.warehouse_slip_prints ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.warehouse_slip_prints TO service_role;

CREATE OR REPLACE FUNCTION public.claim_warehouse_slip(
  p_factory uuid,
  p_document_kind text,
  p_reference text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_document_id uuid;
  v_rows integer;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
     OR NOT public._works_in_factory(auth.uid(), p_factory) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_document_kind = 'dispatch' THEN
    SELECT id INTO v_document_id
      FROM public.stock_dispatches
     WHERE factory_id = p_factory AND dispatch_number = p_reference;
  ELSIF p_document_kind = 'sale' THEN
    SELECT id INTO v_document_id
      FROM public.sales
     WHERE factory_id = p_factory AND invoice_number = p_reference;
  ELSE
    RAISE EXCEPTION 'Unsupported Warehouse slip type';
  END IF;
  IF v_document_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse document not found';
  END IF;
  INSERT INTO public.warehouse_slip_prints(factory_id, document_kind, document_id, printed_by)
  VALUES (p_factory, p_document_kind, v_document_id, auth.uid())
  ON CONFLICT (factory_id, document_kind, document_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_warehouse_slip(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_warehouse_slip(uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
