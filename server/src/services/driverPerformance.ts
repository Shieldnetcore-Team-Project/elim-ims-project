import { db } from '../db/client.js';

export interface DriverPerformanceRow {
  driver: string;
  trips: number;
  deliveries: number;
  successful_deliveries: number;
  returns: number;
  cancelled_trips: number;
  distance_km: number | null;
  fuel_cost: number;
  maintenance_cost: number;
  performance: number;
}

/** Section 38. "Driver" is the free-text name recorded on delivery_runs at
 *  dispatch time — there's no separate drivers master table in this app
 *  (same convention fuel_records.driver already uses). period, if given, is
 *  'YYYY-MM' and filters by dispatched_at.
 *
 *  Trips = every run assigned to the driver. Deliveries = trips that reached
 *  an end state at the customer (DELIVERED or RETURNED — the vehicle got
 *  there, whether or not the drop-off succeeded); Successful Deliveries
 *  narrows that to DELIVERED only, so the two numbers can genuinely differ.
 *  Distance isn't captured per trip anywhere in this app (only a single
 *  running vehicle odometer and per-fuel-purchase readings, neither
 *  reliably attributable to one driver's individual trips on a shared
 *  vehicle) — reported as null, matching the spec's own "where available"
 *  hedge, rather than fabricating a number. Fuel Cost sums fuel_records
 *  directly (it carries its own driver field). Maintenance Cost is an
 *  approximation: spend on whichever vehicle(s) the driver actually drove
 *  during the period, since maintenance_records is recorded per-vehicle,
 *  not per-driver. Performance is the plain success rate (Successful
 *  Deliveries ÷ Trips) — the one transparent reading of "Performance"
 *  without inventing an opaque scoring formula. SQLite's strftime() has no
 *  Postgres equivalent — every date column here is formatted TEXT (see
 *  schema.ts), cast to timestamp then to_char(). */
export async function report(period?: string): Promise<DriverPerformanceRow[]> {
  const dispatchPeriodCond = period ? `AND to_char(dispatched_at::timestamp, 'YYYY-MM') = ?` : '';
  const periodParams = period ? [period] : [];

  const trips = await db.prepare(`
    SELECT driver,
      COUNT(*) AS trips,
      SUM(CASE WHEN status IN ('DELIVERED','RETURNED') THEN 1 ELSE 0 END) AS deliveries,
      SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS successful_deliveries,
      SUM(CASE WHEN status = 'RETURNED' THEN 1 ELSE 0 END) AS returns,
      SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_trips
    FROM delivery_runs
    WHERE driver IS NOT NULL AND driver != '' ${dispatchPeriodCond}
    GROUP BY driver
    ORDER BY driver
  `).all(...periodParams) as {
    driver: string; trips: number; deliveries: number; successful_deliveries: number; returns: number; cancelled_trips: number;
  }[];

  if (trips.length === 0) return [];

  const fuelPeriodCond = period ? `AND to_char(fuel_date::timestamp, 'YYYY-MM') = ?` : '';
  const fuelByDriver = new Map(
    (await db.prepare(`
      SELECT driver, COALESCE(SUM(total_cost), 0) AS fuel_cost FROM fuel_records
      WHERE driver IS NOT NULL AND driver != '' ${fuelPeriodCond} GROUP BY driver
    `).all(...periodParams) as { driver: string; fuel_cost: number }[]).map(r => [r.driver, r.fuel_cost]),
  );

  // Vehicle(s) each driver was assigned to (within the same period window),
  // used to approximate a per-driver maintenance figure below.
  const vehiclesByDriver = new Map<string, Set<string>>();
  for (const row of await db.prepare(`
    SELECT DISTINCT driver, vehicle_id FROM delivery_runs WHERE driver IS NOT NULL AND driver != '' ${dispatchPeriodCond}
  `).all(...periodParams) as { driver: string; vehicle_id: string }[]) {
    const set = vehiclesByDriver.get(row.driver) ?? new Set<string>();
    set.add(row.vehicle_id);
    vehiclesByDriver.set(row.driver, set);
  }

  const maintenancePeriodCond = period ? `AND to_char(service_date::timestamp, 'YYYY-MM') = ?` : '';
  const maintenanceCostByVehicle = new Map(
    (await db.prepare(`
      SELECT ref_id AS vehicle_id, COALESCE(SUM(amount), 0) AS cost FROM maintenance_records
      WHERE ref_type = 'VEHICLE' ${maintenancePeriodCond} GROUP BY ref_id
    `).all(...periodParams) as { vehicle_id: string; cost: number }[]).map(r => [r.vehicle_id, r.cost]),
  );

  return trips.map(t => {
    const vehicles = vehiclesByDriver.get(t.driver) ?? new Set<string>();
    let maintenanceCost = 0;
    for (const v of vehicles) maintenanceCost += maintenanceCostByVehicle.get(v) ?? 0;

    return {
      driver: t.driver, trips: t.trips, deliveries: t.deliveries, successful_deliveries: t.successful_deliveries,
      returns: t.returns, cancelled_trips: t.cancelled_trips, distance_km: null,
      fuel_cost: fuelByDriver.get(t.driver) ?? 0, maintenance_cost: maintenanceCost,
      performance: t.trips > 0 ? Math.round((t.successful_deliveries / t.trips) * 1000) / 10 : 0,
    };
  });
}
