import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { asyncHandler, HttpError } from "../utils/httpError.js";
import { unwrap, cleanSearch, pageParams } from "../utils/helpers.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Cache public GETs briefly at the edge/browser; content changes rarely.
router.use((req, res, next) => {
  if (req.method === "GET") res.set("Cache-Control", "public, max-age=30");
  next();
});

router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const rows = unwrap(await supabase.from("website_settings").select("key,value").eq("is_public", true));
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  })
);

router.get(
  "/project-categories",
  asyncHandler(async (req, res) => {
    res.json(unwrap(await supabase.from("project_categories").select("id,name,slug").order("sort_order")));
  })
);

router.get(
  "/projects",
  asyncHandler(async (req, res) => {
    const { page, limit, from, to } = pageParams(req.query, 9, 24);
    let q = supabase
      .from("projects")
      .select(
        "id,slug,title,description,technologies,thumbnail_url,github_url,live_url,completed_on,is_featured,project_categories(name,slug)",
        { count: "exact" }
      )
      .eq("is_active", true);

    if (req.query.featured === "true") q = q.eq("is_featured", true);
    if (req.query.category) {
      const cat = unwrap(
        await supabase.from("project_categories").select("id").eq("slug", String(req.query.category)).maybeSingle()
      );
      if (!cat) return res.json({ items: [], total: 0, page, limit });
      q = q.eq("category_id", cat.id);
    }
    const search = cleanSearch(req.query.q);
    if (search) q = q.or(`title.ilike.%${search}%,description.ilike.%${search}%`);

    const { data, error, count } = await q
      .order("is_featured", { ascending: false })
      .order("completed_on", { ascending: false, nullsFirst: false })
      .range(from, to);
    res.json({ items: unwrap({ data, error }), total: count ?? 0, page, limit });
  })
);

router.get(
  "/projects/:slug",
  asyncHandler(async (req, res) => {
    const project = unwrap(
      await supabase
        .from("projects")
        .select("*, project_categories(name,slug), project_images(id,image_url,caption,sort_order)")
        .eq("slug", req.params.slug)
        .eq("is_active", true)
        .maybeSingle(),
      "Project not found"
    );
    project.project_images?.sort((a, b) => a.sort_order - b.sort_order);
    res.json(project);
  })
);

router.get(
  "/skills",
  asyncHandler(async (req, res) => {
    res.json(
      unwrap(
        await supabase
          .from("skills")
          .select("id,name,group_name,icon,proficiency,level_label,sort_order")
          .eq("is_published", true)
          .order("sort_order")
      )
    );
  })
);

router.get(
  "/services",
  asyncHandler(async (req, res) => {
    res.json(
      unwrap(
        await supabase
          .from("services")
          .select(
            "id,slug,title,description,icon,features,delivery_estimate,price_kes,is_starting_price,allow_quantity,quantity_label,service_categories(name,slug)"
          )
          .eq("is_active", true)
          .order("sort_order")
      )
    );
  })
);

router.get(
  "/testimonials",
  asyncHandler(async (req, res) => {
    res.json(
      unwrap(
        await supabase
          .from("testimonials")
          .select("id,author_name,author_role,content,rating")
          .eq("is_published", true)
          .order("sort_order")
      )
    );
  })
);

router.get(
  "/faqs",
  asyncHandler(async (req, res) => {
    res.json(
      unwrap(await supabase.from("faqs").select("id,question,answer").eq("is_published", true).order("sort_order"))
    );
  })
);

// Privacy-conscious analytics: no cookies, no IPs, no user identifiers.
const trackSchema = z.object({
  event_type: z.enum(["page_view", "project_click", "service_inquiry", "whatsapp_click"]),
  path: z.string().max(300).optional(),
  ref_id: z.string().uuid().optional(),
});

router.post(
  "/track",
  validate(trackSchema),
  asyncHandler(async (req, res) => {
    const { event_type, path, ref_id } = req.body;
    await supabase.from("analytics_events").insert({ event_type, path: path ?? null, ref_id: ref_id ?? null });
    if (event_type === "project_click" && ref_id) {
      // best-effort counter; ignore failures
      const { data } = await supabase.from("projects").select("view_count").eq("id", ref_id).maybeSingle();
      if (data) await supabase.from("projects").update({ view_count: data.view_count + 1 }).eq("id", ref_id);
    }
    res.status(204).end();
  })
);

export default router;
