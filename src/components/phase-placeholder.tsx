import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Construction } from "lucide-react";

export function PhasePlaceholder({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Card className="rounded-2xl border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Construction className="h-5 w-5 text-warning" /> Arriving in {phase}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The database schema, RLS, and factory scoping for this module are already in place. The
          full UI (forms, tables, PDFs, filters, exports) ships in {phase}.
        </CardContent>
      </Card>
    </div>
  );
}
