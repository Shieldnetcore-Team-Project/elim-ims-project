// Seeds by replaying the real service functions, not by inserting fabricated rows —
// the demo data is exactly as consistent as real usage would produce, because it's
// produced the same way real usage would produce it.
import { db } from './client.js';
import { mulberry32, pick, int } from '../lib/rng.js';
import { fullName, businessName, emailFor, LOCATIONS } from '../data/pools.js';
import { RAW_MATERIALS, DELIVERY_PRODUCTS } from '../../../shared/src/moduleConfig.js';

import * as inventory from '../services/inventory.js';
import * as procurement from '../services/procurement.js';
import * as receiving from '../services/receiving.js';
import * as qualityControl from '../services/qualityControl.js';
import * as materialRequests from '../services/materialRequests.js';
import * as production from '../services/production.js';
import * as packaging from '../services/packaging.js';
import * as sales from '../services/sales.js';
import * as fleet from '../services/fleet.js';
import * as finance from '../services/finance.js';
import * as peripheral from '../services/peripheral.js';

const rng = mulberry32(20260727);

const RAW_MATERIAL_TYPE: Record<string, 'RAW_MATERIAL' | 'CONSUMABLE'> = {
  'PET preforms': 'RAW_MATERIAL', 'Bottle caps': 'RAW_MATERIAL', Labels: 'RAW_MATERIAL',
  'Shrink wraps': 'RAW_MATERIAL', 'Packaging nylon': 'RAW_MATERIAL', Cartons: 'RAW_MATERIAL',
  Chemicals: 'CONSUMABLE', 'Water treatment consumables': 'CONSUMABLE', Fuel: 'CONSUMABLE',
  'Generator diesel': 'CONSUMABLE', Lubricants: 'CONSUMABLE', 'Spare materials': 'CONSUMABLE',
};

function seedMasters() {
  RAW_MATERIALS.forEach((name, i) => {
    inventory.createItem({
      id: `RM-${String(i + 1).padStart(2, '0')}`, name, category: 'Raw material',
      type: RAW_MATERIAL_TYPE[name], uom: 'unit', reorder_point: int(rng, 200, 1500), unit_cost: int(rng, 150, 4500),
    });
  });
  DELIVERY_PRODUCTS.forEach((name, i) => {
    inventory.createItem({
      id: `FG-${String(i + 1).padStart(2, '0')}`, name, category: 'Finished goods',
      type: 'FINISHED_GOOD', uom: 'case', reorder_point: int(rng, 100, 400), unit_cost: int(rng, 800, 4200),
    });
  });

  for (let i = 0; i < 5; i++) {
    procurement.createSupplier({ id: `SUP-${String(i + 1).padStart(2, '0')}`, name: businessName(rng), location: pick(rng, LOCATIONS) });
  }
  for (let i = 0; i < 9; i++) {
    sales.createCustomer({ id: `CUS-${String(i + 1).padStart(2, '0')}`, name: businessName(rng), location: pick(rng, LOCATIONS) });
  }
  const drivers = ['Abe Ojuma', 'Samuel Oke', 'Bimpe Musa', 'Akingba Musa', 'Samiolu Agbo'];
  drivers.forEach((driver, i) => fleet.createVehicle({ id: `FLT-${String(i + 1).padStart(2, '0')}`, driver, status: 'ACTIVE', odometer: `${int(rng, 20000, 140000).toLocaleString('en-NG')} km` }));
}

const ITEM_IDS = RAW_MATERIALS.map((_, i) => `RM-${String(i + 1).padStart(2, '0')}`);
const FG_IDS = DELIVERY_PRODUCTS.map((_, i) => `FG-${String(i + 1).padStart(2, '0')}`);
const SUPPLIER_IDS = Array.from({ length: 5 }, (_, i) => `SUP-${String(i + 1).padStart(2, '0')}`);
const CUSTOMER_IDS = Array.from({ length: 9 }, (_, i) => `CUS-${String(i + 1).padStart(2, '0')}`);
const VEHICLE_IDS = Array.from({ length: 5 }, (_, i) => `FLT-${String(i + 1).padStart(2, '0')}`);

