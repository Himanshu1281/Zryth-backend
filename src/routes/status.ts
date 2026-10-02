import { Router } from 'express';
import { db } from '../lib/supabase.js';
import { agentHealth } from '../lib/agent.js';
import { ah } from '../middleware/errors.js';

const r = Router();
const HEARTBEAT_MAX_AGE_MS = 30_000;

/** True when at least one voice worker has heart-beaten recently. */
export async function workerOnline(): Promise<boolean> {
  const { data } = await db.from('agent_status').select('status, last_heartbeat');
  return (data ?? []).some((s: any) =>
    s.status !== 'offline' && s.status !== 'inactive' && s.last_heartbeat &&
    Date.now() - new Date(s.last_heartbeat).getTime() < HEARTBEAT_MAX_AGE_MS);
}

// GET /api/status -> is the voice platform up (any org can see this)
r.get('/', ah(async (_req, res) => {
  const [online, webhook] = await Promise.all([workerOnline(), agentHealth()]);
  res.json({ data: { voice_online: online, webhook_reachable: webhook } });
}));

export default r;
