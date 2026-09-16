import type { IconName, ModuleConfig, ModuleFilterOption } from './types';

export const DELIVERY_PRODUCTS = ['50cl PET', 'Sachet (bags)', '20L Dispenser', '1.5L PET', '75cl PET'];
export const DELIVERY_STATUS_OPTIONS: ModuleFilterOption[] = [
  { value: 'DELIVERED', label: 'Delivered' }, { value: 'IN_TRANSIT', label: 'In transit' },
  { value: 'PENDING', label: 'Pending' }, { value: 'ON_HOLD', label: 'On hold' },
];

export const RAW_MATERIALS = [
  'PET preforms', 'Bottle caps', 'Labels', 'Shrink wraps', 'Packaging nylon', 'Chemicals',
  'Water treatment consumables', 'Cartons', 'Fuel', 'Generator diesel', 'Lubricants', 'Spare materials',
  'Empty 20L Dispenser Bottle',
];

export const DEPARTMENTS = [
  'Production', 'Water Treatment', 'Quality Control', 'Sales', 'Fleet & Delivery', 'Finance', 'Human Resources', 'Warehouse',
];

export const JOB_ROLES = [
  'Operator', 'Supervisor', 'Analyst', 'Driver', 'Accountant', 'Sales rep', 'Manager', 'Technician',
];

/** Per-module, per-field pick-lists — a field with an entry here renders as a <select> in
 *  RecordForm and is drawn from here in mock data generation, instead of being free text. */
const USER_ROLES = [
  'System admin',
  'Water treatment', 'Production', 'Quality control', 'Inventory', 'Procurement', 'Commercial',
  'Sales', 'Point of sale', 'Finance & people', 'Human resources',
  'Assets & maintenance', 'Warehouse Manager', 'Sales manager', 'Viewer',
];

export const FIELD_OPTIONS: Record<string, Record<string, string[]>> = {
  procurement: { item: RAW_MATERIALS },
  users: { role: USER_ROLES },
  hr: { department: DEPARTMENTS, role: JOB_ROLES },
};

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  group: string;
  moduleNo?: number;
  path: string;
}

export const DASHBOARD_NAV: NavItem = { key: 'dashboard', label: 'Dashboard', icon: 'grid', group: 'Overview', path: '/' };

/** Single source of truth for every non-dashboard nav item: drives the sidebar,
 *  the command palette, the routes, and the server's generic /api/modules/:key mock data. */
