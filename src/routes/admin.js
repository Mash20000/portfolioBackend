import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../utils/httpError.js";
import { unwrap, slugify, randomSuffix, cleanSearch, pageParams } from "../utils/helpers.js";
import { logActivity } from "../utils/activity.js";
import { resources } from "./adminResources.js";

const router = Router();
router.use(requireAdmin); // every admin route requires a verified admin

router.get("/me", (req, res) => res.json({ id: req.admin.id, email: req.admin.email }));

// ---------- dashboard stats ----------
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const count = async (table, apply) => {
      let q = supabase.from(table).select("*", { count: "exact", head: true });
      if (apply) q = apply(q);
      const { count: c, error } = await q;
      if (error) throw new HttpError(500, "Database error");
      return c ?? 0;
    };
    const since14 = new Date(Date.now() - 14 * 864e5).toISOString();
    const since30 = new Date(Date.now() - 30 * 864e5).toISOString();

    const [projects, services, orders, pendingOrders, paidPayments, newInquiries] = await Promise.all([
      count("projects"),
      count("services"),
      count("orders"),
      count("orders", (q) => q.in("payment_status", ["pending", "processing"])),
      count("payments", (q) => q.eq("status", "paid")),
      count("inquiries", (q) => q.eq("status", "new")),
    ]);

    const paid = unwrap(
      await supabase.from("orders").select("total_kes,created_at").eq("payment_status", "paid").limit(20000)
    );
    const revenue = paid.reduce((s, o) => s + Number(o.total_kes), 0);

    const byDay = {};
    for (let i = 13; i >= 0; i--) byDay[new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)] = 0;
    for (const o of paid) {
      const d = o.created_at.slice(0, 10);
      if (o.created_at >= since14 && d in byDay) byDay[d] += Number(o.total_kes);
    }

    const events = unwrap(
      await supabase.from("analytics_events").select("event_type").gte("created_at", since30).limit(50000)
    );
    const analytics = { page_view: 0, project_click: 0, service_inquiry: 0, whatsapp_click: 0 };
    for (const e of events) analytics[e.event_type] = (analytics[e.event_type] ?? 0) + 1;

    res.json({
      projects,
      services,
      orders,
      pendingOrders,
      paidPayments,
      newInquiries,
      revenue,
      revenueByDay: Object.entries(byDay).map(([date, total]) => ({ date: date.slice(5), total })),
      analytics,
    });
  })
);

// ---------- uploads ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    ["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file.mimetype)
      ? cb(null, true)
      : cb(new HttpError(400, "Only JPG, PNG, WebP or AVIF images up to 5MB are allowed")),
});
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };

router.post(
  "/upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const bucket = req.body.bucket;
    if (!["project-images", "profile-images"].includes(bucket)) throw new HttpError(400, "Invalid bucket");
    if (!req.file) throw new HttpError(400, "No file uploaded");
    const path = `${new Date().getFullYear()}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${EXT[req.file.mimetype]}`;
    const { error } = await supabase.storage.from(bucket).upload(path, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });
    if (error) throw new HttpError(500, `Upload failed: ${error.message}`);
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    res.status(201).json({ url: data.publicUrl, path, bucket });
  })
);

// ---------- project screenshots ----------
router.post(
  "/projects/:id/images",
  validate(
    z.object({
      image_url: z.string().url().max(1000),
      storage_path: z.string().max(500).optional(),
      caption: z.string().max(200).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { count } = await supabase
      .from("project_images")
      .select("*", { count: "exact", head: true })
      .eq("project_id", req.params.id);
    const row = unwrap(
      await supabase
        .from("project_images")
        .insert({ project_id: req.params.id, ...req.body, sort_order: count ?? 0 })
        .select()
        .single()
    );
    await logActivity(req.admin, "project.image.add", "project", req.params.id);
    res.status(201).json(row);
  })
);

router.delete(
  "/project-images/:id",
  asyncHandler(async (req, res) => {
    const img = unwrap(
      await supabase.from("project_images").select("id,project_id,storage_path").eq("id", req.params.id).maybeSingle(),
      "Image not found"
    );
    if (img.storage_path) await supabase.storage.from("project-images").remove([img.storage_path]);
    unwrap(await supabase.from("project_images").delete().eq("id", img.id));
    await logActivity(req.admin, "project.image.delete", "project", img.project_id);
    res.status(204).end();
  })
);

// ---------- website settings ----------
const SETTING_KEYS = [
  "site_name", "hero_headline", "hero_intro", "about_bio", "email", "whatsapp",
  "profile_image_url", "social_links", "contact_info",
];

router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const rows = unwrap(await supabase.from("website_settings").select("key,value"));
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  })
);

