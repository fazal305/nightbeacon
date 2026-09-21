import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import { pool } from './db/pool.js';
import { authRouter } from './routes/auth.js';
import { itemsRouter } from './routes/items.js';
import { sourcesRouter } from './routes/sources.js';
import { taxonomyRouter } from './routes/taxonomy.js';
import { subsystemsRouter } from './routes/subsystems.js';
import { activityRouter } from './routes/activity.js';
import { requireAuth } from './middleware/requireAuth.js';

const PgSession = connectPgSimple(session);

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: process.env.WEB_ORIGIN || 'http://localhost:5173',
      credentials: true,
    })
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(
    session({
      store: new PgSession({ pool, tableName: 'session' }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 12, // 12 hours
      },
    })
  );

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
  app.use('/api/auth/login', authLimiter);

  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', dbConnected: true, uptimeSeconds: process.uptime() });
    } catch (err) {
      res.status(503).json({ status: 'degraded', dbConnected: false });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/items', requireAuth, itemsRouter);
  app.use('/api/sources', requireAuth, sourcesRouter);
  app.use('/api/taxonomy', requireAuth, taxonomyRouter);
  app.use('/api/subsystems', requireAuth, subsystemsRouter);
  app.use('/api/activity', requireAuth, activityRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
