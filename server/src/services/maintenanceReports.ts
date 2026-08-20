import { db } from '../db/client.js';

export type MaintenanceReportType = 'VEHICLE' | 'GENERATOR' | 'MACHINE' | 'BUILDING' | 'FUEL' | 'SPARE_PARTS' | 'UTILITIES' | 'REGULATORY';

export interface MaintenanceReportRow {
  id: string; report_type: MaintenanceReportType; ref_label: string; category: string; description: string | null;
  vendor: string | null; amount: number; date: string; reference: string | null;
  performed_by: string | null; approved_by: string | null; actor: string | null; created_at: string;
}

export interface DateRange { from: string; to: string }

const REPORT_TYPES: MaintenanceReportType[] = ['VEHICLE', 'GENERATOR', 'MACHINE', 'BUILDING', 'FUEL', 'SPARE_PARTS', 'UTILITIES', 'REGULATORY'];

/** Section 40: eight report lenses over the same underlying maintenance
 *  data (maintenance_records, fuel_records, vehicle_documents), not a
 *  strict partition — a vehicle tyre job can legitimately show up under
 *  both "Vehicle Maintenance" (by ref_type) and "Spare Parts" (by category)
 *  when a user runs each report, the same way a bank statement can be
 *  filtered by date and separately by payee without the two views being
 *  mutually exclusive.
 *
 *  Vehicle/Generator/Machine/Building split maintenance_records by
 *  ref_type + category (Generator/Machine keyed off the category name
 *  containing "Generator"/"Machine"; Building also covers the office-
 *  equipment categories under it — photocopiers/printers are building
 *  fixtures, not separate asset classes here). Fuel is fuel_records
 *  wholesale. Spare Parts and Utilities are category-based cuts across
 *  both assets and vehicles. Regulatory Documentation is vehicle_documents
 *  — audit-ready in the same sense as the rest: every row keeps its actor
 *  and created_at, so who logged it and when is never lost. */
export function report(type: MaintenanceReportType, range?: DateRange): MaintenanceReportRow[] {
  const rangeParams = range ? [range.from, range.to] : [];

  if (type === 'FUEL') {
    const dateCond = range ? 'AND date(fuel_date) BETWEEN date(?) AND date(?)' : '';
    return (db.prepare(`
      SELECT fr.id, 'FUEL' AS report_type, v.plate_number AS ref_label, COALESCE(fr.fuel_type, 'Fuel') AS category,
        fr.remarks AS description, fr.vendor, fr.total_cost AS amount, fr.fuel_date AS date, fr.receipt_reference AS reference,
        fr.driver AS performed_by, NULL AS approved_by, fr.actor, fr.created_at
      FROM fuel_records fr JOIN vehicles v ON v.id = fr.vehicle_id
      WHERE 1 = 1 ${dateCond}
      ORDER BY fr.fuel_date DESC
    `).all(...rangeParams) as unknown as MaintenanceReportRow[]).map(r => ({ ...r, ref_label: r.ref_label ?? '' }));
  }

  if (type === 'REGULATORY') {
    const dateCond = range ? 'AND date(COALESCE(vd.issue_date, vd.created_at)) BETWEEN date(?) AND date(?)' : '';
    return db.prepare(`
      SELECT vd.id, 'REGULATORY' AS report_type, v.plate_number AS ref_label, vd.document_type AS category,
        vd.notes AS description, NULL AS vendor, 0 AS amount, COALESCE(vd.issue_date, vd.created_at) AS date,
        vd.document_number AS reference, NULL AS performed_by, NULL AS approved_by, vd.actor, vd.created_at
      FROM vehicle_documents vd JOIN vehicles v ON v.id = vd.vehicle_id
      WHERE 1 = 1 ${dateCond}
      ORDER BY date DESC
    `).all(...rangeParams) as unknown as MaintenanceReportRow[];
  }

  const dateCond = range ? 'AND date(mr.service_date) BETWEEN date(?) AND date(?)' : '';
  const typeFilter: Record<Exclude<MaintenanceReportType, 'FUEL' | 'REGULATORY'>, string> = {
    VEHICLE: `mr.ref_type = 'VEHICLE'`,
    GENERATOR: `mr.ref_type = 'ASSET' AND mr.category LIKE '%Generator%'`,
    MACHINE: `mr.ref_type = 'ASSET' AND mr.category LIKE '%Machine%'`,
    BUILDING: `mr.ref_type = 'ASSET' AND (mr.category LIKE '%Building%' OR mr.category LIKE '%Photocopier%' OR mr.category LIKE '%Printer%')`,
    SPARE_PARTS: `(mr.category LIKE '%Spare%' OR mr.category IN ('Filters','Brake','Tyres','Tyre Maintenance','Engine Oil'))`,
    UTILITIES: `mr.category IN ('Utilities','Electricity')`,
  };

  return db.prepare(`
    SELECT mr.id, ? AS report_type,
      CASE mr.ref_type WHEN 'VEHICLE' THEN (SELECT plate_number FROM vehicles WHERE id = mr.ref_id) ELSE (SELECT equipment FROM assets WHERE id = mr.ref_id) END AS ref_label,
      mr.category, mr.description, mr.vendor, mr.amount, mr.service_date AS date, mr.invoice_reference AS reference,
      mr.performed_by, mr.approved_by, mr.actor, mr.created_at
    FROM maintenance_records mr
    WHERE ${typeFilter[type as Exclude<MaintenanceReportType, 'FUEL' | 'REGULATORY'>]} ${dateCond}
    ORDER BY mr.service_date DESC
  `).all(type, ...rangeParams) as unknown as MaintenanceReportRow[];
}

export function reportTypes(): MaintenanceReportType[] {
  return REPORT_TYPES;
}
