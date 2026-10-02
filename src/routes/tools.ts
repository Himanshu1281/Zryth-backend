import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/supabase.js';
import { ah, check } from '../middleware/errors.js';

const r = Router();
const body = z.object({
  name: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/, 'Use letters, numbers, _ or -'),
  // The format the voice agent executes (dynamic_executor.py): a fixed https endpoint
  // (placeholders allowed in the path/query/body, never in the host) + the input schema
  json_spec: z.object({
    description: z.string().max(1000).optional(),
    input_schema: z.object({ type: z.literal('object'), properties: z.record(z.any()) }).passthrough(),
    http: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
      url_template: z.string().max(2000).refine((u) => {
        const m = /^https:\/\/([^/?#]+)/.exec(u);
        return Boolean(m && !m[1].includes('{'));
      }, 'url_template must start with https://<fixed host>'),
      query_params: z.record(z.string()).optional(),
      headers: z.record(z.string()).optional(),
      body: z.any().optional(),
    }).passthrough(),
  }).passthrough(),
  execution_instruction: z.string().max(50_000).optional().default(''),
});

r.get('/', ah(async (_req, res) => {
  res.json({ data: check(await db.from('tools').select('*').order('created_at', { ascending: false })) });
}));
r.post('/', ah(async (req, res) => {
  const data = check(await db.from('tools').insert(body.parse(req.body)).select().single());
  res.status(201).json({ data });
}));
r.put('/:id', ah(async (req, res) => {
  const data = check(await db.from('tools').update(body.parse(req.body)).eq('id', req.params.id).select().single());
  res.json({ data });
}));
r.delete('/:id', ah(async (req, res) => {
  check(await db.from('tools').delete().eq('id', req.params.id));
  res.json({ ok: true });
}));

export default r;
