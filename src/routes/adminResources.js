import { z } from "zod";

// Optional http(s) URL that may be blank; blank becomes null.
const optUrl = z
  .union([z.string().trim().url().max(500), z.literal(""), z.null()])
  .optional()
  .transform((v) => v || null);

const optText = (max) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => v || null);

const sortOrder = z.coerce.number().int().min(0).max(10000).optional();
const uuidOrNull = z
  .union([z.string().uuid(), z.literal(""), z.null()])
  .optional()
  .transform((v) => v || null);

const SKILL_GROUPS = ["Web Development", "Data and Productivity", "IoT and Hardware", "Education and Training"];

// table: Postgres table | schema: validated writable fields | slugFrom: auto-slug source field
export const resources = {
  projects: {
    table: "projects",
    select: "*, project_categories(name,slug), project_images(id,image_url,storage_path,caption,sort_order)",
    order: { col: "created_at", asc: false },
    search: ["title", "description"],
    slugFrom: "title",
    schema: z.object({
      title: z.string().trim().min(2).max(160),
      slug: z.string().trim().max(100).optional(),
      description: z.string().trim().max(10000).default(""),
      category_id: uuidOrNull,
      technologies: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
      thumbnail_url: optUrl,
      github_url: optUrl,
      live_url: optUrl,
      completed_on: z
        .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(""), z.null()])
        .optional()
        .transform((v) => v || null),
      is_featured: z.boolean().default(false),
      is_active: z.boolean().default(true),
    }),
  },
  services: {
    table: "services",
    select: "*, service_categories(name)",
    order: { col: "sort_order", asc: true },
    search: ["title", "description"],
    slugFrom: "title",
    schema: z.object({
      title: z.string().trim().min(2).max(160),
      slug: z.string().trim().max(100).optional(),
      description: z.string().trim().max(5000).default(""),
      category_id: uuidOrNull,
      icon: optText(40),
      features: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
      delivery_estimate: z.string().trim().min(1).max(80).default("To be agreed"),
      price_kes: z.coerce.number().min(0).max(10_000_000),
      is_starting_price: z.boolean().default(true),
      allow_quantity: z.boolean().default(false),
      quantity_label: optText(30),
      is_active: z.boolean().default(true),
      sort_order: sortOrder,
    }),
  },
  skills: {
    table: "skills",
    order: { col: "group_name", asc: true },
    search: ["name"],
    schema: z.object({
      name: z.string().trim().min(1).max(80),
      group_name: z.enum(SKILL_GROUPS),
      icon: optText(40),
      proficiency: z.coerce.number().int().min(0).max(100).default(70),
      level_label: optText(30),
      sort_order: sortOrder,
      is_published: z.boolean().default(true),
    }),
  },
  testimonials: {
    table: "testimonials",
    order: { col: "sort_order", asc: true },
    search: ["author_name", "content"],
    schema: z.object({
      author_name: z.string().trim().min(2).max(120),
      author_role: optText(120),
      content: z.string().trim().min(5).max(2000),
      rating: z
        .union([z.coerce.number().int().min(1).max(5), z.literal(""), z.null()])
        .optional()
        .transform((v) => v || null),
      is_published: z.boolean().default(true),
      sort_order: sortOrder,
    }),
  },
  faqs: {
    table: "faqs",
    order: { col: "sort_order", asc: true },
    search: ["question", "answer"],
    schema: z.object({
      question: z.string().trim().min(3).max(300),
      answer: z.string().trim().min(3).max(3000),
      is_published: z.boolean().default(true),
      sort_order: sortOrder,
    }),
  },
  "project-categories": {
    table: "project_categories",
    order: { col: "sort_order", asc: true },
    slugFrom: "name",
    schema: z.object({
      name: z.string().trim().min(2).max(80),
      slug: z.string().trim().max(80).optional(),
      sort_order: sortOrder,
    }),
  },
  "service-categories": {
    table: "service_categories",
    order: { col: "sort_order", asc: true },
    slugFrom: "name",
    schema: z.object({
      name: z.string().trim().min(2).max(80),
      slug: z.string().trim().max(80).optional(),
      sort_order: sortOrder,
    }),
  },
};
