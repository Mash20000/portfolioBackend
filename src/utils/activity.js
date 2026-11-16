import { supabase } from "../config/supabase.js";

// Best-effort audit trail of admin changes. Never blocks the request.
export async function logActivity(admin, action, entity, entityId, details = null) {
  try {
    await supabase.from("activity_logs").insert({
      admin_id: admin?.id ?? null,
      action,
      entity,
      entity_id: entityId ? String(entityId) : null,
      details,
    });
  } catch (e) {
    console.error("activity log failed:", e.message);
  }
}
