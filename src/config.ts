import 'dotenv/config';
import { z } from 'zod';

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  // Owner account(s): comma-separated emails that manage Zryth's own agent, number, knowledge
  // base, prompts and tools (and see its call history). Everyone else sees only their own org.
  ADMIN_EMAILS: z.string().default(''),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(20),
  KNOWLEDGE_BUCKET: z.string().default('knowledge_base'),

  // Voice agent webhook_server.py (same host, private)
  AGENT_BASE_URL: z.string().url(),
  AGENT_SHARED_SECRET: z.string().min(16),
  // Template whose prompts/tools the admin pages edit by default
  AGENT_ID: z.string().default('maya_v2'),

  // Vobiz REST API: buying numbers and routing them to our SIP trunk
  VOBIZ_AUTH_ID: z.string().default(''),
  VOBIZ_AUTH_TOKEN: z.string().default(''),
  VOBIZ_TRUNK_ID: z.string().default(''),   // trunk_group_id whose origination URI points at LiveKit

  // LiveKit: new numbers are added to the inbound trunk's accepted-numbers list
  LIVEKIT_URL: z.string().default(''),
  LIVEKIT_API_KEY: z.string().default(''),
  LIVEKIT_API_SECRET: z.string().default(''),
  LIVEKIT_INBOUND_TRUNK_ID: z.string().default(''),

  COST_PER_MINUTE: z.coerce.number().default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
export const allowedOrigins = list(env.ALLOWED_ORIGINS);
export const adminEmails = new Set(list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()));
