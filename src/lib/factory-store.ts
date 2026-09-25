// Only "water" exists as a factory now. This module previously read/wrote a
// "fmis.activeFactoryCode" localStorage key so users could switch between
// Water and Nylon; that's gone, but the exported API is kept so callers
// (FactorySwitcher, production scope gating, etc.) don't need to change. A
// browser with a stale "nylon" value cached from before the factory was
// removed would otherwise still try to operate in a nonexistent context.
export function setActiveFactoryCode(_code: "water") {
  // No-op: nothing to switch to.
}

export function useActiveFactoryCode(): "water" {
  return "water";
}

export function useHydratedFactoryCode(): "water" {
  return "water";
}
