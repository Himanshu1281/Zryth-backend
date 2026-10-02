import { Router } from 'express';
import { db } from '../lib/supabase.js';
import { HttpError } from '../lib/agent.js';
import { ah, check } from '../middleware/errors.js';

const r = Router();

// GET /api/account/me -> who am I, which org, am I an admin
r.get('/me', ah(async (req, res) => {
  const u = req.user!;
  res.json({ data: { id: u.id, email: u.email, org: req.org, is_admin: Boolean(req.isAdmin) } });
}));

// DELETE /api/account/me -> the user, and their org if they own it.
// Blocked while the org still rents numbers (Vobiz keeps billing them).
r.delete('/me', ah(async (req, res) => {
  const org = req.org!;
  if (org.role === 'owner') {
    // pending/active/failed numbers are still rented on Vobiz: they must be released first
    const live = check(await db.from('phone_numbers').select('id').eq('org_id', org.id)
      .neq('status', 'released')) as any[];
    if (live.length) throw new HttpError(409, 'Your organization still has phone numbers. Contact support to release them before deleting your account.');
    // released rows are history only; they would block the org delete (FK on delete restrict)
    check(await db.from('phone_numbers').delete().eq('org_id', org.id).eq('status', 'released'));
    check(await db.from('organizations').delete().eq('id', org.id));
  }
  const profile = await db.from('users').delete().eq('id', req.user!.id);
  if (profile.error) console.error('Profile delete failed:', profile.error);
  const { error } = await db.auth.admin.deleteUser(req.user!.id);
  if (error) throw error;
  res.json({ ok: true });
}));

export default r;
