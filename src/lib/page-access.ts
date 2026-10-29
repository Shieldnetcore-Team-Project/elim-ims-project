import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { nav, type NavItem, type NavTab } from "@/lib/nav";
import { usePermissions, type ModuleKey } from "@/lib/permissions";

// Pages, one by one. Every sidebar entry without tabs is a page; an entry with
// tabs is a group, and each of its tabs is a page. A page's id is its place in
// the menu ("Production › Products Report"), so the same route listed under
// two entries (Store requests under Production, Store and Warehouse) is ticked
// for each entry on its own. user_page_access
// (supabase/migrations/20261021140000_user_page_access.sql) holds the admin's
// decision per user and page; with no decision the page follows the module,
// as it always has.

export type Page = {
  id: string;
  section: string;
  entry: string;
  label: string;
  module: ModuleKey;
  url?: string;
  search?: Record<string, string>;
};

export const pageIdFor = (item: NavItem, tab?: NavTab) =>
  tab ? `${item.title} › ${tab.label}` : item.title;

export const PAGES: Page[] = nav.flatMap((group) =>
  group.items.flatMap((item): Page[] =>
    item.tabs
      ? item.tabs.map((t) => ({
          id: pageIdFor(item, t),
          section: group.section,
          entry: item.title,
          label: t.label,
          module: t.module,
          url: t.url,
          search: t.search,
        }))
      : item.modules
        ? item.modules.map((m) => ({
            id: `${item.title} › ${m}`,
            section: group.section,
            entry: item.title,
            label: m,
            module: m,
            url: item.url,
          }))
        : [
            {
              id: pageIdFor(item),
              section: group.section,
              entry: item.title,
              label: item.title,
              module: item.module,
              url: item.url,
            },
          ],
  ),
);

// The pages under one sidebar entry (one page for an entry without tabs).
export const pagesOfEntry = (title: string) => PAGES.filter((p) => p.entry === title);

// What a new account starts with: only its department's page(s), every other
// page blocked, until an admin grants more in Page access. The department
// decides; when it matches none, the role does; when neither matches (or the
// account is an Admin / Chairman) there is no default and the role's pages
// show as before. Applied once, right after the account is created or
// approved (apply_default_page_access,
// supabase/migrations/20261022120000_new_user_department_pages.sql).
const SALES_PAGES = ["Retail › POS"];
const INVENTORY_PAGES = ["Warehouse › Stock", "Store › Raw Materials"];
const FINANCE_PAGES = ["Finance Overview"];
const PRODUCTION_PAGES = ["Production › Production"];
const QC_PAGES = ["Quality Control › Inspections"];

const DEPARTMENT_PAGES: [RegExp, () => string[]][] = [
  [/^sales/, () => SALES_PAGES],
  [/inventory|store|warehouse/, () => INVENTORY_PAGES],
  [/financ|account/, () => FINANCE_PAGES],
  [/production|water/, () => PRODUCTION_PAGES],
  [/quality|^qc$/, () => QC_PAGES],
  [/^admin/, () => pagesOfEntry("Admin Panel").map((p) => p.id)],
];

const ROLE_PAGES: Record<string, string[]> = {
  sales: SALES_PAGES,
  inventory_officer: INVENTORY_PAGES,
  store_officer: ["Store › Raw Materials"],
  store_keeper: ["Store › Raw Materials"],
  store_warehouse: ["Store › Raw Materials"],
  warehouse_manager: ["Warehouse › Stock"],
  accountant: FINANCE_PAGES,
  production: PRODUCTION_PAGES,
  qc_officer: QC_PAGES,
};

export type DefaultPageAccess = { granted: string[]; blocked: string[]; viewModules: ModuleKey[] };

