import { useQuery } from "@tanstack/react-query";
import { useResolvedFactoryCode } from "./factory-store";
import { getFactoryIdByCode } from "./factories";
import { supabase } from "@/integrations/supabase/client";

export function useFactoryId() {
  const { code, ready } = useResolvedFactoryCode();
  return useQuery({
    queryKey: ["factory-id", code],
    enabled: ready,
    queryFn: () => getFactoryIdByCode(code),
    staleTime: Infinity,
  });
}

export function useFactorySettings(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["settings", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("*")
        .eq("factory_id", factoryId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}