router.put(
  "/settings",
  asyncHandler(async (req, res) => {
    const entries = Object.entries(req.body || {}).filter(([k]) => SETTING_KEYS.includes(k));
    if (!entries.length) throw new HttpError(400, "No valid settings supplied");
    for (const [key, value] of entries) {
      if (key === "whatsapp") {
        const digits = String(value).replace(/\D/g, "");
        if (!/^\d{10,15}$/.test(digits)) throw new HttpError(400, "WhatsApp number must be in international format, e.g. 254798890529");
      }
      if (key === "social_links") {
        for (const v of Object.values(value || {})) {
          if (v && !/^https?:\/\//i.test(String(v))) throw new HttpError(400, "Social links must start with http:// or https://");
        }
      }
    }
    unwrap(
      await supabase.from("website_settings").upsert(
        entries.map(([key, value]) => ({
          key,
          // value column is NOT NULL jsonb: store "" instead of null (e.g. no profile image)
          value: key === "whatsapp" ? String(value).replace(/\D/g, "") : value ?? "",
          is_public: true,
        }))
      )
    );
    await logActivity(req.admin, "settings.update", "website_settings", null, { keys: entries.map(([k]) => k) });
    res.json({ ok: true });
  })
);

// ---------- orders ----------
router.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const { page, limit, from, to } = pageParams(req.query, 15, 50);
    let q = supabase
      .from("orders")
      .select("*, order_items(service_title,quantity,unit_price_kes,line_total_kes), payments(status,mpesa_receipt_number,checkout_request_id,result_desc,created_at)", { count: "exact" });
    if (req.query.payment_status) q = q.eq("payment_status", String(req.query.payment_status));
    if (req.query.fulfilment_status) q = q.eq("fulfilment_status", String(req.query.fulfilment_status));
    const s = cleanSearch(req.query.q);
    if (s) q = q.or(`reference.ilike.%${s}%,customer_name.ilike.%${s}%,customer_email.ilike.%${s}%,customer_phone.ilike.%${s}%`);
    const { data, error, count } = await q.order("created_at", { ascending: false }).range(from, to);
    res.json({ items: unwrap({ data, error }), total: count ?? 0, page, limit });
  })
);

router.patch(
  "/orders/:id",
  validate(z.object({ fulfilment_status: z.enum(["new", "accepted", "in_progress", "completed", "rejected"]) })),
  asyncHandler(async (req, res) => {
    const row = unwrap(
      await supabase.from("orders").update(req.body).eq("id", req.params.id).select().maybeSingle(),
      "Order not found"
    );
    await logActivity(req.admin, "order.fulfilment", "order", row.reference, req.body);
    res.json(row);
  })
);

// ---------- inquiries ----------
router.get(
  "/inquiries",
  asyncHandler(async (req, res) => {
    const { page, limit, from, to } = pageParams(req.query, 15, 50);
    let q = supabase.from("inquiries").select("*", { count: "exact" });
    if (req.query.status) q = q.eq("status", String(req.query.status));
    const { data, error, count } = await q.order("created_at", { ascending: false }).range(from, to);
    res.json({ items: unwrap({ data, error }), total: count ?? 0, page, limit });
  })
);

