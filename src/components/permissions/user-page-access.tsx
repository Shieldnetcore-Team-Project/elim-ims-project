import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { nav } from "@/lib/nav";
import { ALL_MODULES, MODULE_LABELS, type ModuleKey } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RotateCcw, ShieldCheck } from "lucide-react";

// A page is visible when the user holds `view` on the module behind it — the
// sidebar gates every entry on can(module) (i.e. can(module, 'view')). This
// mirrors the sidebar one-to-one: one row per actual nav page, in the same
// section order. A page with real internal tabs (Payments, Procurement,
// Inventory Overview — see NavItem.tabs in src/lib/nav.ts) nests one checkbox
// per tab underneath it, so an admin can grant the whole page but still deny
// one tab inside it. A plain single-module page renders as one checkbox, same
// as always. Modules with no sidebar entry of their own — the pages reached
// from inside the Admin Panel — fall into OTHER_SECTION, one per module.
const OTHER_SECTION = "Admin & other";

type PageEntry = { title: string; items: { module: ModuleKey; label: string }[] };

function buildSections(): { section: string; pages: PageEntry[] }[] {
  const grouped = new Map<string, PageEntry[]>();
  const seen = new Set<ModuleKey>();

  const push = (section: string, page: PageEntry) => {
    const list = grouped.get(section) ?? [];
    list.push(page);
    grouped.set(section, list);
    for (const it of page.items) seen.add(it.module);
  };

  for (const group of nav) {
    for (const item of group.items) {
      const items = item.tabs
        ? item.tabs
        : item.modules
          ? item.modules.map((m) => ({ module: m, label: MODULE_LABELS[m] }))
          : [{ module: item.module, label: item.title }];
      push(group.section, { title: item.title, items });
    }
  }

  for (const m of ALL_MODULES) {
    if (!seen.has(m)) {
      push(OTHER_SECTION, {
        title: MODULE_LABELS[m],
        items: [{ module: m, label: MODULE_LABELS[m] }],
      });
    }
  }

  const order = [...new Set(nav.map((g) => g.section)), OTHER_SECTION];
  return order
    .filter((s) => grouped.has(s))
    .map((section) => ({ section, pages: grouped.get(section)! }));
}

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

  const roleViewGrants = useQuery({
    queryKey: ["role-view-grants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("role,module")
        .eq("action", "view");
      if (error) throw error;
      return new Set((data ?? []).map((r) => `${r.role}:${r.module}`));
    },
  });

  const overrides = useQuery({
    queryKey: ["page-access-overrides", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("permission_overrides")
        .select("module,granted")
        .eq("user_id", userId)
        .eq("action", "view");
      if (error) throw error;
      return new Map((data ?? []).map((o) => [o.module as ModuleKey, o.granted as boolean]));
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["page-access-overrides", userId] });
    qc.invalidateQueries({ queryKey: ["permission-overrides-for-user", userId] });
    qc.invalidateQueries({ queryKey: ["permission-overrides-list"] });
    // The edited user's own session re-reads this; refreshing here keeps the
    // admin's view honest if they edited themselves.
    qc.invalidateQueries({ queryKey: ["my-permissions"] });
  };

  // An explicit override either way, rather than deleting the row when
  // unchecking: deleting would fall back to the role's grant, which is often
  // exactly the access the admin just tried to remove.
  const setAccess = useMutation({
    mutationFn: async ({ module, granted }: { module: ModuleKey; granted: boolean }) => {
      const { error } = await supabase
        .from("permission_overrides")
        .upsert({ user_id: userId, module, action: "view", granted });
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const clearOverride = useMutation({
    mutationFn: async (module: ModuleKey) => {
      const { error } = await supabase
        .from("permission_overrides")
        .delete()
        .eq("user_id", userId)
        .eq("module", module)
        .eq("action", "view");
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
      const { error } = await supabase
        .from("permission_overrides")
        .delete()
        .eq("user_id", userId)
        .eq("action", "view");
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("All page overrides cleared");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const isAdmin = (userRoles.data ?? []).includes("super_admin");
  const loading = userRoles.isLoading || roleViewGrants.isLoading || overrides.isLoading;
  const busy = setAccess.isPending || clearOverride.isPending || clearAll.isPending;

  const roleAllows = (module: ModuleKey) =>
    (userRoles.data ?? []).some((r) => roleViewGrants.data?.has(`${r}:${module}`));

  const state = (module: ModuleKey) => {
    const override = overrides.data?.get(module);
    const fromRole = roleAllows(module);
    if (override === undefined) return { checked: fromRole, source: "role" as const };
    return { checked: override, source: override ? ("granted" as const) : ("blocked" as const) };
  };

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

  const overrideCount = overrides.data?.size ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Tick a page to give this user access, untick it to take access away. A tick overrides
          whatever their role allows, so it applies to this user only.
        </p>
        {canEdit && overrideCount > 0 && (
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
          {sections.map(({ section, pages }) => (
            <div key={section}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {pages.map((page) =>
                  page.items.length === 1 ? (
                    <ModuleRow
                      key={page.title}
                      module={page.items[0].module}
                      label={page.title}
                      state={state}
                      canEdit={canEdit}
                      busy={busy}
                      onToggle={(module, granted) => setAccess.mutate({ module, granted })}
                      onReset={(module) => clearOverride.mutate(module)}
                    />
                  ) : (
                    <div key={page.title} className="space-y-2 rounded-xl border p-3 sm:col-span-2">
                      <PageHeaderRow
                        title={page.title}
                        items={page.items}
                        state={state}
                        canEdit={canEdit}
                        busy={busy}
                        onToggleAll={(granted) =>
                          page.items.forEach((it) =>
                            setAccess.mutate({ module: it.module, granted }),
                          )
                        }
                      />
                      <div className="grid gap-2 pl-6 sm:grid-cols-2">
                        {page.items.map((it) => (
                          <ModuleRow
                            key={it.module}
                            module={it.module}
                            label={it.label}
                            state={state}
                            canEdit={canEdit}
                            busy={busy}
                            onToggle={(module, granted) => setAccess.mutate({ module, granted })}
                            onReset={(module) => clearOverride.mutate(module)}
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

type PageState = (module: ModuleKey) => {
  checked: boolean;
  source: "role" | "granted" | "blocked";
};

function PageHeaderRow({
  title,
  items,
  state,
  canEdit,
  busy,
  onToggleAll,
}: {
  title: string;
  items: { module: ModuleKey; label: string }[];
  state: PageState;
  canEdit: boolean;
  busy: boolean;
  onToggleAll: (granted: boolean) => void;
}) {
  const checkedCount = items.filter((it) => state(it.module).checked).length;
  const allChecked = checkedCount === items.length;
  return (
    <label className="flex items-center gap-3">
      <Checkbox
        checked={allChecked}
        disabled={!canEdit || busy}
        onCheckedChange={(v) => onToggleAll(!!v)}
      />
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">
        {allChecked
          ? "Full page access"
          : checkedCount === 0
            ? "No access"
            : `${checkedCount} of ${items.length} tabs granted`}
      </span>
    </label>
  );
}

function ModuleRow({
  module,
  label,
  state,
  canEdit,
  busy,
  onToggle,
  onReset,
}: {
  module: ModuleKey;
  label: string;
  state: PageState;
  canEdit: boolean;
  busy: boolean;
  onToggle: (module: ModuleKey, granted: boolean) => void;
  onReset: (module: ModuleKey) => void;
}) {
  const { checked, source } = state(module);
  return (
    <label
      htmlFor={`pa-${module}`}
      className="flex items-start gap-3 rounded-xl border p-3 transition-colors hover:border-primary/40"
    >
      <Checkbox
        id={`pa-${module}`}
        className="mt-0.5"
        checked={checked}
        disabled={!canEdit || busy}
        onCheckedChange={(v) => onToggle(module, !!v)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {source === "granted" && (
            <Badge variant="secondary" className="text-[10px]">
              Granted
            </Badge>
          )}
          {source === "blocked" && (
            <Badge variant="destructive" className="text-[10px]">
              Blocked
            </Badge>
          )}
        </div>
        {source === "role" && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {checked ? "Allowed by role" : "Not allowed by role"}
          </div>
        )}
        {source !== "role" && canEdit && (
          <button
            type="button"
            className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={(e) => {
              e.preventDefault();
              onReset(module);
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
