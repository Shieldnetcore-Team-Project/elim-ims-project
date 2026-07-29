import type { TrendPoint } from '@shared/types';
import { useChartTheme } from './useChartTheme';

const W = 560, H = 220, PAD_L = 46, PAD_B = 26, PAD_T = 12, PAD_R = 8;
const IW = W - PAD_L - PAD_R, IH = H - PAD_T - PAD_B;

export function TrendChart({ data }: { data: TrendPoint[] }) {
  const { chart1, grid, axis } = useChartTheme();

  const vals = data.map(d => d.units);
  const min = Math.min(...vals) * 0.92;
  const max = Math.max(...vals) * 1.04;
  const x = (i: number) => PAD_L + (i / (data.length - 1)) * IW;
  const y = (v: number) => PAD_T + IH - ((v - min) / (max - min)) * IH;
  const line = data.map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(d.units).toFixed(1)).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${PAD_T + IH} L${PAD_L},${PAD_T + IH} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => min + t * (max - min));
  const first = data[0], last = data[data.length - 1];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', flex: '1 1 auto', minHeight: 0 }} role="img"
        aria-label={`Units filled per day, rising from ${Math.round(first.units / 1000)} thousand on ${first.day} to ${Math.round(last.units / 1000)} thousand on ${last.day}`}
      >
        <defs>
          <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={chart1} stopOpacity=".22" />
            <stop offset="100%" stopColor={chart1} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={y(t)} x2={W - PAD_R} y2={y(t)} stroke={grid} strokeWidth=".5" strokeDasharray="3 3" />
            <text x={PAD_L - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={axis} fontFamily="Inter">{Math.round(t / 1000)}k</text>
          </g>
        ))}
        <path d={area} fill="url(#trendGradient)" />
        <path d={line} fill="none" stroke={chart1} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={d.day} cx={x(i)} cy={y(d.units)} r="9" fill="transparent"><title>{d.day}: {d.units.toLocaleString('en-NG')} units</title></circle>
        ))}
        {data.map((d, i) => (
          <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill={axis} fontFamily="Inter">{d.day}</text>
        ))}
      </svg>
      {/* Visually hidden on screen, revealed on print — a chart is a blur on a fax. */}
      <table className="sr print-only">
        <caption>Units filled per day</caption>
        <thead><tr><th>Day</th><th>Units</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.day}><td>{d.day}</td><td>{d.units.toLocaleString('en-NG')}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
