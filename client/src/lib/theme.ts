import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'elim.theme';

function systemPrefersDark(): boolean {
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyDom(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#071624' : '#0A2540');
  return dark;
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem(STORAGE_KEY) as ThemePref) || 'system');

  useEffect(() => { applyDom(pref); }, [pref]);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if ((localStorage.getItem(STORAGE_KEY) || 'system') === 'system') applyDom('system'); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next: ThemePref) => {
    setPref(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private browsing */ }
  }, []);

  const toggle = useCallback(() => {
    const dark = document.documentElement.classList.contains('dark');
    setTheme(dark ? 'light' : 'dark');
  }, [setTheme]);

  return { pref, setTheme, toggle };
}
