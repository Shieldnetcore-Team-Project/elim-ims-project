// Run: npx tsx --test src/lib/page-access.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGES, openAllowed, pageAllowed, type Page } from "./page-access";

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
  assert.equal(openAllowed("/preform-production", { tab: "issues" }, onlyIssues), true);
  // Preform Blowing itself (no tab) is not granted.
  assert.equal(openAllowed("/preform-production", {}, onlyIssues), false);
});

test("routes the menu does not list are left to their module", () => {
  assert.equal(
    openAllowed("/reset-password", {}, () => false),
    true,
  );
});
