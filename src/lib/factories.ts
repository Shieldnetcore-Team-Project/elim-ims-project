import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type FactoryRow = Database["public"]["Tables"]["factories"]["Row"];

let cache: FactoryRow[] | null = null;

export async function loadFactories(): Promise<FactoryRow[]> {
  if (cache) return cache;
  const { data, error } = await supabase.from("factories").select("*").order("name");
  if (error) throw error;
  cache = data ?? [];
  return cache;
}

export async function getFactoryIdByCode(code: "water" | "nylon"): Promise<string> {
  const list = await loadFactories();
  const f = list.find((x) => x.code === code);
  if (!f) throw new Error(`Factory ${code} not found`);
  return f.id;
}
