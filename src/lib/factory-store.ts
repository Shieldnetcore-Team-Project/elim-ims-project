import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Two factories (user, 2026-11-21): Kubwa Factory (internal code "water", the
// factory this system ran alone until now) and Lugbe Factory ("lugbe"). Every
// page reads its data for the active factory through useFactoryId().
//
// The Chairman and Admin switch between them from the dropdown beside the
// Dashboard title. Everyone else stays in Kubwa unless an Admin has allowed
// them into another factory (factory_access, read through my_factories()).
// A stored choice the account may not open is ignored, so a value left in
// the browser by someone else never opens a factory for the wrong person.
export type FactoryCode = "water" | "lugbe";

const KEY = "fmis.activeFactoryCode";
const listeners = new Set<() => void>();

function readStored(): FactoryCode {
  if (typeof window === "undefined") return "water";
  try {
    return window.localStorage.getItem(KEY) === "lugbe" ? "lugbe" : "water";
  } catch {
    return "water";
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function setActiveFactoryCode(code: FactoryCode) {
  try {
    window.localStorage.setItem(KEY, code);
  } catch {
    // Private mode etc.: the choice just won't survive a reload.
  }
  listeners.forEach((l) => l());
}

function useStoredFactoryCode(): FactoryCode {
  return useSyncExternalStore(subscribe, readStored, () => "water" as const);
}

export type MyFactory = { id: string; code: string; name: string };

// The factories the signed-in account may open (Kubwa always).
export function useMyFactories() {
  return useQuery({
    queryKey: ["my-factories"],
    queryFn: async (): Promise<MyFactory[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC added in 20261121140000, not in generated types yet
      const { data, error } = await (supabase.rpc as any)("my_factories");
      if (error) throw error;
      return (data ?? []) as MyFactory[];
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// The factory pages should work in, plus whether that is settled yet. While
// the account's factories load, a stored non-Kubwa choice isn't trusted yet
// (ready = false) so no page fetches the wrong factory's data first.
export function useResolvedFactoryCode(): { code: FactoryCode; ready: boolean } {
  const stored = useStoredFactoryCode();
  const mine = useMyFactories();
  if (stored === "water") return { code: "water", ready: true };
  if (mine.isError) return { code: "water", ready: true };
  if (!mine.data) return { code: "water", ready: false };
  return mine.data.some((f) => f.code === stored)
    ? { code: stored, ready: true }
    : { code: "water", ready: true };
}

export function useActiveFactoryCode(): FactoryCode {
  return useResolvedFactoryCode().code;
}

export function useHydratedFactoryCode(): FactoryCode {
  return useResolvedFactoryCode().code;
}

// Chairman / Admin: may switch factory from the Dashboard dropdown.
export function useCanSwitchFactory() {
  const mine = useMyFactories();
  return (mine.data?.length ?? 0) > 1;
}
