import type { SalesOverviewPoint } from '@shared/types';
import { useChartTheme } from './useChartTheme';

const W = 560, H = 220, PAD_L = 52, PAD_B = 26, PAD_T = 12, PAD_R = 8;
const IW = W - PAD_L - PAD_R, IH = H - PAD_T - PAD_B;

export function SalesOverviewChart({ data }: { data: SalesOverviewPoint[] }) {
  const { chart1, chart3, grid, axis } = useChartTheme();

  const vals = data.flatMap(d => [d.sales, d.profit]);
  const min = Math.min(0, ...vals);
  const max = Math.max(...vals, 1) * 1.08;
  const slot = IW / data.length;
  const barW = slot * 0.5;
  const x = (i: number) => PAD_L + i * slot + slot / 2;
  const y = (v: number) => PAD_T + IH - ((v - min) / (max - min)) * IH;
  const y0 = y(0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => min + t * (max - min));
  const linePath = data.map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(d.profit).toFixed(1)).join(' ');
  const totalSales = data.reduce((s, d) => s + d.sales, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', flex: '1 1 auto', minHeight: 0 }} role="img"
        aria-label={`Daily sales against profit trend, last seven days. Total sales ₦${totalSales.toLocaleString('en-NG')}.`}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={y(t)} x2={W - PAD_R} y2={y(t)} stroke={grid} strokeWidth=".5" strokeDasharray="3 3" />
            <text x={PAD_L - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={axis} fontFamily="Inter">₦{(t / 1000).toFixed(0)}k</text>
          </g>
        ))}
        {data.map((d, i) => (
          <rect
            key={d.day} x={x(i) - barW / 2} y={y(Math.max(0, d.sales))} width={barW}
            height={Math.abs(y0 - y(d.sales))} rx="3" fill={chart1} opacity=".85"
          >
            <title>{d.day}: ₦{d.sales.toLocaleString('en-NG')} sales</title>
          </rect>
        ))}
        <path d={linePath} fill="none" stroke={chart3} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={d.day} cx={x(i)} cy={y(d.profit)} r="3.5" fill={chart3}>
            <title>{d.day}: ₦{d.profit.toLocaleString('en-NG')} profit</title>
          </circle>
        ))}
        {data.map((d, i) => (
          <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill={axis} fontFamily="Inter">{d.day}</text>
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 11, color: 'rgb(var(--muted))', flexShrink: 0 }} className="no-print">
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 8, height: 8, borderRadius: 2, background: chart1, display: 'inline-block' }} /> Daily sales
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 8, height: 8, borderRadius: 999, background: chart3, display: 'inline-block' }} /> Profit trend
        </span>
      </div>
      <table className="sr print-only">
        <caption>Daily sales and profit, last seven days</caption>
        <thead><tr><th>Day</th><th>Sales</th><th>Profit</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.day}><td>{d.day}</td><td>₦{d.sales.toLocaleString('en-NG')}</td><td>₦{d.profit.toLocaleString('en-NG')}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