export const MODULES: ModuleConfig[] = [
  {
    key: 'inventory', label: 'Inventory', group: 'Operations', icon: 'box', moduleNo: 5,
    subtitle: 'Stock on hand across raw materials and finished goods.',
    searchPlaceholder: 'Search SKU or item name',
    columns: [
      { key: 'id', label: 'SKU', kind: 'mono' },
      { key: 'item', label: 'Item & category', kind: 'text', subKey: 'category' },
      { key: 'onHand', label: 'On hand', kind: 'num' },
      { key: 'reorderPoint', label: 'Reorder at', kind: 'num' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'IN_STOCK', label: 'In stock' }, { value: 'LOW_STOCK', label: 'Low stock' }, { value: 'OUT_OF_STOCK', label: 'Out of stock' },
    ],
  },
  {
    key: 'procurement', label: 'Procurement', group: 'Operations', icon: 'receipt', moduleNo: 4,
    subtitle: 'Purchase orders to suppliers.',
    searchPlaceholder: 'Search purchase orders or supplier',
    columns: [
      { key: 'id', label: 'PO', kind: 'mono' },
      { key: 'supplier', label: 'Supplier & item', kind: 'text', subKey: 'item' },
      { key: 'amount', label: 'Amount', kind: 'num' },
      { key: 'requestedBy', label: 'Requested by', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'DRAFT', label: 'Draft' }, { value: 'AWAITING_APPROVAL', label: 'Awaiting approval' },
      { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' },
    ],
  },
  {
    key: 'store', label: 'Store', group: 'Operations', icon: 'warehouse', moduleNo: 0,
    subtitle: 'Finished goods on hand, ready to assign out to a Distributor, Sales Rep, or Walk-in customer.',
    searchPlaceholder: 'Search finished goods',
    columns: [
      { key: 'item_name', label: 'Item', kind: 'text', subKey: 'category' },
      { key: 'physical_stock', label: 'Physical stock', kind: 'num' },
      { key: 'assigned_stock', label: 'Assigned', kind: 'num' },
      { key: 'available_stock', label: 'Available', kind: 'num' },
    ],
    statusOptions: [],
  },
  {
    key: 'production', label: 'Production', group: 'Operations', icon: 'factory', moduleNo: 7,
    subtitle: 'Fill runs by production line and shift.',
    searchPlaceholder: 'Search production runs or product',
    columns: [
      { key: 'id', label: 'Run', kind: 'mono' },
      { key: 'line', label: 'Line & shift', kind: 'text', subKey: 'product' },
      { key: 'units', label: 'Units filled', kind: 'num' },
      { key: 'operator', label: 'Operator', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'COMPLETED', label: 'Completed' }, { value: 'RUNNING', label: 'Running' },
      { value: 'SCHEDULED', label: 'Scheduled' }, { value: 'FAILED', label: 'Failed' },
    ],
  },
  {
    key: 'quality-control', label: 'Quality Control', group: 'Operations', icon: 'flask', moduleNo: 8,
    subtitle: 'Lab tests against batch samples.',
    searchPlaceholder: 'Search tests or batch code',
    columns: [
      { key: 'id', label: 'Test', kind: 'mono' },
      { key: 'batch', label: 'Batch & parameter', kind: 'text', subKey: 'parameter' },
      { key: 'result', label: 'Result', kind: 'text' },
      { key: 'analyst', label: 'Analyst', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'PASS', label: 'Passed' }, { value: 'PENDING', label: 'Pending' }, { value: 'FAIL', label: 'Failed' },
    ],
  },
  {
    key: 'water-treatment', label: 'Water Treatment', group: 'Operations', icon: 'drop', moduleNo: 6,
    subtitle: 'Borehole draw, RO, UV and ozone treatment runs.',
    searchPlaceholder: 'Search treatment runs or borehole reference',
    columns: [
      { key: 'id', label: 'Run', kind: 'mono' },
      { key: 'source', label: 'Source', kind: 'text', subKey: 'stage' },
      { key: 'volume_l', label: 'Volume (L)', kind: 'num' },
      { key: 'operator', label: 'Operator', kind: 'text' },
      { key: 'tested_at', label: 'Tested', kind: 'text', readOnly: true },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'PASS', label: 'Passed' }, { value: 'IN_PROGRESS', label: 'In progress' }, { value: 'FAIL', label: 'Failed' },
    ],
  },
  {
    key: 'sales', label: 'Warehouse', group: 'Commercial', icon: 'cart', moduleNo: 9,
    subtitle: 'Customer orders across all channels.',
    searchPlaceholder: 'Search orders or customer',
    columns: [
      { key: 'id', label: 'Order', kind: 'mono' },
      { key: 'customer', label: 'Customer & location', kind: 'text', subKey: 'location' },
      { key: 'amount', label: 'Amount', kind: 'num' },
      { key: 'rep', label: 'Rep', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'PENDING', label: 'Pending' }, { value: 'PROCESSING', label: 'Processing' },
      { value: 'DELIVERED', label: 'Delivered' }, { value: 'CANCELLED', label: 'Cancelled' },
    ],
  },
  {
    key: 'pos', label: 'Retail', group: 'Commercial', icon: 'wallet', moduleNo: 10,
    subtitle: 'Walk-in and depot retail sales.',
    searchPlaceholder: 'Search receipts or cashier',
    columns: [
      { key: 'id', label: 'Receipt', kind: 'mono' },
      { key: 'till', label: 'Till & cashier', kind: 'text', subKey: 'cashier' },
      { key: 'amount', label: 'Amount', kind: 'num' },
      { key: 'payment', label: 'Payment', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'PAID', label: 'Paid' }, { value: 'PENDING', label: 'Pending' }, { value: 'REJECTED', label: 'Rejected' },
    ],
  },
  {
    key: 'fleet', label: 'Fleet & Delivery', group: 'Commercial', icon: 'truck', moduleNo: 11,
    subtitle: 'Vehicles and delivery runs.',
    searchPlaceholder: 'Search vehicles or driver',
    columns: [
      { key: 'id', label: 'Vehicle', kind: 'mono' },
      { key: 'driver', label: 'Driver & route', kind: 'text', subKey: 'route' },
      { key: 'load', label: 'Load (cases)', kind: 'num' },
      { key: 'odometer', label: 'Odometer', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'ACTIVE', label: 'On the road' }, { value: 'SCHEDULED', label: 'Scheduled' }, { value: 'SUSPENDED', label: 'Grounded' },
    ],
  },
  {
    key: 'finance', label: 'Finance', group: 'Finance & people', icon: 'bank', moduleNo: 12,
    subtitle: 'Invoices, payments and ledger entries.',
    searchPlaceholder: 'Search references or narration',
    columns: [
      { key: 'id', label: 'Ref', kind: 'mono' },
      { key: 'account', label: 'Account & narration', kind: 'text', subKey: 'narration' },
      { key: 'amount', label: 'Amount', kind: 'num' },
      { key: 'type', label: 'Type', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'CLEARED', label: 'Cleared' }, { value: 'PENDING', label: 'Pending' }, { value: 'OVERDUE', label: 'Overdue' },
    ],
  },
  {
    key: 'day-close', label: 'Day Close', group: 'Finance & people', icon: 'scroll', moduleNo: 19,
    subtitle: 'Business reconciliation dashboard — what needs attention before today can close.',
    searchPlaceholder: 'Search day closes',
    columns: [
      { key: 'id', label: 'Close', kind: 'mono' },
      { key: 'business_date', label: 'Business date', kind: 'text' },
      { key: 'checked_by', label: 'Checked by', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [{ value: 'CLOSED', label: 'Closed' }],
  },
  {
    key: 'hr', label: 'Human Resources', group: 'Finance & people', icon: 'users', moduleNo: 13,
    subtitle: 'Staff records across departments.',
    searchPlaceholder: 'Search staff or department',
    columns: [
      { key: 'id', label: 'Staff ID', kind: 'mono' },
      { key: 'name', label: 'Name & department', kind: 'text', subKey: 'department' },
      { key: 'role', label: 'Position', kind: 'text' },
      { key: 'date_engaged', label: 'Date engaged', kind: 'text' },
      { key: 'date_disengaged', label: 'Date disengaged', kind: 'text' },
      { key: 'exit_reason', label: 'Exit reason', kind: 'text' },
      { key: 'notes', label: 'Notes', kind: 'text' },
      // Never a form input (see RecordForm's fieldsFor, which skips readOnly
      // columns) — always computed server-side from date_engaged/
      // date_disengaged by peripheral.ts, per Section 25: "do not use Tenure
      // as a manually maintained field."
      { key: 'tenure', label: 'Tenure', kind: 'text', readOnly: true },
      { key: 'created_at', label: 'Added', kind: 'text', readOnly: true },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    // Fallback shape only — the live list is configurable (Settings ->
    // "Employee status options") and fetched at runtime; see
    // client/src/pages/Module/ModulePage.tsx's hrStatusOptions override.
    statusOptions: [
      { value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }, { value: 'ON_LEAVE', label: 'On Leave' },
      { value: 'RESIGNED', label: 'Resigned' }, { value: 'TERMINATED', label: 'Terminated' },
      { value: 'DISENGAGED', label: 'Disengaged' }, { value: 'ABSCONDED', label: 'Absconded' },
    ],
  },
  {
    key: 'payroll', label: 'Payroll', group: 'Finance & people', icon: 'clock', moduleNo: 14,
    subtitle: 'Monthly payroll runs.',
    searchPlaceholder: 'Search payslips or staff',
    columns: [
      { key: 'id', label: 'Payslip', kind: 'mono' },
      { key: 'staff_name', label: 'Staff', kind: 'text', subKey: 'staff_id' },
      { key: 'period', label: 'Period', kind: 'text' },
      { key: 'gross', label: 'Gross', kind: 'num' },
      { key: 'net', label: 'Net', kind: 'num' },
      { key: 'created_at', label: 'Run date', kind: 'text', readOnly: true },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'PAID', label: 'Paid' }, { value: 'SCHEDULED', label: 'Scheduled' }, { value: 'ON_HOLD', label: 'On hold' },
    ],
  },
  {
    key: 'assets', label: 'Assets & Maintenance', group: 'Plant & insight', icon: 'wrench', moduleNo: 15,
    subtitle: 'Equipment and maintenance schedule.',
    searchPlaceholder: 'Search equipment or location',
    columns: [
      { key: 'id', label: 'Asset', kind: 'mono' },
      { key: 'equipment', label: 'Equipment & location', kind: 'text', subKey: 'location' },
      { key: 'last_service', label: 'Last service', kind: 'text' },
      { key: 'next_due', label: 'Next due', kind: 'text' },
      { key: 'created_at', label: 'Added', kind: 'text', readOnly: true },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'ACTIVE', label: 'Operating' }, { value: 'SCHEDULED', label: 'Service due' }, { value: 'SUSPENDED', label: 'Down' },
    ],
  },
  {
    key: 'reports', label: 'Reports & Analytics', group: 'Plant & insight', icon: 'chart', moduleNo: 16,
    subtitle: 'Scheduled and saved reports.',
    searchPlaceholder: 'Search reports or owner',
    columns: [
      { key: 'id', label: 'Report', kind: 'mono' },
      { key: 'name', label: 'Name & scope', kind: 'text', subKey: 'scope' },
      { key: 'owner', label: 'Owner', kind: 'text' },
      { key: 'last_run', label: 'Last run', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'COMPLETED', label: 'Completed' }, { value: 'RUNNING', label: 'Running' }, { value: 'FAILED', label: 'Failed' },
    ],
  },
  {
    key: 'users', label: 'Users', group: 'Administration', icon: 'usercog', moduleNo: 0,
    subtitle: 'System accounts and access.',
    searchPlaceholder: 'Search users or email',
    columns: [
      { key: 'id', label: 'User ID', kind: 'mono' },
      { key: 'name', label: 'Name & email', kind: 'text', subKey: 'email' },
      { key: 'phone', label: 'Phone', kind: 'text' },
      { key: 'role', label: 'Role', kind: 'text' },
      { key: 'last_active', label: 'Last active', kind: 'text' },
      { key: 'created_at', label: 'Created', kind: 'text', readOnly: true },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'ACTIVE', label: 'Active' }, { value: 'PENDING_APPROVAL', label: 'Pending approval' },
      { value: 'INVITED', label: 'Invited' }, { value: 'SUSPENDED', label: 'Suspended' },
    ],
  },
  {
    key: 'roles', label: 'Roles & Permissions', group: 'Administration', icon: 'shield', moduleNo: 0,
    subtitle: 'Roles and their permission sets.',
    searchPlaceholder: 'Search roles',
    idInput: 'text',
    columns: [
      { key: 'id', label: 'Role', kind: 'mono' },
      { key: 'description', label: 'Description', kind: 'text' },
      { key: 'members', label: 'Members', kind: 'num' },
      { key: 'scope', label: 'Scope', kind: 'text' },
      { key: 'created_at', label: 'Created', kind: 'text', readOnly: true },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'ACTIVE', label: 'Active' }, { value: 'DRAFT', label: 'Draft' },
    ],
  },
  {
    key: 'activity-log', label: 'Audit Log', group: 'Administration', icon: 'scroll', moduleNo: 0,
    subtitle: 'Read-only audit trail of every action taken across the system.',
    searchPlaceholder: 'Search action, user or detail',
    readOnly: true,
    columns: [
      { key: 'action', label: 'Action', kind: 'text' },
      { key: 'actor', label: 'User', kind: 'text' },
      { key: 'department', label: 'Department', kind: 'text' },
      { key: 'summary', label: 'Detail of activity', kind: 'text' },
      { key: 'old_value', label: 'Old value', kind: 'mono' },
      { key: 'new_value', label: 'New value', kind: 'mono' },
      { key: 'reason', label: 'Reason', kind: 'text' },
      { key: 'ip_address', label: 'IP Address', kind: 'mono' },
      { key: 'device', label: 'Device', kind: 'text' },
      { key: 'at', label: 'Timestamp', kind: 'text' },
    ],
    statusOptions: [
      { value: 'COMPLETED', label: 'Completed' }, { value: 'FAILED', label: 'Failed' },
    ],
  },
  {
    key: 'settings', label: 'Settings', group: 'Administration', icon: 'cog', moduleNo: 18,
    subtitle: 'Configuration and system preferences.',
    searchPlaceholder: 'Search settings',
    idInput: 'text',
    columns: [
      { key: 'id', label: 'Setting', kind: 'mono' },
      { key: 'description', label: 'Description', kind: 'text' },
      { key: 'value', label: 'Value', kind: 'text' },
      { key: 'updated_by', label: 'Updated by', kind: 'text' },
      { key: 'updated_at', label: 'Updated', kind: 'text', readOnly: true },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    statusOptions: [
      { value: 'ACTIVE', label: 'Active' }, { value: 'DRAFT', label: 'Draft' },
    ],
  },
];

