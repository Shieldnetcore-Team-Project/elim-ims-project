import type { ProfitLossPoint } from '@shared/types';
import { useChartTheme } from './useChartTheme';

const W = 560, H = 220, PAD_L = 52, PAD_B = 26, PAD_T = 12, PAD_R = 8;
const IW = W - PAD_L - PAD_R, IH = H - PAD_T - PAD_B;

export function ProfitLossChart({ data }: { data: ProfitLossPoint[] }) {
  const { ok, wait, stop, grid, axis } = useChartTheme();

  const vals = data.map(d => d.value);
  const min = Math.min(0, ...vals) * 1.04;
  const max = Math.max(0, ...vals) * 1.08 || 1;
  // Evenly-spaced x-axis label indices (always including the first and last point) so wide
  // windows don't crowd two labels together at the tail end.
  const numLabels = Math.min(8, data.length);
  const shownIdx = new Set(Array.from({ length: numLabels }, (_, k) => Math.round((k / (numLabels - 1 || 1)) * (data.length - 1))));
  const x = (i: number) => PAD_L + (i / (data.length - 1)) * IW;
  const y = (v: number) => PAD_T + IH - ((v - min) / (max - min)) * IH;
  const y0 = y(0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => min + t * (max - min));
  const line = data.map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(d.value).toFixed(1)).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${y0} L${PAD_L},${y0} Z`;
  const net = data.reduce((s, d) => s + d.value, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', flex: '1 1 auto', minHeight: 0 }} role="img"
        aria-label={`Profit and loss over the selected period. Net ₦${net.toLocaleString('en-NG')}.`}
      >
        <defs>
          <linearGradient id="plGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ok} stopOpacity=".5" />
            <stop offset="60%" stopColor={wait} stopOpacity=".28" />
            <stop offset="100%" stopColor={stop} stopOpacity=".4" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={y(t)} x2={W - PAD_R} y2={y(t)} stroke={grid} strokeWidth=".5" strokeDasharray="3 3" />
            <text x={PAD_L - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={axis} fontFamily="Inter">₦{(t / 1000).toFixed(0)}k</text>
          </g>
        ))}
        <line x1={PAD_L} y1={y0} x2={W - PAD_R} y2={y0} stroke={axis} strokeWidth=".5" opacity=".4" />
        <path d={area} fill="url(#plGradient)" />
        <path d={line} fill="none" stroke={ok} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={d.day} cx={x(i)} cy={y(d.value)} r="9" fill="transparent">
            <title>{d.day}: ₦{d.value.toLocaleString('en-NG')}</title>
          </circle>
        ))}
        {data.map((d, i) => shownIdx.has(i) && (
          <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill={axis} fontFamily="Inter">{d.day}</text>
        ))}
      </svg>
      <table className="sr print-only">
        <caption>Profit and loss over the selected period</caption>
        <thead><tr><th>Day</th><th>Value</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.day}><td>{d.day}</td><td>₦{d.value.toLocaleString('en-NG')}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
