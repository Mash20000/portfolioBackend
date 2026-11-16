import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  JWT_SECRET: z.string().min(16),
  MPESA_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CONSUMER_KEY: z.string().default(""),
  MPESA_CONSUMER_SECRET: z.string().default(""),
  MPESA_SHORTCODE: z.string().default("174379"),
  MPESA_PASSKEY: z.string().default(""),
  MPESA_CALLBACK_URL: z.string().default(""),
  MPESA_CALLBACK_TOKEN: z.string().default(""),
  EMAIL_ENABLED: z.enum(["true", "false"]).default("false"),
  IP_HASH_SALT: z.string().default("change-me"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("Copy server/.env.example to server/.env and fill in the values.");
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const clientOrigins = env.CLIENT_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
