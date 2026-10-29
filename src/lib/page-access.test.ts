// Run: npx tsx --test src/lib/page-access.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGES, defaultPageAccess, openAllowed, pageAllowed, type Page } from "./page-access";

const byId = (id: string) => {
  const p = PAGES.find((x) => x.id === id);
  assert.ok(p, `page ${id} exists`);
  return p as Page;
};

test("every page has its own id", () => {
  const ids = PAGES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("pages sharing a module are still separate pages", () => {
  const production = byId("Production › Production");
  const report = byId("Production › Products Report");
  assert.equal(production.module, report.module);
  // Ticking Production only, with the module allowed: Products Report hidden.
  const decisions = new Map([
    [production.id, true],
    [report.id, false],
  ]);
  const canView = () => true;
  assert.equal(pageAllowed(decisions, production, canView), true);
  assert.equal(pageAllowed(decisions, report, canView), false);
});

test("no decision follows the module, as before", () => {
  const p = byId("Production › Production");
  assert.equal(
    pageAllowed(new Map(), p, () => true),
    true,
  );
  assert.equal(
    pageAllowed(new Map(), p, () => false),
    false,
  );
});

test("a hidden page cannot be opened by typing its address", () => {
  const hidden = new Set(["Production › Products Report"]);
  const canPage = (p: Page) => !hidden.has(p.id);
  assert.equal(openAllowed("/production-report", {}, canPage), false);
  assert.equal(openAllowed("/production", {}, canPage), true);
});

test("the same route under two entries opens if either page is allowed", () => {
  const store = byId("Store › Requests");
  const warehouse = byId("Warehouse › Store requests");
  assert.equal(store.url, warehouse.url);
  const onlyWarehouse = (p: Page) => p.id === warehouse.id;
  assert.equal(openAllowed(store.url!, {}, onlyWarehouse), true);
  assert.equal(
    openAllowed(store.url!, {}, () => false),
    false,
  );
});

test("a tab page decides for its own tab only", () => {
  const issues = byId("Store › Issue preforms");
  assert.deepEqual(issues.search, { tab: "issues" });
  const onlyIssues = (p: Page) => p.id === issues.id;
  assert.equal(openAllowed("/preform-inventory", { tab: "issues" }, onlyIssues), true);
  // Preform Inventory itself (no tab) is not granted.
  assert.equal(openAllowed("/preform-inventory", {}, onlyIssues), false);
});

test("routes the menu does not list are left to their module", () => {
  assert.equal(
    openAllowed("/reset-password", {}, () => false),
    true,
  );
});

test("a new account gets only its department's pages", () => {
  const sales = defaultPageAccess("Sales", "production");
  assert.deepEqual(sales?.granted, ["Retail › POS"]);
  assert.equal(sales!.granted.length + sales!.blocked.length, PAGES.length);
  assert.ok(sales!.blocked.includes("Dashboard"));
  assert.ok(sales!.blocked.includes("Retail › Retail Outlet"));
  assert.deepEqual(sales?.viewModules, ["sales"]);

  for (const dept of ["Inventory / Warehouse", "Store"])
    assert.deepEqual(defaultPageAccess(dept, "store_officer")?.granted, [
      "Store › Raw Materials",
      "Warehouse › Stock",
    ]);
  assert.deepEqual(defaultPageAccess("Finance & Accounts", "accountant")?.granted, [
    "Finance Overview",
  ]);
  for (const dept of ["Production", "Water Factory"])
    assert.deepEqual(defaultPageAccess(dept, "production")?.granted, ["Production › Production"]);
  const admin = defaultPageAccess("Admin", "hr")!;
  assert.ok(
    admin.granted.length > 1 && admin.granted.every((id) => id.startsWith("Admin Panel ›")),
  );
});

test("no matching department falls back to the role; no match at all keeps the role's pages", () => {
  assert.deepEqual(defaultPageAccess(undefined, "accountant")?.granted, ["Finance Overview"]);
  assert.deepEqual(defaultPageAccess("Logistics", "store_officer")?.granted, [
    "Store › Raw Materials",
  ]);
  assert.equal(defaultPageAccess("", "manager"), null);
  assert.equal(defaultPageAccess("Sales", "super_admin"), null);
  assert.equal(defaultPageAccess("Sales", "chairman"), null);
});

test("every default page id is a real page", () => {
  const roles = [
    "sales",
    "inventory_officer",
    "store_officer",
    "store_keeper",
    "store_warehouse",
    "warehouse_manager",
    "accountant",
    "production",
    "qc_officer",
  ];
  const depts = ["Sales", "Store", "Finance & Accounts", "Production", "Quality Control", "Admin"];
  for (const d of [
    ...roles.map((r) => defaultPageAccess("", r)),
    ...depts.map((x) => defaultPageAccess(x, "hr")),
  ]) {
    assert.ok(d && d.granted.length > 0);
    for (const id of d.granted) byId(id);
  }
});
