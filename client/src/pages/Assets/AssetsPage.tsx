import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Tabs } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { NumberInput } from '../../components/ui/NumberInput';
import { Icon } from '../../components/ui/Icon';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';

interface Asset {
  id: string; equipment: string; category: string | null; serial_number: string | null; location: string | null;
  assigned_department: string | null; last_service: string | null; next_due: string | null;
  service_interval_days: number | null; notes: string | null; status: string; created_at: string;
}
interface MaintenanceRecord {
  id: string; ref_type: 'ASSET' | 'VEHICLE'; ref_id: string; category: string; description: string | null;
  vendor: string | null; amount: number; service_date: string; invoice_reference: string | null;
  performed_by: string | null; approved_by: string | null; next_due_date: string | null; remarks: string | null; created_at: string;
}

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [records, setRecords] = useState<MaintenanceRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => { api<Asset[]>('/assets').then(setAssets); }, [reloadKey]);
  useEffect(() => { api<MaintenanceRecord[]>('/maintenance').then(setRecords); }, [reloadKey]);

  const assetRecords = useMemo(() => records.filter(r => r.ref_type === 'ASSET'), [records]);
  const dueSoon = useMemo(() => {
    const today = new Date();
    return assets.filter(a => a.next_due && new Date(a.next_due).getTime() - today.getTime() < 14 * 86400000);
  }, [assets]);

  const kpis = [
    { key: 'assets', label: 'Registered assets', icon: 'wrench' as const, value: number(assets.length) },
    { key: 'due', label: 'Service due within 14 days', icon: 'clock' as const, value: number(dueSoon.length) },
    { key: 'spend', label: 'Maintenance spend', icon: 'wallet' as const, value: naira(assetRecords.reduce((s, r) => s + r.amount, 0)) },
  ];

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Asset &amp; Maintenance</h1><p className="pagesub">Vehicles, generators, machines, equipment, buildings and office equipment — with a full maintenance history per asset.</p></div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        { key: 'assets', label: 'Assets', content: <AssetsTab assets={assets} refresh={refresh} /> },
        { key: 'maintenance', label: 'Maintenance expenses', content: <MaintenanceTab assets={assets} records={assetRecords} refresh={refresh} /> },
      ]} />
    </>
  );
}

