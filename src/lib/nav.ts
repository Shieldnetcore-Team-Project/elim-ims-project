import {
  LayoutDashboard,
  ShoppingCart,
  Factory as FactoryIcon,
  Receipt,
  Wallet,
  Users,
  Truck,
  UserCog,
  FileBarChart,
  Calculator,
  PackageCheck,
  CheckSquare,
  HandCoins,
  FileStack,
  Landmark,
  LayoutGrid,
  Warehouse,
  ClipboardCheck,
  Settings,
} from "lucide-react";
import { type ModuleKey } from "@/lib/permissions";

// The app's navigation tree. Lives here rather than in app-sidebar.tsx so the
// sidebar and the per-user "Page access" grid on the Roles & Permissions page
// read the same definition instead of keeping copies that could drift.
// `tabs` names the real sub-tab (or independently-grantable action) behind
// each module in `modules`, purely for the per-user Page Access grid
// (src/components/permissions/user-page-access.tsx) to render a page's tabs
// nested under it. It's optional and additive -- `modules` alone still drives
// sidebar visibility (app-sidebar.tsx), so leaving `tabs` off changes nothing.
// A tab with a `url` is its own route: those pages render the tabs as a
// SectionTabs bar (src/components/layout/section-tabs.tsx), and the sidebar
// keeps the parent entry highlighted on any of them. `search` targets one
// in-page tab of that route (e.g. /distribution?tab=accounts), and
// `inBar: false` keeps a route grouped under the entry (highlight, badges)
// without showing it in the tab bar.
export type NavTab = {
  label: string;
  module: ModuleKey;
  url?: string;
  search?: Record<string, string>;
  inBar?: boolean;
};

// A page can sit under more than one entry (Orders is in both Retail and
// Warehouse). Links carry the entry they were followed from in history state,
// so the sidebar highlight and the page's tab bar stay with that entry.
declare module "@tanstack/history" {
  interface HistoryState {
    section?: string;
  }
}

export type NavItem = { title: string; url: string; icon: typeof LayoutDashboard } & (
  | { module: ModuleKey; modules?: never; tabs?: never }
  | {
      modules: ModuleKey[];
      module?: never;
      tabs?: NavTab[];
    }
);

