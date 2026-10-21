import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MODULE_LABELS, type ModuleKey } from "@/lib/permissions";
import { PAGES, pageAllowed, type Page } from "@/lib/page-access";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RotateCcw, ShieldCheck } from "lucide-react";

// One tick box per page, each on its own. A page is a sidebar entry, or one
// tab of an entry that has tabs (src/lib/page-access.ts). The admin's decision
// is kept per user and page in user_page_access
// (supabase/migrations/20261021140000_user_page_access.sql):
//   tick     the page shows. If its module's view isn't allowed yet it is
//            granted (so the page can load its data), and the module's other
//            pages that weren't showing are kept hidden -- ticking Production
//            gives Production, not Products Report too.
//   untick   the page is hidden, and nothing else changes. The module's rights
//            stay: other pages and forms may still need to read its data.
//   reset    back to what the role gives.
// "Can work" is the module's create / edit / submit, so it is shared by the
// pages on that module; the row says which.

const WORK_ACTIONS = ["create", "edit", "submit"] as const;
const PAGE_ACTIONS = ["view", ...WORK_ACTIONS];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user_page_access is newer than the generated types
const db = supabase as any;

type Entry = { title: string; pages: Page[] };

function buildSections(): { section: string; entries: Entry[] }[] {
  const out: { section: string; entries: Entry[] }[] = [];
  for (const p of PAGES) {
    let s = out.find((x) => x.section === p.section);
    if (!s) out.push((s = { section: p.section, entries: [] }));
    let e = s.entries.find((x) => x.title === p.entry);
    if (!e) s.entries.push((e = { title: p.entry, pages: [] }));
    e.pages.push(p);
  }
  return out;
}

const pageLabel = (p: Page) =>
  MODULE_LABELS[p.label as ModuleKey] && p.label === p.module ? MODULE_LABELS[p.module] : p.label;

