export const money = (n: number | null | undefined, currency = "NGN") => {
  const v = typeof n === "number" ? n : 0;
  try {
    return new Intl.NumberFormat("en-NG", { style: "currency", currency, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
};

export const num = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n ?? 0);
