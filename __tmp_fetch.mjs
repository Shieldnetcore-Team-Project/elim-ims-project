import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); let v = l.slice(i+1).trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1); return [l.slice(0,i).trim(), v]; })
);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const fns = [
  "public.has_permission(uuid, module_key, action_key)",
  "public.get_my_permissions()",
  "public.has_production_scope_access(uuid, uuid)",
  "public.set_production_scope(uuid, text)",
  "public.admin_update_profile(uuid, jsonb)",
  "public.admin_set_user_role(uuid, text)",
  "public.get_all_users_last_login()",
  "public.approve_delete(uuid)",
  "public.reject_delete(uuid, text)",
  "public.request_delete(text, uuid, text)",
  "public.restore_sale(uuid)",
  "public.purge_expired_deleted_sales()",
];

const out = {};
for (const f of fns) {
  const { data, error } = await supabase.rpc("__temp_get_source", { p_signature: f });
  if (error) { console.error("ERROR for", f, error.message); continue; }
  out[f] = data;
}
fs.writeFileSync("./__fetched_1.json", JSON.stringify(out, null, 2));
console.log("done, wrote", Object.keys(out).length, "functions");
