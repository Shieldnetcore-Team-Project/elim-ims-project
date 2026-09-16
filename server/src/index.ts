import express from 'express';
import cors from 'cors';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { requestContextMiddleware } from './lib/requestContext.js';
import { ensureDefaultPasswords } from './services/auth.js';

import { dashboardRouter } from './routes/dashboard.js';
import { authRouter } from './routes/auth.js';
import { pendingCountsRouter } from './routes/pendingCounts.js';
import { modulesRouter } from './routes/modules.js';
import { mastersRouter } from './routes/masters.js';
import { purchaseOrdersRouter } from './routes/purchaseOrders.js';
import { goodsReceivedRouter } from './routes/goodsReceived.js';
import { qualityControlRouter } from './routes/qualityControl.js';
import { inventoryRouter } from './routes/inventory.js';
import { materialRequestsRouter } from './routes/materialRequests.js';
import { productionBatchesRouter } from './routes/productionBatches.js';
import { productionLogRouter } from './routes/productionLog.js';
import { finishedGoodsRouter } from './routes/finishedGoods.js';
import { salesRouter } from './routes/sales.js';
import { deliveriesRouter } from './routes/deliveries.js';
import { financeRouter } from './routes/finance.js';
import { deletionRequestsRouter } from './routes/deletionRequests.js';
import { accessControlRouter } from './routes/accessControl.js';
import { bomRouter } from './routes/bom.js';
import { supplierReturnsRouter } from './routes/supplierReturns.js';
import { salesReturnsRouter } from './routes/salesReturns.js';
import { marketerStockRouter } from './routes/marketerStock.js';
import { dispenserBottlesRouter } from './routes/dispenserBottles.js';
import { emptyBottleManagementRouter } from './routes/emptyBottleManagement.js';
import { dayCloseRouter } from './routes/dayClose.js';
import { marketerCustomersRouter } from './routes/marketerCustomers.js';
import { distributorBranchesRouter } from './routes/distributorBranches.js';
import { posReceiptsRouter } from './routes/posReceipts.js';
import { reversalsRouter } from './routes/reversals.js';
import { retailStockRouter } from './routes/retailStock.js';
import { retailExchangesRouter } from './routes/retailExchanges.js';
import { marketerReconciliationRouter } from './routes/marketerReconciliation.js';
import { marketerPerformanceRouter } from './routes/marketerPerformance.js';
import { tillCloseRouter } from './routes/tillClose.js';
import { payrollRouter } from './routes/payroll.js';
import { assetsRouter } from './routes/assets.js';
import { maintenanceRouter } from './routes/maintenance.js';
import { fuelRecordsRouter } from './routes/fuelRecords.js';
import { vehicleDocumentsRouter } from './routes/vehicleDocuments.js';
import { driverPerformanceRouter } from './routes/driverPerformance.js';
import { maintenanceReportsRouter } from './routes/maintenanceReports.js';
import { notificationsRouter } from './routes/notifications.js';

// Last line of defence: a stray rejected promise or a throw on some async
// callback outside a request must not take the whole API down. Log it and keep
// serving — a single broken operation is always better than a dead process that
// 500s every request until someone notices and restarts it.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err);
});

await migrate();
// Demo/mock data is opt-in only (local dev), never automatic — a deployed
// install must start virgin, with zero seed rows, so real business data is
// never mixed with (or silently reset back to) sample data.
if (process.env.SEED_DEMO_DATA === 'true') await seed();
await ensureDefaultPasswords();

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json());
app.use(requestContextMiddleware);

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'elim-erp-api' }));

app.use('/api/dashboard', dashboardRouter);
app.use('/api/auth', authRouter);
app.use('/api/pending-counts', pendingCountsRouter);
app.use('/api/modules', modulesRouter);
app.use('/api/masters', mastersRouter);
app.use('/api/purchase-orders', purchaseOrdersRouter);
app.use('/api/goods-received', goodsReceivedRouter);
app.use('/api/quality-control', qualityControlRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/material-requests', materialRequestsRouter);
app.use('/api/production-batches', productionBatchesRouter);
app.use('/api/production-log', productionLogRouter);
app.use('/api/finished-goods', finishedGoodsRouter);
app.use('/api/sales', salesRouter);
app.use('/api/deliveries', deliveriesRouter);
app.use('/api/finance', financeRouter);
app.use('/api/deletion-requests', deletionRequestsRouter);
app.use('/api/access-control', accessControlRouter);
app.use('/api/bom', bomRouter);
app.use('/api/supplier-returns', supplierReturnsRouter);
app.use('/api/sales-returns', salesReturnsRouter);
app.use('/api/marketer-stock', marketerStockRouter);
app.use('/api/dispenser-bottles', dispenserBottlesRouter);
app.use('/api/empty-bottles', emptyBottleManagementRouter);
app.use('/api/day-close', dayCloseRouter);
app.use('/api/marketer-customers', marketerCustomersRouter);
app.use('/api/distributor-branches', distributorBranchesRouter);
app.use('/api/pos-receipts', posReceiptsRouter);
app.use('/api/reversals', reversalsRouter);
app.use('/api/retail-stock', retailStockRouter);
app.use('/api/retail-exchanges', retailExchangesRouter);
app.use('/api/marketer-reconciliation', marketerReconciliationRouter);
app.use('/api/marketer-performance', marketerPerformanceRouter);
app.use('/api/till-close', tillCloseRouter);
app.use('/api/payroll', payrollRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/maintenance', maintenanceRouter);
app.use('/api/fuel-records', fuelRecordsRouter);
app.use('/api/vehicle-documents', vehicleDocumentsRouter);
app.use('/api/driver-performance', driverPerformanceRouter);
app.use('/api/maintenance-reports', maintenanceReportsRouter);
app.use('/api/notifications', notificationsRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Anything that reaches here is an error thrown outside a `safe()`-wrapped
// handler (e.g. express.json parse failure). Return JSON, not Express's default
// HTML page, so the client shows a real message instead of a bare 500.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] unhandled route error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Elim ERP API listening on http://localhost:${PORT}`);
});
