// Run: npx tsx --test src/lib/notification-links.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustmentReference, notificationLink } from "./notification-links";

test("stock adjustments open the page they are approved on", () => {
  const body = "ADJ-20261023-80858 — Prima (+985320) — Physical stock count correction";
  assert.equal(adjustmentReference(body), "ADJ-20261023-80858");
  assert.deepEqual(notificationLink("Stock adjustment awaiting approval", body, "raw_material"), {
    to: "/raw-materials",
  });
  assert.deepEqual(notificationLink("Stock adjustment awaiting approval", body, "finished_good"), {
    to: "/finished-goods",
  });
});

test("deletion requests open the Admin Panel's Delete Requests tab", () => {
  assert.deepEqual(
    notificationLink("Deletion requested", 'Suppliers "Prima" — reason: duplicate'),
    {
      to: "/admin",
      search: { tab: "delete-requests" },
    },
  );
});

test("deletion outcomes open the record's page", () => {
  assert.deepEqual(notificationLink("Deletion approved", 'Suppliers "Prima" was deleted.'), {
    to: "/suppliers",
  });
  assert.deepEqual(
    notificationLink("Deletion rejected", 'Sales Reps "Ade" was not deleted: still active'),
    { to: "/distribution" },
  );
  assert.equal(notificationLink("Deletion approved", "Something else"), null);
});

test("notifications with nothing to do have no link", () => {
  assert.equal(notificationLink("Account registration declined"), null);
  assert.equal(notificationLink("Some other message"), null);
});
