import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); let v = l.slice(i+1).trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1); return [l.slice(0,i).trim(), v]; })
);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const sig = "public.admin_update_profile(uuid, text, text, text, text, text)";
const { data, error } = await supabase.rpc("__temp_get_source", { p_signature: sig });
if (error) { console.error("ERROR", error.message); process.exit(1); }
const out = JSON.parse(fs.readFileSync("./__fetched_1.json", "utf8"));
out[sig] = data;
fs.writeFileSync("./__fetched_1.json", JSON.stringify(out, null, 2));
console.log("ok");
