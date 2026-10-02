import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { HttpError } from '../lib/agent.js';

/** Wrap async handlers so thrown errors reach the error middleware. */
export const ah = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

// Business-rule violations raised by db/002_multitenant.sql triggers/functions (errcode P0001)
const RULES: Record<string, [number, string]> = {
  number_limit_reached: [409, 'You have reached your phone number limit. Contact us to raise it.'],
  phone_number_already_bound: [409, 'This number is already connected to an agent and cannot be changed.'],
  phone_number_not_active: [409, 'This number is not active yet.'],
  agent_not_in_org: [404, 'Agent not found'],
  agent_template_immutable: [400, "An agent's template cannot be changed"],
  phone_number_identity_immutable: [400, 'A phone number cannot be moved'],
  org_not_found: [404, 'Organization not found'],
};

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.issues });
  if (err?.code === '23505') return res.status(409).json({ error: 'Already exists' });
  if (err?.code === '23503') return res.status(409).json({ error: 'It is still in use' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 50MB)' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' }); // never leak internals
}

/** Unwrap a Supabase { data, error } result, throwing on error. */
export function check<T>(r: { data: T; error: any }): NonNullable<T> | T {
  if (r.error) {
    if (r.error.code === '23505' || r.error.code === '23503') throw r.error;
    const rule = r.error.code === 'P0001' && RULES[r.error.message];
    if (rule) throw new HttpError(rule[0], rule[1]);
    console.error('Supabase error:', r.error);
    // Bad input (22xxx data exceptions, 23xxx constraints, PGRST1xx request errors) is the
    // caller's fault; anything else (outage, timeout, permissions) is ours and retryable.
    const code = String(r.error.code ?? '');
    if (/^(22|23)/.test(code) || /^PGRST1/.test(code)) throw new HttpError(400, 'Invalid request');
    throw new HttpError(503, 'Database is temporarily unavailable');
  }
  return r.data;
}
