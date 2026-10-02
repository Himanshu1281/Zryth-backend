import type { Request, Response, NextFunction } from 'express';
import type { User } from '@supabase/supabase-js';
import { db } from '../lib/supabase.js';
import { TtlCache } from '../lib/cache.js';

declare global {
  namespace Express { interface Request { user?: User } }
}

// Verified tokens are reused for up to 60s (never past their own expiry), so a page
// that fires several API calls costs one Supabase auth round trip, not one per call.
const verified = new TtlCache<User>(60_000);

function tokenExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Verifies the Supabase access token the dashboard sends as `Authorization: Bearer <jwt>`. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  const cached = verified.get(token);
  if (cached) {
    req.user = cached;
    return next();
  }

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = data.user;

  const exp = tokenExpiryMs(token);
  const ttl = exp ? Math.min(60_000, exp - Date.now()) : 60_000;
  if (ttl > 0) verified.set(token, data.user, ttl);
  next();
}
