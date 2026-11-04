import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";

import appCss from "../styles.css?url";

// The splash comes off whatever the app shows -- a page, "not found" or the
// error screen -- so an error is never hidden behind "Loading your
// workspace…" (2026-11-04).
function useRemoveSplash() {
  useEffect(() => {
    const splash = document.getElementById("app-splash");
    if (!splash) return;
    splash.style.transition = "opacity 300ms ease";
    splash.style.opacity = "0";
    const timer = setTimeout(() => splash.remove(), 300);
    return () => clearTimeout(timer);
  }, []);
}

// Runs before the app's code: after a new deploy an open tab can ask for app
// files that no longer exist, and the app never starts. Such a load failure
// reloads the page once (fresh files); and if the app still hasn't started
// after 15 seconds, the splash offers a Reload button.
const SPLASH_GUARD = `(function(){
  var KEY = "elim-reloaded-at";
  function reloadOnce() {
    try {
      var last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 60000) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch (e) {}
    location.reload();
  }
  function isLoadFailure(msg) {
    return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i.test(msg || "");
  }
  window.addEventListener("error", function (e) {
    var t = e && e.target;
    if (t && (t.tagName === "SCRIPT" || t.tagName === "LINK")) reloadOnce();
    else if (e && isLoadFailure(e.message)) reloadOnce();
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    if (isLoadFailure(r && (r.message || String(r)))) reloadOnce();
  });
  setTimeout(function () {
    var s = document.getElementById("app-splash");
    if (!s || document.getElementById("app-splash-slow")) return;
    var d = document.createElement("div");
    d.id = "app-splash-slow";
    d.style.cssText = "text-align:center;color:rgba(255,255,255,.8);font:14px system-ui,sans-serif";
    d.innerHTML = 'Taking longer than usual.<br><button style="margin-top:10px;padding:8px 18px;border-radius:8px;border:0;background:#38bdf8;color:#0b1b3a;font-weight:600;cursor:pointer">Reload</button>';
    d.querySelector("button").onclick = function () { location.reload(); };
    s.appendChild(d);
  }, 15000);
})();`;

function NotFoundComponent() {
  useRemoveSplash();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  useRemoveSplash();
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Elim Table Water — Factory Management & Inventory System" },
      {
        name: "description",
        content:
          "Enterprise inventory, sales, production, payroll, and reporting for the Water Factory.",
      },
      {
        property: "og:title",
        content: "Elim Table Water — Factory Management & Inventory System",
      },
      {
        property: "og:description",
        content:
          "One platform for the factory. Secure roles, real-time dashboards, complete audit history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      },
      { rel: "icon", href: "/assets/elim-logo.png", type: "image/png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {/* Server-rendered, so this paints the instant the HTML arrives —
            before the JS bundle loads — masking the real page underneath
            until the app has hydrated. RootComponent's effect fades and
            removes it once React takes over; the <noscript> rule below
            keeps a no-JS visitor from being stuck behind it forever. */}
        <div
          id="app-splash"
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-6 bg-sidebar"
        >
          <div className="h-28 w-56 overflow-hidden rounded-2xl bg-white p-3 shadow-lg animate-pulse">
            <img
              src="/assets/elim-logo.png"
              alt="Elim Table Water"
              className="h-full w-full object-contain"
            />
          </div>
          <p className="text-sm text-sidebar-foreground/70">Loading your workspace…</p>
        </div>
        <noscript>
          <style>{`#app-splash { display: none; }`}</style>
        </noscript>
        <script dangerouslySetInnerHTML={{ __html: SPLASH_GUARD }} />
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  useRemoveSplash();

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
