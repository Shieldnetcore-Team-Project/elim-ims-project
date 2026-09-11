import {
  LayoutDashboard,
  ShoppingCart,
  Factory as FactoryIcon,
  Package,
  Boxes,
  Receipt,
  Wallet,
  Users,
  Truck,
  UserCog,
  FileBarChart,
  ClipboardList,
  Calculator,
  PackageCheck,
  CheckSquare,
  HandCoins,
  FileText,
  FileStack,
  Landmark,
  Undo2,
  LayoutGrid,
} from "lucide-react";
import { type ModuleKey } from "@/lib/permissions";

// The app's navigation tree. Lives here rather than in app-sidebar.tsx so the
// sidebar and the per-user "Page access" grid on the Roles & Permissions page
// read the same definition instead of keeping copies that could drift.
export type NavItem = { title: string; url: string; icon: typeof LayoutDashboard } & (
  { module: ModuleKey; modules?: never } | { modules: ModuleKey[]; module?: never }
);

// Mirrors the recommended nav tree (§10): Operations / Procurement / Finance /
// Logistics / Reports / Administration. Sub-items that don't have their own
// page reuse an existing route under a department-appropriate label (e.g.
// Finance > Invoices links to the same Sales page Operations uses) rather
// than duplicating a page — see the duplicate-page audit before this change.
// "Inventory" = raw materials, "Store" = finished goods, matching the
// Inventory/Store dashboard split in §11.
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
      { title: "Sales", url: "/sales", icon: ShoppingCart, module: "sales" },
      { title: "Sales Returns", url: "/sales-returns", icon: Undo2, module: "sales" },
      { title: "Production", url: "/production", icon: FactoryIcon, module: "production" },
      { title: "Inventory", url: "/raw-materials", icon: Boxes, module: "raw-materials" },
      { title: "Store", url: "/finished-goods", icon: Package, module: "finished-goods" },
      { title: "Distribution", url: "/distribution", icon: Truck, module: "distribution" },
      { title: "Costing", url: "/costing", icon: Calculator, module: "costing" },
    ],
  },
  {
    section: "Procurement",
    items: [
      {
        title: "Purchase Requests",
        url: "/production-requests",
        icon: ClipboardList,
        module: "production-requests",
      },
      {
        title: "Purchase Orders",
        url: "/purchase-orders",
        icon: FileStack,
        module: "purchase-orders",
      },
    ],
  },
  {
    section: "Finance",
    items: [
      { title: "Finance Overview", url: "/finance", icon: Landmark, module: "finance" },
      { title: "Invoices", url: "/sales", icon: FileText, module: "sales" },
      {
        title: "Payments",
        url: "/cash-ledger",
        icon: Wallet,
        modules: ["payments", "receipts-payments", "cash-flow", "debts"],
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
      // Individual admin pages (Users, Role Management, Roles & Permissions,
      // Approval Workflows, Account Approvals, Audit Logs, System Settings) are
      // reached from inside the Admin Panel to keep the sidebar short.
      { title: "Admin Panel", url: "/admin", icon: LayoutGrid, module: "users" },
    ],
  },
];
