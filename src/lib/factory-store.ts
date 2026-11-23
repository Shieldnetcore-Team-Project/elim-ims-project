import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Two factories (user, 2026-11-21): Kubwa Factory (internal code "water", the
// factory this system ran alone until now) and Lugbe Factory ("lugbe"). Every
// page reads its data for the active factory through useFactoryId().
//
// Every account is created under one of them (its home factory) and opens
// there. The Chairman and Admin switch between them from the dropdown beside
// the Dashboard title; anyone else only once an Admin has allowed them into
// the other factory (factory_access, read through my_factories()).
// A stored choice the account may not open is ignored, so a value left in
// the browser by someone else never opens a factory for the wrong person.
export type FactoryCode = "water" | "lugbe";

const KEY = "fmis.activeFactoryCode";
const listeners = new Set<() => void>();

// null = nothing chosen in this browser yet: the account's home factory.
function readStored(): FactoryCode | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "lugbe" || v === "water" ? v : null;
  } catch {
    return null;
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

function useStoredFactoryCode(): FactoryCode | null {
  return useSyncExternalStore(subscribe, readStored, () => null);
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

// The factory pages should work in, plus whether that is settled yet. Every
// account belongs to a factory (profiles.active_factory_id, 2026-11-23), which
// my_factories() lists first. A choice stored in this browser is used only if
// the account may open that factory; otherwise its home factory. Until the
// list loads nothing is trusted (ready = false), so no page fetches the wrong
// factory's data first.
export function useResolvedFactoryCode(): { code: FactoryCode; ready: boolean } {
  const stored = useStoredFactoryCode();
  const mine = useMyFactories();
  if (mine.isError) return { code: "water", ready: true };
  if (!mine.data) return { code: stored ?? "water", ready: false };
  if (stored && mine.data.some((f) => f.code === stored)) return { code: stored, ready: true };
  return { code: mine.data[0]?.code === "lugbe" ? "lugbe" : "water", ready: true };
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
