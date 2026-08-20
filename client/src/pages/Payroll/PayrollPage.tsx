import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost, apiPut } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';
import { exportCsv } from '../../lib/csv';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Tabs } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { NumberInput } from '../../components/ui/NumberInput';
import { Icon } from '../../components/ui/Icon';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';

type DeductionType = 'LOAN' | 'SALARY_ADVANCE' | 'SAVINGS' | 'COMPULSORY_SAVINGS' | 'TAX' | 'PENALTY' | 'OTHER';
type PayrollStatus = 'PENDING_REVIEW' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DISBURSED';
const MANUAL_DEDUCTION_TYPES: DeductionType[] = ['SALARY_ADVANCE', 'SAVINGS', 'TAX', 'PENALTY', 'OTHER'];

interface Employee { id: string; name: string; status: string }
interface Loan { id: string; employee_id: string; employee_name: string; principal: number; date_issued: string; repayment_schedule: string | null; monthly_repayment: number; amount_repaid: number; outstanding: number; status: string }
interface Savings { employee_id: string; employee_name: string; monthly_contribution: number; start_date: string | null; current_balance: number; total_contribution: number; status: string }
interface SavingsTxn { id: string; type: 'CONTRIBUTION' | 'LIQUIDATION'; amount: number; authorized_by: string | null; paid_date: string | null }
interface PayrollDeduction { id: number; type: DeductionType; description: string | null; amount: number }
interface PayrollRun {
  id: string; staff_id: string; staff_name: string | null; period: string; gross: number; total_deductions: number; net: number;
  status: PayrollStatus; prepared_by: string | null; reviewed_by: string | null; approved_by: string | null;
  approval_signature: string | null; disbursed_by: string | null; locked: number; revision_of: string | null; created_at: string;
}
interface PayrollRunDetail extends PayrollRun { deductions: PayrollDeduction[] }
interface ExportRow { payroll_run_id: string; employee_name: string; period: string; gross: number; total_deductions: number; net: number; status: PayrollStatus; bank_name: string | null; bank_account_number: string | null }
interface DeductionScheduleRow { payroll_run_id: string; employee_name: string; period: string; type: DeductionType; description: string | null; amount: number }

export default function PayrollPage() {
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => { api<PayrollRun[]>('/payroll/runs').then(setRuns); }, [reloadKey]);
  useEffect(() => { api<Employee[]>('/masters/employees').then(setEmployees); }, []);

  const kpis = useMemo(() => [
    { key: 'runs', label: 'Payroll runs', icon: 'clock' as const, value: number(runs.length) },
    { key: 'review', label: 'Awaiting review/approval', icon: 'clock' as const, value: number(runs.filter(r => r.status === 'PENDING_REVIEW' || r.status === 'AWAITING_APPROVAL').length) },
    { key: 'approved', label: 'Approved, not disbursed', icon: 'wallet' as const, value: number(runs.filter(r => r.status === 'APPROVED').length) },
    { key: 'net', label: 'Net disbursed', icon: 'bank' as const, value: naira(runs.filter(r => r.status === 'DISBURSED').reduce((s, r) => s + r.net, 0)) },
  ], [runs]);

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Payroll</h1><p className="pagesub">Prepare → Review → Chairman approval → Disbursement. Approved payroll is locked; corrections go through a revision.</p></div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        { key: 'runs', label: 'Payroll runs', content: <RunsTab runs={runs} employees={employees} refresh={refresh} /> },
        { key: 'loans', label: 'Loans', content: <LoansTab employees={employees} /> },
        { key: 'savings', label: 'Compulsory savings', content: <SavingsTab employees={employees} /> },
        { key: 'export', label: 'Export', content: <ExportTab /> },
      ]} />
    </>
  );
}

const STATUS_ACTION_LABEL: Record<PayrollStatus, string> = {
  PENDING_REVIEW: 'Review', AWAITING_APPROVAL: 'Approve', APPROVED: 'Disburse', REJECTED: '', DISBURSED: '',
};

