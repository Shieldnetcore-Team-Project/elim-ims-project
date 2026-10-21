import { Link, useRouterState } from "@tanstack/react-router";
import { navItemByTitle, type NavTab } from "@/lib/nav";
import { pageIdFor, usePageAccess } from "@/lib/page-access";

// Tab bar shared by the pages grouped under one sidebar entry (Retail,
// Production, Warehouse). Each tab is its own route; the list comes from the
// entry's `tabs` in src/lib/nav.ts, so adding a tab there shows it here too.
// Rendered outside RequireAccess, so someone who can only open one of the
// tabs still has a way across to it.
//
// `section` is the entry used when the page is opened directly (typed URL,
// refresh without state). A page that sits under several entries (Orders is
// in Retail and Warehouse) shows the bar of whichever entry the user followed
// to get here -- see the HistoryState note in nav.ts.
export function SectionTabs({ section }: { section: string }) {
  const { pathname, search, from } = useRouterState({
    select: (s) => ({
      pathname: s.location.pathname,
      search: s.location.search as Record<string, unknown>,
      from: s.location.state?.section,
    }),
  });
  const { canPage, loading } = usePageAccess();

  // Opened from another entry that also lists this page (its own url or a
  // tab), that entry decides: Customers opened from Directory shows no bar,
  // opened from Warehouse shows Warehouse's.
  const fromItem = from ? navItemByTitle(from) : undefined;
  const fromOwns =
    !!fromItem &&
    (fromItem.url === pathname || (fromItem.tabs ?? []).some((t) => t.url === pathname));
  const title = fromOwns ? from! : section;
  const item = navItemByTitle(title);
  const all = item?.tabs ?? [];
  // Each tab is a page of its own (Admin Panel → Users → Page access).
  const tabs = all.filter(
    (t): t is NavTab & { url: string } =>
      !!t.url &&
      t.inBar !== false &&
      !!item &&
      canPage({ id: pageIdFor(item, t), module: t.module }),
  );
  if (loading || tabs.length < 2) return null;

  const matchesSearch = (t: NavTab) =>
    Object.entries(t.search ?? {}).every(([k, v]) => String(search[k] ?? "") === v);
  // Tabs that share a route (Marketer stock / Reconciliation) are told apart
  // by their search params; the one without any is the route's default.
  const isActive = (t: NavTab & { url: string }) => {
    if (t.url !== pathname) return false;
    if (t.search) return matchesSearch(t);
    return !all.some((o) => o !== t && o.url === pathname && o.search && matchesSearch(o));
  };

  return (
    <div className="mb-6 flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => {
        const active = isActive(t);
        return (
          <Link
            key={`${t.url}?${new URLSearchParams(t.search).toString()}`}
            to={t.url}
            search={(t.search ?? {}) as never}
            state={{ section: title }}
            className={`whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              active
                ? "text-foreground border-primary"
                : "text-muted-foreground border-transparent hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
