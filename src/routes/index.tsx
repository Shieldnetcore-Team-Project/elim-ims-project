import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Factory, ShieldCheck, Zap, LineChart } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "FMIS — Factory Management & Inventory System" },
      { name: "description", content: "Enterprise inventory, sales, production, payroll, and reporting for the Water Factory and Nylon Factory." },
      { property: "og:title", content: "FMIS — Factory Management & Inventory System" },
      { property: "og:description", content: "One platform for two factories. Fully separated data, secure roles, real-time dashboards." },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Factory className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">FMIS</span>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/auth"><Button variant="ghost">Sign in</Button></Link>
          <Link to="/auth"><Button>Get started</Button></Link>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Enterprise · Two-factory ready
          </div>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight md:text-6xl">
            Factory Management &<br />
            <span className="text-primary">Inventory System</span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Run your <strong>Water Factory</strong> and <strong>Nylon Factory</strong> on one platform.
            Sales, production, raw materials, payroll, and reports — all cleanly separated by factory,
            with role-based access and complete audit history.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to="/auth"><Button size="lg">Open dashboard</Button></Link>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            { icon: LineChart, title: "Real-time dashboards", body: "Sales, production, expenses, debts, low-stock alerts — live per factory." },
            { icon: ShieldCheck, title: "RBAC & audit trail", body: "13 roles, row-level security, and full audit logging for every action." },
            { icon: Zap, title: "Built for scale", body: "Postgres-backed, PDF-ready, export to Excel/CSV, barcode & QR ready." },
          ].map((f) => (
            <div key={f.title} className="rounded-2xl border bg-card p-6">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} FMIS</span>
          <span>Water Factory · Nylon Factory</span>
        </div>
      </footer>
    </div>
  );
}
