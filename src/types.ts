import type { Env } from './env';
import type { User } from './lib/db';
import type { SessionData } from './lib/session';

// Hono app typing: bindings + per-request variables set by middleware.
export type AppEnv = {
  Bindings: Env;
  Variables: {
    sessionId: string | null;
    session: SessionData | null;
    user: User | null;
    /** Set by requireAgency. Every tenant query must be scoped by this. */
    agencyId: string;
  };
};
