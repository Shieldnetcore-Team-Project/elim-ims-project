import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePendingAttention } from "@/lib/pending-attention";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FactorySwitcher } from "./factory-switcher";
import { useTheme } from "@/lib/theme";
import { Moon, Sun, LogOut, User as UserIcon, Bell, ChevronRight } from "lucide-react";
import { adjustmentReference, notificationLink } from "@/lib/notification-links";
import { GlobalSearch } from "./global-search";
import { playBeep } from "@/lib/notification-sound";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

function NotificationsBell() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { items: pendingItems, total: pendingTotal } = usePendingAttention();

  const notifications = useQuery({
    queryKey: ["notifications", factoryId],
    enabled: !!factoryId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("id,title,body,read,created_at")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });

  // A stock adjustment notification opens Raw Materials or Finished Goods,
  // whichever the adjustment (by its reference) is for.
  const adjustmentRefs = (notifications.data ?? []).flatMap((n) => {
    const ref = adjustmentReference(n.body);
    return ref ? [ref] : [];
  });
  const adjustmentTypes = useQuery({
    queryKey: ["notification-adjustments", adjustmentRefs],
    enabled: adjustmentRefs.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("stock_adjustment_requests")
        .select("reference_number,entity_type")
        .in("reference_number", adjustmentRefs);
      return new Map(
        (data ?? []).map((a) => [
          a.reference_number,
          a.entity_type as "raw_material" | "finished_good",
        ]),
      );
    },
  });
  const linkFor = (n: { title: string; body: string | null }) => {
    const ref = adjustmentReference(n.body);
    return notificationLink(n.title, n.body, ref ? adjustmentTypes.data?.get(ref) : null);
  };

  // Beep whenever a notification we haven't seen before drops in.
  // The first load for a factory only records what's already there.
  const seenIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    seenIds.current = null;
  }, [factoryId]);
  useEffect(() => {
    if (!notifications.data) return;
    const ids = notifications.data.map((n) => n.id);
    if (seenIds.current === null) {
      seenIds.current = new Set(ids);
      return;
    }
    const seen = seenIds.current;
    const arrived = notifications.data.some((n) => !n.read && !seen.has(n.id));
    ids.forEach((id) => seen.add(id));
    if (arrived) playBeep();
  }, [notifications.data]);

  const unreadCount = (notifications.data ?? []).filter((n) => !n.read).length;
  const badgeCount = unreadCount + pendingTotal;

  const markAllRead = async () => {
    const unreadIds = (notifications.data ?? []).filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .in("id", unreadIds);
    if (error) {
      toast.error(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) markAllRead();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-4 w-4" />
          {badgeCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px]"
            >
              {badgeCount > 99 ? "99+" : badgeCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {pendingItems.length > 0 && (
          <>
            <DropdownMenuLabel>Needs Your Attention</DropdownMenuLabel>
            <div className="space-y-1 p-1">
              {pendingItems.map((item) => (
                <DropdownMenuItem key={item.key} asChild>
                  <Link to={item.to} className="flex items-center justify-between gap-2 text-sm">
                    <span>{item.label}</span>
                    <Badge variant="destructive" className="shrink-0">
                      {item.count}
                    </Badge>
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(notifications.data?.length ?? 0) === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">No notifications.</p>
        ) : (
          <ScrollArea className="h-80">
            <div className="space-y-1 p-1">
              {notifications.data!.map((n) => {
                const link = linkFor(n);
                const content = (
                  <>
                    <div className="flex items-center justify-between gap-2 font-medium">
                      <span>{n.title}</span>
                      {link && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                    </div>
                    {n.body && <div className="text-xs text-muted-foreground">{n.body}</div>}
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                    </div>
                  </>
                );
                const tone = `rounded-md p-2 text-sm ${n.read ? "" : "bg-accent/50"}`;
                // With somewhere to act on it, the notification opens that page.
                return link ? (
                  <DropdownMenuItem key={n.id} asChild className={`${tone} block cursor-pointer`}>
                    <Link to={link.to} search={link.search}>
                      {content}
                    </Link>
                  </DropdownMenuItem>
                ) : (
                  <div key={n.id} className={tone}>
                    {content}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
    navigate({ to: "/", replace: true });
  };

  const initials = (email || "?").slice(0, 2).toUpperCase();

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/80 px-3 backdrop-blur">
      <SidebarTrigger className="h-9 w-9 shrink-0 border" title="Collapse / expand menu (Ctrl+B)" />
      <FactorySwitcher />
      <div className="ml-2 hidden md:flex items-center gap-2 max-w-sm w-full">
        <GlobalSearch />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <NotificationsBell />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 gap-2 px-2">
              <Avatar className="h-7 w-7">
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
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
