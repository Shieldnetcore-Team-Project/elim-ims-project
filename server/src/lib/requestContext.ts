import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

export interface RequestContext { ipAddress: string | null; device: string | null }

const als = new AsyncLocalStorage<RequestContext>();

/** Captures req.ip/user-agent once per request so activityLog.record() can read them
 *  internally — every existing call site keeps its current signature and gains audit
 *  fields for free instead of threading req through 23 service files. Must be
 *  registered before any router so it wraps the whole handler chain. */
export const requestContextMiddleware: RequestHandler = (req, _res, next) => {
  als.run({ ipAddress: req.ip ?? null, device: (req.headers['user-agent'] as string) ?? null }, next);
};

/** Outside a request (e.g. seed() at boot) there's no context — falls back to nulls,
 *  which is correct since seeded rows weren't produced by a real request. */
export function currentRequestContext(): RequestContext {
  return als.getStore() ?? { ipAddress: null, device: null };
}
