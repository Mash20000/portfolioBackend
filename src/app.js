import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env, clientOrigins, isProd } from "./config/env.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";
import routes from "./routes/index.js";
import seoRoutes from "./routes/seo.js";

const TUNNEL_ORIGIN = /^https:\/\/[a-z0-9-]+\.(ngrok-free\.(dev|app)|ngrok\.(io|app)|trycloudflare\.com)$/i;

const app = express();

app.disable("x-powered-by");
// Required when deployed behind a proxy/tunnel so rate limiting sees the real client IP.
app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / server-to-server (no Origin header) and configured origins.
      if (!origin || clientOrigins.includes(origin)) return cb(null, true);
      // Development only: also accept common tunnel domains (ngrok, Cloudflare) so testing over a tunnel just works.
      if (!isProd && TUNNEL_ORIGIN.test(origin)) return cb(null, true);
      console.warn(`CORS blocked origin: ${origin} (add it to CLIENT_ORIGIN in server/.env)`);
      cb(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use("/api", apiLimiter, routes);
app.use(seoRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`API running on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

export default app;