import { Router, type Request } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db } from '../lib/supabase.js';
import { callAgent, HttpError } from '../lib/agent.js';
import { ah, check } from '../middleware/errors.js';

const r = Router();

/**
 * Restrict a calls query to the caller's org. Admins also see legacy calls
 * (org_id null: Zryth's own line from before numbers were bound to orgs).
 */
export function scopeCalls<Q extends { eq: Function; or: Function }>(q: Q, req: Request): Q {
  return req.isAdmin ? q.or(`org_id.eq.${req.org!.id},org_id.is.null`) : q.eq('org_id', req.org!.id);
}

async function getScopedCall(req: Request, id: string) {
  const c = check(await scopeCalls(db.from('calls').select('*').eq('id', id), req).maybeSingle());
  if (!c) throw new HttpError(404, 'Call not found');
  return c as any;
}

// GET /api/calls?limit=&before= -> newest first, with message_count; estimated_duration
// for calls that never got one (e.g. the worker crashed). `before` (an ISO started_at)
// pages backwards through history.
r.get('/', ah(async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(1000).default(1000).parse(req.query.limit);
  const before = z.string().datetime({ offset: true }).optional().parse(req.query.before || undefined);
  let q = scopeCalls(db.from('calls').select('*, messages(count)'), req);
  if (before) q = q.lt('started_at', before);
  const rows = (check(await q.order('started_at', { ascending: false }).limit(limit)) ?? []) as any[];

  // Last message time only for the (few) calls without a duration
  const open = rows.filter((c) => c.duration_seconds == null).map((c) => c.id);
  const lastAt = new Map<string, number>();
  for (let i = 0; i < open.length; i += 20) { // small batches: replies cap at 1000 rows
    const msgs = check(await db.from('messages').select('call_id, created_at').in('call_id', open.slice(i, i + 20))) as any[];
    for (const m of msgs) lastAt.set(m.call_id, Math.max(lastAt.get(m.call_id) ?? 0, new Date(m.created_at).getTime()));
  }

  const calls = rows.map(({ messages, ...call }) => {
    const out: any = { ...call, message_count: messages?.[0]?.count ?? 0 };
    const last = lastAt.get(call.id);
    if (call.duration_seconds == null && last) {
      const diff = Math.floor((last - new Date(call.started_at).getTime()) / 1000);
      if (diff > 0) out.estimated_duration = diff;
    }
    return out;
  });
  res.json({ data: calls });
}));

// GET /api/calls/:id -> call + transcript
r.get('/:id', ah(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const call = await getScopedCall(req, id);
  const messages = check(await db.from('messages').select('*').eq('call_id', id).order('created_at'));
  res.json({ data: { call, messages } });
}));

// Each fresh summary is a paid LLM call
const summaryLimit = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.user!.id,
  message: { error: 'Too many summaries requested. Please wait a minute.' },
});

// POST /api/calls/:id/summary[?refresh=1] -> the stored summary (the agent writes one at
// call end); otherwise the transcript is summarised by the agent (Gemini key stays there)
// and stored, so each call is paid for once.
r.post('/:id/summary', summaryLimit, ah(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const call = await getScopedCall(req, id);
  if (call.summary && !req.query.refresh) return res.json({ data: { summary: call.summary } });
  const msgs = check(await db.from('messages').select('speaker, message').eq('call_id', id).order('created_at')) as any[];
  if (!msgs?.length) throw new HttpError(404, 'No transcript for this call');
  const customer = call.customer_name || 'Customer';
  // messages columns: speaker ('customer' | 'maya'), message
  const transcript = msgs
    .map((m) => `${m.speaker === 'maya' ? 'AI Agent' : customer}: ${m.message ?? ''}`)
    .join('\n')
    .slice(0, 60_000);
  const out = await callAgent<{ summary: string }>('/internal/ai/summarize', { transcript });
  if (out?.summary) {
    const saved = await db.from('calls').update({ summary: out.summary }).eq('id', id);
    if (saved.error) console.error('Could not store summary:', saved.error);
  }
  res.json({ data: out });
}));

export default r;
