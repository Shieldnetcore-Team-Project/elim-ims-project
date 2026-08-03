import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { Pill } from '../../components/ui/Pill';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { ReportToolbar } from '../../components/ui/ReportToolbar';
import { inRange, type DateRange } from '../../lib/reportExport';
import type { CsvColumn } from '../../lib/csv';

type CustomerType = 'RETAIL' | 'MARKETER' | 'DISTRIBUTOR';
interface Customer { id: string; name: string; location: string | null; customer_type: CustomerType }

interface Branch {
  id: string; company_id: string; name: string; location: string | null;
  contact_phone: string | null; status: 'ACTIVE' | 'INACTIVE'; created_at: string; outstanding: number;
}
interface BranchBalance { invoiced: number; paid: number; outstanding: number }
interface StatementLine {
  id: string; entry_date: string; debit: number; credit: number; description: string | null;
  reference_id: string | null; manual_invoice_number: string | null; running_balance: number;
}
interface BranchInvoice {
  id: string; manual_invoice_number: string | null; created_at: string; status: string;
  products: string; value: number; balance: number; vehicle_id: string | null; driver: string | null;
}

export function DistributorBranchesTab({ customers }: { customers: Customer[] }) {
  const ui = useUi();
  const companies = useMemo(() => customers.filter(c => c.customer_type === 'DISTRIBUTOR'), [customers]);
  const [companyId, setCompanyId] = useState('');
  const [branchList, setBranchList] = useState<Branch[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [balance, setBalance] = useState<BranchBalance | null>(null);
  const [statement, setStatement] = useState<StatementLine[]>([]);
  const [invoices, setInvoices] = useState<BranchInvoice[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [statementRange, setStatementRange] = useState<DateRange | null>(null);
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => { if (!companyId && companies[0]) setCompanyId(companies[0].id); }, [companies, companyId]);
  useEffect(() => {
    if (!companyId) { setBranchList([]); return; }
    api<Branch[]>('/distributor-branches', { companyId }).then(setBranchList);
  }, [companyId, reloadKey]);

  useEffect(() => {
    if (!selectedId) { setBalance(null); setStatement([]); setInvoices([]); return; }
    api<BranchBalance>(`/distributor-branches/${encodeURIComponent(selectedId)}/balance`).then(setBalance);
    api<StatementLine[]>(`/distributor-branches/${encodeURIComponent(selectedId)}/statement`).then(setStatement);
    api<BranchInvoice[]>(`/distributor-branches/${encodeURIComponent(selectedId)}/invoices`).then(setInvoices);
  }, [selectedId, reloadKey]);

  const selected = branchList.find(b => b.id === selectedId) ?? null;
  const filteredStatement = useMemo(() => statement.filter(l => inRange(l.entry_date, statementRange)), [statement, statementRange]);
  const statementColumns: CsvColumn<StatementLine>[] = useMemo(() => [
    { label: 'ERP #', get: l => l.reference_id ?? l.id },
    { label: 'Manual #', get: l => l.manual_invoice_number ?? '' },
    { label: 'Date', get: l => l.entry_date },
    { label: 'Description', get: l => l.description ?? '' },
    { label: 'Debit', get: l => l.debit },
    { label: 'Credit', get: l => l.credit },
    { label: 'Balance', get: l => l.running_balance },
  ], []);

  return (
    <>
      <Card
        title="Distributor branches" description="Each branch of a major distributor receives its own independent invoices and running balance."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="no-print">
            <select aria-label="Distributor" value={companyId} onChange={e => { setCompanyId(e.target.value); setSelectedId(null); }} style={{ minWidth: 160 }}>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" onClick={() => setNewBranchOpen(true)} disabled={!companyId}><Icon name="plus" size={14} /> New branch</button>
          </div>
        }
      >
        {companies.length === 0 && <EmptyState title="No distributors yet" description="Add a customer of type Distributor to manage their branches." onClear={() => {}} />}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Location</th><th>Contact</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {branchList.map(b => (
                <tr key={b.id} className="row-clickable" onClick={() => setSelectedId(b.id)}>
                  <td style={{ fontWeight: b.id === selectedId ? 700 : 500 }}>{b.name}</td>
                  <td className="sub">{b.location ?? '—'}</td>
                  <td className="sub">{b.contact_phone ?? '—'}</td>
                  <td className="num tnum">{naira(b.outstanding)}</td>
                  <td><Pill status={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {branchList.length === 0 && companies.length > 0 && <EmptyState title="No branches yet" description="Add this distributor's first branch." onClear={() => {}} />}
      </Card>

      {selected && balance && (
        <Card
          title={selected.name} description={[selected.location, selected.contact_phone].filter(Boolean).join(' · ') || undefined}
        >
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 20px 16px' }}>
            <p className="sub">Invoiced <strong style={{ color: 'rgb(var(--ink))' }}>{naira(balance.invoiced)}</strong></p>
            <p className="sub">Paid <strong style={{ color: 'rgb(var(--ink))' }}>{naira(balance.paid)}</strong></p>
            <p className="sub">Outstanding <strong style={{ color: 'rgb(var(--ink))' }}>{naira(balance.outstanding)}</strong></p>
          </div>

          <p className="card-title" style={{ padding: '4px 20px', fontSize: 14 }}>Invoices</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ERP #</th><th>Manual #</th><th>Date</th><th>Products</th><th className="num">Value</th>
                  <th>Vehicle</th><th>Driver</th><th className="num">Balance</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => (
                  <tr key={inv.id}>
                    <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{inv.id}</td>
                    <td className="sub">{inv.manual_invoice_number ?? '—'}</td>
                    <td className="sub">{inv.created_at}</td>
                    <td>{inv.products}</td>
                    <td className="num tnum">{naira(inv.value)}</td>
                    <td className="sub">{inv.vehicle_id ?? 'Not yet dispatched'}</td>
                    <td className="sub">{inv.driver ?? '—'}</td>
                    <td className="num tnum">{naira(inv.balance)}</td>
                    <td><Pill status={inv.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {invoices.length === 0 && <EmptyState title="No invoices yet" description="Appears once an order is placed against this branch." onClear={() => {}} />}

          <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Statement</p>
          <div style={{ padding: '0 20px' }}>
            <ReportToolbar rows={filteredStatement} columns={statementColumns} filenameBase={`elim-statement-${selected.id}`} onRangeChange={setStatementRange} />
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>ERP #</th><th>Manual #</th><th>Date</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
              <tbody>
                {filteredStatement.map(l => (
                  <tr key={l.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{l.reference_id ?? l.id}</td>
                    <td className="sub">{l.manual_invoice_number ?? '—'}</td>
                    <td className="sub">{l.entry_date}</td>
                    <td className="sub">{l.description}</td>
                    <td className="num tnum">{l.debit ? naira(l.debit) : ''}</td>
                    <td className="num tnum">{l.credit ? naira(l.credit) : ''}</td>
                    <td className="num tnum">{naira(l.running_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredStatement.length === 0 && <EmptyState title={statement.length === 0 ? 'No activity yet' : 'No activity matches that range'} description="Nothing invoiced or paid against this branch yet." onClear={() => {}} />}
        </Card>
      )}

      {newBranchOpen && (
        <NewBranchModal companyId={companyId} onClose={() => setNewBranchOpen(false)} onCreated={() => { setNewBranchOpen(false); refresh(); ui.toast('Branch added'); }} />
      )}
    </>
  );
}

function NewBranchModal({ companyId, onClose, onCreated }: { companyId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/distributor-branches', { companyId, name, location: location || undefined, contactPhone: contactPhone || undefined });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New branch" onClose={onClose} onSubmit={submit} submitLabel="Add branch" saving={saving} error={error}>
      <div className="form-row"><label htmlFor="db-name">Name</label><input id="db-name" value={name} onChange={e => setName(e.target.value)} required autoFocus /></div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="db-location">Location</label><input id="db-location" value={location} onChange={e => setLocation(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="db-phone">Contact phone</label><input id="db-phone" value={contactPhone} onChange={e => setContactPhone(e.target.value)} /></div>
      </div>
    </Modal>
  );
}
