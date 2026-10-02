import { SipClient } from 'livekit-server-sdk';
import { ListUpdate } from '@livekit/protocol';
import { env } from '../config.js';
import { numberFormats } from './phone.js';

const configured = () =>
  Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_INBOUND_TRUNK_ID);

/**
 * Let the LiveKit inbound trunk accept calls to a new number. Vobiz may present the
 * dialled number in any of four formats, so all of them are added.
 * Skipped when LIVEKIT_INBOUND_TRUNK_ID is unset (e.g. a trunk with an empty numbers
 * list, which already accepts every number Vobiz sends).
 */
export async function addNumberToInboundTrunk(e164: string): Promise<boolean> {
  if (!configured()) return false;
  const host = env.LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const sip = new SipClient(host, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  await sip.updateSipInboundTrunkFields(env.LIVEKIT_INBOUND_TRUNK_ID, {
    numbers: new ListUpdate({ add: numberFormats(e164) }),
  });
  return true;
}
