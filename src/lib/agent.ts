import { env } from '../config.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Server-to-server call to the voice agent's webhook_server.py on EC2. */
export async function callAgent<T = unknown>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.AGENT_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': env.AGENT_SHARED_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(503, 'Voice agent is unreachable');
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`Agent ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    throw new HttpError(502, 'Voice agent request failed');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error(`Agent ${path} returned non-JSON: ${text.slice(0, 200)}`);
    throw new HttpError(502, 'Voice agent returned an invalid response');
  }
}

export async function agentHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${env.AGENT_BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
