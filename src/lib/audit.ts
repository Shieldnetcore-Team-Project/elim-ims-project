import { supabase } from "@/integrations/supabase/client";

export type AuditAction =
  | "login" | "logout" | "create" | "update" | "delete"
  | "print" | "export" | "payment" | "production" | "sale";

let cachedIp: string | null | undefined;

// Best-effort client-reported IP (there's no server-side request handler in front of
// these Supabase calls to read a real IP from). Never blocks or fails the caller.
async function lookupIp(): Promise<string | null> {
  if (cachedIp !== undefined) return cachedIp;
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    cachedIp = data?.ip ?? null;
  } catch {
    cachedIp = null;
  }
  return cachedIp ?? null;
}

export async function logAudit(entry: {
  action: AuditAction | string;
  entity?: string;
  entityId?: string;
  factoryId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}) {
  try {
    const [{ data: userData }, ip] = await Promise.all([supabase.auth.getUser(), lookupIp()]);
    await supabase.from("audit_logs").insert({
      user_id: userData.user?.id ?? null,
      factory_id: entry.factoryId ?? null,
      action: entry.action,
      entity: entry.entity ?? null,
      entity_id: entry.entityId ?? null,
      old_value: entry.oldValue == null ? null : (entry.oldValue as any),
      new_value: entry.newValue == null ? null : (entry.newValue as any),
      ip_address: ip,
    });
  } catch {
    // Audit logging must never block or fail the action it's describing.
  }
}
