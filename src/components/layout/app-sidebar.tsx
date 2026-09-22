import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { usePermissions } from "@/lib/permissions";
import { nav } from "@/lib/nav";
import { usePendingAttention } from "@/lib/pending-attention";
import { Badge } from "@/components/ui/badge";

export function AppSidebar() {
  const { state, setOpen, setOpenMobile, isMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { can } = usePermissions();
  const { byUrl } = usePendingAttention();

  return (
    <Sidebar
      collapsible="icon"
      // Desktop only: expand on hover, collapse the moment the cursor
      // leaves, on top of the existing click/keyboard toggle. Mobile uses a
      // separate slide-out Sheet (see Sidebar's isMobile branch), where hover
      // doesn't apply.
      onMouseEnter={() => !isMobile && setOpen(true)}
      onMouseLeave={() => !isMobile && setOpen(false)}
    >
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center px-2 py-2">
          {collapsed ? (
            <div className="h-8 w-8 shrink-0 overflow-hidden rounded-lg bg-white">
              <img
                src="/assets/bluespring%20logo.jpeg"
                alt="Bluespring Total Connect"
                className="h-full w-full object-cover object-left"
              />
            </div>
          ) : (
            <div className="h-10 w-full overflow-hidden rounded-lg bg-white">
              <img
                src="/assets/bluespring%20logo.jpeg"
                alt="Bluespring Total Connect"
                className="h-full w-full object-contain"
              />
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        {nav.map((group) => {
          const items = group.items.filter((item) =>
            item.modules ? item.modules.some((m) => can(m)) : can(item.module),
          );
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.section}>
              {!collapsed && <SidebarGroupLabel>{group.section}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => {
                    const active = pathname === item.url || pathname.startsWith(item.url + "/");
                    const pending = byUrl.get(item.url) ?? 0;
                    return (
                      <SidebarMenuItem key={item.url}>
                        <SidebarMenuButton asChild isActive={active}>
                          <Link
                            to={item.url}
                            // On mobile the sidebar is a sheet; close it so the page shows.
                            onClick={() => setOpenMobile(false)}
                            className={
                              active
                                ? "flex items-center gap-2 bg-sidebar-accent text-sidebar-accent-foreground"
                                : "flex items-center gap-2 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
                            }
                          >
                            <span className="relative">
                              <item.icon className="h-4 w-4" />
                              {collapsed && pending > 0 && (
                                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive" />
                              )}
                            </span>
                            {!collapsed && (
                              <span className="flex flex-1 items-center justify-between gap-2">
                                <span>{item.title}</span>
                                {pending > 0 && (
                                  <Badge
                                    variant="destructive"
                                    className="h-5 min-w-5 justify-center rounded-full px-1 text-[10px]"
                                  >
                                    {pending > 99 ? "99+" : pending}
                                  </Badge>
                                )}
                              </span>
                            )}
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        {!collapsed && (
          <div className="px-2 py-2 text-[10px] text-sidebar-foreground/50">v1.0 · Phase 1</div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