/** Procurement → Receiving → Quality Control → Inventory */
function seedProcurementChain() {
  for (let i = 0; i < 16; i++) {
    const po = procurement.createPurchaseOrder({
      supplierId: pick(rng, SUPPLIER_IDS), requestedBy: fullName(rng),
      items: Array.from({ length: int(rng, 1, 3) }, () => ({ itemId: pick(rng, ITEM_IDS), quantity: int(rng, 100, 1200), unitPrice: int(rng, 150, 4500) })),
    });

    const roll = rng();
    if (roll < 0.1) continue; // stays DRAFT/AWAITING_APPROVAL
    if (roll < 0.18) { procurement.setStatus(po.id, 'REJECTED'); continue; }
    procurement.setStatus(po.id, 'APPROVED');

    if (rng() < 0.15) continue; // approved, not yet received

    const grn = receiving.receiveGoods({
      poId: po.id, receivedBy: fullName(rng),
      items: procurement.listPurchaseOrderItems(po.id).map(it => ({ itemId: it.item_id, quantity: it.quantity })),
    });

    if (rng() < 0.9) {
      qualityControl.recordResult({ refType: 'GOODS_RECEIVED', refId: grn.id, inspector: fullName(rng), parameter: 'Batch inspection', result: 'Within spec', verdict: 'PASS' });
    } else {
      qualityControl.recordResult({ refType: 'GOODS_RECEIVED', refId: grn.id, inspector: fullName(rng), parameter: 'Batch inspection', result: 'Damaged packaging', verdict: 'FAIL', notes: 'Rejected at receiving dock' });
    }
  }
}

/** Production issues materials, Manufacturing records a batch, Packaging creates finished goods */
function seedProductionChain(waterRunIds: string[]) {
  const lines = ['Line A', 'Line B', 'Line C'];
  const shifts = ['Morning', 'Afternoon', 'Night'];

  for (let i = 0; i < 14; i++) {
    materialRequests.createRequest({
      requestedBy: fullName(rng), department: 'Production',
      items: Array.from({ length: int(rng, 1, 2) }, () => ({ itemId: pick(rng, ITEM_IDS), quantity: int(rng, 20, 200) })),
    });
  }
  for (const req of materialRequests.listRequests() as { id: string }[]) {
    const roll = rng();
    if (roll < 0.85) materialRequests.approveAndIssue(req.id);
    else if (roll < 0.95) materialRequests.reject(req.id);
  }

  for (let i = 0; i < 16; i++) {
    const productItemId = pick(rng, FG_IDS);
    const unitsActual = int(rng, 8000, 22000);
    const batch = production.recordBatch({
      productItemId, line: pick(rng, lines), shift: pick(rng, shifts), operator: fullName(rng),
      unitsActual, unitsTarget: unitsActual + int(rng, 0, 800),
      waterTreatmentRunId: rng() < 0.7 ? pick(rng, waterRunIds) : undefined,
    });

    if (rng() < 0.88) {
      qualityControl.recordResult({ refType: 'PRODUCTION_BATCH', refId: batch.id, inspector: fullName(rng), parameter: 'Fill volume & seal', result: 'Pass', verdict: 'PASS' });
      const cases = Math.max(1, Math.round(unitsActual / 24));
      packaging.packageBatch({ batchId: batch.id, itemId: productItemId, quantity: cases, packagedBy: fullName(rng) });
    } else {
      qualityControl.recordResult({ refType: 'PRODUCTION_BATCH', refId: batch.id, inspector: fullName(rng), parameter: 'Fill volume & seal', result: 'Under-fill detected', verdict: 'FAIL' });
    }
  }
}

