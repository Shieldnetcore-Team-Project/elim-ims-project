import type { FormEvent, ReactNode } from 'react';
import { Icon } from './Icon';

export function Modal({ title, onClose, onSubmit, submitLabel, saving, error, children, wide }: {
  title: string;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  submitLabel: string;
  saving: boolean;
  error?: string | null;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: wide ? 720 : 560 }}>
        <div className="dialog-head">
          <h2 className="card-title">{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={onSubmit}>
          <div style={{ padding: 20, maxHeight: '65vh', overflowY: 'auto' }}>
            {error && <p style={{ color: 'rgb(var(--stop))', fontSize: 13, marginBottom: 12 }}>{error}</p>}
            {children}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
