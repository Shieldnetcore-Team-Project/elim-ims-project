import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAllRoles, type Role } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Boxes, BarChart3, ShieldCheck, Users, Lock, Eye, EyeOff } from "lucide-react";

const FEATURES = [
  {
    icon: Boxes,
    title: "Inventory & production",
    desc: "Raw materials to finished goods, tracked end to end.",
  },
  {
    icon: BarChart3,
    title: "Real-time reporting",
    desc: "Live dashboards across sales, costs, and cash flow.",
  },
  {
    icon: ShieldCheck,
    title: "Role-based security",
    desc: "Granular access, audited down to every action.",
  },
  {
    icon: Users,
    title: "Two factories, one login",
    desc: "Water and Nylon, fully separated, one platform.",
  },
];

// A plain <Input type="password"> with a toggle to reveal what was typed --
// same input either way, just swaps the rendered type between "password"
// and "text" so the value itself never changes.
function PasswordInput({
  id,
  name,
  autoComplete,
  required,
  minLength,
  value,
  onChange,
}: {
  id?: string;
  name?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        value={value}
        onChange={onChange}
        className="pr-9"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

const STATUS_MESSAGES: Record<string, (reason?: string | null) => string> = {
  pending: () => "Your account is awaiting admin approval. You'll be notified once it's reviewed.",
  rejected: (reason) =>
    reason
      ? `Your registration was declined: ${reason}`
      : "Your registration was declined. Contact an administrator.",
  suspended: () => "Your account has been suspended. Contact an administrator.",
  deactivated: () => "Your account has been deactivated. Contact an administrator.",
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "FMIS — Factory Management & Inventory System" },
      {
        name: "description",
        content:
          "Enterprise inventory, sales, production, payroll, and reporting for the Water Factory and Nylon Factory.",
      },
      { property: "og:title", content: "FMIS — Factory Management & Inventory System" },
      {
        property: "og:description",
        content:
          "One platform for two factories. Fully separated data, secure roles, real-time dashboards.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [suFullName, setSuFullName] = useState("");
  const [suUsername, setSuUsername] = useState("");
  const [suEmail, setSuEmail] = useState("");
  const [suPhone, setSuPhone] = useState("");
  const [suDepartment, setSuDepartment] = useState("");
  const [suRole, setSuRole] = useState<Role | "">("");
  const [suPassword, setSuPassword] = useState("");
  const [suConfirmPassword, setSuConfirmPassword] = useState("");

  const roles = useAllRoles();
  const requestableRoles = roles.data ?? [];

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  const signIn = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Autofilled values don't always trigger React's onChange, which can leave
    // `email`/`password` state stale even though the fields look filled in.
    // Read straight from the submitted form so autofill can't send an empty email.
    const formData = new FormData(e.currentTarget);
    const signInEmail = String(formData.get("email") ?? "").trim();
    const signInPassword = String(formData.get("password") ?? "");
    if (!signInEmail || !signInPassword) {
      return toast.error("Enter your email and password");
    }

    setLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: signInEmail,
      password: signInPassword,
    });
    if (error) {
      setLoading(false);
      return toast.error(error.message);
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("status, rejected_reason")
      .eq("id", data.user.id)
      .single();
    setLoading(false);

    if (profileError || !profile) {
      await supabase.auth.signOut();
      return toast.error("Could not load your account. Contact an administrator.");
    }

    const blockedMessage = STATUS_MESSAGES[profile.status]?.(profile.rejected_reason);
    if (blockedMessage) {
      await supabase.auth.signOut();
      return toast.error(blockedMessage);
    }

    toast.success("Welcome back");
    navigate({ to: "/dashboard" });
  };

  const signUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (suPassword !== suConfirmPassword) return toast.error("Passwords don't match");
    if (!suRole) return toast.error("Select the role you're requesting");

    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: suEmail,
      password: suPassword,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: {
          full_name: suFullName,
          username: suUsername || undefined,
          phone: suPhone || undefined,
          department: suDepartment || undefined,
          role_requested: suRole,
        },
      },
    });

    // With email confirmation turned off, signUp returns a live session straight away.
    // New accounts are still 'pending' until an admin approves them, so drop that session
    // instead of letting an unapproved user walk into the app.
    if (data?.session) await supabase.auth.signOut();

    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Account created. An admin must approve your account before you can sign in.");
  };

  const forgot = async () => {
    if (!email) return toast.error("Enter your email first");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) return toast.error(error.message);
    toast.success("Password reset email sent");
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden lg:flex flex-col bg-sidebar text-sidebar-foreground p-10">
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="h-40 w-80 overflow-hidden rounded-2xl bg-white p-3 shadow-lg">
            <img
              src="/assets/bluespring%20logo.jpeg"
              alt="Bluespring Total Connect"
              className="h-full w-full object-contain"
            />
          </div>

          <div className="mt-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-sidebar-border bg-sidebar-accent px-3 py-1 text-xs font-medium text-sidebar-accent-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Enterprise · Two-factory ready
            </div>
            <h1 className="mt-6 text-4xl font-semibold leading-tight">
              Factory Management &<br />
              Inventory System
            </h1>
            <p className="mt-4 max-w-md mx-auto text-sidebar-foreground/70">
              Run your <strong className="text-sidebar-foreground">Water Factory</strong> and{" "}
              <strong className="text-sidebar-foreground">Nylon Factory</strong> on one platform.
              Sales, production, raw materials, payroll, and reports — all cleanly separated by
              factory, with role-based access and complete audit history.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-sidebar-foreground/60">
          <span>© {new Date().getFullYear()} FMIS</span>
          <span>Water Factory · Nylon Factory</span>
        </div>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-md lg:hidden mb-6 flex justify-center">
          <div className="h-10 w-40 overflow-hidden rounded-lg bg-white">
            <img
              src="/assets/bluespring%20logo.jpeg"
              alt="Bluespring Total Connect"
              className="h-full w-full object-contain"
            />
          </div>
        </div>

        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl">Welcome</CardTitle>
            <CardDescription>Sign in to access your factory dashboard</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="signin">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Sign up</TabsTrigger>
              </TabsList>

              <TabsContent value="signin">
                <form onSubmit={signIn} className="space-y-4 pt-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password">Password</Label>
                      <button
                        type="button"
                        onClick={forgot}
                        className="text-xs text-primary hover:underline"
                      >
                        Forgot?
                      </button>
                    </div>
                    <PasswordInput
                      id="password"
                      name="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Sign in
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="signup">
                <form onSubmit={signUp} className="space-y-4 pt-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="su-name">Full name</Label>
                      <Input
                        id="su-name"
                        required
                        value={suFullName}
                        onChange={(e) => setSuFullName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="su-username">Username</Label>
                      <Input
                        id="su-username"
                        value={suUsername}
                        onChange={(e) => setSuUsername(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="su-email">Email</Label>
                    <Input
                      id="su-email"
                      type="email"
                      required
                      value={suEmail}
                      onChange={(e) => setSuEmail(e.target.value)}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="su-phone">Phone</Label>
                      <Input
                        id="su-phone"
                        type="tel"
                        value={suPhone}
                        onChange={(e) => setSuPhone(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="su-department">Department</Label>
                      <Input
                        id="su-department"
                        value={suDepartment}
                        onChange={(e) => setSuDepartment(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Role requested</Label>
                    <Select value={suRole} onValueChange={(v) => setSuRole(v as Role)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                      <SelectContent>
                        {requestableRoles.map((r) => (
                          <SelectItem key={r.slug} value={r.slug}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="su-password">Password</Label>
                      <PasswordInput
                        id="su-password"
                        required
                        minLength={6}
                        value={suPassword}
                        onChange={(e) => setSuPassword(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="su-confirm">Confirm password</Label>
                      <PasswordInput
                        id="su-confirm"
                        required
                        minLength={6}
                        value={suConfirmPassword}
                        onChange={(e) => setSuConfirmPassword(e.target.value)}
                      />
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    An Admin reviews and approves new accounts before you can sign in.
                  </p>

                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create account
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
