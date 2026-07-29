import { useChartTheme } from './useChartTheme';

export interface DonutSlice { label: string; value: number; tone: 'ok' | 'wait' | 'stop' }

const SIZE = 200, R = 70, STROKE = 26;
const C = 2 * Math.PI * R;

export function DonutChart({ data }: { data: DonutSlice[] }) {
  const theme = useChartTheme();
  const colorOf = (tone: DonutSlice['tone']) => theme[tone];
  const total = data.reduce((s, d) => s + d.value, 0);
  const cx = SIZE / 2, cy = SIZE / 2;
  const headline = data[0];

  let offset = 0;
  const segments = data.map(d => {
    const frac = total > 0 ? d.value / total : 0;
    const len = frac * C;
    const seg = { ...d, len, dashoffset: -offset, pct: Math.round(frac * 100) };
    offset += len;
    return seg;
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
      <svg
        width={180} height={180} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img"
        aria-label={`Stock status: ${data.map(d => `${d.label} ${total > 0 ? Math.round((d.value / total) * 100) : 0}%`).join(', ')}.`}
      >
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgb(var(--line))" strokeWidth={STROKE} />
          {total > 0 && segments.map(s => (
            <circle
              key={s.label} cx={cx} cy={cy} r={R} fill="none" stroke={colorOf(s.tone)} strokeWidth={STROKE}
              strokeDasharray={`${s.len} ${C - s.len}`} strokeDashoffset={s.dashoffset} strokeLinecap="butt"
            >
              <title>{s.label}: {s.pct}%</title>
            </circle>
          ))}
        </g>
        <text x={cx} y={cy - 3} textAnchor="middle" fontSize="28" fontWeight="700" fill="rgb(var(--ink-900))" fontFamily="'IBM Plex Mono'">
          {total > 0 ? `${Math.round((headline.value / total) * 100)}%` : '—'}
        </text>
        <text x={cx} y={cy + 17} textAnchor="middle" fontSize="10" fill="rgb(var(--muted))" fontFamily="Inter">{headline.label}</text>
      </svg>
      <div style={{ display: 'grid', gap: 10, flex: 1, minWidth: 140 }}>
        {segments.map(s => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: colorOf(s.tone), flexShrink: 0 }} />
            <span style={{ flex: 1, color: 'rgb(var(--ink-700))' }}>{s.label}</span>
            <span className="tnum" style={{ fontWeight: 600 }}>{s.pct}%</span>
          </div>
        ))}
      </div>
      <table className="sr print-only">
        <caption>Stock status</caption>
        <thead><tr><th>Status</th><th>Count</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.label}><td>{d.label}</td><td>{d.value}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
