import { env } from '../config.js';
import { HttpError } from './agent.js';

/** Network error or timeout: the request may or may not have taken effect at Vobiz. */
export class VobizUncertainError extends HttpError {
  constructor() { super(504, 'Phone provider did not respond'); }
}

export const vobizConfigured = () => Boolean(env.VOBIZ_AUTH_ID && env.VOBIZ_AUTH_TOKEN);

/** Call the Vobiz REST API (https://www.vobiz.ai/docs/account-phone-number). */
export async function vobiz<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!vobizConfigured()) throw new HttpError(500, 'Phone provider is not configured');
  let res: Response;
  try {
    res = await fetch(`https://api.vobiz.ai/api/v1/Account/${env.VOBIZ_AUTH_ID}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'X-Auth-ID': env.VOBIZ_AUTH_ID,
      'X-Auth-Token': env.VOBIZ_AUTH_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error(`Vobiz ${init.method ?? 'GET'} ${path} unreachable:`, e);
    throw new VobizUncertainError();
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`Vobiz ${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    let message = 'Phone provider request failed';
    try { message = JSON.parse(text).message || message; } catch { /* not JSON */ }
    throw new HttpError(502, message);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    console.error(`Vobiz ${path} returned non-JSON: ${text.slice(0, 200)}`);
    throw new HttpError(502, 'Phone provider returned an invalid response');
  }
}

/** Does our Vobiz account already own this number? (used to settle uncertain purchases) */
export async function ownsNumber(e164: string): Promise<boolean> {
  for (let page = 1; page <= 50; page++) {
    const data: any = await vobiz(`/numbers?per_page=100&page=${page}`);
    const list: any[] = data?.numbers || data?.objects || data?.data || data?.items || (Array.isArray(data) ? data : []);
    if (list.some((n) => (n.e164 || n.number) === e164)) return true;
    if (list.length < 100) return false;
  }
  return false;
}

/** Buy a number from Vobiz inventory (debits our Vobiz balance). */
export const purchaseNumber = (e164: string) =>
  vobiz<{ number?: { id?: string; setup_fee?: number; monthly_fee?: number; currency?: string } }>(
    '/numbers/purchase-from-inventory', { method: 'POST', body: { e164 } });

/** Route an owned number to our SIP trunk (whose origination URI points at LiveKit). */
export async function assignToTrunk(e164: string) {
  if (!env.VOBIZ_TRUNK_ID) throw new HttpError(500, 'VOBIZ_TRUNK_ID is not configured');
  await vobiz(`/numbers/${encodeURIComponent(e164)}/assign`, { method: 'POST', body: { trunk_group_id: env.VOBIZ_TRUNK_ID } });
}
