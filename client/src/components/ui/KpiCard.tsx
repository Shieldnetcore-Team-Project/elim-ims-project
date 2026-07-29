import type { KpiMetric } from '@shared/types';
import { Icon } from './Icon';

export function KpiCard({ kpi }: { kpi: KpiMetric }) {
  const hasDelta = typeof kpi.delta === 'number';
  const up = (kpi.delta ?? 0) >= 0;
  return (
    <article className="kpi">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="kpi-tile"><Icon name={kpi.icon} /></span>
        <p className="kpi-label">{kpi.label}</p>
      </div>
      <p className="kpi-value">{kpi.value}</p>
      {hasDelta && (
        <p className={`kpi-delta ${kpi.good ? 'up' : 'down'}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d={up ? 'm7 17 10-10M7 7h10v10' : 'm7 7 10 10M17 7v10H7'} />
          </svg>
          <span style={{ fontWeight: 600 }} className="tnum">{up ? '+' : ''}{kpi.delta!.toFixed(1)}%</span>
          <span style={{ color: 'rgb(var(--muted))', fontWeight: 400 }}>vs last week</span>
        </p>
      )}
    </article>
  );
}

export function KpiRow({ kpis }: { kpis: KpiMetric[] }) {
  return (
    <div className="kpis">
      {kpis.map(k => <KpiCard key={k.key} kpi={k} />)}
    </div>
  );
}
