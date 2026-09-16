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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Truck, Plus, UserRound, PackageCheck, Pencil, Trash2 } from "lucide-react";
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";

export const Route = createFileRoute("/_app/logistics")({
  head: () => ({ meta: [{ title: "Logistics — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="logistics">
      <LogisticsPage />
    </RequireAccess>
  ),
});

const statusVariant = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "delivered"
    ? "secondary"
    : s === "cancelled"
      ? "destructive"
      : s === "in_transit"
        ? "default"
        : "outline";

type DriverRow = {
  id: string;
  full_name: string;
  phone: string | null;
  license_number: string | null;
  status: string;
};

type VehicleRow = {
  id: string;
  plate_number: string;
  brand: string | null;
  model: string | null;
  vehicle_type: string | null;
  year: number | null;
  color: string | null;
  capacity: string | null;
  chassis_number: string | null;
  engine_number: string | null;
  registration_expiry_date: string | null;
  insurance_expiry_date: string | null;
  status: string;
};

const emptyVehicleForm = {
  plate_number: "",
  brand: "",
  model: "",
  vehicle_type: "",
  year: "",
  color: "",
  capacity: "",
  chassis_number: "",
  engine_number: "",
  registration_expiry_date: "",
  insurance_expiry_date: "",
  status: "active",
};

function LogisticsPage() {
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const factory = useFactoryId();
  const factoryId = factory.data;
  const write = canWrite("logistics");

  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<VehicleRow | null>(null);
  const [driverOpen, setDriverOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState<DriverRow | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deleteVehicleTarget, setDeleteVehicleTarget] = useState<VehicleRow | null>(null);
  const [deleteDriverTarget, setDeleteDriverTarget] = useState<DriverRow | null>(null);
  const [vForm, setVForm] = useState(emptyVehicleForm);
  const [dForm, setDForm] = useState({
    full_name: "",
    phone: "",
    license_number: "",
    status: "active",
  });
  const [delForm, setDelForm] = useState({
    vehicle_id: "",
    driver_id: "",
    route_id: "",
    destination: "",
    notes: "",
  });

  const vehicles = useQuery({
    queryKey: ["logistics-vehicles", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vehicles")
        .select("*")
        .eq("factory_id", factoryId!)
        .order("plate_number");
      if (error) throw error;
      return data ?? [];
    },
  });

  const drivers = useQuery({
    queryKey: ["logistics-drivers", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("drivers")
        .select("*")
        .eq("factory_id", factoryId!)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const routes = useQuery({
    queryKey: ["logistics-routes", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("delivery_routes")
        .select("*")
        .eq("factory_id", factoryId!)
        .order("name");
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

  const resetVehicleForm = () => {
    setEditingVehicle(null);
    setVForm(emptyVehicleForm);
  };

  const vehiclePayload = () => ({
    plate_number: vForm.plate_number,
    brand: vForm.brand || null,
    model: vForm.model || null,
    vehicle_type: vForm.vehicle_type || null,
    year: vForm.year === "" ? null : Number(vForm.year),
    color: vForm.color || null,
    capacity: vForm.capacity || null,
    chassis_number: vForm.chassis_number || null,
    engine_number: vForm.engine_number || null,
    registration_expiry_date: vForm.registration_expiry_date || null,
    insurance_expiry_date: vForm.insurance_expiry_date || null,
    status: vForm.status,
  });

  const addVehicle = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("vehicles")
        .insert({ factory_id: factoryId!, ...vehiclePayload() });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Vehicle added");
      logAudit({ action: "create", entity: "vehicles", factoryId });
      qc.invalidateQueries({ queryKey: ["logistics-vehicles"] });
      setVehicleOpen(false);
      resetVehicleForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateVehicle = useMutation({
    mutationFn: async () => {
      if (!editingVehicle) throw new Error("No vehicle selected");
      const { error } = await supabase
        .from("vehicles")
        .update(vehiclePayload())
        .eq("id", editingVehicle.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Vehicle updated");
      logAudit({ action: "update", entity: "vehicles", entityId: editingVehicle?.id, factoryId });
      qc.invalidateQueries({ queryKey: ["logistics-vehicles"] });
      setVehicleOpen(false);
      resetVehicleForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteVehicle = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await requestDelete("vehicles", id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteVehicleTarget(null);
      qc.invalidateQueries({ queryKey: ["logistics-vehicles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetDriverForm = () => {
    setEditingDriver(null);
    setDForm({ full_name: "", phone: "", license_number: "", status: "active" });
  };

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
      resetDriverForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateDriver = useMutation({
    mutationFn: async () => {
      if (!editingDriver) throw new Error("No driver selected");
      const { error } = await supabase.from("drivers").update(dForm).eq("id", editingDriver.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Driver updated");
      logAudit({ action: "update", entity: "drivers", entityId: editingDriver?.id, factoryId });
      qc.invalidateQueries({ queryKey: ["logistics-drivers"] });
      setDriverOpen(false);
      resetDriverForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteDriver = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await requestDelete("drivers", id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteDriverTarget(null);
      qc.invalidateQueries({ queryKey: ["logistics-drivers"] });
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
      const { error } = await supabase.rpc("update_delivery_status", {
        p_id: id,
        p_status: status,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: ["logistics-deliveries"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Logistics</h1>
        <p className="text-sm text-muted-foreground">
          Vehicles, drivers, and deliveries for the currently selected factory.
        </p>
      </div>

      <Tabs defaultValue="deliveries">
        <TabsList>
          <TabsTrigger value="deliveries">
            <PackageCheck className="mr-1.5 h-4 w-4" /> Deliveries
          </TabsTrigger>
          <TabsTrigger value="vehicles">
            <Truck className="mr-1.5 h-4 w-4" /> Vehicles
          </TabsTrigger>
          <TabsTrigger value="drivers">
            <UserRound className="mr-1.5 h-4 w-4" /> Drivers
          </TabsTrigger>
        </TabsList>

        <TabsContent value="deliveries" className="space-y-4 pt-4">
          {write && (
            <div className="flex justify-end">
              <Button onClick={() => setDeliveryOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Schedule Delivery
              </Button>
            </div>
          )}
          <Card className="rounded-2xl">
            <CardContent className="overflow-x-auto pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Delivery #</TableHead>
                    <TableHead>Destination</TableHead>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
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
                      <TableCell className="text-xs whitespace-nowrap">
                        {new Date(d.scheduled_date).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(d.status)} className="capitalize">
                          {d.status.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {write && d.status !== "delivered" && d.status !== "cancelled" && (
                          <Select
                            value={d.status}
                            onValueChange={(v) => setStatus.mutate({ id: d.id, status: v })}
                          >
                            <SelectTrigger className="h-8 w-36">
                              <SelectValue />
                            </SelectTrigger>
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
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                        No deliveries scheduled.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vehicles" className="space-y-4 pt-4">
          {write && (
            <div className="flex justify-end">
              <Button onClick={() => setVehicleOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add Vehicle
              </Button>
            </div>
          )}
          <Card className="rounded-2xl">
            <CardContent className="overflow-x-auto pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plate</TableHead>
                    <TableHead>Brand / Model</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Year</TableHead>
                    <TableHead>Capacity</TableHead>
                    <TableHead>Status</TableHead>
                    {write && <TableHead></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(vehicles.data ?? []).map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-medium">{v.plate_number}</TableCell>
                      <TableCell>{[v.brand, v.model].filter(Boolean).join(" ") || "—"}</TableCell>
                      <TableCell className="capitalize">{v.vehicle_type ?? "—"}</TableCell>
                      <TableCell>{v.year ?? "—"}</TableCell>
                      <TableCell>{v.capacity ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {v.status}
                        </Badge>
                      </TableCell>
                      {write && (
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => {
                                setEditingVehicle(v);
                                setVForm({
                                  plate_number: v.plate_number,
                                  brand: v.brand ?? "",
                                  model: v.model ?? "",
                                  vehicle_type: v.vehicle_type ?? "",
                                  year: v.year != null ? String(v.year) : "",
                                  color: v.color ?? "",
                                  capacity: v.capacity ?? "",
                                  chassis_number: v.chassis_number ?? "",
                                  engine_number: v.engine_number ?? "",
                                  registration_expiry_date: v.registration_expiry_date ?? "",
                                  insurance_expiry_date: v.insurance_expiry_date ?? "",
                                  status: v.status,
                                });
                                setVehicleOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Remove"
                              onClick={() => setDeleteVehicleTarget(v)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  {(vehicles.data?.length ?? 0) === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={write ? 7 : 6}
                        className="text-center text-muted-foreground py-8"
                      >
                        No vehicles on file.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="drivers" className="space-y-4 pt-4">
          {write && (
            <div className="flex justify-end">
              <Button onClick={() => setDriverOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add Driver
              </Button>
            </div>
          )}
          <Card className="rounded-2xl">
            <CardContent className="overflow-x-auto pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>License #</TableHead>
                    <TableHead>Status</TableHead>
                    {write && <TableHead></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(drivers.data ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">{d.full_name}</TableCell>
                      <TableCell>{d.phone ?? "—"}</TableCell>
                      <TableCell>{d.license_number ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {d.status}
                        </Badge>
                      </TableCell>
                      {write && (
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => {
                                setEditingDriver(d);
                                setDForm({
                                  full_name: d.full_name,
                                  phone: d.phone ?? "",
                                  license_number: d.license_number ?? "",
                                  status: d.status,
                                });
                                setDriverOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Remove"
                              onClick={() => setDeleteDriverTarget(d)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  {(drivers.data?.length ?? 0) === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={write ? 5 : 4}
                        className="text-center text-muted-foreground py-8"
                      >
                        No drivers on file.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog
        open={vehicleOpen}
        onOpenChange={(v) => {
          setVehicleOpen(v);
          if (!v) resetVehicleForm();
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingVehicle ? "Edit Vehicle" : "Add Vehicle"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Plate number</Label>
                <Input
                  value={vForm.plate_number}
                  onChange={(e) => setVForm({ ...vForm, plate_number: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Vehicle type</Label>
                <Select
                  value={vForm.vehicle_type}
                  onValueChange={(v) => setVForm({ ...vForm, vehicle_type: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="van">Van</SelectItem>
                    <SelectItem value="truck">Truck</SelectItem>
                    <SelectItem value="bus">Bus</SelectItem>
                    <SelectItem value="car">Car</SelectItem>
                    <SelectItem value="motorcycle">Motorcycle</SelectItem>
                    <SelectItem value="tricycle">Tricycle</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Brand</Label>
                <Input
                  placeholder="e.g. Toyota"
                  value={vForm.brand}
                  onChange={(e) => setVForm({ ...vForm, brand: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Model</Label>
                <Input
                  placeholder="e.g. Hiace"
                  value={vForm.model}
                  onChange={(e) => setVForm({ ...vForm, model: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Year</Label>
                <Input
                  type="number"
                  value={vForm.year}
                  onChange={(e) => setVForm({ ...vForm, year: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Color</Label>
                <Input
                  value={vForm.color}
                  onChange={(e) => setVForm({ ...vForm, color: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Capacity</Label>
                <Input
                  placeholder="e.g. 1000kg"
                  value={vForm.capacity}
                  onChange={(e) => setVForm({ ...vForm, capacity: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={vForm.status}
                  onValueChange={(v) => setVForm({ ...vForm, status: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="maintenance">Maintenance</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Chassis / VIN number</Label>
                <Input
                  value={vForm.chassis_number}
                  onChange={(e) => setVForm({ ...vForm, chassis_number: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Engine number</Label>
                <Input
                  value={vForm.engine_number}
                  onChange={(e) => setVForm({ ...vForm, engine_number: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Registration expiry</Label>
                <Input
                  type="date"
                  value={vForm.registration_expiry_date}
                  onChange={(e) => setVForm({ ...vForm, registration_expiry_date: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Insurance expiry</Label>
                <Input
                  type="date"
                  value={vForm.insurance_expiry_date}
                  onChange={(e) => setVForm({ ...vForm, insurance_expiry_date: e.target.value })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!vForm.plate_number || addVehicle.isPending || updateVehicle.isPending}
              onClick={() => (editingVehicle ? updateVehicle.mutate() : addVehicle.mutate())}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={driverOpen}
        onOpenChange={(v) => {
          setDriverOpen(v);
          if (!v) resetDriverForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingDriver ? "Edit Driver" : "Add Driver"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Full name</Label>
              <Input
                value={dForm.full_name}
                onChange={(e) => setDForm({ ...dForm, full_name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input
                value={dForm.phone}
                onChange={(e) => setDForm({ ...dForm, phone: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>License number</Label>
              <Input
                value={dForm.license_number}
                onChange={(e) => setDForm({ ...dForm, license_number: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={dForm.status} onValueChange={(v) => setDForm({ ...dForm, status: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!dForm.full_name || addDriver.isPending || updateDriver.isPending}
              onClick={() => (editingDriver ? updateDriver.mutate() : addDriver.mutate())}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deliveryOpen} onOpenChange={setDeliveryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule Delivery</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Vehicle</Label>
              <Select
                value={delForm.vehicle_id}
                onValueChange={(v) => setDelForm({ ...delForm, vehicle_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select vehicle" />
                </SelectTrigger>
                <SelectContent>
                  {(vehicles.data ?? []).map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.plate_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Driver</Label>
              <Select
                value={delForm.driver_id}
                onValueChange={(v) => setDelForm({ ...delForm, driver_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select driver" />
                </SelectTrigger>
                <SelectContent>
                  {(drivers.data ?? []).map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Route (optional)</Label>
              <Select
                value={delForm.route_id}
                onValueChange={(v) => setDelForm({ ...delForm, route_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select route" />
                </SelectTrigger>
                <SelectContent>
                  {(routes.data ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Destination</Label>
              <Input
                value={delForm.destination}
                onChange={(e) => setDelForm({ ...delForm, destination: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                rows={2}
                value={delForm.notes}
                onChange={(e) => setDelForm({ ...delForm, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={addDelivery.isPending} onClick={() => addDelivery.mutate()}>
              Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RequestDeleteDialog
        open={!!deleteVehicleTarget}
        onOpenChange={(v) => !v && setDeleteVehicleTarget(null)}
        isPending={deleteVehicle.isPending}
        title={
          deleteVehicleTarget
            ? `Request deletion — ${deleteVehicleTarget.plate_number}`
            : "Request deletion"
        }
        onConfirm={(reason) =>
          deleteVehicleTarget && deleteVehicle.mutate({ id: deleteVehicleTarget.id, reason })
        }
      />
      <RequestDeleteDialog
        open={!!deleteDriverTarget}
        onOpenChange={(v) => !v && setDeleteDriverTarget(null)}
        isPending={deleteDriver.isPending}
        title={
          deleteDriverTarget
            ? `Request deletion — ${deleteDriverTarget.full_name}`
            : "Request deletion"
        }
        onConfirm={(reason) =>
          deleteDriverTarget && deleteDriver.mutate({ id: deleteDriverTarget.id, reason })
        }
      />
    </div>
  );
}
