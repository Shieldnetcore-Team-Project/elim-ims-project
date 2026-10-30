import {
  LayoutDashboard,
  ShoppingCart,
  Factory as FactoryIcon,
  Receipt,
  Wallet,
  Users,
  Truck,
  Wrench,
  UserCog,
  FileBarChart,
  Calculator,
  CheckSquare,
  HandCoins,
  FileStack,
  Landmark,
  LayoutGrid,
  Warehouse,
  Store,
  ClipboardCheck,
  Settings,
  BookOpenCheck,
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
// in-page tab of that route (e.g. /accountant?tab=accounts), and
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
// Retail (sales), Production, Store and Warehouse each group several routes under one
// entry, shown as tabs on the pages. Store holds all raw materials (stocked and
// received there) and the requests queue: the Warehouse requests the materials for a
// product, and the Store approves and issues them to Production. Warehouse holds the
// stock overview and finished products. Quality Control inspects supplier deliveries
// before the Store confirms them into raw materials.
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
        url: "/retail-outlet",
        icon: ShoppingCart,
        modules: ["sales", "sales-returns"],
        tabs: [
          { label: "POS", module: "sales", url: "/sales" },
          { label: "Retail Outlet", module: "sales", url: "/retail-outlet" },
          { label: "Transaction Summary", module: "sales", url: "/retail-summary" },
          {
            label: "Posting Log",
            module: "sales",
            url: "/retail-summary",
            search: { tab: "log" },
          },
          { label: "Sales Returns", module: "sales-returns", url: "/sales-returns" },
        ],
      },
      {
        title: "Production",
        url: "/production",
        icon: FactoryIcon,
        // Production only produces with the material issued to it and releases
        // to the Warehouse; preform blowing is run by Quality Control (Good
        // bottles tab), and the Store issues preforms from Preform Inventory.
        modules: ["production", "production-requests"],
        tabs: [
          { label: "Production", module: "production", url: "/production" },
          {
            label: "Store Requests",
            module: "production-requests",
            url: "/production-requests",
          },
          { label: "Products Report", module: "production", url: "/production-report" },
        ],
      },
      {
        // Supplier deliveries (POs) and jugs, plus the good blown bottles
        // waiting to be stocked and the returnable-bottle tracking, which
        // moved here from the Warehouse. All are tabs of one page (?tab=);
        // each has a search so /quality-control itself opens for anyone with
        // one of them and the page shows only the tabs they're allowed.
        title: "Quality Control",
        url: "/quality-control",
        icon: ClipboardCheck,
        modules: ["goods-receiving", "preform-production", "distribution"],
        tabs: [
          {
            label: "Inspections",
            module: "goods-receiving",
            url: "/quality-control",
            search: { tab: "orders" },
          },
          {
            label: "Good bottles",
            module: "preform-production",
            url: "/quality-control",
            search: { tab: "good-bottles" },
          },
          {
            label: "Bottle tracking",
            module: "distribution",
            url: "/quality-control",
            search: { tab: "bottle-tracking" },
          },
        ],
      },
      {
        title: "Store",
        url: "/raw-materials",
        icon: Store,
        modules: ["raw-materials", "production-requests"],
        tabs: [
          { label: "Raw Materials", module: "raw-materials", url: "/raw-materials" },
          { label: "Preform Inventory", module: "raw-materials", url: "/preform-inventory" },
          { label: "Requests", module: "production-requests", url: "/production-requests" },
          {
            label: "Issue preforms",
            module: "preform-production",
            url: "/preform-inventory",
            search: { tab: "issues" },
          },
          { label: "Issued out", module: "raw-materials", url: "/store-issues" },
          { label: "Brands", module: "raw-materials", url: "/brands" },
        ],
      },
      {
        title: "Warehouse",
        url: "/inventory",
        icon: Warehouse,
        modules: ["finished-goods", "sales", "sales-returns", "distribution", "customers"],
        // Stock plus the goods side of order-to-cash: customer orders, returns,
        // marketer (sales rep) and outlet stock, and customers. Cash remitted,
        // credit and account balances are Accounting's (Finance → Marketer &
        // Retail Accounts), not the Warehouse's. The Stock overview has its own
        // Raw Materials / Finished Products tabs linking to the full pages, so
        // those stay out of the bar.
        tabs: [
          { label: "Stock", module: "finished-goods", url: "/inventory" },
          { label: "Store requests", module: "production-requests", url: "/production-requests" },
          { label: "Orders", module: "sales", url: "/sales" },
          { label: "Returns", module: "sales-returns", url: "/sales-returns" },
          { label: "Reps & outlet stock", module: "distribution", url: "/distribution" },
          { label: "Dispenser & jugs", module: "distribution", url: "/jug-accountability" },
          { label: "Customers", module: "customers", url: "/customers" },
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
      { title: "Accountant", url: "/accountant", icon: BookOpenCheck, module: "finance" },
      {
        title: "Payments",
        url: "/cash-ledger",
        icon: Wallet,
        modules: ["payments", "receipts-payments", "cash-flow", "debts"],
        tabs: [
          { label: "Overview", module: "cash-flow" },
          { label: "Ledger", module: "receipts-payments" },
          { label: "Debts", module: "debts" },
          { label: "Record Payments", module: "payments" },
        ],
      },
      {
        // Money owed by and collected from marketers, the retail outlet and
        // distributors (credit customers): Accounting's, not the Warehouse's.
        // Tabs are gated on finance/debts so stock-only roles don't get them;
        // the two account pages have their own modules so they can be
        // granted alone (e.g. to the warehouse manager).
        title: "Marketer & Retail Accounts",
        url: "/marketer-accounts",
        icon: HandCoins,
        modules: ["marketer-accounts", "distributor-accounts", "finance", "debts"],
        tabs: [
          {
            label: "Marketer & retail accounts",
            module: "marketer-accounts",
            url: "/marketer-accounts",
          },
          {
            label: "Distributor accounts",
            module: "distributor-accounts",
            url: "/distributor-accounts",
          },
          { label: "Credit sales (distributors)", module: "debts", url: "/credit-sales" },
          {
            label: "Postings to assess",
            module: "finance",
            url: "/accountant",
            search: { tab: "postings" },
          },
          {
            label: "Retail cash-up",
            module: "finance",
            url: "/accountant",
            search: { tab: "retail-cashup" },
          },
          {
            label: "Cash remitted",
            module: "finance",
            url: "/distribution",
            search: { tab: "remittances" },
          },
          {
            label: "Performance & commission",
            module: "finance",
            url: "/marketer-performance",
          },
        ],
      },
      { title: "Financial Reports", url: "/reports", icon: FileBarChart, module: "reports" },
      { title: "Expenses", url: "/expenses", icon: Receipt, module: "expenses" },
      { title: "Payroll", url: "/payroll", icon: HandCoins, module: "payroll" },
    ],
  },
  {
    // Replaces Logistics (2026-10-28); keeps the 'logistics' permission key
    // so existing grants carry over.
    section: "Maintenance",
    items: [{ title: "Maintenance", url: "/maintenance", icon: Wrench, module: "logistics" }],
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
      // The Admin Panel consolidates Users, Pending, Delete Requests, Deleted
      // Sales, Permissions, Audit Log, Factory and Auth Users into one tabbed
      // page to keep the sidebar short.
      // Settings gets its own entry here since nothing else links to it.
      {
        title: "Admin Panel",
        url: "/admin",
        icon: LayoutGrid,
        // Each tab is granted on its own; the entry shows for anyone with one.
        modules: [
          "users",
          "account-approvals",
          "delete-requests",
          "deleted-sales",
          "permissions",
          "audit-logs",
          "auth-users",
        ],
        tabs: [
          { label: "Users & Factory", module: "users" },
          { label: "Pending", module: "account-approvals" },
          { label: "Delete Requests", module: "delete-requests" },
          { label: "Deleted Sales", module: "deleted-sales" },
          { label: "Permissions", module: "permissions" },
          { label: "Audit Log", module: "audit-logs" },
          { label: "Auth Users", module: "auth-users" },
        ],
      },
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

// Where an entry's sidebar link goes for this user: its own url when they can
// open it, otherwise the first of its tab pages they can (Marketer & Retail
// Accounts opens on Credit sales for someone with only Debts).
export function entryUrlFor(item: NavItem, can: (m: ModuleKey) => boolean): string {
  const tabs = (item.tabs ?? []).filter((t) => t.url && !t.search);
  const own = tabs.find((t) => t.url === item.url);
  if (!own || can(own.module)) return item.url;
  return tabs.find((t) => can(t.module))?.url ?? item.url;
}
