import express from 'express';
import cors from 'cors';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { requestContextMiddleware } from './lib/requestContext.js';

import { dashboardRouter } from './routes/dashboard.js';
import { modulesRouter } from './routes/modules.js';
import { mastersRouter } from './routes/masters.js';
import { purchaseOrdersRouter } from './routes/purchaseOrders.js';
import { goodsReceivedRouter } from './routes/goodsReceived.js';
import { qualityControlRouter } from './routes/qualityControl.js';
import { inventoryRouter } from './routes/inventory.js';
import { materialRequestsRouter } from './routes/materialRequests.js';
import { productionBatchesRouter } from './routes/productionBatches.js';
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

migrate();
seed();

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json());
app.use(requestContextMiddleware);

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'elim-erp-api' }));

app.use('/api/dashboard', dashboardRouter);
app.use('/api/modules', modulesRouter);
app.use('/api/masters', mastersRouter);
app.use('/api/purchase-orders', purchaseOrdersRouter);
app.use('/api/goods-received', goodsReceivedRouter);
app.use('/api/quality-control', qualityControlRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/material-requests', materialRequestsRouter);
app.use('/api/production-batches', productionBatchesRouter);
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

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Elim ERP API listening on http://localhost:${PORT}`);
});
