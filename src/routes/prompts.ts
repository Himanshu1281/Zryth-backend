import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/supabase.js';
import { ah, check } from '../middleware/errors.js';

const r = Router();
const body = z.object({ tag: z.string().min(1).max(200), content: z.string().min(1).max(100_000) });

r.get('/', ah(async (_req, res) => {
  res.json({ data: check(await db.from('prompts').select('*').order('created_at', { ascending: false })) });
}));
r.post('/', ah(async (req, res) => {
  const data = check(await db.from('prompts').insert(body.parse(req.body)).select().single());
  res.status(201).json({ data });
}));
r.put('/:id', ah(async (req, res) => {
  const data = check(await db.from('prompts').update(body.parse(req.body)).eq('id', req.params.id).select().single());
  res.json({ data });
}));
r.delete('/:id', ah(async (req, res) => {
  check(await db.from('prompts').delete().eq('id', req.params.id));
  res.json({ ok: true });
}));

export default r;
