import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTheme, type ThemePref } from './theme';

interface Toast { id: number; message: string }

const RAIL_COLLAPSED_KEY = 'elim.railCollapsed';

interface UiState {
  themePref: ThemePref;
  setTheme(pref: ThemePref): void;
  toggleTheme(): void;

  paletteOpen: boolean; openPalette(): void; closePalette(): void;
  helpOpen: boolean; openHelp(): void; closeHelp(): void;
  drawerOpen: boolean; openDrawer(): void; closeDrawer(): void;
  railCollapsed: boolean; toggleRailCollapsed(): void;
  closeAll(): void;

  registerExport(fn: (() => void) | null): void;
  runExport(): void;
  registerSearchFocus(fn: (() => void) | null): void;
  focusSearch(): void;

  toasts: Toast[];
  toast(message: string): void;
}

const Ctx = createContext<UiState | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const exportRef = useRef<(() => void) | null>(null);
  const searchRef = useRef<(() => void) | null>(null);
  const toastSeq = useRef(0);

  const closeAll = useCallback(() => { setPaletteOpen(false); setHelpOpen(false); setDrawerOpen(false); }, []);

  const toggleRailCollapsed = useCallback(() => {
    setRailCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* private browsing */ }
      return next;
    });
  }, []);

  const toast = useCallback((message: string) => {
    const id = ++toastSeq.current;
    setToasts(t => [...t, { id, message }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3600);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

      // Cmd/Ctrl+K works even inside a field — it's how you leave one.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); return; }
      if (e.key === 'Escape') { closeAll(); return; }
      if (typing) return; // a store keeper typing "Ngozi" must not trigger whatever is bound to 'n'

      if (e.key === '/') { e.preventDefault(); searchRef.current?.(); }
      if (e.key === '?') { e.preventDefault(); setHelpOpen(true); }
      if (e.key.toLowerCase() === 'e') { e.preventDefault(); exportRef.current?.(); }
      if (e.key.toLowerCase() === 't') { e.preventDefault(); theme.toggle(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeAll, theme]);

  const value: UiState = {
    themePref: theme.pref, setTheme: theme.setTheme, toggleTheme: theme.toggle,
    paletteOpen, openPalette: () => setPaletteOpen(true), closePalette: () => setPaletteOpen(false),
    helpOpen, openHelp: () => setHelpOpen(true), closeHelp: () => setHelpOpen(false),
    drawerOpen, openDrawer: () => setDrawerOpen(true), closeDrawer: () => setDrawerOpen(false),
    railCollapsed, toggleRailCollapsed,
    closeAll,
    registerExport: (fn) => { exportRef.current = fn; },
    runExport: () => exportRef.current?.(),
    registerSearchFocus: (fn) => { searchRef.current = fn; },
    focusSearch: () => searchRef.current?.(),
    toasts, toast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): UiState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useUi must be used within <UiProvider>');
  return ctx;
}

/** Pages call this so the global `e` shortcut and export button export *their* current rows. */
export function useRegisterExport(fn: (() => void) | null) {
  const ui = useUi();
  useEffect(() => {
    ui.registerExport(fn);
    return () => ui.registerExport(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);
}

/** Pages call this so the global `/` shortcut focuses *their* search field. */
export function useRegisterSearchFocus(fn: (() => void) | null) {
  const ui = useUi();
  useEffect(() => {
    ui.registerSearchFocus(fn);
    return () => ui.registerSearchFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);
}
