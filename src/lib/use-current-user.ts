import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// The signed-in user's display name (profile full name, else their email),
// for pre-filling "recorded / inspected / requested by" fields. Shares its
// cache key with the copies on the Sales and Production pages.
export function useCurrentUserName() {
  return useQuery({
    queryKey: ["current-user-full-name"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", userData.user.id)
        .maybeSingle();
      return data?.full_name || userData.user.email || null;
    },
    staleTime: Infinity,
  });
}
