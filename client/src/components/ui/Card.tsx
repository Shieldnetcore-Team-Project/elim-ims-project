import type { ReactNode } from 'react';

export function Card({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">{title}</h2>
          {description && <p className="card-desc">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
