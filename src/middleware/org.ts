import type { Request, Response, NextFunction } from 'express';
import { db } from '../lib/supabase.js';
import { adminEmails } from '../config.js';
import { TtlCache } from '../lib/cache.js';

export interface OrgContext { id: string; name: string; role: 'owner' | 'admin' | 'member'; max_numbers: number }

declare global {
  namespace Express { interface Request { org?: OrgContext; isAdmin?: boolean } }
}

/**
 * Resolve the signed-in user's organization. Every org-scoped query uses req.org.id,
 * never an id from the request, so one tenant can't read another's data.
 * Users get an org from the on_auth_user_created trigger (db/002_multitenant.sql).
 */
// user -> org for 30s per instance (limit changes reach users within that window;
// admin limit updates clear the entry immediately on the instance that made them)
export const orgCache = new TtlCache<OrgContext>(30_000);

export async function loadOrg(req: Request, res: Response, next: NextFunction) {
  const user = req.user!;
  req.isAdmin = adminEmails.has((user.email ?? '').toLowerCase());
  const cached = orgCache.get(user.id);
  if (cached) {
    req.org = cached;
    return next();
  }
  const { data, error } = await db
    .from('org_members')
    .select('role, organizations(id, name, max_numbers)')
    .eq('user_id', user.id)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('Org lookup failed:', error);
    return res.status(500).json({ error: 'Could not load your organization' });
  }
  const org = (data as any)?.organizations;
  if (!org) return res.status(403).json({ error: 'Your account has no organization. Contact support.' });
  req.org = { id: org.id, name: org.name, max_numbers: org.max_numbers, role: (data as any).role };
  orgCache.set(user.id, req.org);
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Only the owner account can use this page.' });
  next();
}
