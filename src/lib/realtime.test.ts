// Run: npx tsx --test --experimental-test-module-mocks src/lib/realtime.test.ts
// One channel per table shared by every watcher, and a burst of change events
// refreshes each query once (src/lib/realtime.ts).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { QueryClient } from "@tanstack/react-query";

type Handler = () => void;
const channels: { topic: string; handlers: Handler[]; removed: boolean }[] = [];
const fakeSupabase = {
  channel(topic: string) {
    const ch = { topic, handlers: [] as Handler[], removed: false };
    channels.push(ch);
    const api = {
      on(_e: string, _f: unknown, h: Handler) {
        ch.handlers.push(h);
        return api;
      },
      subscribe() {
        return api;
      },
      _ch: ch,
    };
    return api;
  },
  removeChannel(api: { _ch: { removed: boolean } }) {
    api._ch.removed = true;
    return Promise.resolve("ok");
  },
};
mock.module("@/integrations/supabase/client", { namedExports: { supabase: fakeSupabase } });

test("shared channel per table, one refresh per burst, closed when unused", async () => {
  const { watch } = await import("./realtime");
  const calls: string[] = [];
  const qc = {
    invalidateQueries: (o: { queryKey: unknown[] }) => {
      calls.push(JSON.stringify(o.queryKey));
      return Promise.resolve();
    },
  } as unknown as QueryClient;

  // The sidebar and the top bar both watch "sales" (as useRealtimeInvalidate does).
  const a = { qc, keys: () => [["a"]] };
  const b = { qc, keys: () => [["b"], ["a"]] };
  const stops = [watch("sales", a), watch("payments_received", a), watch("sales", b)];

  const sales = channels.filter((c) => c.topic.startsWith("live:sales:"));
  assert.equal(sales.length, 1, "one channel for sales, shared by both");
  assert.equal(channels.length, 2, "sales + payments_received");

  // One posting: several rows change at once.
  for (let i = 0; i < 5; i++) sales[0].handlers.forEach((h) => h());
  channels[1].handlers.forEach((h) => h());
  assert.equal(calls.length, 0, "nothing until the batch flushes");
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(calls.sort(), ['["a"]', '["b"]'], "each key refreshed once for the burst");

  // A later change is still picked up.
  sales[0].handlers.forEach((h) => h());
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(calls.length, 4, "the next event refreshes again");

  stops[0]();
  assert.equal(sales[0].removed, false, "still watched by the other hook");
  stops.slice(1).forEach((s) => s());
  assert.ok(
    channels.every((c) => c.removed),
    "channels closed when nothing watches them",
  );

  // Watching again opens a fresh channel.
  const stop = watch("sales", a);
  assert.equal(channels.filter((c) => c.topic.startsWith("live:sales:")).length, 2);
  stop();
});