/** Sales → inventory OUT + ledger, then Fleet dispatches some of them, Finance collects a few */
function seedSalesAndFleet() {
  const reps = ['Tunde Bakare', 'Grace Effiong', 'Ifeanyi Ude', 'Halima Oke'];
  const orders: { id: string; channel: string; status: string }[] = [];

  for (let i = 0; i < 22; i++) {
    const channel = rng() < 0.7 ? 'INVOICE' : 'POS';
    const itemId = pick(rng, FG_IDS);
    const available = Math.floor(inventory.getBalance(itemId));
    if (available < 5) continue;
    const quantity = Math.min(available, int(rng, 5, 120));
    const order = sales.createOrder({
      customerId: pick(rng, CUSTOMER_IDS), channel: channel as 'INVOICE' | 'POS', rep: pick(rng, reps),
      items: [{ itemId, quantity, unitPrice: int(rng, 800, 4200) }],
    });
    orders.push({ id: order.id, channel, status: order.status });
  }

  const invoiceOrders = orders.filter(o => o.channel === 'INVOICE');
  for (const order of invoiceOrders) {
    if (rng() < 0.65) {
      const run = fleet.dispatchDelivery({ salesId: order.id, vehicleId: pick(rng, VEHICLE_IDS), driver: fullName(rng), route: pick(rng, LOCATIONS) });
      if (rng() < 0.6) fleet.markDelivered(run.id);
    }
  }

  const settled = sales.listOrders('INVOICE') as { id: string; status: string; total_amount: number; customer_id: string }[];
  for (const order of settled) {
    if (order.status === 'DELIVERED' && rng() < 0.7) {
      finance.recordReceipt({ receivedFrom: order.customer_id, amount: order.total_amount, method: pick(rng, ['Bank transfer', 'Cheque', 'POS card']), referenceType: 'sales', referenceId: order.id });
    }
  }

  finance.recordPayment({ paidTo: 'Diesel supplier', amount: int(rng, 80000, 260000), method: 'Bank transfer', referenceType: 'expense' });
  finance.recordPayment({ paidTo: 'PHCN / power', amount: int(rng, 120000, 400000), method: 'Bank transfer', referenceType: 'expense' });
}