function RunsTab({ runs, employees, refresh }: { runs: PayrollRun[]; employees: Employee[]; refresh: () => void }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [reviseFor, setReviseFor] = useState<PayrollRun | null>(null);

  async function advance(run: PayrollRun) {
    const actorName = user?.name ?? 'Someone';
    try {
      if (run.status === 'PENDING_REVIEW') await apiPost(`/payroll/runs/${encodeURIComponent(run.id)}/review`, { reviewedBy: actorName });
      else if (run.status === 'AWAITING_APPROVAL') await apiPost(`/payroll/runs/${encodeURIComponent(run.id)}/approve`, { approvedBy: actorName });
      else if (run.status === 'APPROVED') await apiPost(`/payroll/runs/${encodeURIComponent(run.id)}/disburse`, { disbursedBy: actorName });
      ui.toast(`${run.id} updated`);
      refresh();
    } catch (err) { ui.toast(err instanceof Error ? err.message : 'Something went wrong'); }
  }

  async function reject(run: PayrollRun) {
    const reason = window.prompt(`Reason for rejecting ${run.id}?`);
    if (!reason) return;
    try {
      await apiPost(`/payroll/runs/${encodeURIComponent(run.id)}/reject`, { reason, actor: user?.name ?? 'Someone' });
      ui.toast(`${run.id} rejected`);
      refresh();
    } catch (err) { ui.toast(err instanceof Error ? err.message : 'Something went wrong'); }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card title="Payroll runs" description="Every run, most recent first." action={
        <button className="btn btn-primary no-print" onClick={() => setPrepareOpen(true)}><Icon name="plus" size={14} /> Prepare payroll</button>
      }>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Run</th><th>Staff</th><th>Period</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net</th><th>Status</th><th className="no-print">Action</th></tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))', cursor: 'pointer' }} onClick={() => setDetailFor(r.id)}>{r.id}</td>
                  <td>{r.staff_name}{r.revision_of && <span className="sub"> · revises {r.revision_of}</span>}</td>
                  <td className="sub">{r.period}</td>
                  <td className="num tnum">{naira(r.gross)}</td>
                  <td className="num tnum">{naira(r.total_deductions)}</td>
                  <td className="num tnum">{naira(r.net)}</td>
                  <td><Pill status={r.status} /></td>
                  <td className="no-print">
                    <div style={{ display: 'flex', gap: 6 }}>
                      {STATUS_ACTION_LABEL[r.status] && <button className="btn btn-secondary btn-sm" onClick={() => advance(r)}>{STATUS_ACTION_LABEL[r.status]}</button>}
                      {r.status === 'AWAITING_APPROVAL' && <button className="btn btn-secondary btn-sm" onClick={() => reject(r)}>Reject</button>}
                      {!!r.locked && <button className="btn btn-secondary btn-sm" onClick={() => setReviseFor(r)}>Revise</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {runs.length === 0 && <EmptyState title="No payroll runs yet" description="Prepare a payroll run for a staff member to get started." onClear={() => {}} />}
      </Card>

      {prepareOpen && <PrepareRun employees={employees} onClose={() => setPrepareOpen(false)} onSaved={() => { setPrepareOpen(false); refresh(); ui.toast('Payroll prepared'); }} />}
      {detailFor && <RunDetail id={detailFor} onClose={() => setDetailFor(null)} />}
      {reviseFor && <ReviseRun run={reviseFor} onClose={() => setReviseFor(null)} onSaved={() => { setReviseFor(null); refresh(); ui.toast('Revision raised'); }} />}
    </div>
  );
}

