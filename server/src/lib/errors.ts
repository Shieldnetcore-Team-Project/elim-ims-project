import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Wraps a route handler so a thrown Error (e.g. "batch hasn't passed QC yet") — or a
 *  rejected promise, now that every DB-touching handler is async — becomes a 400
 *  response instead of crashing the process / hanging as an unhandled rejection. */
export function safe(fn: (req: Request, res: Response) => void | Promise<void>): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Request failed' });
    }
  };
}
