import { useEffect, useState, useSyncExternalStore } from "react";

const KEY = "fmis.activeFactoryCode";
type Listener = () => void;
const listeners = new Set<Listener>();

function read(): "water" | "nylon" {
  if (typeof window === "undefined") return "water";
  const v = window.localStorage.getItem(KEY);
  return v === "nylon" ? "nylon" : "water";
}

export function setActiveFactoryCode(code: "water" | "nylon") {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, code);
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useActiveFactoryCode(): "water" | "nylon" {
  return useSyncExternalStore(
    subscribe,
    () => read(),
    () => "water",
  );
}

export function useHydratedFactoryCode(): "water" | "nylon" | null {
  const [c, setC] = useState<"water" | "nylon" | null>(null);
  useEffect(() => {
    setC(read());
    const un = subscribe(() => setC(read()));
    return () => {
      un();
    };
  }, []);
  return c;
}
