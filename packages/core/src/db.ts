import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { databaseUrl } from './config';
import * as schema from './schema';
const globals = globalThis as unknown as { filemorphSql?: ReturnType<typeof postgres> };
export function sqlClient() {
  return (globals.filemorphSql ||= postgres(databaseUrl(), {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  }));
}
export function db() {
  return drizzle(sqlClient(), { schema });
}
export { eq, and, or, lt, gt, gte, inArray, desc, sql, isNull } from 'drizzle-orm';
