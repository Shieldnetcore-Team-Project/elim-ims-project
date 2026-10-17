import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Loader2, Search } from "lucide-react";
import { RepDetailsDialog, type Rep } from "@/routes/_app.distribution";
import { CustomerProfileDialog } from "@/routes/_app.customers";

type CustomerHit = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  registered: boolean;
  total_purchases: number;
  outstanding_balance: number;
};

const MIN_CHARS = 2;

// Top-bar search. From the second letter typed, matching marketers, the
// retail shop and customers drop down as you type -- no Enter needed. Picking
// a marketer opens their account and activity; a customer opens their
// profile. Each group shows only to whoever can open that page.
export function GlobalSearch() {
  const { data: factoryId } = useFactoryId();
  const { can } = usePermissions();
  const canReps = can("distribution");
  const canCustomers = can("customers");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rep, setRep] = useState<Rep | null>(null);
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Wait for a short pause in typing before searching.
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);

  // Close the list on a click anywhere else.
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const enabled = !!factoryId && term.length >= MIN_CHARS && (canReps || canCustomers);
  // Characters that would break the filter syntax become spaces; % and _ are
  // escaped so they match literally.
  const like = `%${term.replace(/[,()"]/g, " ").replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const results = useQuery({
    queryKey: ["global-search", factoryId, term, canReps, canCustomers],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const [reps, customers] = await Promise.all([
        canReps
          ? supabase
              .from("sales_reps")
              .select("id,code,full_name,phone,status,employee_id,remarks,kind")
              .eq("factory_id", factoryId!)
              .or(`full_name.ilike.${like},code.ilike.${like},phone.ilike.${like}`)
              .order("full_name")
              .limit(8)
          : Promise.resolve({ data: [], error: null }),
        canCustomers
          ? supabase
              .from("customers")
              .select("id,name,phone,email,address,registered,total_purchases,outstanding_balance")
              .eq("factory_id", factoryId!)
              .or(`name.ilike.${like},phone.ilike.${like}`)
              .order("name")
              .limit(8)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (reps.error) throw reps.error;
      if (customers.error) throw customers.error;
      return {
        reps: (reps.data ?? []) as Rep[],
        customers: (customers.data ?? []) as unknown as CustomerHit[],
      };
    },
  });

  const hits: ({ type: "rep"; rep: Rep } | { type: "customer"; customer: CustomerHit })[] = [
    ...(results.data?.reps ?? []).map((r) => ({ type: "rep" as const, rep: r })),
    ...(results.data?.customers ?? []).map((c) => ({ type: "customer" as const, customer: c })),
  ];

  const pick = (i: number) => {
    const h = hits[i];
    if (!h) return;
    if (h.type === "rep") setRep(h.rep);
    else setCustomer(h.customer);
    setOpen(false);
    setQ("");
  };

  const showList = open && q.trim().length >= MIN_CHARS;

  return (
    <div ref={boxRef} className="relative w-full">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Search marketers, customers…"
        className="h-9 pl-8"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(active);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showList && (
        <div className="absolute left-0 right-0 top-10 z-50 max-h-80 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {(results.isLoading || term !== q.trim()) && hits.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : hits.length === 0 ? (
            <div className="px-2 py-3 text-sm text-muted-foreground">
              {canReps || canCustomers ? "No matches." : "Nothing you can search here."}
            </div>
          ) : (
            hits.map((h, i) => (
              <button
                key={h.type === "rep" ? `r-${h.rep.id}` : `c-${h.customer.id}`}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm ${
                  i === active ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span className="truncate">
                  {h.type === "rep" ? h.rep.full_name : h.customer.name}
                  {(h.type === "rep" ? h.rep.phone : h.customer.phone) && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {h.type === "rep" ? h.rep.phone : h.customer.phone}
                    </span>
                  )}
                </span>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {h.type === "rep"
                    ? h.rep.kind === "outlet"
                      ? "Retail outlet"
                      : "Marketer"
                    : h.customer.registered
                      ? "Distributor"
                      : "Customer"}
                </Badge>
              </button>
            ))
          )}
        </div>
      )}

      <Dialog open={!!rep} onOpenChange={(v) => !v && setRep(null)}>
        {rep && factoryId && <RepDetailsDialog factoryId={factoryId} rep={rep} />}
      </Dialog>
      <Dialog open={!!customer} onOpenChange={(v) => !v && setCustomer(null)}>
        {customer && <CustomerProfileDialog customer={customer as never} />}
      </Dialog>
    </div>
  );
}
