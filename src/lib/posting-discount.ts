import { usePermissions } from "@/lib/permissions";

// Who may give a discount per pack on postings (set_posting_discount,
// 20261103220000): as an invoice discount -- payments or debts write.
export function useCanDiscountPostings() {
  const perms = usePermissions();
  return perms.canWrite("payments") || perms.canWrite("debts");
}
