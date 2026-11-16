// Usage: router.post("/", validate(schema), handler) — replaces req.body with parsed data.
export const validate = (schema, source = "body") => (req, res, next) => {
  req[source] = schema.parse(req[source]);
  next();
};
