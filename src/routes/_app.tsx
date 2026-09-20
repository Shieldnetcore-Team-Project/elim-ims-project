import { useEffect, useRef, useState } from "react";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { TopBar } from "@/components/layout/top-bar";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

// Everything under /_app needs a signed-in user. Without this guard an expired
// or cleared session rendered the full shell with an empty sidebar and an
// "Access restricted" card on every page, and a fresh sign-in could still see
// the previous (signed-out) permissions from the query cache.
function AppLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const userId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const goToLogin = () => navigate({ to: "/", replace: true });

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) return goToLogin();
      userId.current = data.session.user.id;
      setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) {
        if (event === "SIGNED_OUT") {
          userId.current = null;
          qc.clear();
          setReady(false);
          goToLogin();
        }
        return;
      }
      // A different person signed in (or first sign-in): drop everything
      // cached for the previous user, including permissions and roles.
      if (userId.current !== session.user.id) {
        userId.current = session.user.id;
        qc.clear();
      }
      setReady(true);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate, qc]);

  if (!ready) return null;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <TopBar />
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
