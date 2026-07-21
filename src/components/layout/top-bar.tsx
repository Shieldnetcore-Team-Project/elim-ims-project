import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { FactorySwitcher } from "./factory-switcher";
import { useTheme } from "@/lib/theme";
import { Moon, Sun, LogOut, User as UserIcon, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export function TopBar() {
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/auth", replace: true });
  };

  const initials = (email || "?").slice(0, 2).toUpperCase();

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/80 px-3 backdrop-blur">
      <SidebarTrigger />
      <FactorySwitcher />
      <div className="ml-2 hidden md:flex items-center gap-2 max-w-sm w-full">
        <div className="relative w-full">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search…" className="pl-8 h-9" />
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 gap-2 px-2">
              <Avatar className="h-7 w-7"><AvatarFallback>{initials}</AvatarFallback></Avatar>
              <span className="hidden md:inline text-sm">{email || "Account"}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{email || "Signed in"}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate({ to: "/settings" })}>
              <UserIcon className="mr-2 h-4 w-4" /> Profile & settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
