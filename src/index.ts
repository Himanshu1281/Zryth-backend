import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env, allowedOrigins } from './config.js';
import { requireAuth } from './middleware/auth.js';
import { loadOrg, requireAdmin } from './middleware/org.js';
import { errorHandler } from './middleware/errors.js';
import account from './routes/account.js';
import agents from './routes/agents.js';
import numbers from './routes/numbers.js';
import calls from './routes/calls.js';
import metrics from './routes/metrics.js';
import knowledge from './routes/knowledge.js';
import status from './routes/status.js';
import admin from './routes/admin.js';
import prompts from './routes/prompts.js';
import tools from './routes/tools.js';
import { ownerAgents, ownerPhoneNumbers, ownerPhoneMap } from './routes/owner.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const api = express.Router();
api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
api.use(requireAuth); // every /api route needs a valid Supabase session
api.use(loadOrg);     // ...and resolves the caller's organization (req.org) for scoping
api.use('/account', account);
// Original dashboard pages. Shared-template prompts/tools are owner-only; status is open to all
api.use('/agents', (req, res, next) => {
  if (req.path === '/status') return ownerAgents(req, res, next);
  if (/^\/(config|prompts|tools)(\/|$)/.test(req.path)) return requireAdmin(req, res, () => ownerAgents(req, res, next));
  next();
});
api.use('/prompts', requireAdmin, prompts);
api.use('/tools', requireAdmin, tools);
api.use('/phone-numbers', ownerPhoneNumbers);
api.use('/calls/agent-phone-map', ownerPhoneMap);
api.use('/agents', agents);
api.use('/numbers', numbers);
api.use('/calls', calls);
api.use('/metrics', metrics);
api.use('/knowledge', knowledge);
api.use('/status', status);
api.use('/admin', requireAdmin, admin);
app.use('/api', api);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const server = app.listen(env.PORT, () => console.log(`zryth-backend listening on :${env.PORT}`));
// Uploads wait on ingest (up to 180s); keep sockets open long enough
server.requestTimeout = 200_000;
server.headersTimeout = 65_000;

// Graceful shutdown: stop accepting, let in-flight requests (e.g. a purchase) finish
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${sig} received, draining connections...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref(); // hard stop if something hangs
  });
}
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
