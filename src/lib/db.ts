import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import type { Env } from '../env';

export function getDb(env: Pick<Env, 'DB'>) {
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof getDb>;
export type User = typeof schema.users.$inferSelect;
export type Agency = typeof schema.agencies.$inferSelect;
