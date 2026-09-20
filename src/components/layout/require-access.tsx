import type { ReactNode } from "react";
import { usePermissions, type ModuleKey } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

export function RequireAccess({ module, children }: { module: ModuleKey; children: ReactNode }) {
  const { can, loading, loadFailed, reload } = usePermissions();
  if (loading) return null;
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
  if (!can(module, "view")) {
    return (
      <div className="space-y-4">
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" /> Access restricted
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Your role doesn't have access to this module. Contact an Admin or Factory Manager
            if you believe this is a mistake.
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
