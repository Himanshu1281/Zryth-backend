import { HttpError } from './agent.js';

/** Normalise an Indian number in any common format to E.164 (+91XXXXXXXXXX). */
export function toE164(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  if (!/^91\d{10}$/.test(d)) throw new HttpError(400, 'Enter a valid Indian phone number');
  return `+${d}`;
}

/** Every format Vobiz may present the dialled number in (LiveKit matches the trunk on these). */
export function numberFormats(e164: string): string[] {
  const national = e164.replace(/^\+91/, '');
  return [national, `0${national}`, `91${national}`, `+91${national}`];
}
