import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/supabase.js';
import { env } from '../config.js';
import { agentHealth } from '../lib/agent.js';
import { vobiz } from '../lib/vobiz.js';
import { ah, check } from '../middleware/errors.js';

/**
 * Routes used by the original dashboard pages.
 *  - ownerAgents: prompts/tools attached to the shared template (AGENT_ID). Changing them
 *    changes every customer's agent, so only the owner account(s) may (requireAdmin at
 *    mount); /status is the shared worker's health and is open to every account.
 *  - ownerPhoneNumbers / ownerPhoneMap: the signed-in account's own numbers.
 */

const agentId = (q: unknown) => z.string().min(1).max(64).default(env.AGENT_ID).parse(q || undefined);
const HEARTBEAT_MAX_AGE_MS = 30_000;

// Mounted at /api/agents (before the customer-agent routes)
export const ownerAgents = Router();

// GET /api/agents/status -> freshest worker heartbeat + webhook reachability
ownerAgents.get('/status', ah(async (_req, res) => {
  const [rows, reachable] = await Promise.all([
    db.from('agent_status').select('*').order('last_heartbeat', { ascending: false, nullsFirst: false }).limit(1),
    agentHealth(),
  ]);
  const s = (check(rows) as any[])[0];
  const fresh = s?.last_heartbeat && Date.now() - new Date(s.last_heartbeat).getTime() < HEARTBEAT_MAX_AGE_MS;
  res.json({ data: {
    agent_id: env.AGENT_ID, status: s?.status ?? 'unknown', last_heartbeat: s?.last_heartbeat ?? null,
    is_active: Boolean(fresh && s.status === 'active'), server_reachable: reachable,
  } });
}));

// GET /api/agents/config -> prompts + tools attached to the agent
ownerAgents.get('/config', ah(async (req, res) => {
  const id = agentId(req.query.agent_id);
  const [p, t] = await Promise.all([
    db.from('agent_prompts').select('*').eq('agent_id', id),
    db.from('agent_tools').select('*').eq('agent_id', id),
  ]);
  res.json({ data: { prompts: check(p), tools: check(t) } });
}));

ownerAgents.post('/prompts', ah(async (req, res) => {
  const b = z.object({ prompt_tag: z.string().min(1).max(200), agent_id: z.string().optional() }).parse(req.body);
  check(await db.from('agent_prompts').insert({ agent_id: agentId(b.agent_id), prompt_tag: b.prompt_tag }));
  res.status(201).json({ ok: true });
}));
ownerAgents.delete('/prompts/:tag', ah(async (req, res) => {
  check(await db.from('agent_prompts').delete().eq('agent_id', agentId(req.query.agent_id)).eq('prompt_tag', req.params.tag));
  res.json({ ok: true });
}));
ownerAgents.post('/tools', ah(async (req, res) => {
  const b = z.object({ tool_name: z.string().min(1).max(200), agent_id: z.string().optional() }).parse(req.body);
  check(await db.from('agent_tools').insert({ agent_id: agentId(b.agent_id), tool_name: b.tool_name }));
  res.status(201).json({ ok: true });
}));
ownerAgents.delete('/tools/:name', ah(async (req, res) => {
  check(await db.from('agent_tools').delete().eq('agent_id', agentId(req.query.agent_id)).eq('tool_name', req.params.name));
  res.json({ ok: true });
}));

// Mounted at /api/phone-numbers -> the signed-in account's numbers (phone_numbers rows),
// in the shape the Phone Numbers page renders
export const ownerPhoneNumbers = Router();
ownerPhoneNumbers.get('/', ah(async (req, res) => {
  const rows = check(await db.from('phone_numbers')
    .select('id, e164, status, agent_id, monthly_fee, setup_fee, currency, purchased_at, created_at')
    .eq('org_id', req.org!.id).neq('status', 'released').order('created_at')) as any[];
  res.json({ data: rows.map((n) => ({
    ...n, country: n.e164.startsWith('+91') ? 'IN' : null, region: 'Vobiz', voice_enabled: true,
  })) });
}));
ownerPhoneNumbers.get('/inventory', ah(async (req, res) => {
  const page = z.coerce.number().int().min(1).max(1000).default(1).parse(req.query.page);
  const search = z.string().max(50).optional().parse(req.query.search || undefined);
  let path = `/inventory/numbers?per_page=50&page=${page}`;
  if (search) path += `&search=${encodeURIComponent(search)}`;
  res.json({ data: await vobiz(path) });
}));

// Mounted at /api/calls/agent-phone-map -> which of the account's agents answers each number
export const ownerPhoneMap = Router();
ownerPhoneMap.get('/', ah(async (req, res) => {
  const rows = check(await db.from('phone_numbers').select('e164, agent_id, agents(name)')
    .eq('org_id', req.org!.id).not('agent_id', 'is', null)) as any[];
  res.json({ data: rows.map((n) => ({ phone_number: n.e164, agent_id: n.agent_id, agent_name: n.agents?.name ?? null })) });
}));