router.patch(
  "/inquiries/:id",
  validate(
    z.object({
      status: z.enum(["new", "read", "replied", "closed", "spam"]).optional(),
      is_read: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const patch = { ...req.body };
    if (patch.status && patch.status !== "new") patch.is_read = true;
    const row = unwrap(
      await supabase.from("inquiries").update(patch).eq("id", req.params.id).select().maybeSingle(),
      "Inquiry not found"
    );
    await logActivity(req.admin, "inquiry.update", "inquiry", req.params.id, patch);
    res.json(row);
  })
);

router.delete(
  "/inquiries/:id",
  asyncHandler(async (req, res) => {
    unwrap(await supabase.from("inquiries").delete().eq("id", req.params.id));
    await logActivity(req.admin, "inquiry.delete", "inquiry", req.params.id);
    res.status(204).end();
  })
);

// ---------- activity log ----------
router.get(
  "/activity",
  asyncHandler(async (req, res) => {
    const { page, limit, from, to } = pageParams(req.query, 25, 100);
    const { data, error, count } = await supabase
      .from("activity_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    res.json({ items: unwrap({ data, error }), total: count ?? 0, page, limit });
  })
);

// ---------- generic CRUD for content tables (see adminResources.js) ----------
const getResource = (req) => {
  const r = resources[req.params.resource];
  if (!r) throw new HttpError(404, "Unknown resource");
  return r;
};

router.get(
  "/:resource",
  asyncHandler(async (req, res) => {
    const r = getResource(req);
    const { page, limit, from, to } = pageParams(req.query, 20, 100);
    let q = supabase.from(r.table).select(r.select ?? "*", { count: "exact" });
    const s = cleanSearch(req.query.q);
    if (s && r.search) q = q.or(r.search.map((c) => `${c}.ilike.%${s}%`).join(","));
    const { data, error, count } = await q.order(r.order.col, { ascending: r.order.asc }).range(from, to);
    res.json({ items: unwrap({ data, error }), total: count ?? 0, page, limit });
  })
);

async function writeWithSlug(r, op) {
  const first = await op(false);
  if (first.error?.code === "23505" && /slug/.test(first.error.message || "")) return op(true);
  return first;
}

router.post(
  "/:resource",
  asyncHandler(async (req, res) => {
    const r = getResource(req);
    const body = r.schema.parse(req.body);
    const baseSlug = r.slugFrom ? slugify(body.slug || body[r.slugFrom]) : null;
    const result = await writeWithSlug(r, (retry) =>
      supabase
        .from(r.table)
        .insert(baseSlug ? { ...body, slug: retry ? `${baseSlug}-${randomSuffix()}` : baseSlug } : body)
        .select()
        .single()
    );
    const row = unwrap(result);
    await logActivity(req.admin, `${r.table}.create`, r.table, row.id);
    res.status(201).json(row);
  })
);

router.put(
  "/:resource/:id",
  asyncHandler(async (req, res) => {
    const r = getResource(req);
    const body = r.schema.partial().parse(req.body);
    if (body.slug) body.slug = slugify(body.slug);
    const row = unwrap(
      await supabase.from(r.table).update(body).eq("id", req.params.id).select().maybeSingle(),
      "Record not found"
    );
    await logActivity(req.admin, `${r.table}.update`, r.table, req.params.id);
    res.json(row);
  })
);

router.delete(
  "/:resource/:id",
  asyncHandler(async (req, res) => {
    const r = getResource(req);
    if (r.table === "projects") {
      // clean up screenshot files in storage before the rows cascade away
      const { data: imgs } = await supabase.from("project_images").select("storage_path").eq("project_id", req.params.id);
      const paths = (imgs ?? []).map((i) => i.storage_path).filter(Boolean);
      if (paths.length) await supabase.storage.from("project-images").remove(paths);
    }
    unwrap(await supabase.from(r.table).delete().eq("id", req.params.id));
    await logActivity(req.admin, `${r.table}.delete`, r.table, req.params.id);
    res.status(204).end();
  })
);

export default router;
