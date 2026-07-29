import type { ProductVolume } from '@shared/types';
import { useChartTheme } from './useChartTheme';

const W = 560, H = 220, LEFT = 118, RIGHT = 12, TOP = 8;

export function ComparisonChart({ data }: { data: ProductVolume[] }) {
  const { chart1, axis } = useChartTheme();
  const innerWidth = W - LEFT - RIGHT;
  const rowHeight = (H - TOP) / data.length;
  const max = Math.max(...data.map(d => d.value));
  const leader = data[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', flex: '1 1 auto', minHeight: 0 }} role="img"
        aria-label={`Units filled this week by product. ${leader.label} leads at ${leader.value.toLocaleString('en-NG')} units.`}
      >
        {data.map((d, i) => {
          const w = (d.value / max) * innerWidth;
          const cy = TOP + i * rowHeight + rowHeight / 2;
          return (
            <g key={d.label}>
              <text x={LEFT - 10} y={cy + 4} textAnchor="end" fontSize="11" fill={axis} fontFamily="Inter">{d.label}</text>
              <rect x={LEFT} y={cy - 11} width={w} height="22" rx="4" fill={chart1}><title>{d.label}: {d.value.toLocaleString('en-NG')} units</title></rect>
              <text x={LEFT + w + 8} y={cy + 4} fontSize="11" fill={axis} fontFamily="IBM Plex Mono">{(d.value / 1000).toFixed(1)}k</text>
            </g>
          );
        })}
      </svg>
      <table className="sr print-only">
        <caption>Units filled this week, by product</caption>
        <thead><tr><th>Product</th><th>Units</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.label}><td>{d.label}</td><td>{d.value.toLocaleString('en-NG')}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
