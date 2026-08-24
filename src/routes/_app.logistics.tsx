import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { usePermissions } from "@/lib/permissions";
import { useFactoryId } from "@/lib/use-factory";
import { logAudit } from "@/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Truck, Plus, UserRound, PackageCheck } from "lucide-react";

export const Route = createFileRoute("/_app/logistics")({
  head: () => ({ meta: [{ title: "Logistics — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="logistics">
      <LogisticsPage />
    </RequireAccess>
  ),
});

const statusVariant = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "delivered" ? "secondary" : s === "cancelled" ? "destructive" : s === "in_transit" ? "default" : "outline";

function LogisticsPage() {
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const factory = useFactoryId();
  const factoryId = factory.data;
  const write = canWrite("logistics");

  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [driverOpen, setDriverOpen] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [vForm, setVForm] = useState({ plate_number: "", make_model: "", capacity: "" });
  const [dForm, setDForm] = useState({ full_name: "", phone: "", license_number: "" });
  const [delForm, setDelForm] = useState({ vehicle_id: "", driver_id: "", route_id: "", destination: "", notes: "" });

  const vehicles = useQuery({
    queryKey: ["logistics-vehicles", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("vehicles").select("*").eq("factory_id", factoryId!).order("plate_number");
      if (error) throw error;
      return data ?? [];
    },
  });

  const drivers = useQuery({
    queryKey: ["logistics-drivers", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("drivers").select("*").eq("factory_id", factoryId!).order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const routes = useQuery({
    queryKey: ["logistics-routes", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("delivery_routes").select("*").eq("factory_id", factoryId!).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const deliveries = useQuery({
    queryKey: ["logistics-deliveries", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deliveries")
        .select("*, vehicles(plate_number), drivers(full_name), delivery_routes(name)")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const addVehicle = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("vehicles").insert({ factory_id: factoryId!, ...vForm });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Vehicle added");
      logAudit({ action: "create", entity: "vehicles", factoryId });
      qc.invalidateQueries({ queryKey: ["logistics-vehicles"] });
      setVehicleOpen(false);
      setVForm({ plate_number: "", make_model: "", capacity: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addDriver = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("drivers").insert({ factory_id: factoryId!, ...dForm });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Driver added");
      logAudit({ action: "create", entity: "drivers", factoryId });
      qc.invalidateQueries({ queryKey: ["logistics-drivers"] });
      setDriverOpen(false);
      setDForm({ full_name: "", phone: "", license_number: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addDelivery = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("create_delivery", {
        payload: {
          factory_id: factoryId,
          vehicle_id: delForm.vehicle_id || null,
          driver_id: delForm.driver_id || null,
          route_id: delForm.route_id || null,
          destination: delForm.destination || null,
          notes: delForm.notes || null,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Delivery scheduled");
      qc.invalidateQueries({ queryKey: ["logistics-deliveries"] });
      setDeliveryOpen(false);
      setDelForm({ vehicle_id: "", driver_id: "", route_id: "", destination: "", notes: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase.rpc("update_delivery_status", { p_id: id, p_status: status });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Status updated"); qc.invalidateQueries({ queryKey: ["logistics-deliveries"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Logistics</h1>
        <p className="text-sm text-muted-foreground">Vehicles, drivers, and deliveries for the currently selected factory.</p>
      </div>

      <Tabs defaultValue="deliveries">
        <TabsList>
          <TabsTrigger value="deliveries"><PackageCheck className="mr-1.5 h-4 w-4" /> Deliveries</TabsTrigger>
          <TabsTrigger value="vehicles"><Truck className="mr-1.5 h-4 w-4" /> Vehicles</TabsTrigger>
          <TabsTrigger value="drivers"><UserRound className="mr-1.5 h-4 w-4" /> Drivers</TabsTrigger>
        </TabsList>

        <TabsContent value="deliveries" className="space-y-4 pt-4">
          {write && (
            <div className="flex justify-end">
              <Button onClick={() => setDeliveryOpen(true)}><Plus className="mr-2 h-4 w-4" /> Schedule Delivery</Button>
            </div>
          )}
          <Card className="rounded-2xl">
            <CardContent className="overflow-x-auto pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Delivery #</TableHead><TableHead>Destination</TableHead><TableHead>Vehicle</TableHead>
                    <TableHead>Driver</TableHead><TableHead>Route</TableHead><TableHead>Scheduled</TableHead>
                    <TableHead>Status</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(deliveries.data ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">{d.delivery_number}</TableCell>
                      <TableCell>{d.destination ?? "—"}</TableCell>
                      <TableCell>{d.vehicles?.plate_number ?? "—"}</TableCell>
                      <TableCell>{d.drivers?.full_name ?? "—"}</TableCell>
                      <TableCell>{d.delivery_routes?.name ?? "—"}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{new Date(d.scheduled_date).toLocaleDateString()}</TableCell>
                      <TableCell><Badge variant={statusVariant(d.status)} className="capitalize">{d.status.replace("_", " ")}</Badge></TableCell>
                      <TableCell>
                        {write && d.status !== "delivered" && d.status !== "cancelled" && (
                          <Select value={d.status} onValueChange={(v) => setStatus.mutate({ id: d.id, status: v })}>
                            <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="pending">Pending</SelectItem>
                              <SelectItem value="in_transit">In transit</SelectItem>
                              <SelectItem value="delivered">Delivered</SelectItem>
                              <SelectItem value="cancelled">Cancelled</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(deliveries.data?.length ?? 0) === 0 && (
                    <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No deliveries scheduled.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vehicles" className="space-y-4 pt-4">
          {write && (
            <div className="flex justify-end">
              <Button onClick={() => setVehicleOpen(true)}><Plus className="mr-2 h-4 w-4" /> Add Vehicle</Button>
            </div>
          )}
          <Card className="rounded-2xl">
            <CardContent className="overflow-x-auto pt-6">
              <Table>
                <TableHeader><TableRow><TableHead>Plate</TableHead><TableHead>Make/Model</TableHead><TableHead>Capacity</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(vehicles.data ?? []).map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-medium">{v.plate_number}</TableCell>
                      <TableCell>{v.make_model ?? "—"}</TableCell>
                      <TableCell>{v.capacity ?? "—"}</TableCell>
                      <TableCell><Badge variant="outline" className="capitalize">{v.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                  {(vehicles.data?.length ?? 0) === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No vehicles on file.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="drivers" className="space-y-4 pt-4">
          {write && (
            <div className="flex justify-end">
              <Button onClick={() => setDriverOpen(true)}><Plus className="mr-2 h-4 w-4" /> Add Driver</Button>
            </div>
          )}
          <Card className="rounded-2xl">
            <CardContent className="overflow-x-auto pt-6">
              <Table>
                <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Phone</TableHead><TableHead>License #</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(drivers.data ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">{d.full_name}</TableCell>
                      <TableCell>{d.phone ?? "—"}</TableCell>
                      <TableCell>{d.license_number ?? "—"}</TableCell>
                      <TableCell><Badge variant="outline" className="capitalize">{d.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                  {(drivers.data?.length ?? 0) === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No drivers on file.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={vehicleOpen} onOpenChange={setVehicleOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Vehicle</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label>Plate number</Label><Input value={vForm.plate_number} onChange={(e) => setVForm({ ...vForm, plate_number: e.target.value })} /></div>
            <div className="space-y-2"><Label>Make / model</Label><Input value={vForm.make_model} onChange={(e) => setVForm({ ...vForm, make_model: e.target.value })} /></div>
            <div className="space-y-2"><Label>Capacity</Label><Input value={vForm.capacity} onChange={(e) => setVForm({ ...vForm, capacity: e.target.value })} /></div>
          </div>
          <DialogFooter><Button disabled={!vForm.plate_number || addVehicle.isPending} onClick={() => addVehicle.mutate()}>Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={driverOpen} onOpenChange={setDriverOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Driver</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label>Full name</Label><Input value={dForm.full_name} onChange={(e) => setDForm({ ...dForm, full_name: e.target.value })} /></div>
            <div className="space-y-2"><Label>Phone</Label><Input value={dForm.phone} onChange={(e) => setDForm({ ...dForm, phone: e.target.value })} /></div>
            <div className="space-y-2"><Label>License number</Label><Input value={dForm.license_number} onChange={(e) => setDForm({ ...dForm, license_number: e.target.value })} /></div>
          </div>
          <DialogFooter><Button disabled={!dForm.full_name || addDriver.isPending} onClick={() => addDriver.mutate()}>Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deliveryOpen} onOpenChange={setDeliveryOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Schedule Delivery</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Vehicle</Label>
              <Select value={delForm.vehicle_id} onValueChange={(v) => setDelForm({ ...delForm, vehicle_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select vehicle" /></SelectTrigger>
                <SelectContent>{(vehicles.data ?? []).map((v) => (<SelectItem key={v.id} value={v.id}>{v.plate_number}</SelectItem>))}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Driver</Label>
              <Select value={delForm.driver_id} onValueChange={(v) => setDelForm({ ...delForm, driver_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select driver" /></SelectTrigger>
                <SelectContent>{(drivers.data ?? []).map((d) => (<SelectItem key={d.id} value={d.id}>{d.full_name}</SelectItem>))}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Route (optional)</Label>
              <Select value={delForm.route_id} onValueChange={(v) => setDelForm({ ...delForm, route_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select route" /></SelectTrigger>
                <SelectContent>{(routes.data ?? []).map((r) => (<SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>))}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label>Destination</Label><Input value={delForm.destination} onChange={(e) => setDelForm({ ...delForm, destination: e.target.value })} /></div>
            <div className="space-y-2"><Label>Notes</Label><Textarea rows={2} value={delForm.notes} onChange={(e) => setDelForm({ ...delForm, notes: e.target.value })} /></div>
          </div>
          <DialogFooter><Button disabled={addDelivery.isPending} onClick={() => addDelivery.mutate()}>Schedule</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
