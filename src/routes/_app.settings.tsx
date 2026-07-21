import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveFactoryCode } from "@/lib/factory-store";
import { getFactoryIdByCode } from "@/lib/factories";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const code = useActiveFactoryCode();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [factoryId, setFactoryId] = useState<string>("");
  const [form, setForm] = useState({
    company_name: "", address: "", phone: "", email: "",
    vat_rate: "7.5", currency: "NGN",
    invoice_prefix: "INV", receipt_prefix: "RCP",
    production_prefix: "PRD", employee_prefix: "EMP",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const fid = await getFactoryIdByCode(code);
      const { data } = await supabase.from("settings").select("*").eq("factory_id", fid).maybeSingle();
      if (cancelled) return;
      setFactoryId(fid);
      if (data) {
        setForm({
          company_name: data.company_name ?? "",
          address: data.address ?? "",
          phone: data.phone ?? "",
          email: data.email ?? "",
          vat_rate: String(data.vat_rate ?? "7.5"),
          currency: data.currency ?? "NGN",
          invoice_prefix: data.invoice_prefix ?? "INV",
          receipt_prefix: data.receipt_prefix ?? "RCP",
          production_prefix: data.production_prefix ?? "PRD",
          employee_prefix: data.employee_prefix ?? "EMP",
        });
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [code]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const { error } = await supabase
      .from("settings")
      .update({
        company_name: form.company_name,
        address: form.address,
        phone: form.phone,
        email: form.email,
        vat_rate: Number(form.vat_rate),
        currency: form.currency,
        invoice_prefix: form.invoice_prefix,
        receipt_prefix: form.receipt_prefix,
        production_prefix: form.production_prefix,
        employee_prefix: form.employee_prefix,
      })
      .eq("factory_id", factoryId);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Settings saved");
  };

  const field = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }),
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">These settings apply only to the currently selected factory.</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <form onSubmit={save} className="space-y-6">
          <Card className="rounded-2xl">
            <CardHeader><CardTitle>Company</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2"><Label>Company name</Label><Input {...field("company_name")} /></div>
              <div className="space-y-2"><Label>Phone</Label><Input {...field("phone")} /></div>
              <div className="space-y-2 md:col-span-2"><Label>Address</Label><Input {...field("address")} /></div>
              <div className="space-y-2"><Label>Email</Label><Input type="email" {...field("email")} /></div>
              <div className="space-y-2"><Label>Currency</Label><Input {...field("currency")} /></div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader><CardTitle>Tax & numbering</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2"><Label>VAT rate (%)</Label><Input type="number" step="0.01" {...field("vat_rate")} /></div>
              <div className="space-y-2"><Label>Invoice prefix</Label><Input {...field("invoice_prefix")} /></div>
              <div className="space-y-2"><Label>Receipt prefix</Label><Input {...field("receipt_prefix")} /></div>
              <div className="space-y-2"><Label>Production prefix</Label><Input {...field("production_prefix")} /></div>
              <div className="space-y-2"><Label>Employee prefix</Label><Input {...field("employee_prefix")} /></div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save settings
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