export function UserPageAccess({ userId, canEdit }: { userId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const sections = useMemo(buildSections, []);

  const userRoles = useQuery({
    queryKey: ["user-roles-for-page-access", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId);
      if (error) throw error;
      return (data ?? []).map((r) => r.role as string);
    },
  });

  const roleGrants = useQuery({
    queryKey: ["role-page-grants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("role,module,action")
        .in("action", PAGE_ACTIONS);
      if (error) throw error;
      return new Set((data ?? []).map((r) => `${r.role}:${r.module}:${r.action}`));
    },
  });

  const overrides = useQuery({
    queryKey: ["page-access-overrides", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("permission_overrides")
        .select("module,action,granted")
        .eq("user_id", userId)
        .in("action", PAGE_ACTIONS);
      if (error) throw error;
      return new Map((data ?? []).map((o) => [`${o.module}:${o.action}`, o.granted as boolean]));
    },
  });

  const decisions = useQuery({
    queryKey: ["page-access-decisions", userId],
    queryFn: async () => {
      const { data, error } = await db
        .from("user_page_access")
        .select("page_id,granted")
        .eq("user_id", userId);
      if (error) throw error;
      return new Map(
        ((data ?? []) as { page_id: string; granted: boolean }[]).map((r) => [
          r.page_id,
          r.granted,
        ]),
      );
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["page-access-overrides", userId] });
    qc.invalidateQueries({ queryKey: ["page-access-decisions", userId] });
    qc.invalidateQueries({ queryKey: ["permission-overrides-for-user", userId] });
    qc.invalidateQueries({ queryKey: ["permission-overrides-list"] });
    // The edited user's own session re-reads these; refreshing here keeps the
    // admin's view honest if they edited themselves.
    qc.invalidateQueries({ queryKey: ["my-permissions"] });
    qc.invalidateQueries({ queryKey: ["my-page-access"] });
  };

  const roleAllows = (module: ModuleKey, action: string) =>
    (userRoles.data ?? []).some((r) => roleGrants.data?.has(`${r}:${module}:${action}`));
  const allowed = (module: ModuleKey, action: string) =>
    overrides.data?.get(`${module}:${action}`) ?? roleAllows(module, action);
  const shows = (p: Page) => pageAllowed(decisions.data, p, (m) => allowed(m, "view"));

  const setPage = useMutation({
    mutationFn: async ({ page, granted }: { page: Page; granted: boolean }) => {
      const rows: { user_id: string; page_id: string; granted: boolean }[] = [
        { user_id: userId, page_id: page.id, granted },
      ];
      if (granted && !allowed(page.module, "view")) {
        // The page needs its module's view to load. Granting that would also
        // show the module's other pages -- keep the ones not showing hidden.
        const { error } = await supabase
          .from("permission_overrides")
          .upsert({ user_id: userId, module: page.module, action: "view", granted: true });
        if (error) throw error;
        for (const other of PAGES)
          if (
            other.id !== page.id &&
            other.module === page.module &&
            !decisions.data?.has(other.id) &&
            !shows(other)
          )
            rows.push({ user_id: userId, page_id: other.id, granted: false });
      }
      const { error } = await db.from("user_page_access").upsert(rows);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast.success(`${v.page.label}: ${v.granted ? "granted" : "hidden"}`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // "Can work": create + edit + submit on the page's module. Granting it also
  // grants the module's view -- working on a page you can't open isn't possible.
  const setWork = useMutation({
    mutationFn: async ({ module, granted }: { module: ModuleKey; granted: boolean }) => {
      const actions: string[] = granted ? [...WORK_ACTIONS, "view"] : [...WORK_ACTIONS];
      const rows = actions.map((action) => ({ user_id: userId, module, action, granted }));
      const { error } = await supabase.from("permission_overrides").upsert(rows);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast.success(v.granted ? "Can now work on this page" : "Can no longer work on this page");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetPage = useMutation({
    mutationFn: async (page: Page) => {
      const { error } = await db
        .from("user_page_access")
        .delete()
        .eq("user_id", userId)
        .eq("page_id", page.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Back to the role's default");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clearAll = useMutation({
    mutationFn: async () => {
      const { error: e1 } = await db.from("user_page_access").delete().eq("user_id", userId);
      if (e1) throw e1;
      const { error: e2 } = await supabase
        .from("permission_overrides")
        .delete()
        .eq("user_id", userId)
        .in("action", PAGE_ACTIONS);
      if (e2) throw e2;
    },
    onSuccess: () => {
      toast.success("All page settings back to the role's defaults");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const isAdmin = (userRoles.data ?? []).includes("super_admin");
  const loading =
    userRoles.isLoading || roleGrants.isLoading || overrides.isLoading || decisions.isLoading;
  const busy = setPage.isPending || setWork.isPending || resetPage.isPending || clearAll.isPending;

  if (isAdmin) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          This user is an <strong>Admin</strong>, which has every page on every module by design.
          Per-page limits don't apply — remove the Admin role first if you need to restrict them.
        </span>
      </div>
    );
  }

  const changed = (decisions.data?.size ?? 0) + (overrides.data?.size ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Tick each page this user may open — every page is ticked or unticked on its own. Tick
          &quot;Can work&quot; to also let them record and submit there. Settings here override
          their role, for this user only.
        </p>
        {canEdit && changed > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1 whitespace-nowrap"
            onClick={() => clearAll.mutate()}
            disabled={busy}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset all to role defaults
          </Button>
        )}
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading page access…</p>
      ) : (
        <div className="space-y-5">
          {sections.map(({ section, entries }) => (
            <div key={section}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {entries.map((entry) =>
                  entry.pages.length === 1 ? (
                    <PageRow
                      key={entry.title}
                      page={entry.pages[0]}
                      label={entry.title}
                      checked={shows(entry.pages[0])}
                      decision={decisions.data?.get(entry.pages[0].id)}
                      work={WORK_ACTIONS.every((a) => allowed(entry.pages[0].module, a))}
                      canEdit={canEdit}
                      busy={busy}
                      onToggle={(granted) => setPage.mutate({ page: entry.pages[0], granted })}
                      onWork={(granted) =>
                        setWork.mutate({ module: entry.pages[0].module, granted })
                      }
                      onReset={() => resetPage.mutate(entry.pages[0])}
                    />
                  ) : (
                    <div
                      key={entry.title}
                      className="space-y-2 rounded-xl border p-3 sm:col-span-2"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold">{entry.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {entry.pages.filter(shows).length} of {entry.pages.length} pages
                        </span>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {entry.pages.map((p) => (
                          <PageRow
                            key={p.id}
                            page={p}
                            label={pageLabel(p)}
                            checked={shows(p)}
                            decision={decisions.data?.get(p.id)}
                            work={WORK_ACTIONS.every((a) => allowed(p.module, a))}
                            canEdit={canEdit}
                            busy={busy}
                            onToggle={(granted) => setPage.mutate({ page: p, granted })}
                            onWork={(granted) => setWork.mutate({ module: p.module, granted })}
                            onReset={() => resetPage.mutate(p)}
                          />
                        ))}
                      </div>
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PageRow({
  page,
  label,
  checked,
  decision,
  work,
  canEdit,
  busy,
  onToggle,
  onWork,
  onReset,
}: {
  page: Page;
  label: string;
  checked: boolean;
  decision: boolean | undefined;
  work: boolean;
  canEdit: boolean;
  busy: boolean;
  onToggle: (granted: boolean) => void;
  onWork: (granted: boolean) => void;
  onReset: () => void;
}) {
  const id = `pa-${page.id}`;
  // Other pages whose "Can work" moves with this one (same module).
  const sharing = PAGES.filter((p) => p.module === page.module && p.id !== page.id);
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 rounded-xl border p-3 transition-colors hover:border-primary/40"
    >
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={checked}
        disabled={!canEdit || busy}
        onCheckedChange={(v) => onToggle(!!v)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {decision === true && (
            <Badge variant="secondary" className="text-[10px]">
              Granted
            </Badge>
          )}
          {decision === false && (
            <Badge variant="destructive" className="text-[10px]">
              Hidden
            </Badge>
          )}
        </div>
        {decision === undefined && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {checked ? "Allowed by role" : "Not allowed by role"}
          </div>
        )}
        {checked && (
          // Inside the row's <label>: stop clicks here from also toggling the
          // page checkbox.
          <div
            className="mt-2 flex items-start gap-2"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <Checkbox
              className="mt-0.5"
              checked={work}
              disabled={!canEdit || busy}
              onCheckedChange={(v) => onWork(!!v)}
            />
            <span
              className="cursor-pointer text-xs"
              onClick={() => canEdit && !busy && onWork(!work)}
            >
              Can work — create, edit, submit
              {sharing.length > 0 && (
                <span className="block text-[11px] text-muted-foreground">
                  {MODULE_LABELS[page.module]} rights — also used by{" "}
                  {[...new Set(sharing.map((p) => p.label))].slice(0, 3).join(", ")}
                  {sharing.length > 3 ? "…" : ""}
                </span>
              )}
            </span>
          </div>
        )}
        {decision !== undefined && canEdit && (
          <button
            type="button"
            className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={(e) => {
              e.preventDefault();
              onReset();
            }}
            disabled={busy}
          >
            Reset to role default
          </button>
        )}
      </div>
    </label>
  );
}
