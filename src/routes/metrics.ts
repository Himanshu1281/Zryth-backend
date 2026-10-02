import { Router } from 'express';
import { db } from '../lib/supabase.js';
import { env } from '../config.js';
import { ah, check } from '../middleware/errors.js';
import { scopeCalls } from './calls.js';
import { workerOnline } from './status.js';

const r = Router();

/** Totals via db/003 org_call_stats(); falls back to a row scan if 003 isn't applied yet. */
async function callTotals(req: Parameters<typeof scopeCalls>[1]): Promise<{ calls: number; seconds: number }> {
  const { data, error } = await db.rpc('org_call_stats', { p_org: req.org!.id, p_include_legacy: Boolean(req.isAdmin) });
  if (!error) {
    const row = (Array.isArray(data) ? data[0] : data) as any;
    return { calls: Number(row?.total_calls ?? 0), seconds: Number(row?.total_seconds ?? 0) };
  }
  if (error.code !== 'PGRST202') check({ data, error }); // anything but "function missing" is a real error
  const rows = check(await scopeCalls(db.from('calls').select('duration_seconds'), req)) as any[];
  return { calls: rows.length, seconds: rows.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) };
}

// GET /api/metrics -> org totals; activeAgents = org agents answering an active number while the worker is up
r.get('/', ah(async (req, res) => {
  const [totals, live, online] = await Promise.all([
    callTotals(req),
    db.from('phone_numbers').select('agent_id').eq('org_id', req.org!.id).eq('status', 'active').not('agent_id', 'is', null),
    workerOnline(),
  ]);
  const totalMinutes = Math.round((totals.seconds / 60) * 100) / 100;
  const activeAgents = online ? new Set((check(live) as any[]).map((n) => n.agent_id)).size : 0;
  res.json({
    data: {
      totalCalls: totals.calls,
      totalMinutes,
      totalCost: Math.round(totalMinutes * env.COST_PER_MINUTE * 100) / 100,
      activeAgents,
    },
  });
}));

export default r;
