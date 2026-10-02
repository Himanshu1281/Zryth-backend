import { Router, type Request } from 'express';
import multer from 'multer';
import { db } from '../lib/supabase.js';
import { env } from '../config.js';
import { callAgent, HttpError } from '../lib/agent.js';
import { ah, check } from '../middleware/errors.js';
import { assertOrgAgent, orgPageAgent } from './agents.js';

// Each agent has its own knowledge base: storage folder "<agent_id>/" and rows with
// zryth_knowledge.agent_id.
const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const bucket = () => db.storage.from(env.KNOWLEDGE_BUCKET);
const ALLOWED = ['application/pdf', 'text/plain'];
const HIDDEN = new Set(['.emptyFolderPlaceholder', '.DS_Store']);
const safeName = (n: string) => {
  if (!/^[\w.-]+$/.test(n)) throw new HttpError(400, 'Invalid file name');
  return n;
};

/**
 * Resolve which knowledge base the request targets. Without agent_id it is the signed-in
 * account's own agent (the Knowledge Base page). The root folder (unbound legacy KB) is
 * only reachable by the owner account, and only while its org has no agent.
 */
async function target(req: Request): Promise<{ agentId: string | null; prefix: string }> {
  let agentId = String(req.query.agent_id ?? req.body?.agent_id ?? '');
  if (agentId) {
    await assertOrgAgent(req.org!.id, agentId);
  } else {
    agentId = (await orgPageAgent(req.org!.id)) ?? '';
    if (!agentId) {
      if (!req.isAdmin) throw new HttpError(404, 'Your account has no voice agent yet.');
      return { agentId: null, prefix: '' };
    }
  }
  return { agentId, prefix: `${agentId}/` };
}

r.get('/', ah(async (req, res) => {
  const { prefix } = await target(req);
  const files = check(await bucket().list(prefix.replace(/\/$/, ''), { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } })) as any[];
  // folders come back with id null; only real files are shown
  res.json({ data: (files ?? []).filter((f) => f.id && !HIDDEN.has(f.name)) });
}));

// POST /api/knowledge  (multipart: file, agent_id) -> store, then the agent chunks + embeds it
r.post('/', upload.single('file'), ah(async (req, res) => {
  const { agentId, prefix } = await target(req);
  const f = req.file;
  if (!f) throw new HttpError(400, 'No file');
  if (!ALLOWED.includes(f.mimetype)) throw new HttpError(400, 'Only PDF or TXT files are supported');
  const filename = `${prefix}${Date.now()}_${f.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  check(await bucket().upload(filename, f.buffer, { contentType: f.mimetype }));

  let ingest: unknown = null;
  try {
    ingest = await callAgent('/internal/knowledge/ingest', { filename, agent_id: agentId }, 180_000);
  } catch (e) {
    console.error('Ingest failed, file kept in storage:', e);
    return res.status(202).json({ data: { filename, ingested: false } });
  }
  res.status(201).json({ data: { filename, ingested: true, ingest } });
}));

r.get('/:name/url', ah(async (req, res) => {
  const { prefix } = await target(req);
  const data = check(await bucket().createSignedUrl(prefix + safeName(req.params.name), 300));
  res.json({ data: { url: data?.signedUrl } });
}));

r.delete('/:name', ah(async (req, res) => {
  const { prefix } = await target(req);
  const filename = prefix + safeName(req.params.name);
  check(await bucket().remove([filename]));
  // Drop that file's chunks (Supabase + the agent's LanceDB) so callers stop hearing it
  await callAgent('/internal/knowledge/delete', { filename }).catch((e) => console.error('Chunk delete failed:', e));
  res.json({ ok: true });
}));

export default r;
