import { createFileRoute, Link } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { useActiveFactoryCode } from "@/lib/factory-store";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { money, num } from "@/lib/format";
import { isLowStock } from "@/lib/metrics";
import {
  Boxes,
  Package,
  AlertTriangle,
  Wallet,
  Search,
  Droplet,
  ArrowRight,
  ChevronDown,
  Gift,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WarehousePostMenu } from "@/components/warehouse/post-menu";
import { ReleasesToAccept } from "@/components/warehouse/releases-to-accept";
import { WarehouseRecentActivity } from "@/components/warehouse/recent-activity";

export const Route = createFileRoute("/_app/inventory")({
  head: () => ({
    meta: [{ title: "Warehouse — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <>
      <SectionTabs section="Warehouse" />
      <RequireAccess module="finished-goods">
        <InventoryOverviewPage />
      </RequireAccess>
    </>
  ),
});

const FACTORY_LABEL = {
  water: { name: "Water Factory", icon: Droplet },
} as const;

type RawMaterialRow = {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  current_stock: number;
  unit_cost: number;
  current_value: number;
  reorder_level: number | null;
  active: boolean;
  material_categories: { name: string } | null;
};
type ProductRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  current_stock: number;
  unit_price: number;
  cost_price: number;
  reorder_level: number | null;
  product_type: string;
  active: boolean;
  product_categories: { name: string } | null;
};

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone = "primary",
  hint,
  children,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  tone?: "primary" | "warning" | "destructive";
  // Short plain-language explanation shown under the number.
  hint?: string;
  children?: React.ReactNode;
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold">{value}</div>
          {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
          {children}
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${toneClasses}`}>
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

const isLow = isLowStock;

function InventoryOverviewPage() {
  const { data: factoryId } = useFactoryId();
  const factoryCode = useActiveFactoryCode();
  const { can } = usePermissions();
  const canSeeFinishedGoods = can("finished-goods", "view");
  const factoryLabel = FACTORY_LABEL[factoryCode];
  const FactoryIcon = factoryLabel.icon;

  const [productSearch, setProductSearch] = useState("");

  const products = useQuery({
    queryKey: ["inventory-overview-products", factoryId],
    enabled: !!factoryId && canSeeFinishedGoods,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select(
          "id,name,sku,unit,current_stock,unit_price,cost_price,reorder_level,product_type,active,product_categories(name)",
        )
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as ProductRow[];
    },
  });

  // Chairman's gifts (Post → Others → Chairman's gift): products given out at
  // cost on the chairman's request. Not sales, so none of it is revenue.
  const gifts = useQuery({
    queryKey: ["chairmans-gifts", factoryId],
    enabled: !!factoryId && canSeeFinishedGoods,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("chairmans_gifts" as never)
        .select("id,gift_date,total_value")
        .eq("factory_id", factoryId!);
      if (error) throw error;
      return (data ?? []) as unknown as { id: string; gift_date: string; total_value: number }[];
    },
  });
  const giftSummary = useMemo(() => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const rows = gifts.data ?? [];
    return {
      value: rows.reduce((t, g) => t + Number(g.total_value), 0),
      month: rows
        .filter((g) => g.gift_date.slice(0, 7) === thisMonth)
        .reduce((t, g) => t + Number(g.total_value), 0),
      count: rows.length,
    };
  }, [gifts.data]);

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    const rows = products.data ?? [];
    return q
      ? rows.filter(
          (p) => p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q),
        )
      : rows;
  }, [products.data, productSearch]);

  const summary = useMemo(() => {
    const prods = products.data ?? [];
    return {
      productCount: prods.length,
      lowStock: prods.filter((p) => isLow(Number(p.current_stock), p.reorder_level)).length,
      value: prods.reduce((s, p) => s + Number(p.current_stock) * Number(p.cost_price), 0),
    };
  }, [products.data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Warehouse Overview</h1>
          <p className="text-sm text-muted-foreground">
            Every finished product on hand at the Water Factory, ready to post to marketers,
            distributors and the Company Retail Shop.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {factoryId && <WarehousePostMenu factoryId={factoryId} />}
          <Badge variant="outline" className="h-9 gap-2 px-3 text-sm">
            <FactoryIcon className="h-4 w-4 text-primary" /> {factoryLabel.name}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          icon={Package}
          label="Finished Product SKUs"
          value={String(summary.productCount)}
          hint="SKU = Stock Keeping Unit: each different finished product counts as one."
        >
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="mt-2 h-8 gap-1 px-2 text-xs">
                View all {factoryLabel.name.replace(" Factory", "")} products
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-72 w-72 overflow-y-auto p-1">
              {(products.data ?? []).length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  No finished products yet.
                </div>
              ) : (
                (products.data ?? []).map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {num(Number(p.current_stock))} {p.unit}
                    </span>
                  </div>
                ))
              )}
            </PopoverContent>
          </Popover>
        </SummaryCard>
        <SummaryCard
          icon={AlertTriangle}
          label="Low Stock Items"
          value={String(summary.lowStock)}
          tone={summary.lowStock > 0 ? "destructive" : "primary"}
        />
        <SummaryCard icon={Wallet} label="Estimated Stock Value" value={money(summary.value)} />
        {canSeeFinishedGoods && (
          <SummaryCard
            icon={Gift}
            label="Chairman's Gifts"
            value={money(giftSummary.value)}
            tone="warning"
            hint={`Value at cost of products given out on the chairman's request (${num(giftSummary.count)} posted). Not revenue — nobody pays for it.`}
          >
            <div className="mt-1 text-xs text-muted-foreground">
              This month {money(giftSummary.month)}
            </div>
          </SummaryCard>
        )}
      </div>

      {factoryId && <ReleasesToAccept factoryId={factoryId} alwaysShow />}

      <Tabs defaultValue="products">
        <TabsList>
          {canSeeFinishedGoods && <TabsTrigger value="products">Finished Products</TabsTrigger>}
        </TabsList>

        {canSeeFinishedGoods && (
          <TabsContent value="products">
            <Card className="rounded-2xl">
              <CardHeader className="flex-row items-center justify-between gap-3">
                <CardTitle>Finished Products — {factoryLabel.name}</CardTitle>
                <div className="relative w-full max-w-xs">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder="Search products or SKU…"
                    className="pl-8 h-9"
                  />
                </div>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead className="text-right">Reorder Level</TableHead>
                      <TableHead className="text-right">Selling Price</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredProducts.map((p) => {
                      const low = isLow(Number(p.current_stock), p.reorder_level);
                      return (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{p.name}</TableCell>
                          <TableCell className="font-mono text-xs">{p.sku ?? "—"}</TableCell>
                          <TableCell>{p.product_categories?.name ?? "—"}</TableCell>
                          <TableCell>
                            <Badge
                              variant={p.product_type === "semi_finished" ? "outline" : "secondary"}
                            >
                              {p.product_type === "semi_finished" ? "Semi-Finished" : "Finished"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className={low ? "text-destructive font-medium" : ""}>
                              {num(Number(p.current_stock))} {p.unit}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            {p.reorder_level != null
                              ? `${num(Number(p.reorder_level))} ${p.unit}`
                              : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {money(Number(p.unit_price))}
                          </TableCell>
                          <TableCell>
                            {low ? (
                              <Badge variant="destructive">Low Stock</Badge>
                            ) : (
                              <Badge variant="secondary">OK</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button asChild variant="ghost" size="sm" className="gap-1">
                              <Link to="/finished-goods">
                                Manage <ArrowRight className="h-3.5 w-3.5" />
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredProducts.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                          No finished goods for {factoryLabel.name}.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {factoryId && <WarehouseRecentActivity factoryId={factoryId} />}
    </div>
  );
}
