import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarHeader, SidebarFooter, useSidebar,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard, ShoppingCart, Factory as FactoryIcon, Package, Boxes, Warehouse,
  Receipt, Wallet, HandCoins, Users, Truck, UserCog, FileBarChart, Settings, Shield, ScrollText, Factory,
} from "lucide-react";

const nav = [
  { section: "Overview", items: [
    { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  ]},
  { section: "Operations", items: [
    { title: "Sales / POS", url: "/sales", icon: ShoppingCart },
    { title: "Production", url: "/production", icon: FactoryIcon },
    { title: "Raw Materials", url: "/raw-materials", icon: Boxes },
    { title: "Finished Goods", url: "/finished-goods", icon: Package },
    { title: "Inventory", url: "/inventory", icon: Warehouse },
    { title: "Expenses", url: "/expenses", icon: Receipt },
    { title: "Payroll", url: "/payroll", icon: Wallet },
    { title: "Payments Received", url: "/payments", icon: HandCoins },
    { title: "Debts", url: "/debts", icon: ScrollText },
  ]},
  { section: "Directory", items: [
    { title: "Customers", url: "/customers", icon: Users },
    { title: "Suppliers", url: "/suppliers", icon: Truck },
    { title: "Employees", url: "/employees", icon: UserCog },
  ]},
  { section: "System", items: [
    { title: "Reports", url: "/reports", icon: FileBarChart },
    { title: "Users", url: "/users", icon: Shield },
    { title: "Audit Logs", url: "/audit-logs", icon: ScrollText },
    { title: "Settings", url: "/settings", icon: Settings },
  ]},
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Factory className="h-4 w-4" />
          </div>
          {!collapsed && (
            <div className="leading-tight">
              <div className="font-semibold text-sidebar-foreground">FMIS</div>
              <div className="text-[10px] uppercase tracking-wider text-sidebar-foreground/60">Factory & Inventory</div>
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        {nav.map((group) => (
          <SidebarGroup key={group.section}>
            {!collapsed && <SidebarGroupLabel>{group.section}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = pathname === item.url || pathname.startsWith(item.url + "/");
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton asChild isActive={active}>
                        <Link
                          to={item.url}
                          className={
                            active
                              ? "flex items-center gap-2 bg-sidebar-accent text-sidebar-accent-foreground"
                              : "flex items-center gap-2 hover:bg-white hover:text-sidebar"
                          }
                        >
                          <item.icon className="h-4 w-4" />
                          {!collapsed && <span>{item.title}</span>}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        {!collapsed && (
          <div className="px-2 py-2 text-[10px] text-sidebar-foreground/50">
            v1.0 · Phase 1
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
