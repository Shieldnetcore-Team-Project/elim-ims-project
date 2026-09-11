import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { adminCreateUser } from "@/lib/admin-users";
import { useAllRoles, usePermissions, type ProductionScope } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, RefreshCw, UserPlus } from "lucide-react";

type Factory = { id: string; name: string };

const SCOPES: { value: ProductionScope; label: string }[] = [
  { value: "BOTH", label: "Both factories" },
  { value: "WATER", label: "Water only" },
  { value: "NYLON", label: "Nylon only" },
];

// Avoids look-alike characters (0/O, 1/l/I) so a password read off a screen and
// typed by hand doesn't bounce.
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";

function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
}

const EMPTY = {
  full_name: "",
  email: "",
  password: "",
  username: "",
  phone: "",
  department: "",
  role: "",
  factory_id: "",
  production_scope: "BOTH" as ProductionScope,
};

export function CreateUserDialog() {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const roles = useAllRoles();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [showPassword, setShowPassword] = useState(false);
  // Survives the dialog closing so the admin can still read the credentials off
  // the page — the password is never retrievable again after this.
  const [lastCreated, setLastCreated] = useState<{ email: string; password: string } | null>(null);

  const factories = useQuery({
    queryKey: ["factories-all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("factories").select("id,code,name").order("name");
      if (error) throw error;
      return (data ?? []) as Factory[];
    },
  });

  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const create = useMutation({
    mutationFn: async () => {
      return await adminCreateUser({
        data: {
          email: form.email.trim(),
          password: form.password,
          full_name: form.full_name.trim(),
          username: form.username.trim() || undefined,
          phone: form.phone.trim() || undefined,
          department: form.department.trim() || undefined,
          role: form.role,
          factory_id: form.factory_id || undefined,
          production_scope: form.production_scope,
        },
      });
    },
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);

      setLastCreated({ email: form.email.trim(), password: form.password });
      toast.success(`${form.full_name.trim()} can now sign in`);
      setForm(EMPTY);
      setShowPassword(false);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["all-accounts"] });
      qc.invalidateQueries({ queryKey: ["admin-panel"] });
      qc.invalidateQueries({ queryKey: ["all-profiles"] });
      qc.invalidateQueries({ queryKey: ["all-user-roles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copyCredentials = async () => {
    if (!lastCreated) return;
    await navigator.clipboard.writeText(
      `Email: ${lastCreated.email}\nPassword: ${lastCreated.password}`,
    );
    toast.success("Credentials copied");
  };

  if (!can("account-approvals", "create")) return null;

  // Mirrors the server's zod schema so a bad email surfaces here as a disabled
  // button rather than a validator throw from the server function.
  const missing =
    !form.full_name.trim() ||
    !/^\S+@\S+\.\S+$/.test(form.email.trim()) ||
    form.password.length < 8 ||
    !form.role;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setForm(EMPTY);
            setShowPassword(false);
          }
        }}
      >
        <DialogTrigger asChild>
          <Button className="gap-1">
            <UserPlus className="h-4 w-4" /> Create user
          </Button>
        </DialogTrigger>

        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-4 w-4" /> Create a user account
            </DialogTitle>
            <DialogDescription>
              You set the password and the account goes live straight away — no confirmation email,
              no approval step. Hand the credentials over and the user can sign in immediately.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cu-name">Full name</Label>
              <Input
                id="cu-name"
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
                placeholder="Ada Obi"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-email">Email</Label>
              <Input
                id="cu-email"
                type="email"
                autoComplete="off"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="ada@example.com"
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cu-password">Password</Label>
              <div className="flex gap-2">
                <Input
                  id="cu-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  placeholder="At least 8 characters"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1 whitespace-nowrap"
                  onClick={() => {
                    set("password", generatePassword());
                    setShowPassword(true);
                  }}
                >
                  <RefreshCw className="h-4 w-4" /> Generate
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-role">Role</Label>
              <Select value={form.role} onValueChange={(v) => set("role", v)}>
                <SelectTrigger id="cu-role">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {(roles.data ?? []).map((r) => (
                    <SelectItem key={r.slug} value={r.slug}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-factory">Factory</Label>
              <Select value={form.factory_id} onValueChange={(v) => set("factory_id", v)}>
                <SelectTrigger id="cu-factory">
                  <SelectValue placeholder="Default (Water)" />
                </SelectTrigger>
                <SelectContent>
                  {(factories.data ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-scope">Production scope</Label>
              <Select
                value={form.production_scope}
                onValueChange={(v) => set("production_scope", v as ProductionScope)}
              >
                <SelectTrigger id="cu-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-department">Department</Label>
              <Input
                id="cu-department"
                value={form.department}
                onChange={(e) => set("department", e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-username">Username</Label>
              <Input
                id="cu-username"
                value={form.username}
                onChange={(e) => set("username", e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-phone">Phone</Label>
              <Input
                id="cu-phone"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {missing
                ? "Name, a valid email, a role, and an 8+ character password are required."
                : "The password is shown once after creation — copy it before closing."}
            </span>
            <Button
              onClick={() => create.mutate()}
              disabled={missing || create.isPending}
              className="gap-1"
            >
              <UserPlus className="h-4 w-4" />
              {create.isPending ? "Creating…" : "Create account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {lastCreated && (
        <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
          <div className="font-medium">Account ready — share these credentials</div>
          <div className="mt-1 font-mono text-xs break-all">
            {lastCreated.email} · {lastCreated.password}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={copyCredentials} className="gap-1">
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setLastCreated(null)}>
              Dismiss
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            This password isn't stored anywhere you can read it again. If it's lost, send a reset
            link instead.
          </p>
        </div>
      )}
    </>
  );
}