function seedPeripherals() {
  const departments = ['Production', 'Water treatment', 'Quality control', 'Sales', 'Fleet & delivery', 'Finance', 'Human resources', 'Warehouse'];
  const roleTitles = ['Operator', 'Supervisor', 'Analyst', 'Driver', 'Accountant', 'Sales rep', 'Manager', 'Technician'];
  const employeeIds: string[] = [];
  for (let i = 0; i < 14; i++) {
    const name = fullName(rng);
    const row = peripheral.create('hr', 'System Administrator', undefined, pick(rng, ['ACTIVE', 'ACTIVE', 'ACTIVE', 'INVITED']), {
      name, department: pick(rng, departments), role: pick(rng, roleTitles), tenure: `${int(rng, 0, 9)} yrs ${int(rng, 0, 11)} mo`,
    });
    if (row) employeeIds.push(row.id);
  }

  for (let i = 0; i < 12; i++) {
    const gross = int(rng, 120000, 650000);
    peripheral.create('payroll', 'Finance officer', undefined, pick(rng, ['PAID', 'PAID', 'SCHEDULED', 'ON_HOLD']), {
      staff_id: pick(rng, employeeIds), period: pick(rng, ['Jun 2026', 'Jul 2026']), gross, net: Math.round(gross * 0.82),
    });
  }

  const roles: [string, string, number, string, string][] = [
    ['System administrator', 'Full access to every module and setting', 2, 'Global', 'ACTIVE'],
    ['Plant manager', 'Operations, production and quality modules', 4, 'Plant', 'ACTIVE'],
    ['Sales manager', 'Sales, POS and fleet dispatch', 3, 'Commercial', 'ACTIVE'],
    ['Finance officer', 'Finance, payroll and procurement approvals', 3, 'Finance', 'ACTIVE'],
    ['QC analyst', 'Quality control tests and batch sign-off', 5, 'Operations', 'ACTIVE'],
    ['Warehouse clerk', 'Inventory counts and stock movement', 6, 'Operations', 'ACTIVE'],
    ['Driver', 'Fleet & delivery module, own routes only', 9, 'Commercial', 'ACTIVE'],
    ['Viewer', 'Read-only access to reports & analytics', 5, 'Global', 'DRAFT'],
  ];
  for (const [name, description, members, scope, status] of roles) {
    peripheral.create('roles', 'System Administrator', name, status, { description, members, scope });
  }

  // A guaranteed super admin so there's always at least one account to sign in as —
  // inserted first, before the randomised users below.
  peripheral.create('users', 'System Administrator', undefined, 'ACTIVE', {
    name: 'System Administrator', email: 'admin@elimwater.ng', role: 'System admin', last_active: new Date().toISOString(),
  });

  const userRoles = ['System admin', 'Plant manager', 'Sales manager', 'Finance officer', 'QC analyst', 'Driver', 'Viewer'];
  for (let i = 0; i < 12; i++) {
    const name = fullName(rng);
    peripheral.create('users', 'System Administrator', undefined, pick(rng, ['ACTIVE', 'ACTIVE', 'INVITED', 'SUSPENDED']), {
      name, email: emailFor(name), role: pick(rng, userRoles), last_active: new Date().toISOString(),
    });
  }

  const equipment = ['RO membrane unit 2', 'UV steriliser 1', 'Ozone generator', 'Bottling line A', 'Bottling line B',
    'Sachet sealer 3', 'Forklift FLT-04', 'Generator 500kVA', 'Air compressor 2', 'Boiler unit 1', 'Cold room 1', 'Palletiser 1'];
  for (const eq of equipment) {
    peripheral.create('assets', 'System Administrator', undefined, pick(rng, ['ACTIVE', 'ACTIVE', 'SCHEDULED', 'SUSPENDED']), {
      equipment: eq, location: pick(rng, ['Treatment plant', 'Line A', 'Line B', 'Warehouse', 'Yard']),
      last_service: 'Recently', next_due: 'Upcoming',
    });
  }

  const reportNames = ['Weekly production summary', 'Monthly revenue report', 'QC exceptions', 'Fleet utilisation',
    'Inventory ageing', 'Payroll register', 'Customer aging', 'Water quality trend', 'Procurement spend', 'Shift attendance'];
  for (const name of reportNames) {
    peripheral.create('reports', 'System Administrator', undefined, pick(rng, ['COMPLETED', 'COMPLETED', 'RUNNING', 'FAILED']), {
      name, scope: pick(rng, ['Plant-wide', 'Line A', 'Line B', 'Commercial', 'Finance']), owner: fullName(rng),
    });
  }

  const settingsRows: [string, string, string, string][] = [
    ['Company name', 'Legal entity name on invoices and reports', 'Elim Water Factory Ltd.', 'System Administrator'],
    ['Base currency', 'Currency used across finance and sales', 'NGN (₦)', 'System Administrator'],
    ['Timezone', 'Used for all timestamps in the system', 'Africa/Lagos (WAT)', 'System Administrator'],
    ['VAT rate', 'Applied to taxable sales and invoices', '7.5%', 'Finance officer'],
    ['Default warehouse', 'Warehouse assumed for new inventory items', 'Idu Central Warehouse', 'Warehouse clerk'],
    ['Low stock threshold', 'Percent of reorder point that triggers an alert', '20%', 'Warehouse clerk'],
    ['Notification email', 'Recipient for system alerts and daily digests', 'ops@elimwater.ng', 'System Administrator'],
    ['Backup schedule', 'Automated database backup frequency', 'Every 6 hours', 'System Administrator'],
    ['Session timeout', 'Idle time before a user is signed out', '30 minutes', 'System Administrator'],
    ['Two-factor authentication', 'Required for finance and admin roles', 'Enabled', 'System Administrator'],
  ];
  for (const [name, description, value, updated_by] of settingsRows) {
    peripheral.create('settings', 'System Administrator', name, 'ACTIVE', { description, value, updated_by });
  }
}

function seedWaterTreatment(): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 14; i++) {
    const row = peripheral.create('water-treatment', 'System Administrator', undefined, pick(rng, ['PASS', 'PASS', 'PASS', 'IN_PROGRESS', 'FAIL']), {
      source: `BOREHOLE-0${int(rng, 1, 4)}`, stage: pick(rng, ['RO stage', 'UV stage', 'Ozone stage', 'Full cycle']),
      volume_l: int(rng, 9000, 18000), operator: fullName(rng),
    });
    if (row) ids.push(row.id);
  }
  return ids;
}

export function seed(): void {
  const already = db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get() as { n: number };
  if (already.n > 0) return;

  seedMasters();
  const waterRunIds = seedWaterTreatment();
  seedPeripherals();
  seedProcurementChain();
  seedProductionChain(waterRunIds);
  seedSalesAndFleet();
}
