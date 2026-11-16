import { supabase } from "../config/supabase.js";
import { HttpError, asyncHandler } from "../utils/httpError.js";

// Admin guard. The admin signs in with Supabase Auth in the browser and sends the
// access token as `Authorization: Bearer <token>`. We verify the token with Supabase
// and require an admin row in public.profiles. No credentials live in this codebase.
export const requireAdmin = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Authentication required");

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Invalid or expired session");

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError) throw new HttpError(500, "Could not verify permissions");
  if (!profile || profile.role !== "admin") throw new HttpError(403, "Admin access required");

  req.admin = { id: data.user.id, email: data.user.email };
  next();
});
