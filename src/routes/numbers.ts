import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db } from '../lib/supabase.js';
import { HttpError } from '../lib/agent.js';
import { toE164 } from '../lib/phone.js';
import { vobiz, purchaseNumber, assignToTrunk, ownsNumber, VobizUncertainError } from '../lib/vobiz.js';
import { addNumberToInboundTrunk } from '../lib/livekit.js';
import { ah, check } from '../middleware/errors.js';

// Customer flow: browse inventory → buy → bind to one of their agents (once, forever).
const r = Router();

// Purchases spend real money on our Vobiz balance: a few per org per hour at most
const purchaseLimit = rateLimit({
  windowMs: 60 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.org!.id,
  message: { error: 'Too many purchase attempts. Please try again later.' },
});

// GET /api/numbers -> the org's numbers, with the bound agent
r.get('/', ah(async (req, res) => {
  const rows = check(await db.from('phone_numbers')
    .select('id, e164, status, agent_id, monthly_fee, currency, purchased_at, bound_at, error, agents(id, name, business_name)')
    .eq('org_id', req.org!.id).neq('status', 'released').order('created_at', { ascending: false })) as any[];
  const used = rows.filter((n) => n.status === 'pending' || n.status === 'active').length;
  res.json({ data: { numbers: rows, limit: req.org!.max_numbers, used } });
}));

// GET /api/numbers/inventory?page=&search= -> Vobiz stock available to buy
r.get('/inventory', ah(async (req, res) => {
  const page = z.coerce.number().int().min(1).max(1000).default(1).parse(req.query.page);
  const search = z.string().max(20).regex(/^[\d+]*$/).optional().parse(req.query.search || undefined);
  let path = `/inventory/numbers?per_page=50&page=${page}`;
  if (search) path += `&search=${encodeURIComponent(search)}`;
  res.json({ data: await vobiz(path) });
}));

// POST /api/numbers/purchase { e164 }
//   1. reserve a row (enforces the org limit atomically)  2. buy on Vobiz
//   3. route to our SIP trunk  4. let LiveKit accept it   -> status 'active'
r.post('/purchase', purchaseLimit, ah(async (req, res) => {
  const e164 = toE164(z.object({ e164: z.string().min(10).max(16) }).parse(req.body).e164);
  const id = check(await db.rpc('reserve_phone_number', { p_org: req.org!.id, p_e164: e164 })) as string;

  let bought;
  try {
    bought = (await purchaseNumber(e164)).number;
  } catch (e) {
    if (e instanceof VobizUncertainError) {
      // Vobiz may have charged us: keep the row so the number is never lost.
      // "Retry" checks our Vobiz account and either finishes setup or frees the slot.
      await db.from('phone_numbers').update({ status: 'failed', error: 'purchase_unconfirmed' }).eq('id', id);
      throw new HttpError(504, 'We could not confirm the purchase with the phone provider. Use Retry on the Phone Numbers page in a minute.');
    }
    // Definite refusal (an answer from Vobiz): not charged, free the reservation
    await db.from('phone_numbers').delete().eq('id', id);
    throw e;
  }

  // Charged from here on: keep the row even if routing fails, so it can be fixed/retried
  await db.from('phone_numbers').update({
    vobiz_number_id: bought?.id ?? null, setup_fee: bought?.setup_fee ?? null,
    monthly_fee: bought?.monthly_fee ?? null, currency: bought?.currency ?? null,
    purchased_at: new Date().toISOString(),
  }).eq('id', id);

  try {
    await assignToTrunk(e164);
    await addNumberToInboundTrunk(e164);
  } catch (e: any) {
    console.error(`Routing failed for purchased number ${e164}:`, e);
    await db.from('phone_numbers').update({ status: 'failed', error: 'Routing to the voice platform failed' }).eq('id', id);
    throw new HttpError(502, 'Number purchased, but connecting it to the voice platform failed. Our team has been notified; please retry from the Phone Numbers page.');
  }

  const data = check(await db.from('phone_numbers').update({ status: 'active', error: null }).eq('id', id).select().single());
  res.status(201).json({ data });
}));

// POST /api/numbers/:id/retry -> settle a failed setup:
//   purchase unconfirmed -> ask Vobiz whether we own it (yes: continue, no: free the slot)
//   routing failed       -> re-run routing
r.post('/:id/retry', ah(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const n = check(await db.from('phone_numbers').select('id, e164, status, purchased_at, error')
    .eq('id', id).eq('org_id', req.org!.id).maybeSingle()) as any;
  if (!n) throw new HttpError(404, 'Number not found');
  if (n.status !== 'failed') throw new HttpError(409, 'Nothing to retry for this number');
  if (!n.purchased_at) {
    if (!(await ownsNumber(n.e164))) {
      await db.from('phone_numbers').delete().eq('id', n.id);
      return res.json({ data: null, message: 'The purchase did not go through and you were not charged. You can buy a number again.' });
    }
    await db.from('phone_numbers').update({ purchased_at: new Date().toISOString(), error: null }).eq('id', n.id);
  }
  await assignToTrunk(n.e164);
  await addNumberToInboundTrunk(n.e164);
  const data = check(await db.from('phone_numbers').update({ status: 'active', error: null }).eq('id', n.id).select().single());
  res.json({ data });
}));

// POST /api/numbers/:id/bind { agent_id } -> permanent (DB trigger rejects any later change)
r.post('/:id/bind', ah(async (req, res) => {
  const { agent_id } = z.object({ agent_id: z.string().uuid() }).parse(req.body);
  const n = check(await db.from('phone_numbers').select('id, agent_id')
    .eq('id', z.string().uuid().parse(req.params.id)).eq('org_id', req.org!.id).maybeSingle()) as any;
  if (!n) throw new HttpError(404, 'Number not found');
  if (n.agent_id) throw new HttpError(409, 'This number is already connected to an agent and cannot be changed.');
  const data = check(await db.from('phone_numbers').update({ agent_id })
    .eq('id', n.id).eq('org_id', req.org!.id).is('agent_id', null).select().maybeSingle());
  if (!data) throw new HttpError(409, 'This number is already connected to an agent and cannot be changed.');
  res.json({ data });
}));

export default r;
