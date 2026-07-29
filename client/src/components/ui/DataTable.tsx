import type { ModuleColumn, ModuleRow } from '@shared/types';
import { formatModuleNumber } from '../../lib/format';
import { Pill } from './Pill';
import { DeleteButton } from './DeleteButton';

function fieldValue(row: ModuleRow, key: string): string | number {
  if (key === 'id') return row.id;
  if (key === 'status') return row.status;
  return row.fields[key] ?? '';
}

function Cell({ row, col }: { row: ModuleRow; col: ModuleColumn }) {
  const value = fieldValue(row, col.key);
  switch (col.kind) {
    case 'status':
      return <Pill status={String(value)} />;
    case 'num':
      return <span className="tnum">{formatModuleNumber(col.key, Number(value))}</span>;
    case 'mono':
      return <span className="mono" style={{ color: 'rgb(var(--aqua-700))', fontSize: 12 }}>{value}</span>;
    case 'sub':
      return <span className="sub">{value}</span>;
    case 'text':
    default: {
      const sub = col.subKey ? fieldValue(row, col.subKey) : null;
      return (
        <>
          <p style={{ fontWeight: 500, color: 'rgb(var(--ink-900))' }}>{value}</p>
          {sub != null && sub !== '' && <p className="sub" style={{ marginTop: 4 }}>{sub}</p>}
        </>
      );
    }
  }
}

export function DataTable({ columns, rows, onRowClick, deleteEntityType, pendingDeletionIds, onDeleteRequested }: {
  columns: ModuleColumn[];
  rows: ModuleRow[];
  onRowClick?: (row: ModuleRow) => void;
  /** Set to the module key to add a delete column — wired up once here for all 9 generic modules. */
  deleteEntityType?: string;
  pendingDeletionIds?: Set<string>;
  onDeleteRequested?: () => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          {columns.map(c => <th key={c.key} className={c.kind === 'num' ? 'num' : undefined}>{c.label}</th>)}
          {deleteEntityType && <th className="no-print" />}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr
            key={row.id}
            className={onRowClick ? 'row-clickable' : undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map(c => <td key={c.key} className={c.kind === 'num' ? 'num' : undefined}><Cell row={row} col={c} /></td>)}
            {deleteEntityType && (
              <td className="no-print">
                <DeleteButton
                  entityType={deleteEntityType} entityId={row.id} entityLabel={row.id}
                  pending={pendingDeletionIds?.has(row.id)} onRequested={() => onDeleteRequested?.()}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
