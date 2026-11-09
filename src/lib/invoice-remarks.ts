const dispatchPostingRemark =
  /^\d{4}-\d{2}-\d{2}:\s*posted\s+DSP-\d{8}-\d+(?:\s*,\s*DSP-\d{8}-\d+)*\s*\.?$/i;

// "Sachet Water: discount ₦40.00 per pack": the Warehouse's note to Accounts,
// never printed (user, 2026-11-09). The price on the line already shows it.
const perPackRemark = /^.+:\s*(?:discount|surcharge)\b.*per pack\.?$/i;

function withoutPerPackNotes(remark: string): string {
  return remark
    .split(" · ")
    .filter((part) => !perPackRemark.test(part.trim()))
    .join(" · ")
    .trim();
}

export function visibleInvoiceRemarks(remarks: (string | null | undefined)[]): string | null {
  const visible = [
    ...new Set(
      remarks
        .filter(
          (remark): remark is string => !!remark && !dispatchPostingRemark.test(remark.trim()),
        )
        .map(withoutPerPackNotes)
        .filter(Boolean),
    ),
  ];
  return visible.join(". ") || null;
}
