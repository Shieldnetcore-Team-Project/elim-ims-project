// Domain types shared between the client and the server so the two never drift.

export type IconName =
  | 'grid' | 'drop' | 'factory' | 'flask' | 'box' | 'receipt' | 'cart' | 'wallet'
  | 'truck' | 'bank' | 'users' | 'clock' | 'wrench' | 'chart' | 'usercog'
  | 'shield' | 'scroll' | 'cog' | 'search' | 'sun' | 'moon' | 'monitor' | 'bell'
  | 'download' | 'print' | 'x' | 'chevronRight' | 'arrowRight' | 'table' | 'file' | 'plus' | 'trash' | 'lock' | 'switch' | 'warehouse' | 'alert-triangle';

/** Every status string used anywhere in the app resolves to one of these four tones. */
export type Tone = 'ok' | 'wait' | 'stop' | 'live';

export const STATUS_TONE: Record<string, Tone> = {
  DELIVERED: 'ok', PAID: 'ok', APPROVED: 'ok', COMPLETED: 'ok', PASS: 'ok',
  IN_STOCK: 'ok', RESOLVED: 'ok', ACTIVE: 'ok', CLEARED: 'ok', ACCEPTED: 'ok', RETURNED: 'ok',
  IN_TRANSIT: 'live', RUNNING: 'live', IN_PROGRESS: 'live', ONLINE: 'live', PROCESSING: 'live', DISPATCHED: 'live', ORDERED: 'live',
  PENDING: 'wait', ON_HOLD: 'wait', SCHEDULED: 'wait', DRAFT: 'wait', OPEN: 'wait', READY: 'wait',
  LOW_STOCK: 'wait', INVITED: 'wait', AWAITING_APPROVAL: 'wait', PENDING_APPROVAL: 'wait',
  PENDING_INSPECTION: 'wait', PARTIALLY_ACCEPTED: 'wait', PENDING_VERIFICATION: 'wait', VERIFIED: 'ok', RECONCILED: 'ok',
  SENT: 'wait', CONFIRMED: 'ok',
  DUE_SOON: 'wait', NO_DUE_DATE: 'wait', ON_TRACK: 'ok',
  PENDING_RETURN: 'wait', BALANCED: 'ok',
  CREDIT: 'wait', PARTIALLY_PAID: 'wait', FULLY_PAID: 'ok',
  REJECTED: 'stop', OVERDUE: 'stop', FAILED: 'stop', FAIL: 'stop',
  OUT_OF_STOCK: 'stop', SUSPENDED: 'stop', INACTIVE: 'stop', CANCELLED: 'stop', FOLLOW_UP_DUE: 'stop',
  SHORT: 'stop', EXCESS: 'stop',
  ON_LEAVE: 'wait', RESIGNED: 'stop', TERMINATED: 'stop', DISENGAGED: 'stop', ABSCONDED: 'stop',
  UNPAID: 'stop', REVIEWED: 'ok', NOT_STARTED: 'wait', PARTIAL: 'wait', COMPLETE: 'ok',
  PENDING_REVIEW: 'wait', DISBURSED: 'ok', PAID_OFF: 'ok', COMMERCIAL: 'live', PRIVATE: 'live', EXPIRED: 'stop',
  CRITICAL: 'stop', WARNING: 'wait', INFO: 'live',
};
export const toneOf = (status: string): Tone => STATUS_TONE[status] ?? 'live';

export interface KpiMetric {
  key: string;
  label: string;
  icon: IconName;
  value: string;
  delta?: number;
  good?: boolean;
}

export interface TrendPoint { day: string; units: number }
export interface ProductVolume { label: string; value: number }
export interface SalesOverviewPoint { day: string; sales: number; profit: number }
export interface ProfitLossPoint { day: string; value: number }
export interface LowStockAlert { id: string; name: string; uom: string; onHand: number; reorderPoint: number }
export interface TopProduct { id: string; name: string; unitsSold: number }
export interface StockStatus { inStock: number; lowStock: number; outOfStock: number }

export interface Delivery {
  orderId: string;
  customer: string;
  location: string;
  batch: string;
  product: string;
  cases: number;
  driver: string;
  status: string;
  dueAt: string;
}

export interface TraceStop {
  stage: string;
  ref: string;
  detail: string;
  verdict?: 'pass' | 'fail';
}

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** A generic row for the config-driven module pages — one shape fits every module's table. */
export interface ModuleRow {
  id: string;
  status: string;
  fields: Record<string, string | number>;
}

export interface ModuleColumn {
  key: string;
  label: string;
  kind: 'mono' | 'text' | 'num' | 'status' | 'sub';
  /** For kind:'text' — a second field rendered as a muted line underneath. */
  subKey?: string;
  /** System-generated (e.g. a created_at timestamp) — shown in the table but never
   *  rendered as an input in RecordForm, and excluded from create/update writes. */
  readOnly?: boolean;
}

export interface ModuleFilterOption { value: string; label: string }

export interface ModuleConfig {
  key: string;
  label: string;
  group: string;
  icon: IconName;
  moduleNo: number;
  subtitle: string;
  searchPlaceholder: string;
  columns: ModuleColumn[];
  statusOptions: ModuleFilterOption[];
  /** 'text' when the id column is a human-chosen title (e.g. a role name) the user types at
   *  creation, rather than a system-generated code. Defaults to 'auto' (id is auto-generated). */
  idInput?: 'auto' | 'text';
  /** True for an append-only audit trail — ModulePage hides "New", disables row-click-to-edit,
   *  and never renders a delete action, regardless of what deleteEntityType a caller passes. */
  readOnly?: boolean;
}

export interface ModuleResponse {
  config: Pick<ModuleConfig, 'key' | 'label' | 'subtitle'>;
  kpis: KpiMetric[];
  data: Paginated<ModuleRow>;
}

/** Body shape for both creating and updating a module row. */
export interface ModuleRowInput {
  id?: string; // only used/required when the module's idInput is 'text' and mode is create
  status: string;
  fields: Record<string, string | number>;
}

export type DeliveryInput = Omit<Delivery, 'orderId'>;
