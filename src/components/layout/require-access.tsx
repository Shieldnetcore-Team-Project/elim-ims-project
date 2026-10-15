import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { usePermissions, type ModuleKey } from "@/lib/permissions";
import { nav } from "@/lib/nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

// `anyOf`: other modules that also open the page (e.g. the Warehouse overview
// opens with raw-materials or finished-goods). `fallbackToFirstPage`: instead
// of "Access restricted", send the user to the first sidebar page they can
// open -- used by the Dashboard, where everyone lands after signing in, so a
// user given only e.g. the Warehouse starts there.
export function RequireAccess({
  module,
  anyOf,
  fallbackToFirstPage,
  children,
}: {
  module: ModuleKey;
  anyOf?: ModuleKey[];
  fallbackToFirstPage?: boolean;
  children: ReactNode;
}) {
  const { can, loading, loadFailed, reload } = usePermissions();
  const navigate = useNavigate();
  const allowed = !loading && [module, ...(anyOf ?? [])].some((m) => can(m, "view"));
  const firstPage =
    !loading && !loadFailed && !allowed && fallbackToFirstPage
      ? nav
          .flatMap((g) => g.items)
          .find((i) => (i.modules ? i.modules.some((m) => can(m, "view")) : can(i.module, "view")))
          ?.url
      : undefined;
  useEffect(() => {
    if (firstPage) navigate({ to: firstPage, replace: true });
  }, [firstPage, navigate]);

  if (loading || firstPage) return null;
  if (loadFailed) {
    return (
      <Card className="rounded-2xl border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" /> Couldn&apos;t load your permissions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>This is a connection problem, not a restriction on your account.</p>
          <Button size="sm" onClick={() => reload()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!allowed) {
    return (
      <div className="space-y-4">
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" /> Access restricted
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Your role doesn't have access to this module. Contact an Admin or Factory Manager if you
            believe this is a mistake.
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
