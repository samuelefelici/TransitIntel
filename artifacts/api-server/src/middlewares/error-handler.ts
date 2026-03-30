import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Global async error handler.
 * Wraps an async route handler so that thrown errors are forwarded to the
 * Express error middleware instead of crashing the process.
 *
 * Usage:
 *   router.get("/path", asyncHandler(async (req, res) => { … }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Central error middleware — mount as the LAST app.use().
 * Logs the error via pino (attached by pino-http) and returns a consistent
 * JSON error response.
 */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const status = err.status ?? err.statusCode ?? 500;
  const message = status < 500 ? err.message : "Internal server error";

  // Use pino logger attached by pino-http when available
  if (req.log) {
    req.log.error(err, err.message ?? "Unhandled error");
  } else {
    console.error(err);
  }

  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
}
