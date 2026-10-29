import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Search } from "lucide-react";
import { BagQty } from "@/components/shared/bag-quantity";
import { brandDetail } from "@/components/shared/brand-picker";
import { ReportActions } from "@/components/shared/report-actions";
import { detectPack, formatBags, packWord, splitBags } from "@/lib/preform-units";
import { num } from "@/lib/format";

// Store → Issued out: everything the Store issued to other departments,
// newest first, read from the raw-material ledger:
//   * Issue Stock -> Production / Quality Control (issued_to_department,
//     20261020160000), with QC's confirmation (qc_store_receipts,
//     20261023160000), or to the Lugbe / Jos sites (20261029100000; who
//     collected it is in the reason);
//   * Issue preforms -> Preform Blowing ('transferred' lines, reference
//     PFI-..., with the operator and their answer on preform_issues);
//   * older issues made before departments were recorded.

export const Route = createFileRoute("/_app/store-issues")({
  head: () => ({
    meta: [{ title: "Issued Out — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <>
      <SectionTabs section="Store" />
      <RequireAccess module="raw-materials">
        <StoreIssuesPage />
      </RequireAccess>
    </>
  ),
});

type Department = "production" | "quality_control" | "preform_blowing" | "lugbe" | "jos" | "other";
const DEPARTMENT_LABEL: Record<Department, string> = {
  production: "Production",
  quality_control: "Quality Control",
  preform_blowing: "Preform Blowing",
  lugbe: "Lugbe",
  jos: "Jos",
  other: "Other / not recorded",
};
// Recorded on the issue itself (issued_to_department).
const RECORDED: string[] = ["production", "quality_control", "lugbe", "jos"];

type MaterialInfo = {
  name: string;
  unit: string;
  pieces_per_bag: number | null;
  brands: { name: string; category: string; grammage: string | null } | null;
};
type MovementRow = {
  id: string;
  movement_type: string;
  quantity: number;
  reference: string | null;
  reason: string | null;
  user_id: string | null;
  issued_to_department: string | null;
  issued_to_user: string | null;
  created_at: string;
  raw_materials: MaterialInfo | null;
};
type PreformIssue = { reference: string; operator_id: string | null; status: string };
type QcReceipt = { movement_id: string; status: string };

const ISSUE_TYPES = ["issued", "used_for_production", "transferred"];
const PREFORM_STATUS: Record<string, string> = {
  issued: "Awaiting operator",
  accepted: "Accepted",
  rejected: "Rejected — back in store",
  cancelled: "Cancelled — back in store",
};

const packOf = (m: MaterialInfo | null) =>
  detectPack(m?.brands?.category) ?? packWord(m?.name, m?.unit);

function StoreIssuesPage() {
  const { data: factoryId } = useFactoryId();
  const [dept, setDept] = useState<Department | "all">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  useRealtimeInvalidate(
    ["raw_material_movements", "qc_store_receipts", "preform_issues"],
    [["store-issues"]],
  );

  const movements = useQuery({
    queryKey: ["store-issues", "movements", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_material_movements")
        .select(
          "id,movement_type,quantity,reference,reason,user_id,issued_to_department,issued_to_user,created_at,raw_materials(name,unit,pieces_per_bag,brands(name,category,grammage))",
        )
        .eq("factory_id", factoryId!)
        .in("movement_type", ISSUE_TYPES as never)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as MovementRow[];
    },
  });

  // Preform issues: the operator who collected, and whether they accepted.
  const preformRefs = (movements.data ?? []).flatMap((m) =>
    m.movement_type === "transferred" && m.reference?.startsWith("PFI-") ? [m.reference] : [],
  );
  const preformIssues = useQuery({
    queryKey: ["store-issues", "preform", preformRefs],
    enabled: preformRefs.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("preform_issues" as never)
        .select("reference,operator_id,status")
        .in("reference", preformRefs);
      return new Map(((data ?? []) as PreformIssue[]).map((p) => [p.reference, p]));
    },
  });
  // Issues to Quality Control: confirmed by QC yet?
  const qcIds = (movements.data ?? []).flatMap((m) =>
    m.issued_to_department === "quality_control" ? [m.id] : [],
  );
  const qcReceipts = useQuery({
    queryKey: ["store-issues", "qc", qcIds],
    enabled: qcIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("qc_store_receipts")
        .select("movement_id,status")
        .in("movement_id", qcIds);
      return new Map(((data ?? []) as QcReceipt[]).map((r) => [r.movement_id, r.status]));
    },
  });

  const rows = (movements.data ?? []).map((m) => {
    const preform = m.reference ? preformIssues.data?.get(m.reference) : undefined;
    const department: Department =
      m.issued_to_department && RECORDED.includes(m.issued_to_department)
        ? (m.issued_to_department as Department)
        : m.movement_type === "transferred" && m.reference?.startsWith("PFI-")
          ? "preform_blowing"
          : m.movement_type === "used_for_production"
            ? "production"
            : "other";
    const collector = m.issued_to_user ?? preform?.operator_id ?? null;
    const qcStatus = qcReceipts.data?.get(m.id);
    const status =
      department === "quality_control"
        ? qcStatus === "confirmed"
          ? "Confirmed by QC"
          : qcStatus === "rejected"
            ? "Rejected by QC — back in store"
            : qcStatus === "moved"
              ? "Moved to QC Preforms"
              : qcStatus === "cleared"
                ? "Test data — back in store"
                : qcStatus
                  ? "Awaiting QC confirmation"
                  : null
        : preform
          ? (PREFORM_STATUS[preform.status] ?? preform.status)
          : null;
    return {
      ...m,
      quantity: Math.abs(Number(m.quantity)),
      department,
      collector,
      status,
      brand: brandDetail(m.raw_materials?.brands),
    };
  });

  const peopleIds = [
    ...new Set(rows.flatMap((r) => [r.collector, r.user_id].filter(Boolean) as string[])),
  ];
  const people = useQuery({
    queryKey: ["store-issues", "people", peopleIds],
    enabled: peopleIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id,full_name").in("id", peopleIds);
      return new Map((data ?? []).map((p) => [p.id, p.full_name ?? ""]));
    },
  });
  const nameOf = (id: string | null) => (id ? people.data?.get(id) || "—" : null);

  const term = q.trim().toLowerCase();
  const inPeriod = rows.filter((r) => {
    const d = format(new Date(r.created_at), "yyyy-MM-dd");
    return (!from || d >= from) && (!to || d <= to);
  });
  const shown = inPeriod
    .filter((r) => dept === "all" || r.department === dept)
    .map((r) => ({
      ...r,
      collectedBy:
        nameOf(r.collector) ??
        (r.department === "other" ? "—" : `${DEPARTMENT_LABEL[r.department]} (department)`),
      issuedBy: nameOf(r.user_id) ?? "—",
      when: format(new Date(r.created_at), "dd-MM-yyyy HH:mm:ss"),
      note: [r.reference, r.reason].filter(Boolean).join(" — "),
    }))
    .filter(
      (r) =>
        !term ||
        [r.raw_materials?.name, r.brand, r.collectedBy, r.issuedBy, r.note].some((v) =>
          (v ?? "").toLowerCase().includes(term),
        ),
    );

  // Issues per department in the period (pieces of different materials are
  // not added up -- the count of issues is).
  const counts = (Object.keys(DEPARTMENT_LABEL) as Department[]).map((d) => ({
    d,
    count: inPeriod.filter((r) => r.department === d).length,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Store — Issued Out</h1>
        <p className="text-sm text-muted-foreground">
          Every stock issue from the Store to other departments: what, how much, who collected it
          and who issued it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {counts
          .filter((c) => c.d !== "other" || c.count > 0)
          .map((c) => (
            <button
              key={c.d}
              type="button"
              onClick={() => setDept(dept === c.d ? "all" : c.d)}
              className="text-left"
            >
              <Card
                className={`rounded-2xl transition-colors hover:bg-accent/40 ${
                  dept === c.d ? "border-primary" : ""
                }`}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {DEPARTMENT_LABEL[c.d]}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">{num(c.count)}</div>
                  <p className="text-xs text-muted-foreground">
                    issue{c.count === 1 ? "" : "s"}
                    {from || to ? " in the period" : ""} · click to filter
                  </p>
                </CardContent>
              </Card>
            </button>
          ))}
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle>Issued out</CardTitle>
            <CardDescription>
              {dept === "all" ? "All departments" : DEPARTMENT_LABEL[dept]}, newest first.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <ReportActions
              size="sm"
              title={`Store issues — ${dept === "all" ? "all departments" : DEPARTMENT_LABEL[dept]}`}
              fileName="store-issues"
              columns={[
                { key: "sn", label: "S/N" },
                { key: "when", label: "Date/Time" },
                { key: "department", label: "Department" },
                { key: "material", label: "Material" },
                { key: "brand", label: "Brand" },
                { key: "quantity", label: "Quantity (pieces)" },
                { key: "packs", label: "In packs" },
                { key: "collectedBy", label: "Collected By" },
                { key: "issuedBy", label: "Issued By" },
                { key: "status", label: "Status" },
                { key: "note", label: "Reference / Reason" },
              ]}
              rows={shown.map((r, i) => {
                const split = splitBags(r.quantity, r.raw_materials?.pieces_per_bag);
                return {
                  sn: i + 1,
                  when: r.when,
                  department: DEPARTMENT_LABEL[r.department],
                  material: r.raw_materials?.name ?? "",
                  brand: r.brand ?? "",
                  quantity: num(r.quantity),
                  packs: split ? formatBags(split, packOf(r.raw_materials)) : "",
                  collectedBy: r.collectedBy,
                  issuedBy: r.issuedBy,
                  status: r.status ?? "",
                  note: r.note,
                };
              })}
              subtitle={[
                ...(from || to ? [`Period: ${from || "start"} to ${to || "today"}`] : []),
                ...(term ? [`Search: ${q.trim()}`] : []),
              ]}
            />
            <Select value={dept} onValueChange={(v) => setDept(v as Department | "all")}>
              <SelectTrigger className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {(Object.keys(DEPARTMENT_LABEL) as Department[]).map((d) => (
                  <SelectItem key={d} value={d}>
                    {DEPARTMENT_LABEL[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search material, person…"
                className="h-9 w-52 pl-8"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-1">
              <Label htmlFor="issues-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input
                id="issues-from"
                type="date"
                className="h-9 w-40"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <Label htmlFor="issues-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input
                id="issues-to"
                type="date"
                className="h-9 w-40"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              {(from || to) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                <TableHead>Date/Time</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Material</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Collected By</TableHead>
                <TableHead>Issued By</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reference / Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r, i) => (
                <TableRow key={r.id}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.when}</TableCell>
                  <TableCell>{DEPARTMENT_LABEL[r.department]}</TableCell>
                  <TableCell className="font-medium">{r.raw_materials?.name ?? "—"}</TableCell>
                  <TableCell>{r.brand ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <BagQty
                      value={r.quantity}
                      unit={r.raw_materials?.unit}
                      perBag={r.raw_materials?.pieces_per_bag}
                      pack={packOf(r.raw_materials)}
                    />
                  </TableCell>
                  <TableCell>{r.collectedBy}</TableCell>
                  <TableCell>{r.issuedBy}</TableCell>
                  <TableCell>
                    {r.status ? (
                      <Badge
                        variant={
                          /Awaiting/.test(r.status)
                            ? "outline"
                            : /back in store/.test(r.status)
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {r.status}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="max-w-72 text-muted-foreground">{r.note || "—"}</TableCell>
                </TableRow>
              ))}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    {movements.isLoading
                      ? "Loading…"
                      : term || from || to || dept !== "all"
                        ? "No issues match."
                        : "Nothing issued out yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
