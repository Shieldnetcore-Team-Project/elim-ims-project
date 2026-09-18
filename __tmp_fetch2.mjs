import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); let v = l.slice(i+1).trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1); return [l.slice(0,i).trim(), v]; })
);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const fns = [
  "public.approve_expense(uuid, text)",
  "public.reject_expense(uuid, text)",
  "public.post_expense(uuid, text)",
  "public.reverse_expense(uuid, text)",
  "public.approve_debt_writeoff(uuid, text)",
  "public.reject_debt_writeoff(uuid, text)",
  "public.post_debt_writeoff(uuid, text)",
  "public.reverse_debt_writeoff(uuid, text)",
  "public.confirm_payment(uuid, text)",
  "public.reject_payment(uuid, text)",
  "public.reverse_payment(uuid, text)",
  "public.approve_payroll(uuid, text)",
  "public.reject_payroll(uuid, text)",
  "public.post_payroll(uuid, date, text)",
  "public.reverse_payroll(uuid, text)",
  "public.approve_staff_loan(uuid, text)",
  "public.reject_staff_loan(uuid, text)",
  "public.approve_staff_deduction(uuid, text)",
  "public.reject_staff_deduction(uuid, text)",
  "public.approve_role_grant(uuid, text)",
  "public.reject_role_grant(uuid, text)",
  "public.post_role_grant(uuid, text)",
  "public.reverse_role_grant(uuid, text)",
  "public.confirm_goods_receipt(uuid, text)",
  "public.reject_goods_receipt(uuid, text)",
  "public.approve_costing_sheet(uuid, text)",
  "public.reject_costing_sheet(uuid, text)",
  "public.confirm_production_batch(uuid, numeric, numeric, numeric, text)",
  "public.reject_production_batch(uuid, text)",
  "public.approve_production_request(uuid, text)",
  "public.reject_production_request(uuid, text, text)",
  "public.approve_stock_adjustment(uuid, text)",
  "public.reject_stock_adjustment(uuid, text)",
  "public.reverse_stock_adjustment(uuid, text)",
  "public.post_stock_adjustment(uuid, text)",
  "public.approve_new_material(uuid, text)",
  "public.reject_new_material(uuid, text)",
  "public.inspect_sales_return(uuid, numeric, numeric, numeric, text)",
  "public.approve_sale(uuid, text)",
  "public.reject_sale(uuid, text)",
];

const out = JSON.parse(fs.readFileSync("./__fetched_1.json", "utf8"));
for (const f of fns) {
  const { data, error } = await supabase.rpc("__temp_get_source", { p_signature: f });
  if (error) { console.error("ERROR for", f, error.message); continue; }
  out[f] = data;
}
fs.writeFileSync("./__fetched_1.json", JSON.stringify(out, null, 2));
console.log("done, total functions:", Object.keys(out).length);
