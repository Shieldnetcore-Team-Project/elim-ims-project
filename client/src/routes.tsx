import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { DashboardPage } from './pages/Dashboard/DashboardPage';
import { ModulePage } from './pages/Module/ModulePage';
import { NotFoundPage } from './pages/NotFound';
import { ROUTED_GENERIC_MODULE_KEYS } from '@shared/moduleConfig';

import ProcurementPage from './pages/Procurement/ProcurementPage';
import QualityControlPage from './pages/QualityControl/QualityControlPage';
import InventoryPage from './pages/Inventory/InventoryPage';
import StorePage from './pages/Store/StorePage';
import ProductionPage from './pages/Production/ProductionPage';
import SalesPage from './pages/Sales/SalesPage';
import FleetPage from './pages/Fleet/FleetPage';
import FinancePage from './pages/Finance/FinancePage';
import ControlPanelPage from './pages/ControlPanel/ControlPanelPage';
import DeleteRequestsPage from './pages/DeleteRequests/DeleteRequestsPage';
import DayClosePage from './pages/DayClose/DayClosePage';
import PayrollPage from './pages/Payroll/PayrollPage';
import AssetsPage from './pages/Assets/AssetsPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },

      // Bespoke workflow pages — a real multi-step business process, not generic CRUD.
      { path: 'procurement', element: <ProcurementPage /> },
      { path: 'quality-control', element: <QualityControlPage /> },
      { path: 'inventory', element: <InventoryPage /> },
      { path: 'store', element: <StorePage /> },
      { path: 'production', element: <ProductionPage /> },
      { path: 'sales', element: <SalesPage channel="INVOICE" /> },
      { path: 'pos', element: <SalesPage channel="POS" /> },
      { path: 'fleet', element: <FleetPage /> },
      { path: 'finance', element: <FinancePage /> },
      { path: 'day-close', element: <DayClosePage /> },
      { path: 'payroll', element: <PayrollPage /> },
      { path: 'assets', element: <AssetsPage /> },
      { path: 'control-panel', element: <ControlPanelPage /> },
      { path: 'delete-requests', element: <DeleteRequestsPage /> },

      // Generic CRUD pages — driven entirely by shared/moduleConfig.ts. Users/roles/
      // activity-log are excluded here — they're embedded as Admin panel tabs instead.
      ...ROUTED_GENERIC_MODULE_KEYS.map(key => ({ path: key, element: <ModulePage moduleKey={key} /> })),

      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