export const MODULE_GROUP_ORDER = ['Overview', 'Operations', 'Commercial', 'Finance & people', 'Plant & insight', 'Administration'];

/** These three still use the generic ModulePage/RecordForm CRUD UI, but only ever
 *  rendered embedded as a Control Panel tab — no sidebar entry, no standalone route. */
export const CONTROL_PANEL_TAB_KEYS = ['users', 'roles', 'activity-log'];

/** Not data modules — super-admin-only utility screens. Included in NAV_GROUPS so the
 *  sidebar and command palette agree, but every consumer must gate them on isSuperAdmin
 *  specifically, never on a per-user grant. */
export const CONTROL_PANEL_NAV: NavItem = { key: 'control-panel', label: 'Admin Panel', icon: 'lock', group: 'Administration', path: '/control-panel' };
export const DELETE_REQUESTS_NAV: NavItem = { key: 'delete-requests', label: 'Delete Requests', icon: 'trash', group: 'Administration', path: '/delete-requests' };
export const ADMIN_ONLY_NAV_KEYS = [CONTROL_PANEL_NAV.key, DELETE_REQUESTS_NAV.key];

export const NAV_GROUPS: { group: string; items: NavItem[] }[] = MODULE_GROUP_ORDER.map(group => ({
  group,
  items: [
    ...(group === DASHBOARD_NAV.group ? [DASHBOARD_NAV] : []),
    ...MODULES.filter(m => m.group === group && !CONTROL_PANEL_TAB_KEYS.includes(m.key)).map(m => ({
      key: m.key, label: m.label, icon: m.icon, group: m.group,
      moduleNo: m.moduleNo || undefined, path: '/' + m.key,
    })),
    ...(group === CONTROL_PANEL_NAV.group ? [CONTROL_PANEL_NAV, DELETE_REQUESTS_NAV] : []),
  ],
}));

export const moduleByKey = (key: string): ModuleConfig | undefined => MODULES.find(m => m.key === key);

/** The 7 modules with no natural multi-step business process — they keep the generic
 *  ModulePage/RecordForm CRUD UI, now reading/writing a real table via the peripheral
 *  service instead of an in-memory array. The other 8 (production, quality-control,
 *  inventory, procurement, sales, pos, fleet, finance) get dedicated workflow pages.
 *  Of these 7, users/roles/activity-log (see CONTROL_PANEL_TAB_KEYS) are embedded in
 *  the Control Panel instead of being routed on their own. */
export const GENERIC_MODULE_KEYS = [
  'water-treatment', 'hr', 'reports', 'users', 'roles', 'activity-log', 'settings',
];
export const GENERIC_MODULES: ModuleConfig[] = MODULES.filter(m => GENERIC_MODULE_KEYS.includes(m.key));
export const ROUTED_GENERIC_MODULE_KEYS = GENERIC_MODULE_KEYS.filter(k => !CONTROL_PANEL_TAB_KEYS.includes(k));
