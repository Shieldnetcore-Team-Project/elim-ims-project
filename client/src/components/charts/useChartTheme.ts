import { useEffect, useState } from 'react';

/** Re-renders whenever the theme class or viewport changes, so charts read fresh CSS variables
 *  instead of carrying a second colour palette that could drift out of step with the design system. */
export function useChartTheme() {
  const [, force] = useState(0);

  useEffect(() => {
    const tick = () => force(x => x + 1);
    const observer = new MutationObserver(tick);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', tick);
    return () => { observer.disconnect(); window.removeEventListener('resize', tick); };
  }, []);

  const cssVar = (name: string) => `rgb(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()})`;
  return {
    chart1: cssVar('--chart-1'), chart2: cssVar('--chart-2'), chart3: cssVar('--chart-3'),
    grid: cssVar('--line'), axis: cssVar('--muted'),
    ok: cssVar('--ok'), wait: cssVar('--wait'), stop: cssVar('--stop'),
  };
}
