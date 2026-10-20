import { useEffect } from "react";
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

// Pre-fills a "requested / recorded / issued / approved by" name field with
// the signed-in user's name as soon as it loads, so nobody has to type their
// own name. Only fills an empty field and only once the name arrives, so it
// never overwrites what the user typed or a name already saved on a record.
export function useAutofillUserName(value: string, setValue: (name: string) => void) {
  const me = useCurrentUserName();
  useEffect(() => {
    if (!value && me.data) setValue(me.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fill once, when the name arrives
  }, [me.data]);
}

// The signed-in user's department (profiles.department), set when their
// account was approved or later in Admin → Users.
export function useCurrentUserDepartment() {
  return useQuery({
    queryKey: ["current-user-department"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return null;
      const { data } = await supabase
        .from("profiles")
        .select("department")
        .eq("id", userData.user.id)
        .maybeSingle();
      return data?.department || null;
    },
    staleTime: Infinity,
  });
}

// Same as useAutofillUserName, for a "Department" field.
export function useAutofillUserDepartment(value: string, setValue: (department: string) => void) {
  const dept = useCurrentUserDepartment();
  useEffect(() => {
    if (!value && dept.data) setValue(dept.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fill once, when the department arrives
  }, [dept.data]);
}
