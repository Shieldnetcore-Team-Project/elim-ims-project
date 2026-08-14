
-- ============================================================
-- Logistics module. Confirmed as a supporting function (Phase 3) with
-- zero footprint anywhere in the schema until now. Minimal viable scope:
-- vehicles, drivers, named delivery routes, and deliveries that can
-- optionally link back to the sale/invoice they're fulfilling.
-- ============================================================

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  plate_number text NOT NULL,
  make_model text,
  capacity text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(factory_id, plate_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicles TO authenticated;
GRANT ALL ON public.vehicles TO service_role;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "logistics read vehicles" ON public.vehicles FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics', 'read'));
CREATE POLICY "logistics write vehicles" ON public.vehicles FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'logistics', 'write'));

CREATE TABLE public.drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  phone text,
  license_number text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drivers TO authenticated;
GRANT ALL ON public.drivers TO service_role;
ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "logistics read drivers" ON public.drivers FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics', 'read'));
CREATE POLICY "logistics write drivers" ON public.drivers FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'logistics', 'write'));

CREATE TABLE public.delivery_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.delivery_routes TO authenticated;
GRANT ALL ON public.delivery_routes TO service_role;
ALTER TABLE public.delivery_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "logistics read routes" ON public.delivery_routes FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics', 'read'));
CREATE POLICY "logistics write routes" ON public.delivery_routes FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'logistics', 'write'));

CREATE TABLE public.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  delivery_number text NOT NULL,
  sale_id uuid REFERENCES public.sales(id),
  vehicle_id uuid REFERENCES public.vehicles(id),
  driver_id uuid REFERENCES public.drivers(id),
  route_id uuid REFERENCES public.delivery_routes(id),
  destination text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_transit','delivered','cancelled')),
  scheduled_date date NOT NULL DEFAULT CURRENT_DATE,
  departed_at timestamptz,
  delivered_at timestamptz,
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(factory_id, delivery_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deliveries TO authenticated;
GRANT ALL ON public.deliveries TO service_role;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "logistics read deliveries" ON public.deliveries FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics', 'read'));
CREATE POLICY "logistics write deliveries" ON public.deliveries FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'logistics', 'write'));

CREATE OR REPLACE FUNCTION public.create_delivery(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_sale_id uuid := NULLIF(payload->>'sale_id','')::uuid;
  v_vehicle_id uuid := NULLIF(payload->>'vehicle_id','')::uuid;
  v_driver_id uuid := NULLIF(payload->>'driver_id','')::uuid;
  v_route_id uuid := NULLIF(payload->>'route_id','')::uuid;
  v_destination text := payload->>'destination';
  v_scheduled date := COALESCE((payload->>'scheduled_date')::date, CURRENT_DATE);
  v_notes text := payload->>'notes';
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics', 'write') THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;

  v_number := 'DEL-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO deliveries(factory_id, delivery_number, sale_id, vehicle_id, driver_id, route_id,
                          destination, scheduled_date, notes, created_by)
  VALUES (v_factory, v_number, v_sale_id, v_vehicle_id, v_driver_id, v_route_id,
          v_destination, v_scheduled, v_notes, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'delivery_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_delivery(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_delivery_status(p_id uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row deliveries%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics', 'write') THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_status NOT IN ('pending','in_transit','delivered','cancelled') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  SELECT * INTO v_row FROM deliveries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;

  UPDATE deliveries SET
    status = p_status,
    departed_at = CASE WHEN p_status = 'in_transit' AND departed_at IS NULL THEN now() ELSE departed_at END,
    delivered_at = CASE WHEN p_status = 'delivered' AND delivered_at IS NULL THEN now() ELSE delivered_at END
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'status', p_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_delivery_status(uuid, text) TO authenticated;
