import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // Data counts as fresh for 30 s, so moving between pages or back to the
  // window doesn't re-read everything (Disk IO, 2026-11-03). Saving anything
  // still refreshes what it touches at once (invalidateQueries), and Realtime
  // does the same for other users' changes (src/lib/realtime.ts).
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
