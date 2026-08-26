import type { ReactNode } from "react";
import { usePermissions, type ModuleKey } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldAlert } from "lucide-react";

export function RequireAccess({ module, children }: { module: ModuleKey; children: ReactNode }) {
  const { can, loading } = usePermissions();
  if (loading) return null;
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
            Your role doesn't have access to this module. Contact a Super Admin or Factory Manager
            if you believe this is a mistake.
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
