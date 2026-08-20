import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { Pill } from '../ui/Pill';
import { api } from '../../lib/apiClient';
import { useCurrentUser } from '../../lib/currentUser';

export type NotificationCategory =
  | 'LOW_STOCK' | 'DOCUMENT_EXPIRY' | 'PENDING_APPROVAL' | 'PENDING_RECONCILIATION'
  | 'PENDING_RETURN' | 'OUTSTANDING_CREDIT' | 'OVERDUE_CREDIT' | 'PENDING_DELIVERY'
  | 'PAYROLL_APPROVAL' | 'MAINTENANCE_DUE' | 'UNCLOSED_TILL' | 'QUALITY_TEST_PENDING';

interface NotificationItem {
  id: string;
  category: NotificationCategory;
  pageKey: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  detail: string;
}

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  LOW_STOCK: 'Low Stock', DOCUMENT_EXPIRY: 'Document Expiry', PENDING_APPROVAL: 'Pending Approval',
  PENDING_RECONCILIATION: 'Pending Reconciliation', PENDING_RETURN: 'Pending Return',
  OUTSTANDING_CREDIT: 'Outstanding Credit', OVERDUE_CREDIT: 'Overdue Credit', PENDING_DELIVERY: 'Pending Delivery',
  PAYROLL_APPROVAL: 'Payroll Approval', MAINTENANCE_DUE: 'Maintenance Due', UNCLOSED_TILL: 'Unclosed Till',
  QUALITY_TEST_PENDING: 'Quality Test Pending',
};

/** Users only ever see notifications for pages they can access — same
 *  hasAccess gate the sidebar and routes already enforce (Section 48). */
export function useNotifications(): NotificationItem[] {
  const { hasAccess, isSuperAdmin } = useCurrentUser();
  const [items, setItems] = useState<NotificationItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => api<NotificationItem[]>('/notifications').then(rows => { if (!cancelled) setItems(rows); });
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);
  return useMemo(
    () => items.filter(n => isSuperAdmin || hasAccess(n.pageKey)),
    [items, hasAccess, isSuperAdmin],
  );
}

const SEVERITY_ORDER: Record<NotificationItem['severity'], number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

interface ExpiryAlert {
  id: string; vehicle_id: string; vehicle_plate_number: string | null; document_type: string;
  expiry_date: string | null; days_until_expiry: number; expired: boolean;
}

/** Raw per-document shape for the Dashboard's "Document expiry alerts" table
 *  (Section 42) — useNotifications() above covers the same data folded into
 *  the unified bell, this is for callers that need the document-level detail. */
export function useDocumentExpiryAlerts(): ExpiryAlert[] {
  const [alerts, setAlerts] = useState<ExpiryAlert[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => api<ExpiryAlert[]>('/vehicle-documents/expiring').then(rows => { if (!cancelled) setAlerts(rows); });
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);
  return alerts;
}

export function NotificationCenter({ onClose }: { onClose: () => void }) {
  const items = useNotifications();
  const navigate = useNavigate();
  const sorted = useMemo(() => [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]), [items]);

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Notifications" style={{ maxWidth: 460 }}>
        <div className="dialog-head">
          <h2 className="card-title">Notifications</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ padding: '8px 0', maxHeight: '60vh', overflowY: 'auto' }}>
          {sorted.length === 0 && (
            <p className="sub" style={{ padding: '20px 20px' }}>Nothing needs attention right now.</p>
          )}
          {sorted.map(n => (
            <button
              key={n.id}
              onClick={() => { onClose(); navigate(`/${n.pageKey}`); }}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '10px 20px', textAlign: 'left', borderBottom: '1px solid rgb(var(--line))' }}
            >
              <span>
                <span className="sub" style={{ display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{CATEGORY_LABELS[n.category]}</span>
                <span style={{ display: 'block', fontWeight: 500, fontSize: 13 }}>{n.title}</span>
                <span className="sub">{n.detail}</span>
              </span>
              <Pill status={n.severity} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