export function defaultPageAccess(
  department: string | null | undefined,
  role: string,
): DefaultPageAccess | null {
  if (role === "super_admin" || role === "chairman") return null;
  const dept = (department ?? "").trim().toLowerCase();
  const ids = (dept && DEPARTMENT_PAGES.find(([re]) => re.test(dept))?.[1]()) || ROLE_PAGES[role];
  if (!ids) return null;
  const granted = PAGES.filter((p) => ids.includes(p.id));
  return {
    granted: granted.map((p) => p.id),
    blocked: PAGES.filter((p) => !ids.includes(p.id)).map((p) => p.id),
    viewModules: [...new Set(granted.map((p) => p.module))],
  };
}

// Sets that default on a just-created / just-approved account, as the signed-in
// admin (the browser client, or the caller's client in a server function).
export async function applyDefaultPageAccess(
  client: SupabaseClient<Database>,
  userId: string,
  department: string | null | undefined,
  role: string,
): Promise<void> {
  const d = defaultPageAccess(department, role);
  if (!d) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
  const { error } = await (client as any).rpc("apply_default_page_access", {
    target_id: userId,
    p_granted: d.granted,
    p_blocked: d.blocked,
    p_view_modules: d.viewModules,
  });
  if (error) throw new Error(error.message);
}

// Where an entry's sidebar link goes: its own url when that page is allowed,
// otherwise the first of its pages (with a route of its own) that is.
export function entryUrl(item: NavItem, canPage: (p: Page) => boolean): string {
  const pages = pagesOfEntry(item.title).filter((p) => p.url && !p.search);
  const own = pages.find((p) => p.url === item.url);
  if (!own || canPage(own)) return item.url;
  return pages.find(canPage)?.url ?? item.url;
}

// The signed-in user's page decisions: page id → granted.
export function useMyPageAccess() {
  return useQuery({
    queryKey: ["my-page-access"],
    queryFn: async (): Promise<Map<string, boolean>> => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return new Map();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table newer than the generated types
      const { data, error } = await (supabase as any)
        .from("user_page_access")
        .select("page_id,granted")
        .eq("user_id", userData.user.id);
      if (error) throw error;
      return new Map(
        ((data ?? []) as { page_id: string; granted: boolean }[]).map((r) => [
          r.page_id,
          r.granted,
        ]),
      );
    },
    staleTime: 60_000,
  });
}

// Whether a page shows for a user, given their decisions and module rights.
// Hidden when the admin unticked it; otherwise it needs its module's view
// (ticking a page grants that too, so its data loads).
export function pageAllowed(
  decisions: Map<string, boolean> | undefined,
  page: Pick<Page, "id" | "module">,
  canView: (m: ModuleKey) => boolean,
): boolean {
  const d = decisions?.get(page.id);
  if (d === false) return false;
  return canView(page.module);
}

// Whether an address can be opened. A route the menu lists opens when ANY
// menu page for it is allowed (the same route may sit under several entries);
// routes the menu does not list follow their module, as before.
export function openAllowed(
  pathname: string,
  search: Record<string, unknown>,
  canPage: (p: Page) => boolean,
): boolean {
  const matching = PAGES.filter(
    (p) =>
      p.url === pathname &&
      Object.entries(p.search ?? {}).every(([k, v]) => String(search[k] ?? "") === v),
  );
  // A menu page tied to a tab (/preform-production?tab=issues) decides for
  // that tab; otherwise the page listed without one decides.
  const specific = matching.filter((p) => p.search);
  const relevant = specific.length > 0 ? specific : matching;
  return relevant.length === 0 || relevant.some(canPage);
}

export function usePageAccess() {
  const perms = usePermissions();
  const decisions = useMyPageAccess();
  const canView = (m: ModuleKey) => perms.can(m, "view");
  const canPage = (page: Pick<Page, "id" | "module">) => pageAllowed(decisions.data, page, canView);
  const canEntry = (title: string) => pagesOfEntry(title).some(canPage);
  const canOpen = (pathname: string, search: Record<string, unknown>) =>
    openAllowed(pathname, search, canPage);
  return {
    loading: perms.loading || decisions.isLoading,
    decisions: decisions.data,
    canPage,
    canEntry,
    canOpen,
  };
}
