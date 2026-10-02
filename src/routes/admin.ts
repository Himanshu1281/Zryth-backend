import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/supabase.js';
import { env } from '../config.js';
import { HttpError } from '../lib/agent.js';
import { vobiz } from '../lib/vobiz.js';
import { ah, check } from '../middleware/errors.js';
import { orgCache } from '../middleware/org.js';
import prompts from './prompts.js';
import tools from './tools.js';

// Zryth staff only (ADMIN_EMAILS). Mounted at /api/admin behind requireAdmin.
const r = Router();
r.use('/prompts', prompts);
r.use('/tools', tools);

const templateId = (q: unknown) => z.string().min(1).max(64).default(env.AGENT_ID).parse(q || undefined);

// ── Templates ────────────────────────────────────────────────────────────────
const templateBody = z.object({
  id: z.string().regex(/^[a-z0-9_]{2,64}$/, 'Use lowercase letters, numbers and _'),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  persona_name: z.string().min(1).max(40).default('Maya'),
  default_language: z.enum(['en', 'hi']).default('en'),
  is_published: z.boolean().default(true),
});

r.get('/templates', ah(async (_req, res) => {
  res.json({ data: check(await db.from('agent_templates').select('*').order('created_at')) });
}));
r.post('/templates', ah(async (req, res) => {
  res.status(201).json({ data: check(await db.from('agent_templates').insert(templateBody.parse(req.body)).select().single()) });
}));
r.put('/templates/:id', ah(async (req, res) => {
  const { id: _ignored, ...body } = templateBody.parse({ ...req.body, id: req.params.id });
  res.json({ data: check(await db.from('agent_templates').update(body).eq('id', req.params.id).select().single()) });
}));

// ── Template config: which prompts/tools a template uses (read by the voice agent) ──
r.get('/templates/:id/config', ah(async (req, res) => {
  const id = templateId(req.params.id);
  const [p, t] = await Promise.all([
    db.from('agent_prompts').select('*').eq('agent_id', id),
    db.from('agent_tools').select('*').eq('agent_id', id),
  ]);
  res.json({ data: { prompts: check(p), tools: check(t) } });
}));
r.post('/templates/:id/prompts', ah(async (req, res) => {
  const { prompt_tag } = z.object({ prompt_tag: z.string().min(1).max(200) }).parse(req.body);
  check(await db.from('agent_prompts').insert({ agent_id: templateId(req.params.id), prompt_tag }));
  res.status(201).json({ ok: true });
}));
r.delete('/templates/:id/prompts/:tag', ah(async (req, res) => {
  check(await db.from('agent_prompts').delete().eq('agent_id', templateId(req.params.id)).eq('prompt_tag', req.params.tag));
  res.json({ ok: true });
}));
r.post('/templates/:id/tools', ah(async (req, res) => {
  const { tool_name } = z.object({ tool_name: z.string().min(1).max(200) }).parse(req.body);
  check(await db.from('agent_tools').insert({ agent_id: templateId(req.params.id), tool_name }));
  res.status(201).json({ ok: true });
}));
r.delete('/templates/:id/tools/:name', ah(async (req, res) => {
  check(await db.from('agent_tools').delete().eq('agent_id', templateId(req.params.id)).eq('tool_name', req.params.name));
  res.json({ ok: true });
}));

// ── Organizations: number limits are the purchase approval until billing exists ──
r.get('/orgs', ah(async (_req, res) => {
  res.json({ data: check(await db.from('organizations')
    .select('id, name, owner_id, max_numbers, created_at, phone_numbers(id, e164, status, agent_id)')
    .order('created_at', { ascending: false })) });
}));
r.put('/orgs/:id/limit', ah(async (req, res) => {
  const { max_numbers } = z.object({ max_numbers: z.number().int().min(0).max(1000) }).parse(req.body);
  const data = check(await db.from('organizations').update({ max_numbers }).eq('id', req.params.id).select().maybeSingle());
  if (!data) throw new HttpError(404, 'Organization not found');
  const members = check(await db.from('org_members').select('user_id').eq('org_id', req.params.id)) as any[];
  for (const m of members) orgCache.delete(m.user_id);
  res.json({ data });
}));

// ── Raw Vobiz account numbers (everything Zryth rents, across all orgs) ──
r.get('/vobiz-numbers', ah(async (_req, res) => res.json({ data: await vobiz('/numbers') })));

export default r;
