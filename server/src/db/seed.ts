// Seeds by replaying the real service functions, not by inserting fabricated rows —
// the demo data is exactly as consistent as real usage would produce, because it's
// produced the same way real usage would produce it.
import { db } from './client.js';
import { mulberry32, pick, int } from '../lib/rng.js';
import { fullName, businessName, emailFor, LOCATIONS } from '../data/pools.js';
import { RAW_MATERIALS, DELIVERY_PRODUCTS, DEPARTMENTS, JOB_ROLES, PRIORITY_LEVELS } from '../../../shared/src/moduleConfig.js';

import * as inventory from '../services/inventory.js';
import * as procurement from '../services/procurement.js';
import * as receiving from '../services/receiving.js';
import * as qualityControl from '../services/qualityControl.js';
import * as materialRequests from '../services/materialRequests.js';
import * as production from '../services/production.js';
import * as packaging from '../services/packaging.js';
import * as sales from '../services/sales.js';
import * as salesReturns from '../services/salesReturns.js';
import * as fleet from '../services/fleet.js';
import * as finance from '../services/finance.js';
import * as marketerStock from '../services/marketerStock.js';
import * as retailStock from '../services/retailStock.js';
import * as dispenserBottles from '../services/dispenserBottles.js';
import * as emptyBottleManagement from '../services/emptyBottleManagement.js';
import * as marketerCustomers from '../services/marketerCustomers.js';
import * as distributorBranches from '../services/distributorBranches.js';
import * as peripheral from '../services/peripheral.js';
import * as payroll from '../services/payroll.js';
import * as assets from '../services/assets.js';
import * as maintenance from '../services/maintenance.js';
import * as fuelRecords from '../services/fuelRecords.js';
import * as vehicleDocuments from '../services/vehicleDocuments.js';

const rng = mulberry32(20260727);

const RAW_MATERIAL_TYPE: Record<string, 'RAW_MATERIAL' | 'CONSUMABLE'> = {
  'PET preforms': 'RAW_MATERIAL', 'Bottle caps': 'RAW_MATERIAL', Labels: 'RAW_MATERIAL',
  'Shrink wraps': 'RAW_MATERIAL', 'Packaging nylon': 'RAW_MATERIAL', Cartons: 'RAW_MATERIAL',
  Chemicals: 'CONSUMABLE', 'Water treatment consumables': 'CONSUMABLE', Fuel: 'CONSUMABLE',
  'Generator diesel': 'CONSUMABLE', Lubricants: 'CONSUMABLE', 'Spare materials': 'CONSUMABLE',
  'Empty 20L Dispenser Bottle': 'RAW_MATERIAL',
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
  // migrate.ts backfills is_returnable_asset on the 20L Dispenser for existing
  // installs, but that runs before this item exists on a fresh one — flag it
  // here too so dispenserBottles' custody tracking works from a clean DB.
  db.prepare(`UPDATE items SET is_returnable_asset = 1 WHERE name = '20L Dispenser'`).run();

  for (let i = 0; i < 5; i++) {
    procurement.createSupplier({ id: `SUP-${String(i + 1).padStart(2, '0')}`, name: businessName(rng), location: pick(rng, LOCATIONS) });
  }
  for (let i = 0; i < 9; i++) {
    sales.createCustomer({
      id: `CUS-${String(i + 1).padStart(2, '0')}`, name: businessName(rng), location: pick(rng, LOCATIONS), phone: null,
      customer_type: i < 6 ? 'MARKETER' : 'DISTRIBUTOR',
    });
  }
  const drivers = ['Abe Ojuma', 'Samuel Oke', 'Bimpe Musa', 'Akingba Musa', 'Samiolu Agbo'];
  const vehicleTypes: [string, 'COMMERCIAL' | 'PRIVATE'][] = [
    ['Truck', 'COMMERCIAL'], ['Truck', 'COMMERCIAL'], ['Van', 'COMMERCIAL'], ['Van', 'COMMERCIAL'], ['Sedan', 'PRIVATE'],
  ];
  drivers.forEach((driver, i) => {
    const [vehicleType, category] = vehicleTypes[i];
    const vehicle = fleet.createVehicle({
      id: `FLT-${String(i + 1).padStart(2, '0')}`, driver, status: 'ACTIVE', odometer: `${int(rng, 20000, 140000).toLocaleString('en-NG')} km`,
      plateNumber: `ABJ-${100 + i}-KJA`, vehicleType, category, acquisitionDate: `202${int(rng, 2, 5)}-0${int(rng, 1, 9)}-15`,
    });
    for (const docType of vehicleDocuments.documentTypesFor(category)) {
      // Most documents valid for a year; one per vehicle deliberately expires soon to exercise the notification center on a fresh install.
      const expiryDate = i === 0 && docType === vehicleDocuments.documentTypesFor(category)[0]
        ? new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
        : new Date(Date.now() + int(rng, 60, 300) * 86400000).toISOString().slice(0, 10);
      vehicleDocuments.addDocument({ vehicleId: vehicle.id, documentType: docType, documentNumber: `${docType.slice(0, 3).toUpperCase()}-${1000 + i}`, issueDate: '2026-01-15', expiryDate, actor: 'System Administrator' });
    }
    fuelRecords.recordFuel({ vehicleId: vehicle.id, driver, department: 'Distribution', fuelType: 'Diesel', quantity: int(rng, 30, 80), unitCost: 950, odometer: int(rng, 20000, 140000), vendor: 'NNPC Idu', actor: 'System Administrator' });
    maintenance.recordExpense({ refType: 'VEHICLE', refId: vehicle.id, category: 'Tyres', vendor: 'AutoCare Ltd', amount: int(rng, 15000, 60000), performedBy: 'Fleet Mechanic', approvedBy: 'Fleet Manager', actor: 'System Administrator' });
  });
}

