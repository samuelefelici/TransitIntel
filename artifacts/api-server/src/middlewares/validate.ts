import type { Request, Response, NextFunction, RequestHandler } from "express";
import { z, type ZodType } from "zod";

/**
 * Express middleware that validates `req.query` against a Zod schema.
 * On failure returns 400 with a structured error.
 * On success the parsed (and coerced) values are stored in `res.locals.query`.
 *
 * Usage:
 *   router.get("/path", validateQuery(MySchema), asyncHandler(async (req, res) => {
 *     const { limit } = res.locals.query;
 *   }));
 */
export function validateQuery<T extends ZodType>(schema: T): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: result.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    // Store parsed & coerced values on res.locals (req.query is read-only in Express 5)
    res.locals.query = result.data;
    next();
  };
}

/**
 * Express middleware that validates `req.body` against a Zod schema.
 */
export function validateBody<T extends ZodType>(schema: T): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: result.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    res.locals.body = result.data;
    next();
  };
}
