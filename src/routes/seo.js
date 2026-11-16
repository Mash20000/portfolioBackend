import { Router } from "express";
import { supabase } from "../config/supabase.js";
import { clientOrigins } from "../config/env.js";
import { asyncHandler } from "../utils/httpError.js";

const router = Router();
const site = () => (clientOrigins[clientOrigins.length - 1] || "http://localhost:5173").replace(/\/$/, "");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The LAST value of CLIENT_ORIGIN is treated as the public site URL (put production last).
router.get(
  "/sitemap.xml",
  asyncHandler(async (req, res) => {
    const { data } = await supabase.from("projects").select("slug,updated_at").eq("is_active", true);
    const urls = [
      { loc: `${site()}/` },
      ...(data ?? []).map((p) => ({ loc: `${site()}/projects/${p.slug}`, lastmod: p.updated_at.slice(0, 10) })),
    ];
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls
        .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`)
        .join("\n") +
      `\n</urlset>`;
    res.type("application/xml").send(xml);
  })
);

router.get("/robots.txt", (req, res) => {
  res
    .type("text/plain")
    .send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /checkout\nDisallow: /order/\n\nSitemap: ${site()}/sitemap.xml\n`);
});

export default router;