// Mirrors the recommended nav tree (§10): Operations / Procurement / Finance /
// Logistics / Reports / Administration. Sub-items that don't have their own
// page reuse an existing route under a department-appropriate label rather
// than duplicating a page — see the duplicate-page audit before this change.
// (Finance used to carry an "Invoices" entry that just re-pointed at Sales;
// removed as a redundant duplicate link rather than a real page.)
// Retail (sales), Production and Warehouse each group several routes under one entry,
// shown as tabs on the pages. Warehouse holds the read-only overview plus raw
// materials and finished products (formerly "Inventory Overview", "Inventory"
// and "Store" in the sidebar). Quality Control inspects supplier deliveries
// before the warehouse confirms them into raw materials.
export const nav: { section: string; items: NavItem[] }[] = [
  {
    section: "Overview",
    items: [
      { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, module: "dashboard" },
      { title: "Approval Center", url: "/approvals", icon: CheckSquare, module: "approvals" },
    ],
  },
  {
    section: "Operations",
    items: [
      {
        title: "Retail",
        url: "/sales",
        icon: ShoppingCart,
        modules: ["sales", "sales-returns"],
        tabs: [
          { label: "Sales & POS", module: "sales", url: "/sales" },
          { label: "Sales Returns", module: "sales-returns", url: "/sales-returns" },
        ],
      },
      {
        title: "Production",
        url: "/production",
        icon: FactoryIcon,
        modules: ["production", "production-requests"],
        tabs: [
          { label: "Production", module: "production", url: "/production" },
          {
            label: "Production Requests",
            module: "production-requests",
            url: "/production-requests",
          },
        ],
      },
      {
        title: "Quality Control",
        url: "/quality-control",
        icon: ClipboardCheck,
        module: "goods-receiving",
      },
      {
        title: "Warehouse",
        url: "/inventory",
        icon: Warehouse,
        modules: [
          "raw-materials",
          "finished-goods",
          "sales",
          "sales-returns",
          "distribution",
          "debts",
          "customers",
        ],
        // Stock plus the order-to-cash screens: customer orders, returns,
        // marketer (sales rep) van stock and reconciliation, credit sales and
        // customers. The Stock overview has its own Raw Materials / Finished
        // Products tabs linking to the full pages, so those stay out of the bar.
        tabs: [
          { label: "Stock", module: "raw-materials", url: "/inventory" },
          { label: "Orders", module: "sales", url: "/sales" },
          { label: "Returns", module: "sales-returns", url: "/sales-returns" },
          { label: "Marketer stock", module: "distribution", url: "/distribution" },
          {
            label: "Reconciliation",
            module: "distribution",
            url: "/distribution",
            search: { tab: "accounts" },
          },
          { label: "Credit sales", module: "debts", url: "/credit-sales" },
          {
            label: "Performance & commission",
            module: "distribution",
            url: "/marketer-performance",
          },
          { label: "Bottle tracking", module: "distribution", url: "/bottle-tracking" },
          { label: "Customers", module: "customers", url: "/customers" },
          { label: "Raw Materials", module: "raw-materials", url: "/raw-materials", inBar: false },
          {
            label: "Finished Products",
            module: "finished-goods",
            url: "/finished-goods",
            inBar: false,
          },
        ],
      },
      { title: "Distribution", url: "/distribution", icon: Truck, module: "distribution" },
      { title: "Costing", url: "/costing", icon: Calculator, module: "costing" },
    ],
  },
  {
    section: "Procurement",
    items: [
      {
        title: "Procurement",
        url: "/procurement",
        icon: FileStack,
        modules: ["production-requests", "purchase-orders"],
        tabs: [
          { label: "Purchase Requests", module: "production-requests" },
          { label: "Purchase Orders", module: "purchase-orders" },
        ],
      },
    ],
  },
  {
    section: "Finance",
    items: [
      { title: "Finance Overview", url: "/finance", icon: Landmark, module: "finance" },
      {
        title: "Payments",
        url: "/cash-ledger",
        icon: Wallet,
        modules: ["payments", "receipts-payments", "cash-flow", "debts"],
        tabs: [
          { label: "Overview", module: "cash-flow" },
          { label: "Ledger", module: "receipts-payments" },
          { label: "Debts", module: "debts" },
          { label: "Record & Approve Payments", module: "payments" },
        ],
      },
      { title: "Financial Reports", url: "/reports", icon: FileBarChart, module: "reports" },
      { title: "Expenses", url: "/expenses", icon: Receipt, module: "expenses" },
      { title: "Payroll", url: "/payroll", icon: HandCoins, module: "payroll" },
    ],
  },
  {
    section: "Logistics",
    items: [
      {
        title: "Vehicles, Drivers & Deliveries",
        url: "/logistics",
        icon: PackageCheck,
        module: "logistics",
      },
    ],
  },
  {
    section: "Reports",
    items: [{ title: "All Reports", url: "/reports", icon: FileBarChart, module: "reports" }],
  },
  {
    section: "Directory",
    items: [
      { title: "Customers", url: "/customers", icon: Users, module: "customers" },
      { title: "Suppliers", url: "/suppliers", icon: Truck, module: "suppliers" },
      { title: "Employees", url: "/employees", icon: UserCog, module: "employees" },
    ],
  },
  {
    section: "Administration",
    items: [
      // The Admin Panel consolidates Users, Pending, Permissions, Audit Log,
      // and Auth Users into one tabbed page to keep the sidebar short.
      // Settings gets its own entry here since nothing else links to it.
      { title: "Admin Panel", url: "/admin", icon: LayoutGrid, module: "users" },
      { title: "System Settings", url: "/settings", icon: Settings, module: "settings" },
    ],
  },
];

const navItems = nav.flatMap((g) => g.items);

// Every route an entry covers: its own url plus its tabs' urls.
export function itemUrls(item: NavItem): string[] {
  return [...new Set([item.url, ...(item.tabs ?? []).flatMap((t) => t.url ?? [])])];
}

const covers = (item: NavItem, pathname: string) =>
  itemUrls(item).some((u) => pathname === u || pathname.startsWith(u + "/"));

// The sidebar entry a page is being viewed under. The entry the user came from
// (history state) wins when it covers the page; otherwise the entry whose own
// url this is, then the first entry that covers it.
export function activeNavTitle(pathname: string, fromSection?: string): string | undefined {
  const owners = navItems.filter((i) => covers(i, pathname));
  if (fromSection && owners.some((i) => i.title === fromSection)) return fromSection;
  return (owners.find((i) => i.url === pathname) ?? owners[0])?.title;
}

export function navItemByTitle(title: string): NavItem | undefined {
  return navItems.find((i) => i.title === title);
}
