import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActiveFactoryCode } from "@/lib/factory-store";
import { getFactoryIdByCode } from "@/lib/factories";
import { useTheme } from "@/lib/theme";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Loader2, Sun, Moon, Download, Upload, AlertTriangle, Plus } from "lucide-react";
import { usePermissions, useIsSuperAdmin } from "@/lib/permissions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: SettingsPage,
});

const BACKUP_TABLES = [
  "settings",
  "product_categories",
  "products",
  "raw_materials",
  "expense_categories",
  "customers",
  "suppliers",
  "employees",
] as const;

export function SettingsPage() {
  const code = useActiveFactoryCode();
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();
  const isSuperAdmin = useIsSuperAdmin();
  const isAdmin = isSuperAdmin.data ?? false;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [factoryId, setFactoryId] = useState<string>("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    company_name: "",
    address: "",
    phone: "",
    email: "",
    vat_rate: "7.5",
    currency: "NGN",
    invoice_prefix: "INV",
    receipt_prefix: "RCP",
    production_prefix: "PRD",
    employee_prefix: "EMP",
  });

  const factories = useQuery({
    queryKey: ["factories-all"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.from("factories").select("id,code,name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const fid = await getFactoryIdByCode(code);
      const { data } = await supabase
        .from("settings")
        .select("*")
        .eq("factory_id", fid)
        .maybeSingle();
      if (cancelled) return;
      setFactoryId(fid);
      setLogoUrl(data?.logo_url ?? null);
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
    return () => {
      cancelled = true;
    };
  }, [code, isAdmin]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    let finalLogoUrl = logoUrl;
    if (logoFile) {
      const path = `${factoryId}/${Date.now()}-${logoFile.name}`;
      const { error: uploadError } = await supabase.storage
        .from("company-logos")
        .upload(path, logoFile, { upsert: true });
      if (uploadError) {
        setSaving(false);
        toast.error(uploadError.message);
        return;
      }
      finalLogoUrl = supabase.storage.from("company-logos").getPublicUrl(path).data.publicUrl;
    }
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
        logo_url: finalLogoUrl,
      })
      .eq("factory_id", factoryId);
    setSaving(false);
    if (error) return toast.error(error.message);
    setLogoUrl(finalLogoUrl);
    setLogoFile(null);
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
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? "Manage your account, plus company, tax, and factory settings for the currently selected factory."
            : "Manage your account."}
        </p>
      </div>

      <PersonalSettingsCard />

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Theme</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button
            variant={theme === "light" ? "default" : "outline"}
            className="gap-2"
            onClick={() => setTheme("light")}
          >
            <Sun className="h-4 w-4" /> Light Mode
          </Button>
          <Button
            variant={theme === "dark" ? "default" : "outline"}
            className="gap-2"
            onClick={() => setTheme("dark")}
          >
            <Moon className="h-4 w-4" /> Dark Mode
          </Button>
        </CardContent>
      </Card>

      {isAdmin && (
        <>
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <form onSubmit={save} className="space-y-6">
              <Card className="rounded-2xl">
                <CardHeader>
                  <CardTitle>Company</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Company logo</Label>
                    <div className="flex items-center gap-3">
                      {logoUrl && (
                        <img
                          src={logoUrl}
                          alt="Company logo"
                          className="h-12 w-12 rounded-md border object-contain bg-white"
                        />
                      )}
                      <Input
                        type="file"
                        accept="image/*"
                        onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Company name</Label>
                    <Input {...field("company_name")} />
                  </div>
                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <Input {...field("phone")} />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Address</Label>
                    <Input {...field("address")} />
                  </div>
                  <div className="space-y-2">
                    <Label>Email</Label>
                    <Input type="email" {...field("email")} />
                  </div>
                  <div className="space-y-2">
                    <Label>Currency</Label>
                    <Input {...field("currency")} />
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-2xl">
                <CardHeader>
                  <CardTitle>Tax & numbering</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label>VAT / Tax rate (%)</Label>
                    <MoneyInput
                      step="0.01"
                      value={form.vat_rate === "" ? 0 : Number(form.vat_rate)}
                      onChange={(v) => setForm({ ...form, vat_rate: v === 0 ? "" : String(v) })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Invoice prefix</Label>
                    <Input {...field("invoice_prefix")} />
                  </div>
                  <div className="space-y-2">
                    <Label>Receipt prefix</Label>
                    <Input {...field("receipt_prefix")} />
                  </div>
                  <div className="space-y-2">
                    <Label>Production prefix</Label>
                    <Input {...field("production_prefix")} />
                  </div>
                  <div className="space-y-2">
                    <Label>Employee prefix</Label>
                    <Input {...field("employee_prefix")} />
                  </div>
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

          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Factory Management</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Rename the two factories. Each keeps fully separate data — Water and Nylon can't be
                merged or removed here.
              </p>
              {(factories.data ?? []).map((f) => (
                <FactoryRow
                  key={f.id}
                  id={f.id}
                  code={f.code}
                  name={f.name}
                  onSaved={() => qc.invalidateQueries({ queryKey: ["factories-all"] })}
                />
              ))}
            </CardContent>
          </Card>

          <ProductionTypesCard />
          <UnitsOfMeasureCard />

          <BackupRestoreCard factoryId={factoryId} />
        </>
      )}
    </div>
  );
}

