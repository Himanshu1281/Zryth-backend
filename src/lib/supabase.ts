import { createClient } from '@supabase/supabase-js';
import { env } from '../config.js';

// Service-role client: bypasses RLS. Lives ONLY on the server.
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
