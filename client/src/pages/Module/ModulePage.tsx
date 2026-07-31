import { useCallback, useEffect, useRef, useState } from 'react';
import type { KpiMetric, ModuleRow, Paginated } from '@shared/types';
import { GENERIC_MODULES } from '@shared/moduleConfig';

const moduleByKey = (key: string) => GENERIC_MODULES.find(m => m.key === key);
import { formatModuleNumber } from '../../lib/format';
import { singularLabel } from '../../lib/humanize';
import { api } from '../../lib/apiClient';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useRegisterExport, useRegisterSearchFocus, useUi } from '../../lib/uiState';
import { usePendingDeletions } from '../../lib/pendingDeletions';
import { exportCsv } from '../../lib/csv';
import { KpiRow } from '../../components/ui/KpiCard';
import { FilterBar } from '../../components/ui/FilterBar';
import { Chips, type FilterChip } from '../../components/ui/Chips';
import { DataTable } from '../../components/ui/DataTable';
import { Pager } from '../../components/ui/Pager';
import { EmptyState } from '../../components/ui/EmptyState';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { RecordForm } from '../../components/ui/RecordForm';
import { Icon } from '../../components/ui/Icon';
import { NotFoundPage } from '../NotFound';

const PAGE_SIZE = 8;

export function ModulePage({ moduleKey, embedded }: { moduleKey: string; embedded?: boolean }) {
  const cfg = moduleByKey(moduleKey);

  const [kpis, setKpis] = useState<KpiMetric[]>([]);
  const [data, setData] = useState<Paginated<ModuleRow> | null>(null);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: ModuleRow } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const ui = useUi();
  const pendingDeletionIds = usePendingDeletions(moduleKey, reloadKey);

  useEffect(() => { setQuery(''); setStatus(''); setPage(1); setData(null); }, [moduleKey]);
  useEffect(() => { setPage(1); }, [debouncedQuery, status]);

  useEffect(() => {
    if (!cfg) return;
    api<{ kpis: KpiMetric[]; data: Paginated<ModuleRow> }>(`/modules/${cfg.key}`, {
      query: debouncedQuery, status, page: String(page), pageSize: String(PAGE_SIZE),
    }).then(res => { setKpis(res.kpis); setData(res.data); });
  }, [cfg, debouncedQuery, status, page, reloadKey]);

  const handleExportCsv = useCallback(async () => {
    if (!cfg) return;
    const all = await api<{ data: Paginated<ModuleRow> }>(`/modules/${cfg.key}`, { query: debouncedQuery, status, page: '1', pageSize: '1000' });
    exportCsv(`elim-${cfg.key}.csv`, cfg.columns.map(c => ({
      label: c.label,
      get: (r: ModuleRow) => {
        const raw = c.key === 'id' ? r.id : c.key === 'status' ? r.status : r.fields[c.key];
        return c.kind === 'num' ? formatModuleNumber(c.key, Number(raw)) : String(raw ?? '');
      },
    })), all.data.rows);
    ui.toast(`${all.data.rows.length} rows exported to elim-${cfg.key}.csv`);
  }, [cfg, debouncedQuery, status, ui]);

  useRegisterExport(cfg ? handleExportCsv : null);
  useRegisterSearchFocus(useCallback(() => searchRef.current?.focus(), []));

  if (!cfg) return <NotFoundPage />;

  function clearFilters() { setQuery(''); setStatus(''); }
  const chips: FilterChip[] = [
    ...(status ? [{ id: 'status', label: 'Status', value: cfg!.statusOptions.find(o => o.value === status)?.label ?? status }] : []),
    ...(query.trim() ? [{ id: 'query', label: 'Search', value: query.trim() }] : []),
  ];
  function removeChip(id: string) { if (id === 'status') setStatus(''); if (id === 'query') setQuery(''); }

  function handleSaved(row: ModuleRow) {
    const wasCreate = form?.mode === 'create';
    setForm(null);
    setReloadKey(k => k + 1);
    ui.toast(wasCreate ? `${row.id} created` : `${row.id} updated`);
  }

  const rows = data?.rows ?? [];

  return (
    <>
      {!embedded && <PrintHeader />}
      <div className={embedded ? 'no-print' : 'pagehead'} style={embedded ? { display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 16 } : undefined}>
        {!embedded && (
          <div>
            <h1>{cfg.label}</h1>
            <p className="pagesub">{cfg.subtitle}</p>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, position: 'relative' }} className="no-print">
          <ExportMenu onCsv={handleExportCsv} rowCount={data?.total ?? 0} />
          {!cfg.readOnly && (
            <button className="btn btn-primary" onClick={() => setForm({ mode: 'create' })}>
              <Icon name="plus" size={14} />
              New {singularLabel(cfg.label)}
            </button>
          )}
        </div>
      </div>

      <FilterBar
        ref={searchRef}
        searchValue={query} onSearchChange={setQuery} searchPlaceholder={cfg.searchPlaceholder}
        statusValue={status} onStatusChange={setStatus} statusOptions={cfg.statusOptions}
      />
      <Chips chips={chips} onRemove={removeChip} onClearAll={clearFilters} />

      <KpiRow kpis={kpis} />

      <section className="card" style={{ marginTop: 24 }}>
        <div className="card-head">
          <div><h2 className="card-title">{cfg.label}</h2><p className="card-desc">{rows.length} of {data?.total ?? 0} records shown.{!cfg.readOnly && ' Click a row to edit it.'}</p></div>
        </div>
        <div className="table-wrap">
          <DataTable
            columns={cfg.columns} rows={rows} onRowClick={cfg.readOnly ? undefined : row => setForm({ mode: 'edit', row })}
            deleteEntityType={cfg.readOnly ? undefined : cfg.key}
            pendingDeletionIds={pendingDeletionIds}
            onDeleteRequested={() => { setReloadKey(k => k + 1); ui.toast('Deletion requested — pending admin approval'); }}
          />
        </div>
        {rows.length === 0 && data != null && (
          <EmptyState
            title={`No ${cfg.label.toLowerCase()} match that`}
            description="Try a different search term or status, or clear the filters."
            onClear={clearFilters}
          />
        )}
        <div className="tfoot no-print">
          <p className="sub tnum">Showing {rows.length} of {data?.total ?? 0} records</p>
          <Pager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} />
        </div>
      </section>

      {form && (
        <RecordForm
          cfg={cfg}
          mode={form.mode}
          initial={form.row}
          onClose={() => setForm(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
