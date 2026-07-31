/** 'reorderPoint' -> 'Reorder point', 'staff_id' -> 'Staff id' — derives a label for a
 *  field key that has no explicit one. */
export function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** 'Roles & permissions' -> unchanged (compound labels don't singularize cleanly);
 *  'Sales' -> 'sale' — best-effort singular for "New <thing>" button/dialog copy. */
export function singularLabel(label: string): string {
  const lower = label.toLowerCase();
  return lower.includes('&') ? lower : lower.replace(/s$/, '');
}
