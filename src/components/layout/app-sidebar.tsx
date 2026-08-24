import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarHeader, SidebarFooter, useSidebar,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard, ShoppingCart, Factory as FactoryIcon, Package, Boxes, Warehouse,
  Receipt, Wallet, Users, Truck, UserCog, FileBarChart, Settings, Shield, ScrollText, UserCheck,
  ClipboardList, Calculator, PackageCheck, CheckSquare, HandCoins, FileText, KeyRound, Workflow,
  ShieldPlus, FileStack, Landmark, Undo2,
} from "lucide-react";
import { usePermissions, type ModuleKey } from "@/lib/permissions";

type NavItem = { title: string; url: string; icon: typeof LayoutDashboard } & (
  | { module: ModuleKey; modules?: never }
  | { modules: ModuleKey[]; module?: never }
);

// Mirrors the recommended nav tree (§10): Operations / Procurement / Finance /
// Logistics / Reports / Administration. Sub-items that don't have their own
// page reuse an existing route under a department-appropriate label (e.g.
// Finance > Invoices links to the same Sales page Operations uses) rather
// than duplicating a page — see the duplicate-page audit before this change.
// "Inventory" = raw materials, "Store" = finished goods, matching the
// Inventory/Store dashboard split in §11.
const nav: { section: string; items: NavItem[] }[] = [
  { section: "Overview", items: [
    { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, module: "dashboard" },
    { title: "Approval Center", url: "/approvals", icon: CheckSquare, module: "approvals" },
  ]},
  { section: "Operations", items: [
    { title: "Sales", url: "/sales", icon: ShoppingCart, module: "sales" },
    { title: "Sales Returns", url: "/sales-returns", icon: Undo2, module: "sales" },
    { title: "Production", url: "/production", icon: FactoryIcon, module: "production" },
    { title: "Inventory", url: "/raw-materials", icon: Boxes, module: "raw-materials" },
    { title: "Store", url: "/finished-goods", icon: Package, module: "finished-goods" },
    { title: "Costing", url: "/costing", icon: Calculator, module: "costing" },
  ]},
  { section: "Procurement", items: [
    { title: "Purchase Requests", url: "/production-requests", icon: ClipboardList, module: "production-requests" },
    { title: "Purchase Orders", url: "/purchase-orders", icon: FileStack, module: "purchase-orders" },
  ]},
  { section: "Finance", items: [
    { title: "Finance Overview", url: "/finance", icon: Landmark, module: "finance" },
    { title: "Invoices", url: "/sales", icon: FileText, module: "sales" },
    { title: "Payments", url: "/cash-ledger", icon: Wallet, modules: ["payments", "receipts-payments", "cash-flow", "debts"] },
    { title: "Financial Reports", url: "/reports", icon: FileBarChart, module: "reports" },
    { title: "Expenses", url: "/expenses", icon: Receipt, module: "expenses" },
    { title: "Payroll", url: "/payroll", icon: HandCoins, module: "payroll" },
  ]},
  { section: "Logistics", items: [
    { title: "Vehicles, Drivers & Deliveries", url: "/logistics", icon: PackageCheck, module: "logistics" },
  ]},
  { section: "Reports", items: [
    { title: "All Reports", url: "/reports", icon: FileBarChart, module: "reports" },
  ]},
  { section: "Directory", items: [
    { title: "Customers", url: "/customers", icon: Users, module: "customers" },
    { title: "Suppliers", url: "/suppliers", icon: Truck, module: "suppliers" },
    { title: "Employees", url: "/employees", icon: UserCog, module: "employees" },
  ]},
  { section: "Administration", items: [
    { title: "Users", url: "/users", icon: Shield, module: "users" },
    { title: "Role Management", url: "/role-management", icon: ShieldPlus, module: "users" },
    { title: "Roles & Permissions", url: "/permissions", icon: KeyRound, module: "users" },
    { title: "Approval Workflows", url: "/approval-workflows", icon: Workflow, module: "users" },
    { title: "Account Approvals", url: "/account-approvals", icon: UserCheck, module: "account-approvals" },
    { title: "Audit Logs", url: "/audit-logs", icon: ScrollText, module: "audit-logs" },
    { title: "System Settings", url: "/settings", icon: Settings, module: "settings" },
  ]},
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { can } = usePermissions();

  return (
    <Sidebar collapsible="icon">
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
          const items = group.items.filter((item) => item.modules ? item.modules.some((m) => can(m)) : can(item.module));
          if (items.length === 0) return null;
          return (
          <SidebarGroup key={group.section}>
            {!collapsed && <SidebarGroupLabel>{group.section}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => {
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
          );
        })}
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