const ITEM_IDS = RAW_MATERIALS.map((_, i) => `RM-${String(i + 1).padStart(2, '0')}`);
const FG_IDS = DELIVERY_PRODUCTS.map((_, i) => `FG-${String(i + 1).padStart(2, '0')}`);
const SUPPLIER_IDS = Array.from({ length: 5 }, (_, i) => `SUP-${String(i + 1).padStart(2, '0')}`);
const CUSTOMER_IDS = Array.from({ length: 9 }, (_, i) => `CUS-${String(i + 1).padStart(2, '0')}`);
const VEHICLE_IDS = Array.from({ length: 5 }, (_, i) => `FLT-${String(i + 1).padStart(2, '0')}`);

/** Procurement → Receiving → Quality Control → Inventory */
function seedProcurementChain() {
  for (let i = 0; i < 16; i++) {
    // Distinct items per line — a PO listing the same item twice would collapse
    // to one line by the time it's inspected (receiving.ts groups GRN lines by
    // item_id), so picking without replacement keeps this seed data coherent.
    const lineCount = int(rng, 1, 3);
    const lineItems: string[] = [];
    while (lineItems.length < lineCount) {
      const candidate = pick(rng, ITEM_IDS);
      if (!lineItems.includes(candidate)) lineItems.push(candidate);
    }
    const po = procurement.createPurchaseOrder({
      supplierId: pick(rng, SUPPLIER_IDS), requestedBy: fullName(rng),
      items: lineItems.map(itemId => ({ itemId, quantity: int(rng, 100, 1200), unitPrice: int(rng, 150, 4500) })),
    });

    const roll = rng();
    if (roll < 0.1) continue; // stays DRAFT/AWAITING_APPROVAL
    if (roll < 0.18) { procurement.setStatus(po.id, 'REJECTED'); continue; }
    procurement.setStatus(po.id, 'APPROVED');

    if (rng() < 0.15) continue; // approved, not yet received

    const grn = receiving.receiveGoods({
      poId: po.id, receivedBy: fullName(rng),
      items: procurement.listPurchaseOrderItems(po.id).map(it => ({ itemId: it.item_id, quantity: it.quantity })),
      driverName: fullName(rng), driverPhone: `080${int(rng, 10000000, 99999999)}`,
      vehicleNumber: `ABC-${int(rng, 100, 999)}XY`,
      invoiceNumber: `INV-${int(rng, 10000, 99999)}`, waybillNumber: `WB-${int(rng, 10000, 99999)}`,
    });

    // Inspect: mostly fully accepted, some partially rejected (damage in transit),
    // a few fully rejected — every rejected quantity raises a linked supplier return.
    const items = receiving.listItemsFor(grn.id);
    const inspectionRoll = rng();
    const lines = items.map((it, idx) => {
      if (inspectionRoll < 0.82) return { itemId: it.item_id, acceptedQuantity: it.quantity, rejectedQuantity: 0 };
      if (inspectionRoll < 0.92) {
        if (idx !== 0) return { itemId: it.item_id, acceptedQuantity: it.quantity, rejectedQuantity: 0 };
        const rejected = Math.min(it.quantity, int(rng, 1, Math.max(1, Math.round(it.quantity * 0.05))));
        return { itemId: it.item_id, acceptedQuantity: it.quantity - rejected, rejectedQuantity: rejected, rejectionReason: 'Damaged packaging in transit' };
      }
      return { itemId: it.item_id, acceptedQuantity: 0, rejectedQuantity: it.quantity, rejectionReason: 'Failed incoming inspection' };
    });
    receiving.inspectGoodsReceived(grn.id, { inspectionOfficer: fullName(rng), lines });

    // Finance settles some of what inspection just invoiced — full payment, partial, or
    // left outstanding — so Supplier Payables/Aging/Statements have real, varied data.
    const poItems = procurement.listPurchaseOrderItems(po.id);
    const invoicedValue = receiving.listItemsFor(grn.id).reduce((sum, it) => {
      const price = poItems.find(p => p.item_id === it.item_id)?.unit_price ?? 0;
      return sum + (it.accepted_quantity ?? 0) * price;
    }, 0);
    if (invoicedValue > 0) {
      const supplier = procurement.getSupplier(po.supplier_id)!;
      const payRoll = rng();
      const payAmount = payRoll < 0.5 ? invoicedValue : payRoll < 0.75 ? Math.round(invoicedValue * (0.3 + rng() * 0.4)) : 0;
      if (payAmount > 0) {
        finance.recordPayment({
          paidTo: supplier.name, supplierId: supplier.id, amount: payAmount,
          method: pick(rng, ['Bank transfer', 'Cheque']), referenceType: 'purchase_order', referenceId: po.id,
        });
      }
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

/** Sales → inventory OUT + ledger (three different workflows by customer category),
 *  then Fleet dispatches some of them, Finance collects a few, and Marketers return
 *  some unsold stock. */
function seedSalesAndFleet() {
  const reps = ['Tunde Bakare', 'Grace Effiong', 'Ifeanyi Ude', 'Halima Oke'];
  const orders: { id: string; channel: string; status: string }[] = [];

  // POS sells out of Retail's own bounded stock, not the central warehouse
  // ledger (see services/retailStock.ts) — an intake has to move stock across
  // first, same as a real Retail department receiving from the warehouse.
  const retailIntakeItems = FG_IDS
    .map(itemId => ({ itemId, quantity: Math.floor(inventory.getBalance(itemId) * 0.3), unitCost: inventory.getItem(itemId)?.unit_cost ?? 0 }))
    .filter(it => it.quantity > 0);
  if (retailIntakeItems.length > 0) {
    retailStock.postIntake({ issuedBy: 'Warehouse Manager', items: retailIntakeItems });
  }

  for (let i = 0; i < 22; i++) {
    const channel = rng() < 0.7 ? 'INVOICE' : 'POS';
    const itemId = pick(rng, FG_IDS);
    const available = Math.floor(channel === 'POS' ? retailStock.getBalance(itemId) : inventory.getBalance(itemId));
    if (available < 5) continue;
    const quantity = Math.min(available, int(rng, 5, 120));

    if (channel === 'POS') {
      // Every retail sale requires a real customer record (sales.createOrder rejects a POS sale without one).
      const customerId = pick(rng, CUSTOMER_IDS);
      const unitPrice = int(rng, 800, 4200);
      const total = quantity * unitPrice;
      // Module 13: about 1 in 4 POS sales is a split payment (Cash+Transfer
      // or Cash+POS Terminal) instead of one implicit method, so the receipt
      // view has real multi-method data to show on a fresh install.
      const payments = rng() < 0.25
        ? [
          { method: 'Cash' as const, amount: Math.round(total * (0.3 + rng() * 0.4)) },
          { method: (rng() < 0.5 ? 'Transfer' : 'POS Terminal') as 'Transfer' | 'POS Terminal', amount: 0 },
        ]
        : undefined;
      if (payments) payments[1].amount = total - payments[0].amount;
      const order = sales.createOrder({
        customerId, channel: 'POS', rep: pick(rng, reps),
        items: [{ itemId, quantity, unitPrice }], payments,
      });
      orders.push({ id: order.id, channel, status: order.status });
      continue;
    }

    const customerId = pick(rng, CUSTOMER_IDS);
    const customer = sales.getCustomer(customerId)!;
    const paymentTerms = customer.customer_type === 'DISTRIBUTOR' ? pick(rng, ['CASH', 'ADVANCE', 'CREDIT', 'CREDIT'] as const) : 'CREDIT';
    const order = sales.createOrder({
      customerId, channel: 'INVOICE', rep: pick(rng, reps), paymentTerms,
      items: [{ itemId, quantity, unitPrice: int(rng, 800, 4200) }],
    });
    orders.push({ id: order.id, channel, status: order.status });
  }

  // Distributor credit orders sit AWAITING_APPROVAL — resolve most of them,
  // leaving a few pending so the approval queue has something in it.
  for (const pending of sales.pendingCreditApproval() as { id: string }[]) {
    const roll = rng();
    if (roll < 0.7) sales.approveCreditSale(pending.id);
    else if (roll < 0.85) sales.rejectCreditSale(pending.id);
  }

  // Section 37: marking a delivery Delivered requires a real Sales manager
  // (or System admin) userId — the same guaranteed Sales manager account
  // seeded above for the receipt-reprint gate doubles as this one.
  const salesManager = db.prepare(`SELECT id FROM users WHERE role = 'Sales manager' LIMIT 1`).get() as { id: string } | undefined;

  const invoiceOrders = orders.filter(o => o.channel === 'INVOICE');
  for (const order of invoiceOrders) {
    if (sales.getOrder(order.id)?.status !== 'PENDING') continue; // AWAITING_APPROVAL/CANCELLED can't dispatch
    if (rng() < 0.65) {
      const run = fleet.dispatchDelivery({ salesId: order.id, vehicleId: pick(rng, VEHICLE_IDS), driver: fullName(rng), route: pick(rng, LOCATIONS) });
      if (salesManager && rng() < 0.6) fleet.markDelivered(run.id, { authorizedByUserId: salesManager.id, deliveredBy: run.driver ?? 'Driver' });
    }
  }

  const settled = sales.listOrders('INVOICE') as { id: string; status: string; total_amount: number; customer_id: string | null }[];
  for (const order of settled) {
    if (order.status === 'DELIVERED' && order.customer_id && rng() < 0.7) {
      finance.recordReceipt({ receivedFrom: order.customer_id, amount: order.total_amount, method: pick(rng, ['Bank transfer', 'Cheque', 'POS card']), referenceType: 'sales', referenceId: order.id });
    }
  }

  // Marketers "may return unsold goods" — raise & inspect a few against delivered orders.
  for (const order of settled) {
    if (order.status !== 'DELIVERED' || !order.customer_id) continue;
    if (sales.getCustomer(order.customer_id)?.customer_type !== 'MARKETER') continue;
    if (rng() >= 0.4) continue;

    const line = pick(rng, sales.listItemsFor(order.id));
    const returnQty = Math.max(1, Math.round(line.quantity * (0.1 + rng() * 0.2)));
    const ret = salesReturns.createReturn({ salesId: order.id, items: [{ itemId: line.item_id, quantityReturned: returnQty }], actor: fullName(rng) });
    const rejected = rng() < 0.3 ? Math.min(returnQty, int(rng, 1, Math.max(1, Math.round(returnQty * 0.3)))) : 0;
    salesReturns.inspectReturn(ret.id, {
      inspectorOfficer: fullName(rng),
      lines: [{ itemId: line.item_id, acceptedQuantity: returnQty - rejected, rejectedQuantity: rejected, rejectionReason: rejected > 0 ? 'Damaged / not resaleable' : undefined }],
    });
  }

  finance.recordPayment({ paidTo: 'Diesel supplier', amount: int(rng, 80000, 260000), method: 'Bank transfer', referenceType: 'expense' });
  finance.recordPayment({ paidTo: 'PHCN / power', amount: int(rng, 120000, 400000), method: 'Bank transfer', referenceType: 'expense' });

  // Marketer mobile inventory (consignment) — issue stock to a couple of
  // marketers, then roll a partial return and partial sale against it, so
  // the new balances/statement aren't empty on a fresh install. The first
  // marketer's return gets warehouse-verified (shows a resolved flow); the
  // second is left pending so the "Pending warehouse verification" queue
  // has a real row to work with on a fresh install.
  const marketerIds = CUSTOMER_IDS.filter(id => sales.getCustomer(id)?.customer_type === 'MARKETER').slice(0, 2);
  for (const [idx, marketerId] of marketerIds.entries()) {
    const itemId = pick(rng, FG_IDS);
    const available = Math.floor(inventory.getBalance(itemId));
    if (available < 20) continue;
    const issueQty = Math.min(available, int(rng, 50, 120));
    const unitPrice = int(rng, 800, 4200);
    const issue = marketerStock.issueStock({
      marketerId, issuedBy: pick(rng, reps), actor: 'System Administrator',
      items: [{ itemId, quantity: issueQty, unitPrice }],
    });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: pick(rng, reps), actor: 'System Administrator' });

    const returnQty = Math.round(issueQty * (0.05 + rng() * 0.1));
    if (returnQty > 0) {
      const ret = marketerStock.recordReturn({ marketerId, actor: pick(rng, reps), items: [{ itemId, quantity: returnQty }] });
      if (idx === 0) {
        marketerStock.verifyReturn(ret.id, { verifiedBy: 'Ngozi Bello', lines: [{ itemId, verifiedQuantity: returnQty }] });
      }
    }

    const remaining = marketerStock.getBalance(marketerId, itemId);
    const saleQty = Math.round(remaining * (0.6 + rng() * 0.3));
    if (saleQty > 0) {
      const totalValue = saleQty * unitPrice;
      const cashReceived = Math.round(totalValue * (0.4 + rng() * 0.5));
      marketerStock.recordSale({ marketerId, actor: pick(rng, reps), cashReceived, items: [{ itemId, quantity: saleQty }] });
    }
  }

  // Dispenser-bottle custody demo — deterministic enough that the "Bottle
  // tracking" tab and its reports aren't empty on a fresh install, and it
  // replays the module's own worked example: 100 issued, 90 returned, the
  // other 10 sold with the bottle to named field customers.
  const dispenserItemId = 'FG-03';
  const dispenserMarketerId = CUSTOMER_IDS.filter(id => sales.getCustomer(id)?.customer_type === 'MARKETER')[2] ?? marketerIds[0];
  if (dispenserMarketerId) {
    const available = Math.floor(inventory.getBalance(dispenserItemId));
    const issueQty = Math.min(available, 100);
    if (issueQty >= 20) {
      const issue = marketerStock.issueStock({
        marketerId: dispenserMarketerId, issuedBy: pick(rng, reps), actor: 'System Administrator',
        items: [{ itemId: dispenserItemId, quantity: issueQty }],
      });
      marketerStock.verifyAssignment(issue.id, { verifiedBy: pick(rng, reps), actor: 'System Administrator' });
      const returnQty = Math.round(issueQty * 0.9);
      const soldWithBottleQty = issueQty - returnQty;
      const soldWithBottle = soldWithBottleQty > 0
        ? [
          { customerName: 'Aisha Bello', quantity: Math.ceil(soldWithBottleQty / 2) },
          { customerName: 'Emeka Okonkwo', quantity: Math.floor(soldWithBottleQty / 2) },
        ].filter(l => l.quantity > 0)
        : [];
      dispenserBottles.recordEmptyReturn({
        marketerId: dispenserMarketerId, itemId: dispenserItemId, quantityReturned: returnQty,
        soldWithBottle, returnedBy: pick(rng, reps), actor: 'System Administrator',
      });
    }
  }

  // Marketer-owned field customers (Module 9) — a credit customer and a cash
  // customer per marketer, each recorded via marketerCustomers.recordCustomerSale
  // against a small fresh stock issue, plus one INACTIVE customer, so the
  // Customers tab and its reports aren't empty on a fresh install.
  const routes = ['Route A', 'Route B', 'Route C'];
  for (const [idx, marketerId] of marketerIds.entries()) {
    const itemId = pick(rng, FG_IDS);
    const available = Math.floor(inventory.getBalance(itemId));
    if (available < 20) continue;
    const issueQty = Math.min(available, 30);
    const issue = marketerStock.issueStock({
      marketerId, issuedBy: pick(rng, reps), actor: 'System Administrator',
      items: [{ itemId, quantity: issueQty }],
    });
    marketerStock.verifyAssignment(issue.id, { verifiedBy: pick(rng, reps), actor: 'System Administrator' });
    const unitPrice = marketerStock.listBalances(marketerId).find(b => b.item_id === itemId)?.unit_price ?? 0;

    const creditCustomer = marketerCustomers.createCustomer({
      marketerId, name: businessName(rng), phone: `080${int(rng, 10000000, 99999999)}`,
      location: pick(rng, LOCATIONS), route: pick(rng, routes), creditLimit: 50000, actor: pick(rng, reps),
    });
    const cashCustomer = marketerCustomers.createCustomer({
      marketerId, name: businessName(rng), phone: `081${int(rng, 10000000, 99999999)}`,
      location: pick(rng, LOCATIONS), route: pick(rng, routes), creditLimit: 0, actor: pick(rng, reps),
    });
    const inactiveCustomer = marketerCustomers.createCustomer({
      marketerId, name: businessName(rng), phone: `082${int(rng, 10000000, 99999999)}`,
      location: pick(rng, LOCATIONS), route: pick(rng, routes), creditLimit: 0, actor: pick(rng, reps),
    });
    marketerCustomers.updateCustomer(inactiveCustomer.id, { status: 'INACTIVE' }, 'System Administrator');

    const creditQty = Math.min(issueQty, int(rng, 5, 10));
    const creditSaleValue = creditQty * unitPrice;
    const creditCashPortion = Math.round(creditSaleValue * 0.4);
    const creditSale = marketerCustomers.recordCustomerSale({
      marketerId, customerId: creditCustomer.id, items: [{ itemId, quantity: creditQty }],
      cashReceived: creditCashPortion, actor: pick(rng, reps),
    });
    const paymentAmount = Math.round((creditSaleValue - creditCashPortion) * 0.3);
    if (paymentAmount > 0) {
      marketerCustomers.recordPayment({
        customerId: creditCustomer.id, saleId: creditSale.id, amount: paymentAmount, method: 'Cash', actor: pick(rng, reps),
      });
    }

    // Module 10 follow-up demo — the first marketer's credit invoice gets a
    // due date already in the past (genuinely overdue) plus a collector and
    // a remark, so the Reminders report and the invoice's remarks log aren't
    // empty on a fresh install.
    if (idx === 0) {
      const dueDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      marketerCustomers.assignFollowUp(creditSale.id, { dueDate, collector: pick(rng, reps), actor: 'System Administrator' });
      marketerCustomers.addRemark(creditSale.id, { remark: 'Visited — customer promised to pay by end of week.', actor: pick(rng, reps) });
    }

    const remaining = Math.floor(marketerStock.getBalance(marketerId, itemId));
    const cashQty = Math.min(remaining, int(rng, 3, 6));
    if (cashQty > 0) {
      marketerCustomers.recordCustomerSale({
        marketerId, customerId: cashCustomer.id, items: [{ itemId, quantity: cashQty }],
        cashReceived: cashQty * unitPrice, actor: pick(rng, reps),
      });
    }
  }

  // Major distributor branches (Module 11) — two branches for one existing
  // Distributor customer, a credit order tagged to one of them (with a
  // fabricated manual invoice number), approved, partially paid, and
  // dispatched so its branch invoice shows a real vehicle/driver — so the
  // Distributor branches tab isn't empty on a fresh install.
  const distributorId = CUSTOMER_IDS.find(id => sales.getCustomer(id)?.customer_type === 'DISTRIBUTOR');
  if (distributorId) {
    const branchA = distributorBranches.createBranch({
      companyId: distributorId, name: 'Lagos Depot', location: pick(rng, LOCATIONS),
      contactPhone: `080${int(rng, 10000000, 99999999)}`, actor: 'System Administrator',
    });
    distributorBranches.createBranch({
      companyId: distributorId, name: 'Kaduna Depot', location: pick(rng, LOCATIONS),
      contactPhone: `081${int(rng, 10000000, 99999999)}`, actor: 'System Administrator',
    });

    const itemId = pick(rng, FG_IDS);
    const available = Math.floor(inventory.getBalance(itemId));
    if (available >= 30) {
      const quantity = Math.min(available, int(rng, 20, 40));
      const unitPrice = int(rng, 800, 4200);
      const order = sales.createOrder({
        customerId: distributorId, channel: 'INVOICE', rep: pick(rng, reps), paymentTerms: 'CREDIT',
        items: [{ itemId, quantity, unitPrice }], branchId: branchA.id, manualInvoiceNumber: `MAN-${int(rng, 1000, 9999)}`,
      });
      if (order.status === 'AWAITING_APPROVAL') {
        sales.approveCreditSale(order.id, 'System Administrator');
      }
      const total = quantity * unitPrice;
      const partial = Math.round(total * 0.5);
      finance.recordReceipt({
        receivedFrom: distributorId, amount: partial, method: 'Bank transfer',
        referenceType: 'sales', referenceId: order.id, actor: 'System Administrator', customerId: distributorId,
      });
      fleet.dispatchDelivery({ salesId: order.id, vehicleId: pick(rng, VEHICLE_IDS), driver: fullName(rng), route: pick(rng, LOCATIONS) });
    }
  }
}

function seedPeripherals() {
  const employees: { id: string; name: string }[] = [];
  for (let i = 0; i < 14; i++) {
    const name = fullName(rng);
    const row = peripheral.create('hr', 'System Administrator', undefined, pick(rng, ['ACTIVE', 'ACTIVE', 'ACTIVE', 'INVITED']), {
      name, department: pick(rng, DEPARTMENTS), role: pick(rng, JOB_ROLES), tenure: `${int(rng, 0, 9)} yrs ${int(rng, 0, 11)} mo`,
    });
    if (row) employees.push({ id: row.id, name });
  }

  // Two staff get an active loan and a compulsory savings plan, so Payroll's
  // Loans/Savings tabs aren't empty on a fresh install, and their automatic
  // deductions show up in the payroll runs seeded below.
  payroll.createLoan({ employeeId: employees[0].id, principal: 100000, monthlyRepayment: 20000, repaymentSchedule: '5 months', actor: 'Finance officer' });
  payroll.setSavingsPlan({ employeeId: employees[1].id, monthlyContribution: 5000, startDate: '2026-01-01', actor: 'Finance officer' });
  payroll.setSavingsPlan({ employeeId: employees[2].id, monthlyContribution: 8000, startDate: '2026-01-01', actor: 'Finance officer' });

  // One payroll run per employee (staffId+period must be unique) walked
  // through a realistic mix of workflow stages — most disbursed, a few still
  // mid-approval — so the Runs tab shows the full lifecycle on a fresh install.
  const payrollRuns = employees.slice(0, 12).map((staff, i) => {
    const gross = int(rng, 120000, 650000);
    const period = i % 2 === 0 ? '2026-06' : '2026-07';
    return payroll.prepareRun({ staffId: staff.id, period, gross, preparedBy: 'HR Manager', actor: 'HR Manager' });
  });
  payrollRuns.forEach((run, i) => {
    if (i < 8) payroll.reviewRun(run.id, { reviewedBy: 'Payroll Reviewer' });
    if (i < 6) payroll.approveRun(run.id, { approvedBy: 'Chairman' });
    if (i < 4) payroll.disburseRun(run.id, { disbursedBy: 'Accounts Officer' });
  });

  const roles: [string, string, number, string, string][] = [
    ['System administrator', 'Full access to every module and setting', 2, 'Global', 'ACTIVE'],
    ['Plant manager', 'Operations, production and quality modules', 4, 'Plant', 'ACTIVE'],
    ['Sales manager', 'Sales, POS and fleet dispatch', 3, 'Commercial', 'ACTIVE'],
    ['Finance officer', 'Finance, payroll and procurement approvals', 3, 'Finance', 'ACTIVE'],
    ['Finance manager', 'Approves payment and receipt reversals (Module 17)', 1, 'Finance', 'ACTIVE'],
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
  // A guaranteed Warehouse Manager — the only role marketerStock.issueStock's
  // pending-verification override accepts, so a fresh install always has one
  // reachable to sign in as and test the override with.
  peripheral.create('users', 'System Administrator', undefined, 'ACTIVE', {
    name: 'Ngozi Bello', email: 'ngozi.bello@elimwater.ng', role: 'Warehouse Manager', last_active: new Date().toISOString(),
  });
  // A guaranteed Sales manager — the only role posReceipts.recordPrint's
  // reprint-approval accepts (Module 13), so a fresh install always has one
  // reachable to sign in as and test the reprint gate with.
  peripheral.create('users', 'System Administrator', undefined, 'ACTIVE', {
    name: 'Chidinma Eze', email: 'chidinma.eze@elimwater.ng', role: 'Sales manager', last_active: new Date().toISOString(),
  });
  // A guaranteed Finance manager — the only role Module 17's payment/receipt
  // reversal gate accepts, so a fresh install always has one reachable to
  // sign in as and test reversal with.
  peripheral.create('users', 'System Administrator', undefined, 'ACTIVE', {
    name: 'Amara Nwachukwu', email: 'amara.nwachukwu@elimwater.ng', role: 'Finance manager', last_active: new Date().toISOString(),
  });

  const userRoles = ['System admin', 'Plant manager', 'Sales manager', 'Finance officer', 'QC analyst', 'Driver', 'Viewer', 'Warehouse Manager'];
  for (let i = 0; i < 12; i++) {
    const name = fullName(rng);
    peripheral.create('users', 'System Administrator', undefined, pick(rng, ['ACTIVE', 'ACTIVE', 'INVITED', 'SUSPENDED']), {
      name, email: emailFor(name), role: pick(rng, userRoles), last_active: new Date().toISOString(),
    });
  }

  const equipment: [string, string][] = [
    ['RO membrane unit 2', 'Machines'], ['UV steriliser 1', 'Machines'], ['Ozone generator', 'Generators'],
    ['Bottling line A', 'Machines'], ['Bottling line B', 'Machines'], ['Sachet sealer 3', 'Machines'],
    ['Forklift FLT-04', 'Equipment'], ['Generator 500kVA', 'Generators'], ['Air compressor 2', 'Equipment'],
    ['Boiler unit 1', 'Equipment'], ['Cold room 1', 'Building'], ['Palletiser 1', 'Machines'],
  ];
  for (const [eq, category] of equipment) {
    const asset = assets.createAsset({
      name: eq, category, location: pick(rng, ['Treatment plant', 'Line A', 'Line B', 'Warehouse', 'Yard']),
      assignedDepartment: pick(rng, DEPARTMENTS), serviceIntervalDays: pick(rng, [30, 60, 90, 180]), actor: 'System Administrator',
    });
    const status = pick(rng, ['ACTIVE', 'ACTIVE', 'SCHEDULED', 'SUSPENDED']);
    if (status !== 'ACTIVE') assets.updateAsset(asset.id, { status }, 'System Administrator');
    if (pick(rng, [true, true, false])) {
      const serviceDate = new Date(Date.now() - int(rng, 5, 60) * 86400000).toISOString().slice(0, 10);
      const nextDue = new Date(Date.now() + int(rng, 5, 90) * 86400000).toISOString().slice(0, 10);
      assets.recordService(asset.id, { serviceDate, nextDue });
    }
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

  const requisitionReasons = [
    'Stock running low ahead of next delivery', 'Needed for scheduled maintenance', 'Replenishing safety stock',
    'Urgent shortfall on the line', 'Routine monthly top-up', 'New batch requires additional supply',
  ];
  for (let i = 0; i < 12; i++) {
    const expected = new Date(Date.now() + int(rng, 2, 21) * 86400000).toISOString().slice(0, 10);
    peripheral.create('warehouse', 'System Administrator', undefined, pick(rng, ['PENDING', 'PENDING', 'APPROVED', 'ISSUED', 'REJECTED']), {
      item: pick(rng, RAW_MATERIALS), quantity: int(rng, 20, 500), expected_delivery: expected,
      priority: pick(rng, PRIORITY_LEVELS), reason: pick(rng, requisitionReasons), department: pick(rng, DEPARTMENTS),
    });
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

/** Empty dispenser bottles pulled from the warehouse for a production run —
 *  replays the module's own worked example (500 issued, 5 damaged, 3
 *  leaking, 490 finished, 2 auto-returned), then triages part of the
 *  damaged bucket so Repairable/Scrapped aren't empty on a fresh install. */
function seedEmptyBottles() {
  const item = emptyBottleManagement.getEmptyBottleItem();
  inventory.postTransaction({
    itemId: item.id, direction: 'IN', quantity: 800, unitCost: item.unit_cost,
    sourceType: 'ADJUSTMENT', actor: 'System Administrator', note: 'Opening stock',
  });

  const run = emptyBottleManagement.startRun({ quantityIssued: 500, issuedBy: 'Tunde Bakare', actor: 'System Administrator' });
  emptyBottleManagement.reconcileRun(run.id, { damaged: 5, leaking: 3, finishedProduction: 490, actor: 'System Administrator' });
  emptyBottleManagement.triageDefective({ fromState: 'DAMAGED', repairable: 3, scrapped: 2, actor: 'System Administrator' });
  emptyBottleManagement.completeRepair({ quantity: 3, actor: 'System Administrator' });
}

export function seed(): void {
  const already = db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get() as { n: number };
  if (already.n > 0) return;

  seedMasters();
  const waterRunIds = seedWaterTreatment();
  seedPeripherals();
  seedProcurementChain();
  seedProductionChain(waterRunIds);
  seedEmptyBottles();
  seedSalesAndFleet();
}
