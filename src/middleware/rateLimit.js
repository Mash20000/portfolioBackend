import rateLimit from "express-rate-limit";

const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });

export const apiLimiter = make(60_000, 200, "Too many requests, please slow down.");
export const formLimiter = make(15 * 60_000, 8, "Too many submissions. Please try again later.");
export const checkoutLimiter = make(15 * 60_000, 12, "Too many checkout attempts. Please try again later.");
export const loginLimiter = make(15 * 60_000, 10, "Too many login attempts. Please try again later.");