function DeductionRows({ lines, setLines }: {
  lines: { type: DeductionType; description: string; amount: string }[];
  setLines: (lines: { type: DeductionType; description: string; amount: string }[]) => void;
}) {
  function update(i: number, patch: Partial<{ type: DeductionType; description: string; amount: string }>) {
    setLines(lines.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <label>Manual deductions <span className="sub">(loan and compulsory savings apply automatically)</span></label>
      {lines.map((l, i) => (
        <div key={i} className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr auto', alignItems: 'end' }}>
          <div className="form-row">
            <select value={l.type} onChange={e => update(i, { type: e.target.value as DeductionType })}>
              {MANUAL_DEDUCTION_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="form-row"><input placeholder="Description" value={l.description} onChange={e => update(i, { description: e.target.value })} /></div>
          <div className="form-row"><NumberInput value={l.amount} onChange={v => update(i, { amount: v })} ariaLabel="Amount" placeholder="Amount" /></div>
          <button type="button" className="iconbtn" onClick={() => setLines(lines.filter((_, idx) => idx !== i))} aria-label="Remove"><Icon name="x" size={14} /></button>
        </div>
      ))}
      <button type="button" className="btn btn-secondary btn-sm" style={{ justifySelf: 'start' }} onClick={() => setLines([...lines, { type: 'TAX', description: '', amount: '' }])}>
        <Icon name="plus" size={12} /> Add deduction
      </button>
    </div>
  );
}

function PrepareRun({ employees, onClose, onSaved }: { employees: Employee[]; onClose: () => void; onSaved: () => void }) {
  const { user } = useCurrentUser();
  const [staffId, setStaffId] = useState(employees[0]?.id ?? '');
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [gross, setGross] = useState('');
  const [lines, setLines] = useState<{ type: DeductionType; description: string; amount: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const manualDeductions = lines.filter(l => Number(l.amount) > 0).map(l => ({ type: l.type, description: l.description || undefined, amount: Number(l.amount) }));
      await apiPost('/payroll/runs', { staffId, period, gross: Number(gross), manualDeductions, preparedBy: user?.name ?? 'HR', actor: user?.name });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Prepare payroll" onClose={onClose} onSubmit={submit} submitLabel="Prepare" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="pr-staff">Staff</label>
          <select id="pr-staff" value={staffId} onChange={e => setStaffId(e.target.value)}>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div className="form-row"><label htmlFor="pr-period">Period</label><input id="pr-period" type="month" value={period} onChange={e => setPeriod(e.target.value)} required /></div>
      </div>
      <div className="form-row"><label htmlFor="pr-gross">Gross salary</label><NumberInput id="pr-gross" value={gross} onChange={setGross} required ariaLabel="Gross salary" /></div>
      <DeductionRows lines={lines} setLines={setLines} />
    </Modal>
  );
}

function ReviseRun({ run, onClose, onSaved }: { run: PayrollRun; onClose: () => void; onSaved: () => void }) {
  const { user } = useCurrentUser();
  const [gross, setGross] = useState(String(run.gross));
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<{ type: DeductionType; description: string; amount: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const manualDeductions = lines.filter(l => Number(l.amount) > 0).map(l => ({ type: l.type, description: l.description || undefined, amount: Number(l.amount) }));
      await apiPost(`/payroll/runs/${encodeURIComponent(run.id)}/revise`, { gross: Number(gross), manualDeductions, preparedBy: user?.name ?? 'HR', reason, actor: user?.name });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Revise ${run.id}`} onClose={onClose} onSubmit={submit} submitLabel="Raise revision" saving={saving} error={error} wide>
      <p className="sub">The original run is locked and stays as-is. This creates a new run linked back to it, starting again from Pending review.</p>
      <div className="form-row"><label htmlFor="rv-reason">Reason for revision</label><input id="rv-reason" value={reason} onChange={e => setReason(e.target.value)} required /></div>
      <div className="form-row"><label htmlFor="rv-gross">Gross salary</label><NumberInput id="rv-gross" value={gross} onChange={setGross} required ariaLabel="Gross salary" /></div>
      <DeductionRows lines={lines} setLines={setLines} />
    </Modal>
  );
}

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [run, setRun] = useState<PayrollRunDetail | null>(null);
  useEffect(() => { api<PayrollRunDetail>(`/payroll/runs/${encodeURIComponent(id)}`).then(setRun); }, [id]);

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={id} style={{ maxWidth: 560 }}>
        <div className="dialog-head">
          <h2 className="card-title">{id}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}><Icon name="x" size={16} /></button>
        </div>
        <div style={{ padding: 20, maxHeight: '65vh', overflowY: 'auto' }}>
          {!run && <p className="sub">Loading…</p>}
          {run && (
            <>
              <p><strong>{run.staff_name}</strong> — {run.period}</p>
              <p className="sub">Status: <Pill status={run.status} /></p>
              {run.approval_signature && <p className="sub" style={{ marginTop: 8 }}>{run.approval_signature}</p>}
              <div className="table-wrap" style={{ marginTop: 16 }}>
                <table>
                  <thead><tr><th>Type</th><th>Description</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {run.deductions.map(d => (
                      <tr key={d.id}><td>{d.type.replace('_', ' ')}</td><td className="sub">{d.description}</td><td className="num tnum">{naira(d.amount)}</td></tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={2}>Gross</td><td className="num tnum">{naira(run.gross)}</td></tr>
                    <tr><td colSpan={2}>Total deductions</td><td className="num tnum">{naira(run.total_deductions)}</td></tr>
                    <tr><td colSpan={2}><strong>Net</strong></td><td className="num tnum"><strong>{naira(run.net)}</strong></td></tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LoansTab({ employees }: { employees: Employee[] }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [loans, setLoans] = useState<Loan[]>([]);
  const [open, setOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => { api<Loan[]>('/payroll/loans').then(setLoans); }, [reloadKey]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card title="Staff loans" description="Loan deductions apply to payroll automatically, capped at the outstanding balance." action={
        <button className="btn btn-primary no-print" onClick={() => setOpen(true)}><Icon name="plus" size={14} /> Issue loan</button>
      }>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Loan</th><th>Staff</th><th className="num">Principal</th><th className="num">Monthly</th><th className="num">Repaid</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {loans.map(l => (
                <tr key={l.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{l.id}</td>
                  <td>{l.employee_name}</td>
                  <td className="num tnum">{naira(l.principal)}</td>
                  <td className="num tnum">{naira(l.monthly_repayment)}</td>
                  <td className="num tnum">{naira(l.amount_repaid)}</td>
                  <td className="num tnum">{naira(l.outstanding)}</td>
                  <td><Pill status={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loans.length === 0 && <EmptyState title="No loans issued" description="Issue a loan to a staff member to begin automatic payroll deductions." onClear={() => {}} />}
      </Card>

      {open && (
        <IssueLoan employees={employees} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); setReloadKey(k => k + 1); ui.toast('Loan issued'); }} actor={user?.name ?? 'HR'} />
      )}
    </div>
  );
}

function IssueLoan({ employees, onClose, onSaved, actor }: { employees: Employee[]; onClose: () => void; onSaved: () => void; actor: string }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const [principal, setPrincipal] = useState('');
  const [monthlyRepayment, setMonthlyRepayment] = useState('');
  const [repaymentSchedule, setRepaymentSchedule] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/payroll/loans', { employeeId, principal: Number(principal), monthlyRepayment: Number(monthlyRepayment), repaymentSchedule: repaymentSchedule || undefined, actor });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Issue loan" onClose={onClose} onSubmit={submit} submitLabel="Issue loan" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="ln-emp">Staff</label>
        <select id="ln-emp" value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
          {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="ln-principal">Principal</label><NumberInput id="ln-principal" value={principal} onChange={setPrincipal} required ariaLabel="Principal" /></div>
        <div className="form-row"><label htmlFor="ln-monthly">Monthly repayment</label><NumberInput id="ln-monthly" value={monthlyRepayment} onChange={setMonthlyRepayment} required ariaLabel="Monthly repayment" /></div>
      </div>
      <div className="form-row"><label htmlFor="ln-schedule">Repayment schedule (optional)</label><input id="ln-schedule" value={repaymentSchedule} onChange={e => setRepaymentSchedule(e.target.value)} /></div>
    </Modal>
  );
}

function SavingsTab({ employees }: { employees: Employee[] }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [savings, setSavings] = useState<Savings[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [planOpen, setPlanOpen] = useState(false);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [liquidationDate, setLiquidationDate] = useState('01-01');

  useEffect(() => { api<Savings[]>('/payroll/savings').then(setSavings); }, [reloadKey]);
  useEffect(() => { api<{ date: string }>('/payroll/savings-liquidation-date').then(r => setLiquidationDate(r.date)); }, []);

  const totalBalance = savings.reduce((s, r) => s + r.current_balance, 0);

  async function liquidate() {
    if (!window.confirm(`Liquidate compulsory savings for all ${savings.filter(s => s.current_balance > 0).length} employee(s) with a balance? This zeroes each current balance and records the payout.`)) return;
    const authorizedBy = user?.name ?? window.prompt('Authorized by?') ?? '';
    if (!authorizedBy) return;
    try {
      const result = await apiPost<{ employeeId: string; amount: number }[]>('/payroll/savings/liquidate', { authorizedBy, actor: user?.name });
      ui.toast(`Liquidated savings for ${result.length} employee(s)`);
      setReloadKey(k => k + 1);
    } catch (err) { ui.toast(err instanceof Error ? err.message : 'Something went wrong'); }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card
        title="Compulsory savings"
        description={`Configured liquidation date: ${liquidationDate} (MM-DD). Liquidation zeroes each employee's current balance; total lifetime contribution and history are preserved.`}
        action={
          <div style={{ display: 'flex', gap: 8 }} className="no-print">
            <button className="btn btn-secondary" onClick={() => setPlanOpen(true)}>Set savings plan</button>
            <button className="btn btn-primary" onClick={liquidate} disabled={totalBalance === 0}>Liquidate savings</button>
          </div>
        }
      >
        <div className="table-wrap">
          <table>
            <thead><tr><th>Staff</th><th className="num">Monthly</th><th className="num">Balance</th><th className="num">Lifetime total</th><th>Started</th><th className="no-print" /></tr></thead>
            <tbody>
              {savings.map(s => (
                <tr key={s.employee_id}>
                  <td>{s.employee_name}</td>
                  <td className="num tnum">{naira(s.monthly_contribution)}</td>
                  <td className="num tnum">{naira(s.current_balance)}</td>
                  <td className="num tnum">{naira(s.total_contribution)}</td>
                  <td className="sub">{s.start_date}</td>
                  <td className="no-print"><button className="btn btn-secondary btn-sm" onClick={() => setDetailFor(s.employee_id)}>History</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {savings.length === 0 && <EmptyState title="No savings plans set" description="Set a compulsory savings plan for a staff member." onClear={() => {}} />}
      </Card>

      {planOpen && <SetSavingsPlan employees={employees} onClose={() => setPlanOpen(false)} onSaved={() => { setPlanOpen(false); setReloadKey(k => k + 1); ui.toast('Savings plan saved'); }} actor={user?.name ?? 'HR'} />}
      {detailFor && <SavingsHistory employeeId={detailFor} onClose={() => setDetailFor(null)} />}
    </div>
  );
}

function SetSavingsPlan({ employees, onClose, onSaved, actor }: { employees: Employee[]; onClose: () => void; onSaved: () => void; actor: string }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const [monthlyContribution, setMonthlyContribution] = useState('');
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPut(`/payroll/savings/${encodeURIComponent(employeeId)}`, { monthlyContribution: Number(monthlyContribution), startDate: startDate || undefined, actor });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Set compulsory savings plan" onClose={onClose} onSubmit={submit} submitLabel="Save plan" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="sv-emp">Staff</label>
        <select id="sv-emp" value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
          {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="sv-amount">Monthly contribution</label><NumberInput id="sv-amount" value={monthlyContribution} onChange={setMonthlyContribution} required ariaLabel="Monthly contribution" /></div>
        <div className="form-row"><label htmlFor="sv-start">Start date</label><input id="sv-start" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function SavingsHistory({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const [data, setData] = useState<(Savings & { transactions: SavingsTxn[] }) | null>(null);
  useEffect(() => { api<Savings & { transactions: SavingsTxn[] }>(`/payroll/savings/${encodeURIComponent(employeeId)}`).then(setData); }, [employeeId]);

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Savings history" style={{ maxWidth: 560 }}>
        <div className="dialog-head">
          <h2 className="card-title">{data?.employee_name ?? employeeId} — savings history</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}><Icon name="x" size={16} /></button>
        </div>
        <div style={{ padding: 20, maxHeight: '65vh', overflowY: 'auto' }}>
          {!data && <p className="sub">Loading…</p>}
          {data && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Type</th><th className="num">Amount</th><th>Authorized by</th><th>Paid date</th></tr></thead>
                <tbody>
                  {data.transactions.map(t => (
                    <tr key={t.id}><td><Pill status={t.type} /></td><td className="num tnum">{naira(t.amount)}</td><td className="sub">{t.authorized_by}</td><td className="sub">{t.paid_date}</td></tr>
                  ))}
                </tbody>
              </table>
              {data.transactions.length === 0 && <p className="sub">No contributions or liquidations recorded yet.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExportTab() {
  const [period, setPeriod] = useState('');

  async function exportSummary() {
    const rows = await api<ExportRow[]>('/payroll/export/summary', { period: period || undefined });
    exportCsv<ExportRow>(`payroll-summary${period ? `-${period}` : ''}.csv`, [
      { label: 'Payroll run', get: r => r.payroll_run_id },
      { label: 'Employee', get: r => r.employee_name },
      { label: 'Period', get: r => r.period },
      { label: 'Gross', get: r => r.gross },
      { label: 'Deductions', get: r => r.total_deductions },
      { label: 'Net', get: r => r.net },
      { label: 'Bank', get: r => r.bank_name ?? '' },
      { label: 'Account number', get: r => r.bank_account_number ?? '' },
      { label: 'Status', get: r => r.status },
    ], rows);
  }

  async function exportDeductions() {
    const rows = await api<DeductionScheduleRow[]>('/payroll/export/deductions', { period: period || undefined });
    exportCsv<DeductionScheduleRow>(`payroll-deductions${period ? `-${period}` : ''}.csv`, [
      { label: 'Payroll run', get: r => r.payroll_run_id },
      { label: 'Employee', get: r => r.employee_name },
      { label: 'Period', get: r => r.period },
      { label: 'Type', get: r => r.type },
      { label: 'Description', get: r => r.description ?? '' },
      { label: 'Amount', get: r => r.amount },
    ], rows);
  }

  return (
    <Card title="Export for bank processing / internal review" description="Bank details only appear once a run is Approved or Disbursed.">
      <div className="form-row" style={{ maxWidth: 220 }}><label htmlFor="ex-period">Period (optional)</label><input id="ex-period" type="month" value={period} onChange={e => setPeriod(e.target.value)} /></div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn btn-primary" onClick={exportSummary}><Icon name="download" size={14} /> Export payroll summary</button>
        <button className="btn btn-secondary" onClick={exportDeductions}><Icon name="download" size={14} /> Export deduction schedule</button>
      </div>
    </Card>
  );
}
