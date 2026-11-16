import crypto from "node:crypto";
import { HttpError } from "./httpError.js";
import { env } from "../config/env.js";

// 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX -> 2547XXXXXXXX (or null)
export function normalizeKenyanPhone(input) {
  const s = String(input ?? "").replace(/[\s\-()]/g, "");
  const m = s.match(/^(?:\+?254|0)?([71]\d{8})$/);
  return m ? `254${m[1]}` : null;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export const randomSuffix = () => crypto.randomBytes(2).toString("hex");

export function hashIp(ip) {
  return crypto.createHash("sha256").update(`${env.IP_HASH_SALT}:${ip || ""}`).digest("hex").slice(0, 32);
}

// Strip characters that would break PostgREST .or() filters or act as LIKE wildcards.
export const cleanSearch = (q) => String(q ?? "").replace(/[,()%*\\_]/g, " ").trim().slice(0, 80);

export function pageParams(query, defaultLimit = 12, maxLimit = 50) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, from: (page - 1) * limit, to: (page - 1) * limit + limit - 1 };
}

// Throws a clean HttpError for Supabase errors; returns data otherwise.
export function unwrap({ data, error }, notFoundMessage) {
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "That value already exists (duplicate).");
    if (error.code === "23503") throw new HttpError(409, "This record is still referenced elsewhere.");
    if (error.code === "22P02") throw new HttpError(400, "Invalid identifier or value.");
    console.error("Supabase error:", error);
    throw new HttpError(500, "Database error");
  }
  if (notFoundMessage && (data === null || data === undefined)) throw new HttpError(404, notFoundMessage);
  return data;
}