function PersonalSettingsCard() {
  const [userId, setUserId] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [username, setUsername] = useState("");
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id ?? "";
      if (cancelled) return;
      setUserId(uid);
      if (!uid) {
        setLoadingProfile(false);
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("avatar_url,username")
        .eq("id", uid)
        .maybeSingle();
      if (cancelled) return;
      setAvatarUrl(data?.avatar_url ?? null);
      setUsername(data?.username ?? "");
      setLoadingProfile(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    setSavingProfile(true);
    let finalAvatarUrl = avatarUrl;
    if (avatarFile) {
      const path = `${userId}/${Date.now()}-${avatarFile.name}`;
      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, avatarFile, { upsert: true });
      if (uploadError) {
        setSavingProfile(false);
        toast.error(uploadError.message);
        return;
      }
      finalAvatarUrl = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    }
    const { error } = await supabase
      .from("profiles")
      .update({ avatar_url: finalAvatarUrl, username: username.trim() || null })
      .eq("id", userId);
    setSavingProfile(false);
    if (error) return toast.error(error.message);
    setAvatarUrl(finalAvatarUrl);
    setAvatarFile(null);
    toast.success("Profile updated");
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);
    if (error) return toast.error(error.message);
    setNewPassword("");
    setConfirmPassword("");
    toast.success("Password updated");
  };

  const initials = (username || "?").slice(0, 2).toUpperCase();

  if (loadingProfile) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>My Account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveProfile} className="space-y-4">
            <div className="space-y-2">
              <Label>Profile picture</Label>
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12">
                  {avatarUrl && <AvatarImage src={avatarUrl} alt="Profile picture" />}
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <Input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)}
                />
              </div>
            </div>
            <div className="space-y-2 max-w-xs">
              <Label>Username</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Your username"
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={savingProfile}>
                {savingProfile && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save profile
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Change password</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={savePassword} className="space-y-4 max-w-xs">
            <div className="space-y-2">
              <Label>New password</Label>
              <Input
                type="password"
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Confirm new password</Label>
              <Input
                type="password"
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={savingPassword}>
                {savingPassword && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Update password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

function FactoryRow({
  id,
  code,
  name,
  onSaved,
}: {
  id: string;
  code: string;
  name: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const dirty = value !== name;

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from("factories").update({ name: value }).eq("id", id);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Factory updated");
    onSaved();
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {code}
      </span>
      <Input value={value} onChange={(e) => setValue(e.target.value)} className="max-w-xs" />
      <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={save}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

function BackupRestoreCard({ factoryId }: { factoryId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const runBackup = async () => {
    if (!factoryId) return;
    const snapshot: Record<string, unknown[]> = {};
    for (const table of BACKUP_TABLES) {
      const { data, error } = await supabase.from(table).select("*").eq("factory_id", factoryId);
      if (error) {
        toast.error(`${table}: ${error.message}`);
        return;
      }
      snapshot[table] = data ?? [];
    }
    const blob = new Blob(
      [
        JSON.stringify(
          { factory_id: factoryId, exported_at: new Date().toISOString(), tables: snapshot },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fmis-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Backup downloaded");
  };

  const runRestore = async () => {
    if (!file) return;
    setRestoring(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { tables?: Record<string, any[]> };
      if (!parsed.tables) throw new Error("This file doesn't look like an FMIS backup");
      for (const table of BACKUP_TABLES) {
        const rows = parsed.tables[table];
        if (!rows || rows.length === 0) continue;
        const { error } = await supabase.from(table).upsert(rows, { onConflict: "id" });
        if (error) throw new Error(`${table}: ${error.message}`);
      }
      toast.success("Restore complete. Records from the file were re-applied.");
      setFile(null);
      setConfirmText("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Backup & Restore</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <div className="font-medium text-sm">Backup</div>
            <div className="text-xs text-muted-foreground">
              Download a snapshot of this factory's master data as JSON.
            </div>
          </div>
          <Button variant="outline" className="gap-2" onClick={runBackup}>
            <Download className="h-4 w-4" /> Backup
          </Button>
        </div>

        <div className="rounded-lg border p-3 space-y-2">
          <div className="font-medium text-sm">Restore</div>
          <p className="text-xs text-muted-foreground">
            Re-applies records from a backup file. Matching records (same ID) are overwritten;
            records not in the file are left untouched — this does not delete anything.
          </p>
          <Input
            type="file"
            accept="application/json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <AlertDialog onOpenChange={(v) => !v && setConfirmText("")}>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="gap-2" disabled={!file}>
                <Upload className="h-4 w-4" /> Restore
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-warning" /> Confirm restore
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This will overwrite any current record whose ID matches one in the backup file.
                  Type RESTORE to confirm.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="RESTORE"
              />
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={confirmText !== "RESTORE" || restoring}
                  onClick={runRestore}
                >
                  {restoring ? "Restoring…" : "Restore data"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

type ProductionTypeRow = {
  id: string;
  name: string;
  code: string;
  department: string | null;
  production_scope: string;
  unit_of_measure: string | null;
  active: boolean;
};

// Configurable production types (spec §5): Production's "type" dropdown reads
// straight from this table, so adding "NYLON ROPE" next quarter is a data
// entry here, never a code change or deploy.
function ProductionTypesCard() {
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const write = canWrite("settings");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [department, setDepartment] = useState("Production");
  const [scope, setScope] = useState<"NYLON" | "WATER" | "BOTH">("BOTH");
  const [uom, setUom] = useState("");

  const types = useQuery({
    queryKey: ["production-types-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_types")
        .select("id,name,code,department,production_scope,unit_of_measure,active")
        .order("name");
      if (error) throw error;
      return (data ?? []) as ProductionTypeRow[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["production-types-all"] });

  const add = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name is required");
      if (!code.trim()) throw new Error("Code is required");
      const { error } = await supabase.from("production_types").insert({
        name: name.trim(),
        code: code.trim().toUpperCase().replace(/\s+/g, "_"),
        department: department || null,
        production_scope: scope,
        unit_of_measure: uom || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Production type added");
      setName("");
      setCode("");
      setUom("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: async (t: ProductionTypeRow) => {
      const { error } = await supabase
        .from("production_types")
        .update({ active: !t.active })
        .eq("id", t.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Production Types</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Configurable list Production picks from when recording a new batch — add a type here
          instead of changing code.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead>Status</TableHead>
              {write && <TableHead></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(types.data ?? []).map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="font-mono text-xs">{t.code}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {t.production_scope.toLowerCase()}
                  </Badge>
                </TableCell>
                <TableCell>{t.unit_of_measure ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={t.active ? "secondary" : "outline"}>
                    {t.active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                {write && (
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => toggleActive.mutate(t)}>
                      {t.active ? "Deactivate" : "Activate"}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {(types.data ?? []).length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={write ? 6 : 5}
                  className="text-center text-muted-foreground py-6"
                >
                  No production types configured yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {write && (
          <div className="grid grid-cols-2 gap-3 border-t pt-4 md:grid-cols-5 md:items-end">
            <div>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Nylon Bag"
              />
            </div>
            <div>
              <Label>Code</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. NYLON_BAG"
              />
            </div>
            <div>
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BOTH">Both</SelectItem>
                  <SelectItem value="NYLON">Nylon</SelectItem>
                  <SelectItem value="WATER">Water</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Department</Label>
              <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Input
                value={uom}
                onChange={(e) => setUom(e.target.value)}
                placeholder="Unit (optional)"
              />
              <Button
                size="sm"
                disabled={add.isPending}
                onClick={() => add.mutate()}
                className="shrink-0 gap-1"
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type UnitOfMeasureRow = { id: string; name: string; code: string; active: boolean };

// Configurable units of measure (spec §20): Raw Materials / Finished Goods /
// Production unit pickers all read from this table (src/lib/units.ts'
// useUnitsOfMeasure()) instead of a hard-coded list — adding "Drum" or
// "Gallon" is a row here, never a code change.
function UnitsOfMeasureCard() {
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const write = canWrite("settings");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const units = useQuery({
    queryKey: ["units-of-measure-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units_of_measure")
        .select("id,name,code,active")
        .order("name");
      if (error) throw error;
      return (data ?? []) as UnitOfMeasureRow[];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["units-of-measure-all"] });
    qc.invalidateQueries({ queryKey: ["units-of-measure"] });
  };

  const add = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name is required");
      const { error } = await supabase.from("units_of_measure").insert({
        name: name.trim(),
        code: (code.trim() || name.trim()).toUpperCase().replace(/\s+/g, "_"),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Unit added");
      setName("");
      setCode("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: async (u: UnitOfMeasureRow) => {
      const { error } = await supabase
        .from("units_of_measure")
        .update({ active: !u.active })
        .eq("id", u.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Units of Measure</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Every unit picker in Raw Materials, Finished Goods, and Production reads from this list —
          add a unit here instead of changing code.
        </p>
        <div className="flex flex-wrap gap-2">
          {(units.data ?? []).map((u) => (
            <Badge key={u.id} variant={u.active ? "secondary" : "outline"} className="gap-1">
              {u.name}
              {write && (
                <button
                  onClick={() => toggleActive.mutate(u)}
                  className="ml-1 text-[10px] uppercase hover:text-destructive"
                >
                  {u.active ? "hide" : "show"}
                </button>
              )}
            </Badge>
          ))}
          {(units.data ?? []).length === 0 && (
            <span className="text-xs text-muted-foreground">No units configured yet.</span>
          )}
        </div>
        {write && (
          <div className="flex gap-2 border-t pt-4">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Gallon"
              className="max-w-xs"
            />
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Code (optional)"
              className="max-w-xs"
            />
            <Button
              size="sm"
              disabled={add.isPending}
              onClick={() => add.mutate()}
              className="gap-1"
            >
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
