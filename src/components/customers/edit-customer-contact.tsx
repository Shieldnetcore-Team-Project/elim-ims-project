import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Who may enter a customer's phone and address (user, 2026-11-09): whoever
// works with customers. update_customer_contact makes the same check.
export function useCanEditCustomerContact() {
  const p = usePermissions();
  return (
    p.canEdit("customers") ||
    p.canCreate("distribution") ||
    p.canEdit("distribution") ||
    p.canEdit("marketer-accounts") ||
    p.canView("finance") ||
    p.canCreate("sales")
  );
}

// A customer's contact and address, as printed in the invoice's BILLED TO box.
// Reads and saves through customer_contact / update_customer_contact
// (20261109120000): the customers table is closed to most of these users.
export function EditCustomerContactButton({
  customerId,
  customerName,
  iconOnly = false,
}: {
  customerId: string;
  customerName: string;
  iconOnly?: boolean;
}) {
  const allowed = useCanEditCustomerContact();
  const [open, setOpen] = useState(false);
  if (!allowed) return null;
  const label = `Edit contact and address of ${customerName}`;
  return (
    // Inside clickable rows: neither the button nor the dialog opens the row.
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {iconOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={label}
          aria-label={label}
          onClick={() => setOpen(true)}
        >
          <Pencil className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          title={label}
          onClick={() => setOpen(true)}
        >
          <Pencil className="h-4 w-4" /> Contact &amp; address
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <ContactDialog
            customerId={customerId}
            customerName={customerName}
            onDone={() => setOpen(false)}
          />
        )}
      </Dialog>
    </span>
  );
}

function ContactDialog({
  customerId,
  customerName,
  onDone,
}: {
  customerId: string;
  customerName: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const details = useQuery({
    queryKey: ["customer-contact-edit", customerId],
    gcTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "customer_contact" as never,
        { p_customer: customerId } as never,
      );
      if (error) throw error;
      return ((data ?? []) as unknown as { phone: string | null; address: string | null }[])[0];
    },
  });
  const [typed, setTyped] = useState<{ phone: string; address: string } | null>(null);
  const form = typed ?? {
    phone: details.data?.phone ?? "",
    address: details.data?.address ?? "",
  };

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc(
        "update_customer_contact" as never,
        {
          p_customer: customerId,
          p_phone: form.phone.trim() || null,
          p_address: form.address.trim() || null,
        } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${customerName} updated — invoices now print these details`);
      for (const key of [
        "customers",
        "customers-pos",
        "customer-contact",
        "customer-contact-edit",
        "acct-distributors",
        "dist-rep-customers",
        "dist-rep-customer-accounts",
        "marketer-customer-details",
        "mkt-customers",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{customerName}</DialogTitle>
        <DialogDescription>
          Printed in the BILLED TO box of this customer&apos;s invoices.
        </DialogDescription>
      </DialogHeader>
      {details.isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-3">
          {details.isError && (
            <p className="text-sm text-destructive">{(details.error as Error).message}</p>
          )}
          <div>
            <Label htmlFor="customer-contact-phone">Contact (phone)</Label>
            <Input
              id="customer-contact-phone"
              inputMode="tel"
              value={form.phone}
              onChange={(e) => setTyped({ ...form, phone: e.target.value })}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="customer-contact-address">Address</Label>
            <Input
              id="customer-contact-address"
              value={form.address}
              onChange={(e) => setTyped({ ...form, address: e.target.value })}
            />
          </div>
        </div>
      )}
      <DialogFooter>
        <Button
          disabled={save.isPending || details.isLoading || details.isError}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
