import { useEffect, useState } from 'react';
import { exportCsv, type CsvColumn } from '../../lib/csv';
import { presetRange, toExcelXML, downloadText, setPrintOrientation, type DateRangePreset, type DateRange } from '../../lib/reportExport';
import { Icon } from './Icon';

const PRESETS: { key: DateRangePreset; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'DAILY', label: 'Daily' },
  { key: 'WEEKLY', label: 'Weekly' },
  { key: 'MONTHLY', label: 'Monthly' },
  { key: 'QUARTERLY', label: 'Quarterly' },
  { key: 'YEARLY', label: 'Yearly' },
  { key: 'CUSTOM', label: 'Custom' },
];

/** Owns the preset/custom-date and orientation state and reports the resolved
 *  {from,to} window back to the page — the page alone knows which date field
 *  of its own rows to filter by. Export buttons act on the page's already-
 *  filtered rows, passed in as `rows`. */
export function ReportToolbar<T>({ rows, columns, filenameBase, onRangeChange }: {
  rows: T[];
  columns: CsvColumn<T>[];
  filenameBase: string;
  onRangeChange: (range: DateRange | null) => void;
}) {
  const [preset, setPreset] = useState<DateRangePreset>('ALL');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');

  useEffect(() => { setPrintOrientation(orientation); }, [orientation]);
  useEffect(() => {
    onRangeChange(presetRange(preset, customFrom || undefined, customTo || undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo]);

  return (
    <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {PRESETS.map(p => (
          <button
            key={p.key}
            type="button"
            className={`btn btn-sm ${preset === p.key ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'CUSTOM' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="date" aria-label="From date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
          <span className="sub">to</span>
          <input type="date" aria-label="To date" value={customTo} onChange={e => setCustomTo(e.target.value)} />
        </div>
      )}
      <select aria-label="Print orientation" value={orientation} onChange={e => setOrientation(e.target.value as 'portrait' | 'landscape')}>
        <option value="portrait">A4 Portrait</option>
        <option value="landscape">A4 Landscape</option>
      </select>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>
          <Icon name="print" size={14} /> PDF
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => exportCsv(`${filenameBase}.csv`, columns, rows)}>
          <Icon name="table" size={14} /> CSV
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => downloadText(toExcelXML(rows, columns), `${filenameBase}.xls`, 'application/vnd.ms-excel')}
        >
          <Icon name="file" size={14} /> Excel
        </button>
      </div>
    </div>
  );
}
