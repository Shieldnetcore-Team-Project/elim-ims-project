const dispatchPostingRemark =
  /^\d{4}-\d{2}-\d{2}:\s*posted\s+DSP-\d{8}-\d+(?:\s*,\s*DSP-\d{8}-\d+)*\s*\.?$/i;

export function visibleInvoiceRemarks(remarks: (string | null | undefined)[]): string | null {
  const visible = [
    ...new Set(
      remarks.filter(
        (remark): remark is string => !!remark && !dispatchPostingRemark.test(remark.trim()),
      ),
    ),
  ];
  return visible.join(". ") || null;
}
