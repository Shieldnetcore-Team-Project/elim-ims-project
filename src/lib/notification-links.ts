// Where a notification in the bell takes the user: the page on which its
// approval, confirmation or follow-up is done. Notifications are stored as a
// title and a body only (public.notifications), so the page is worked out
// from the title the database writes, and for deletions from the record type
// at the start of the body ('Suppliers "Prima" was deleted.').

export type NotificationLink = { to: string; search?: Record<string, string> };

// The record types request_delete() accepts, as initcap(table_name) writes
// them, and the page that lists each.
const DELETED_RECORD_PAGES: Record<string, string> = {
  suppliers: "/suppliers",
  employees: "/employees",
  "employee documents": "/employees",
  "sales reps": "/distribution",
  vehicles: "/logistics",
  drivers: "/logistics",
  expenses: "/expenses",
  "cash transactions": "/cash-ledger",
  "product units": "/finished-goods",
  sales: "/sales",
};

// 'Suppliers "Prima" was deleted.' -> "/suppliers"
function deletedRecordPage(body: string | null | undefined): string | null {
  const kind = /^([^"]+?)\s*"/
    .exec(body ?? "")?.[1]
    ?.trim()
    .toLowerCase();
  return (kind && DELETED_RECORD_PAGES[kind]) || null;
}

// entityType: for "Stock adjustment awaiting approval", whether the
// adjustment (looked up by the reference at the start of the body) is a raw
// material or a finished good.
export function notificationLink(
  title: string,
  body?: string | null,
  entityType?: "raw_material" | "finished_good" | null,
): NotificationLink | null {
  switch (title) {
    case "Stock adjustment awaiting approval":
      return { to: entityType === "raw_material" ? "/raw-materials" : "/finished-goods" };
    case "Deletion requested":
      return { to: "/admin", search: { tab: "delete-requests" } };
    case "Deletion approved":
    case "Deletion rejected": {
      const page = deletedRecordPage(body);
      return page ? { to: page } : null;
    }
    case "Account approved":
    case "Account created":
    case "Sample data loaded":
      return { to: "/dashboard" };
    default:
      return null;
  }
}

// "ADJ-20261023-80858 — Prima (+985320) — ..." -> "ADJ-20261023-80858"
export const adjustmentReference = (body: string | null | undefined) =>
  /^(ADJ-\d{8}-\d+)/.exec(body ?? "")?.[1] ?? null;
