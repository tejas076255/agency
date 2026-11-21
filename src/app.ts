import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { log } from './lib/log';
import { csrfProtect, loadSession, trackApiUsage } from './middleware/auth';
import { agencyRoutes } from './routes/agency';
import { authRoutes } from './routes/auth';
import { actionItemRoutes, clientRoutes } from './routes/clients';
import { meRoutes } from './routes/me';
import { publicRoutes } from './routes/public';
import { jobRoutes, reportRoutes, workspaceRoutes } from './routes/reports';
import type { AppEnv } from './types';

export const app = new Hono<AppEnv>();

app.use('*', secureHeaders());

// Public, no session needed.
app.get('/api/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ status: 'ok', db: row?.ok === 1, time: new Date().toISOString() });
});
app.route('/', publicRoutes); // /r/:token, /api/public/chart/:token

app.use('/api/*', loadSession);
app.use('/auth/*', loadSession);
app.use('/api/*', csrfProtect); // all non-GET /api requests need the CSRF token
app.use('/api/*', trackApiUsage); // counts Google/AI calls per agency for quota monitoring

app.route('/auth', authRoutes);
app.route('/api', meRoutes);
app.route('/api/agency/google', workspaceRoutes);
app.route('/api/agency', agencyRoutes);
app.route('/api/clients', clientRoutes);
app.route('/api/action-items', actionItemRoutes);
app.route('/api/reports', reportRoutes);
app.route('/api/jobs', jobRoutes);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  log.error('Unhandled error', err, { path: c.req.path });
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});
