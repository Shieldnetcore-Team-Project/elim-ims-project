## Factory Management & Inventory System (FMIS)

This is a large enterprise system. Before I start coding, I need to align on stack and scope so I don't build the wrong thing.

### 1. Stack adjustment (important)

You asked for **Express + Prisma + standalone PostgreSQL + JWT**. This Lovable project runs on **TanStack Start (React 19 + Vite)** with **Lovable Cloud** (managed Postgres + Auth + Storage + serverless functions) as the backend. I strongly recommend we use the Lovable-native stack because:

- Everything you listed (Postgres tables, auth, RBAC, file uploads, server APIs, audit logs) is fully supported.
- No separate Express server to deploy — server logic runs as TanStack server functions.
- Auth, RLS-based row security, and storage are built in.
- All frontend requirements (React 19, TS, Tailwind, shadcn, RHF+Zod, TanStack Table/Query, Recharts, Lucide) are already in place.

Functionally identical result, dramatically less infra. I'll proceed with this unless you say otherwise.

### 2. Design direction

- Dark blue primary (`oklch` deep navy), sky blue selection state, white hover, white app background, rounded cards, clean sans typography.
- Sidebar layout with a persistent **Factory Switcher** in the top bar (Water / Nylon), stored in a global store + URL, filtering every query.
- Dark mode toggle.

### 3. Data model (Lovable Cloud / Postgres)

Tables (all scoped by `factory_id` where relevant, with RLS + factory filter):
factories, user_roles, profiles, product_categories, products, raw_materials, raw_material_movements, production, sales, sale_items, customers, suppliers, expenses, expense_categories, employees, payroll, payments_received, debts, debt_payments, inventory_movements, audit_logs, notifications, settings.

Roles enum: super_admin, factory_manager, sales_manager, sales_officer, production_manager, production_officer, inventory_manager, store_keeper, hr, payroll_officer, accountant, auditor, viewer. Stored in `user_roles` table with `has_role()` security-definer function (never on profiles).

### 4. Phased delivery

Because this is 15+ modules, I'll ship in phases. **Phase 1 in this turn**, then iterate:

**Phase 1 — Foundation (this turn)**
- Enable Lovable Cloud
- Design system (navy/sky-blue theme, tokens in `src/styles.css`)
- Auth (email/password + Google) with `/auth`, `/reset-password`
- App shell: sidebar, topbar, Factory Switcher, dark mode
- DB schema for ALL tables + RLS + roles + audit trigger
- Dashboard skeleton with KPI cards and empty charts wired to queries
- Settings (company info, prefixes, VAT, factories)

**Phase 2** — Sales (POS + invoice PDF), Customers, Debts, Payments Received
**Phase 3** — Raw Materials + movements, Production, Finished Goods, Inventory rules (no negative stock, triggers)
**Phase 4** — Expenses (+ receipt PDF), Suppliers, Employees
**Phase 5** — Payroll (+ payslip PDF)
**Phase 6** — Reports (Excel/PDF/CSV export, date ranges), Audit Log viewer, Notifications, Users & Permissions admin
**Phase 7** — Polish: global search, keyboard shortcuts, barcode/QR fields, PWA, backup/restore

### 5. Technical notes

- Stock rules enforced with Postgres triggers + `CHECK` constraints so negative stock is impossible at the DB layer.
- Auto numbers (INV-, RCP-, PRD-, EMP-) via Postgres sequences per factory + prefix from settings.
- All privileged writes go through `createServerFn` with `requireSupabaseAuth` + role checks via `has_role()`.
- Audit log written by DB triggers capturing user, time, factory, old/new JSON.
- PDFs generated client-side with a lightweight lib (pdf-lib / jspdf) from rendered templates.

### 6. Confirm before I start

Reply "go" and I'll execute Phase 1 end-to-end. If you'd rather I keep the Express/Prisma stack, say so — but Lovable can't host a separate Express server, so you'd deploy the backend elsewhere and this project would just be the React frontend.
