import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAllRoles, type Role } from "@/lib/permissions";
import { publicSignUp, type PublicSignUpResult } from "@/lib/admin-users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff } from "lucide-react";

// The sign-in page follows the sample the user gave (2026-10-30): a
// deep-blue hero with a flowing wave, the form in a white card on the right,
// and a navy footer. The card stays white in dark mode too, so its fields are
// styled light explicitly rather than following the theme.
const FIELD =
  "h-11 rounded-md border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:ring-sky-500";
const FIELD_LABEL = "text-xs font-medium text-slate-600";
const PRIMARY_BUTTON =
  "h-12 w-full rounded-md bg-[#071433] text-sm font-bold uppercase tracking-wider text-white hover:bg-[#0d2152]";
const SWITCH_LINK =
  "mt-1 block w-full text-sm font-bold uppercase tracking-wide text-sky-600 underline underline-offset-4 hover:text-sky-700";

const COMPANY_ADDRESS =
  "Plot No. 188A, FCDA Scheme Extension III, Off Bwari/Dutse Road, By Power Station, Opp. KAS Guest House, Kubwa, FCT Abuja";

// A plain <Input type="password"> with a toggle to reveal what was typed --
// same input either way, just swaps the rendered type between "password"
// and "text" so the value itself never changes.
function PasswordInput({
  id,
  name,
  autoComplete,
  required,
  minLength,
  placeholder,
  className,
  value,
  onChange,
}: {
  id?: string;
  name?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  placeholder?: string;
  className?: string;
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
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={onChange}
        className={cn("pr-9", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-700"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

// The flowing wave behind the hero, drawn rather than loaded so the page
// needs no extra image. Each layer drifts and swells on its own slow loop so
// the wave flows; it holds still for anyone who has reduced motion set.
function HeroWave() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 1440 520"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[70%] w-full"
    >
      <style>{`
        .wave-a { animation: wave-flow-a 14s ease-in-out infinite alternate; transform-origin: 50% 100%; }
        .wave-b { animation: wave-flow-b 10s ease-in-out infinite alternate; transform-origin: 50% 100%; }
        .wave-c { animation: wave-flow-c 18s ease-in-out infinite alternate; transform-origin: 50% 100%; }
        @keyframes wave-flow-a {
          0% { transform: translateX(-60px) scaleY(1); }
          100% { transform: translateX(60px) scaleY(1.08); }
        }
        @keyframes wave-flow-b {
          0% { transform: translateX(70px) scaleY(1.06); }
          100% { transform: translateX(-70px) scaleY(0.94); }
        }
        @keyframes wave-flow-c {
          0% { transform: translateX(-40px) scaleY(0.95); opacity: 0.35; }
          100% { transform: translateX(80px) scaleY(1.1); opacity: 0.6; }
        }
        @media (prefers-reduced-motion: reduce) {
          .wave-a, .wave-b, .wave-c { animation: none; }
        }
      `}</style>
      <defs>
        <linearGradient id="wave-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7cc4ef" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#2f86d0" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#0b4a94" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id="wave-b" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#bfe3f8" stopOpacity="0.9" />
          <stop offset="60%" stopColor="#4aa3e0" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#0d4f9c" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      {/* Paths run past both edges so the drift never shows a gap. */}
      <path
        className="wave-a"
        d="M-160 430 C 120 300, 360 210, 560 150 C 700 110, 820 120, 760 230 C 700 340, 900 400, 1120 380 C 1300 365, 1460 320, 1600 280 L1600 520 L-160 520 Z"
        fill="url(#wave-a)"
      />
      <path
        className="wave-c"
        d="M-160 470 C 200 400, 520 330, 820 360 C 1080 385, 1300 330, 1600 250 L1600 520 L-160 520 Z"
        fill="#9fd5f5"
      />
      <path
        className="wave-b"
        d="M200 520 C 400 380, 560 230, 700 170 C 760 145, 790 170, 760 240 C 720 330, 860 420, 1080 430 C 1260 437, 1440 390, 1600 340 L1600 520 Z"
        fill="url(#wave-b)"
      />
    </svg>
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
      { title: "Elim Table Water — Factory Management & Inventory System" },
      {
        name: "description",
        content:
          "Enterprise inventory, sales, production, payroll, and reporting for the Water Factory.",
      },
      { property: "og:title", content: "Elim Table Water — Factory Management & Inventory System" },
      {
        property: "og:description",
        content:
          "One platform for the factory. Secure roles, real-time dashboards, complete audit history.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
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

    // Created server-side so no confirmation email is sent (Supabase's built-in
    // mailer caps those at a few an hour). The account starts 'pending' until an
    // admin approves it, and no session is created here.
    setLoading(true);
    let result: PublicSignUpResult;
    try {
      result = await publicSignUp({
        data: {
          email: suEmail,
          password: suPassword,
          full_name: suFullName,
          username: suUsername || undefined,
          phone: suPhone || undefined,
          department: suDepartment || undefined,
          role_requested: suRole,
        },
      });
    } catch {
      result = { ok: false, error: "Check the form and try again" };
    }

    setLoading(false);
    if (!result.ok) return toast.error(result.error);
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
    <div className="flex min-h-screen flex-col bg-[#071433] text-white">
      <section className="relative flex-1 overflow-hidden bg-gradient-to-br from-[#0a3a82] via-[#0a3477] to-[#082a63]">
        <HeroWave />
        <div className="relative mx-auto flex w-full max-w-6xl flex-col px-4 py-8 sm:px-8 lg:py-16">
          <div className="grid items-start gap-8 pb-16 lg:grid-cols-2 lg:gap-12 lg:pb-28">
            {/* The logo heads the left column, its top level with the top of
                the login card (user, 2026-10-30). */}
            <div className="flex flex-col items-center text-center lg:items-start lg:pl-16 lg:text-left">
              {/* Sized to the logo's own shape so it fills the box edge to
                  edge, no white margin around it. */}
              <div className="aspect-[1747/900] w-72 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/20 sm:w-80">
                <img
                  src="/assets/elim-logo.png"
                  alt="Elim Table Water"
                  className="h-full w-full object-cover"
                />
              </div>
              <h1 className="mt-8 text-3xl font-bold leading-tight sm:text-4xl">
                {mode === "signin" ? "Login to your" : "Create your"}
                <br />
                {mode === "signin" ? "personal account" : "staff account"}
              </h1>
              <p className="mt-2 text-base text-white/85 sm:text-lg">
                Elim Table Water · Factory Management System
              </p>
            </div>

            <div className="w-full max-w-md rounded-3xl bg-white p-6 text-slate-900 shadow-2xl sm:p-8 justify-self-center">
              {mode === "signin" ? (
                <form onSubmit={signIn} className="space-y-4">
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="Email"
                    aria-label="Email"
                    className={FIELD}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <PasswordInput
                    id="password"
                    name="password"
                    autoComplete="current-password"
                    required
                    placeholder="Password"
                    className={FIELD}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={forgot}
                    className="text-sm text-sky-600 underline underline-offset-2 hover:text-sky-700"
                  >
                    I don&apos;t remember my password
                  </button>
                  <Button type="submit" disabled={loading} className={cn("mt-2", PRIMARY_BUTTON)}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Sign in
                  </Button>
                  <div className="pt-2 text-center text-sm text-slate-500">
                    No profile yet?
                    <button type="button" onClick={() => setMode("signup")} className={SWITCH_LINK}>
                      Register
                    </button>
                  </div>
                </form>
              ) : (
                <form onSubmit={signUp} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="su-name" className={FIELD_LABEL}>
                        Full name
                      </Label>
                      <Input
                        id="su-name"
                        required
                        className={FIELD}
                        value={suFullName}
                        onChange={(e) => setSuFullName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="su-username" className={FIELD_LABEL}>
                        Username
                      </Label>
                      <Input
                        id="su-username"
                        className={FIELD}
                        value={suUsername}
                        onChange={(e) => setSuUsername(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="su-email" className={FIELD_LABEL}>
                      Email
                    </Label>
                    <Input
                      id="su-email"
                      type="email"
                      required
                      className={FIELD}
                      value={suEmail}
                      onChange={(e) => setSuEmail(e.target.value)}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="su-phone" className={FIELD_LABEL}>
                        Phone
                      </Label>
                      <Input
                        id="su-phone"
                        type="tel"
                        className={FIELD}
                        value={suPhone}
                        onChange={(e) => setSuPhone(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="su-department" className={FIELD_LABEL}>
                        Department
                      </Label>
                      <Input
                        id="su-department"
                        className={FIELD}
                        value={suDepartment}
                        onChange={(e) => setSuDepartment(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className={FIELD_LABEL}>Role requested</Label>
                    <Select value={suRole} onValueChange={(v) => setSuRole(v as Role)}>
                      <SelectTrigger className={FIELD}>
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
                    <div className="space-y-1">
                      <Label htmlFor="su-password" className={FIELD_LABEL}>
                        Password
                      </Label>
                      <PasswordInput
                        id="su-password"
                        required
                        minLength={6}
                        className={FIELD}
                        value={suPassword}
                        onChange={(e) => setSuPassword(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="su-confirm" className={FIELD_LABEL}>
                        Confirm password
                      </Label>
                      <PasswordInput
                        id="su-confirm"
                        required
                        minLength={6}
                        className={FIELD}
                        value={suConfirmPassword}
                        onChange={(e) => setSuConfirmPassword(e.target.value)}
                      />
                    </div>
                  </div>

                  <p className="text-xs text-slate-500">
                    An Admin reviews and approves new accounts before you can sign in.
                  </p>

                  <Button type="submit" disabled={loading} className={PRIMARY_BUTTON}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create account
                  </Button>
                  <div className="pt-1 text-center text-sm text-slate-500">
                    Already have a profile?
                    <button type="button" onClick={() => setMode("signin")} className={SWITCH_LINK}>
                      Sign in
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </section>

      <footer className="bg-[#071433]">
        <div className="mx-auto grid w-full max-w-6xl items-start gap-8 px-4 py-8 sm:px-8 md:grid-cols-2">
          <div className="flex items-center gap-3">
            <div className="aspect-[1747/900] w-20 shrink-0 overflow-hidden rounded-lg ring-1 ring-white/15">
              <img src="/assets/elim-logo.png" alt="" className="h-full w-full object-cover" />
            </div>
            <div className="text-lg font-semibold tracking-wide">
              ELIM <span className="font-light">TABLE WATER</span>
            </div>
          </div>
          <div className="md:justify-self-end">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-white/45">
              Factory
            </p>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-white/90">
              Elim Water Factory
              <br />
              {COMPANY_ADDRESS}
            </p>
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 pb-6 text-[11px] text-white/45 sm:px-8">
          <span>© {new Date().getFullYear()} Elim Table Water</span>
          <span className="flex items-center gap-2">
            <img
              src="/assets/shieldnetcore-logo.png"
              alt="ShieldNetCore Technologies"
              className="h-4 w-4 object-contain"
            />
            Built by ShieldNetCore Technologies
          </span>
        </div>
      </footer>
    </div>
  );
}
