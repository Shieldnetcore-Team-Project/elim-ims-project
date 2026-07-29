import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useUi } from '../../lib/uiState';

export function ExportMenu({ onCsv, rowCount }: { onCsv: () => void; rowCount: number }) {
  const [open, setOpen] = useState(false);
  const ui = useUi();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  return (
    <div style={{ position: 'relative' }} ref={ref} className="no-print">
      <button className="btn btn-secondary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon name="download" size={14} />
        Export
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => { onCsv(); setOpen(false); }}>
            <Icon name="table" size={16} className="muted-icon" />
            <span><span style={{ display: 'block', fontSize: 13 }}>CSV</span><span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>For spreadsheets and imports</span></span>
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); ui.toast('Excel export uses SheetJS, loaded on demand in a future build.'); }}>
            <Icon name="file" size={16} className="muted-icon" />
            <span><span style={{ display: 'block', fontSize: 13 }}>Excel</span><span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>Formatted .xlsx workbook</span></span>
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); ui.toast('PDF export uses pdfmake, loaded on demand in a future build.'); }}>
            <Icon name="file" size={16} className="muted-icon" />
            <span><span style={{ display: 'block', fontSize: 13 }}>PDF</span><span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>For sending and filing</span></span>
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); window.print(); }}>
            <Icon name="print" size={16} className="muted-icon" />
            <span><span style={{ display: 'block', fontSize: 13 }}>Print</span><span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>Ctrl+P</span></span>
          </button>
          <p style={{ borderTop: '1px solid rgb(var(--line))', padding: '6px 10px', fontSize: 11, color: 'rgb(var(--muted))' }}>
            {rowCount.toLocaleString('en-NG')} rows will be exported
          </p>
        </div>
      )}
    </div>
  );
}
