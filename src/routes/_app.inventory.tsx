import { createFileRoute, Link } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
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
  Layers,
  ArrowRight,
} from "lucide-react";

export const Route = createFileRoute("/_app/inventory")({
  head: () => ({
    meta: [{ title: "Inventory Overview — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="raw-materials">
      <InventoryOverviewPage />
    </RequireAccess>
  ),
});

const FACTORY_LABEL = {
  water: { name: "Water Factory", icon: Droplet },
  nylon: { name: "Nylon Factory", icon: Layers },
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
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  tone?: "primary" | "warning" | "destructive";
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

  const [materialSearch, setMaterialSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");

  const materials = useQuery({
    queryKey: ["inventory-overview-materials", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select(
          "id,name,category,unit,current_stock,unit_cost,current_value,reorder_level,active,material_categories(name)",
        )
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as RawMaterialRow[];
    },
  });

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

  const filteredMaterials = useMemo(() => {
    const q = materialSearch.trim().toLowerCase();
    const rows = materials.data ?? [];
    return q ? rows.filter((m) => m.name.toLowerCase().includes(q)) : rows;
  }, [materials.data, materialSearch]);

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
    const mats = materials.data ?? [];
    const prods = products.data ?? [];
    const lowMats = mats.filter((m) => isLow(Number(m.current_stock), m.reorder_level)).length;
    const lowProds = prods.filter((p) => isLow(Number(p.current_stock), p.reorder_level)).length;
    const value =
      mats.reduce((s, m) => s + Number(m.current_value), 0) +
      prods.reduce((s, p) => s + Number(p.current_stock) * Number(p.cost_price), 0);
    return {
      materialCount: mats.length,
      productCount: prods.length,
      lowStock: lowMats + lowProds,
      value,
    };
  }, [materials.data, products.data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory Overview</h1>
          <p className="text-sm text-muted-foreground">
            Every raw material and finished product on hand, isolated to the factory currently
            selected in the top bar.
          </p>
        </div>
        <Badge variant="outline" className="h-9 gap-2 px-3 text-sm">
          <FactoryIcon className="h-4 w-4 text-primary" /> {factoryLabel.name}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard icon={Boxes} label="Raw Material SKUs" value={String(summary.materialCount)} />
        <SummaryCard
          icon={Package}
          label="Finished Product SKUs"
          value={String(summary.productCount)}
        />
        <SummaryCard
          icon={AlertTriangle}
          label="Low Stock Items"
          value={String(summary.lowStock)}
          tone={summary.lowStock > 0 ? "destructive" : "primary"}
        />
        <SummaryCard icon={Wallet} label="Estimated Stock Value" value={money(summary.value)} />
      </div>

      <Tabs defaultValue="materials">
        <TabsList>
          <TabsTrigger value="materials">Raw Materials</TabsTrigger>
          {canSeeFinishedGoods && <TabsTrigger value="products">Finished Goods</TabsTrigger>}
        </TabsList>

        <TabsContent value="materials">
          <Card className="rounded-2xl">
            <CardHeader className="flex-row items-center justify-between gap-3">
              <CardTitle>Raw Materials — {factoryLabel.name}</CardTitle>
              <div className="relative w-full max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={materialSearch}
                  onChange={(e) => setMaterialSearch(e.target.value)}
                  placeholder="Search materials…"
                  className="pl-8 h-9"
                />
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-right">Reorder Level</TableHead>
                    <TableHead className="text-right">Unit Cost</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMaterials.map((m) => {
                    const low = isLow(Number(m.current_stock), m.reorder_level);
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.name}</TableCell>
                        <TableCell>{m.material_categories?.name ?? m.category ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <span className={low ? "text-destructive font-medium" : ""}>
                            {num(Number(m.current_stock))} {m.unit}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          {m.reorder_level != null
                            ? `${num(Number(m.reorder_level))} ${m.unit}`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">{money(Number(m.unit_cost))}</TableCell>
                        <TableCell>
                          {low ? (
                            <Badge variant="destructive">Low Stock</Badge>
                          ) : (
                            <Badge variant="secondary">OK</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button asChild variant="ghost" size="sm" className="gap-1">
                            <Link to="/raw-materials">
                              Manage <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filteredMaterials.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                        No raw materials for {factoryLabel.name}.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {canSeeFinishedGoods && (
          <TabsContent value="products">
            <Card className="rounded-2xl">
              <CardHeader className="flex-row items-center justify-between gap-3">
                <CardTitle>Finished Goods — {factoryLabel.name}</CardTitle>
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
                      <TableHead className="text-right">Unit Price</TableHead>
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
    </div>
  );
}
