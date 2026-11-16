import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

// Service-role client: bypasses RLS. Server-side use ONLY.
// Every route that uses it must validate input and, for private data, require admin auth first.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