function AssetsTab({ assets, refresh }: { assets: Asset[]; refresh: () => void }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card title="Registered assets" description="Every fixed asset with its service schedule." action={
        <button className="btn btn-primary no-print" onClick={() => setOpen(true)}><Icon name="plus" size={14} /> Register asset</button>
      }>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Asset</th><th>Name &amp; location</th><th>Category</th><th>Department</th><th>Last service</th><th>Next due</th><th>Status</th></tr></thead>
            <tbody>
              {assets.map(a => (
                <tr key={a.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{a.id}</td>
                  <td><p style={{ fontWeight: 500 }}>{a.equipment}</p><p className="sub">{a.location}</p></td>
                  <td className="sub">{a.category}</td>
                  <td className="sub">{a.assigned_department}</td>
                  <td className="sub">{a.last_service ?? '—'}</td>
                  <td className="sub">{a.next_due ?? '—'}</td>
                  <td><Pill status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {assets.length === 0 && <EmptyState title="No assets registered" description="Register a vehicle, generator, machine or piece of equipment." onClear={() => {}} />}
      </Card>

      {open && <RegisterAsset onClose={() => setOpen(false)} onSaved={() => { setOpen(false); refresh(); ui.toast('Asset registered'); }} actor={user?.name ?? 'System Administrator'} />}
    </div>
  );
}

function RegisterAsset({ onClose, onSaved, actor }: { onClose: () => void; onSaved: () => void; actor: string }) {
  const [categories, setCategories] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [location, setLocation] = useState('');
  const [assignedDepartment, setAssignedDepartment] = useState('');
  const [serviceIntervalDays, setServiceIntervalDays] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<string[]>('/assets/categories').then(cats => { setCategories(cats); setCategory(cats[0] ?? ''); }); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/assets', {
        name, category, serialNumber: serialNumber || undefined, location: location || undefined,
        assignedDepartment: assignedDepartment || undefined, serviceIntervalDays: serviceIntervalDays ? Number(serviceIntervalDays) : undefined,
        notes: notes || undefined, actor,
      });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Register asset" onClose={onClose} onSubmit={submit} submitLabel="Register" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="as-name">Name</label><input id="as-name" value={name} onChange={e => setName(e.target.value)} required autoFocus /></div>
        <div className="form-row">
          <label htmlFor="as-category">Category</label>
          <select id="as-category" value={category} onChange={e => setCategory(e.target.value)}>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="as-serial">Serial number</label><input id="as-serial" value={serialNumber} onChange={e => setSerialNumber(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="as-location">Location</label><input id="as-location" value={location} onChange={e => setLocation(e.target.value)} /></div>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="as-dept">Assigned department</label><input id="as-dept" value={assignedDepartment} onChange={e => setAssignedDepartment(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="as-interval">Service interval (days)</label><NumberInput id="as-interval" value={serviceIntervalDays} onChange={setServiceIntervalDays} allowDecimal={false} ariaLabel="Service interval days" /></div>
      </div>
      <div className="form-row"><label htmlFor="as-notes">Notes</label><input id="as-notes" value={notes} onChange={e => setNotes(e.target.value)} /></div>
    </Modal>
  );
}

function MaintenanceTab({ assets, records, refresh }: { assets: Asset[]; records: MaintenanceRecord[]; refresh: () => void }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card title="Maintenance expenses" description="Every maintenance job, independently recorded and posted to the ledger." action={
        <button className="btn btn-primary no-print" onClick={() => setOpen(true)} disabled={assets.length === 0}><Icon name="plus" size={14} /> Record expense</button>
      }>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Record</th><th>Asset</th><th>Category</th><th>Vendor</th><th className="num">Amount</th><th>Date</th><th>Next due</th></tr></thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{r.id}</td>
                  <td className="sub">{assets.find(a => a.id === r.ref_id)?.equipment ?? r.ref_id}</td>
                  <td>{r.category}</td>
                  <td className="sub">{r.vendor}</td>
                  <td className="num tnum">{naira(r.amount)}</td>
                  <td className="sub">{r.service_date}</td>
                  <td className="sub">{r.next_due_date ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {records.length === 0 && <EmptyState title="No maintenance recorded" description="Record a maintenance expense against an asset." onClear={() => {}} />}
      </Card>

      {open && <RecordExpense assets={assets} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); refresh(); ui.toast('Maintenance recorded'); }} actor={user?.name ?? 'System Administrator'} />}
    </div>
  );
}

function RecordExpense({ assets, onClose, onSaved, actor }: { assets: Asset[]; onClose: () => void; onSaved: () => void; actor: string }) {
  const [categories, setCategories] = useState<string[]>([]);
  const [refId, setRefId] = useState(assets[0]?.id ?? '');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [serviceDate, setServiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceReference, setInvoiceReference] = useState('');
  const [performedBy, setPerformedBy] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [nextDueDate, setNextDueDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<string[]>('/maintenance/categories').then(cats => { setCategories(cats); setCategory(cats[0] ?? ''); }); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/maintenance', {
        refType: 'ASSET', refId, category, description: description || undefined, vendor: vendor || undefined,
        amount: Number(amount), serviceDate, invoiceReference: invoiceReference || undefined,
        performedBy: performedBy || undefined, approvedBy: approvedBy || undefined, nextDueDate: nextDueDate || undefined,
        remarks: remarks || undefined, actor,
      });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record maintenance expense" onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="me-asset">Asset</label>
          <select id="me-asset" value={refId} onChange={e => setRefId(e.target.value)}>
            {assets.map(a => <option key={a.id} value={a.id}>{a.id} — {a.equipment}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="me-category">Category</label>
          <select id="me-category" value={category} onChange={e => setCategory(e.target.value)}>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="form-row"><label htmlFor="me-desc">Description</label><input id="me-desc" value={description} onChange={e => setDescription(e.target.value)} /></div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="me-vendor">Vendor</label><input id="me-vendor" value={vendor} onChange={e => setVendor(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="me-amount">Amount</label><NumberInput id="me-amount" value={amount} onChange={setAmount} required ariaLabel="Amount" /></div>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="me-date">Service date</label><input id="me-date" type="date" value={serviceDate} onChange={e => setServiceDate(e.target.value)} required /></div>
        <div className="form-row"><label htmlFor="me-next">Next due date</label><input id="me-next" type="date" value={nextDueDate} onChange={e => setNextDueDate(e.target.value)} /></div>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="me-performed">Performed by</label><input id="me-performed" value={performedBy} onChange={e => setPerformedBy(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="me-approved">Approved by</label><input id="me-approved" value={approvedBy} onChange={e => setApprovedBy(e.target.value)} /></div>
      </div>
      <div className="form-row"><label htmlFor="me-invoice">Invoice / receipt reference</label><input id="me-invoice" value={invoiceReference} onChange={e => setInvoiceReference(e.target.value)} /></div>
      <div className="form-row"><label htmlFor="me-remarks">Remarks</label><input id="me-remarks" value={remarks} onChange={e => setRemarks(e.target.value)} /></div>
    </Modal>
  );
}
