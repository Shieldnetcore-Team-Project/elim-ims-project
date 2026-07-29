import { Icon } from './Icon';

export function EmptyState({ title, description, onClear }: { title: string; description: string; onClear: () => void }) {
  return (
    <div className="empty">
      <span className="ring"><Icon name="box" size={20} /></span>
      <h3 className="card-title" style={{ marginTop: 16 }}>{title}</h3>
      <p className="sub" style={{ marginTop: 6, maxWidth: 320 }}>{description}</p>
      <button className="btn btn-secondary btn-sm" style={{ marginTop: 20 }} onClick={onClear}>Clear filters</button>
    </div>
  );
}
