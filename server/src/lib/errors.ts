import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Wraps a route handler so a thrown Error (e.g. "batch hasn't passed QC yet") becomes
 *  a 400 response instead of crashing the process. */
export function safe(fn: (req: Request, res: Response) => void): RequestHandler {
  return (req: Request, res: Response, _next: NextFunction) => {
    try {
      fn(req, res);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Request failed' });
    }
  };
}
