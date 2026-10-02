import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/supabase.js';
import { HttpError } from '../lib/agent.js';
import { env } from '../config.js';
import { ah, check } from '../middleware/errors.js';
import { TtlCache } from '../lib/cache.js';

// The organization's own agents (copies of published templates).
const r = Router();

const editable = z.object({
  name: z.string().trim().min(1).max(80),
  business_name: z.string().trim().min(1).max(80),
  greeting: z.string().trim().max(300).optional().nullable().transform((v) => v || null),
  transfer_number: z.string().trim().max(20).optional().nullable()
    .transform((v) => v || null)
    .refine((v) => v === null || /^\+?\d{10,13}$/.test(v.replace(/[\s-]/g, '')), 'Enter a valid phone number'),
  language: z.enum(['en', 'hi']).default('en'),
});

// GET /api/agents/templates -> what a customer can pick from
r.get('/templates', ah(async (_req, res) => {
  res.json({ data: check(await db.from('agent_templates')
    .select('id, name, description, persona_name, default_language').eq('is_published', true).order('created_at')) });
}));

// GET /api/agents -> org's agents with the number each one answers (if bound)
r.get('/', ah(async (req, res) => {
  res.json({ data: check(await db.from('agents')
    .select('*, agent_templates(name, persona_name), phone_numbers(id, e164, status)')
    .eq('org_id', req.org!.id).order('created_at', { ascending: false })) });
}));

r.post('/', ah(async (req, res) => {
  const body = editable.extend({ template_id: z.string().min(1).max(64) }).parse(req.body);
  const tpl = check(await db.from('agent_templates').select('id').eq('id', body.template_id)
    .eq('is_published', true).maybeSingle());
  if (!tpl) throw new HttpError(404, 'Template not found');
  const data = check(await db.from('agents').insert({ ...body, org_id: req.org!.id }).select().single());
  res.status(201).json({ data });
}));

// Content stays editable after binding; only the number ↔ agent link is permanent.
r.put('/:id', ah(async (req, res) => {
  const data = check(await db.from('agents').update(editable.parse(req.body))
    .eq('id', req.params.id).eq('org_id', req.org!.id).select().maybeSingle());
  if (!data) throw new HttpError(404, 'Agent not found');
  res.json({ data });
}));

// Fails with 409 while a number is bound to it (FK on delete restrict)
r.delete('/:id', ah(async (req, res) => {
  await assertOrgAgent(req.org!.id, req.params.id);
  const bound = check(await db.from('phone_numbers').select('id').eq('agent_id', req.params.id).limit(1)) as any[];
  if (bound.length) throw new HttpError(409, 'This agent answers a phone number and cannot be deleted.');
  // Chunks go with the row (FK cascade); the uploaded files live in storage under "<agent_id>/"
  const bucket = db.storage.from(env.KNOWLEDGE_BUCKET);
  const files = check(await bucket.list(req.params.id)) as any[];
  const paths = (files ?? []).filter((f) => f.id).map((f) => `${req.params.id}/${f.name}`);
  if (paths.length) check(await bucket.remove(paths));
  check(await db.from('agents').delete().eq('id', req.params.id).eq('org_id', req.org!.id));
  res.json({ ok: true });
}));

export default r;

/** Throws 404 unless the agent belongs to the org. */
export async function assertOrgAgent(orgId: string, agentId: string) {
  const id = z.string().uuid().safeParse(agentId);
  if (!id.success) throw new HttpError(404, 'Agent not found');
  const a = check(await db.from('agents').select('id').eq('id', id.data).eq('org_id', orgId).maybeSingle());
  if (!a) throw new HttpError(404, 'Agent not found');
}

// org -> the agent the dashboard pages manage (30s per instance)
const pageAgentCache = new TtlCache<string | null>(30_000);

/**
 * The org's agent for the single-agent dashboard pages (Knowledge Base, Phone Numbers):
 * the one answering an active number, else the newest. null = the org has no agent yet.
 */
export async function orgPageAgent(orgId: string): Promise<string | null> {
  const hit = pageAgentCache.get(orgId);
  if (hit !== undefined) return hit;
  const bound = check(await db.from('phone_numbers').select('agent_id').eq('org_id', orgId)
    .eq('status', 'active').not('agent_id', 'is', null).order('bound_at', { ascending: false }).limit(1)) as any[];
  let id: string | null = bound[0]?.agent_id ?? null;
  if (!id) {
    const newest = check(await db.from('agents').select('id').eq('org_id', orgId)
      .order('created_at', { ascending: false }).limit(1)) as any[];
    id = newest[0]?.id ?? null;
  }
  pageAgentCache.set(orgId, id);
  return id;
}
