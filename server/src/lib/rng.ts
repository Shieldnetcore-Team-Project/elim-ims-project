/** Deterministic PRNG so mock data (and its derived KPIs) is stable across server restarts. */
export function mulberry32(seed: number): () => number {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return h;
}

export const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
export const int = (rng: () => number, min: number, max: number): number => Math.floor(min + rng() * (max - min + 1));
export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
