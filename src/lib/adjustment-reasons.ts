export const ADJUSTMENT_REASONS = [
  "Physical stock count correction",
  "Damaged material",
  "Spillage",
  "Counting error",
  "Supplier short delivery",
  "Data correction",
  "Expired material",
  "Other",
] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
