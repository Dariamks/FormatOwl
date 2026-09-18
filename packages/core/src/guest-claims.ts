import { db, eq, sql } from './db';
import {
  assets,
  jobs,
  batches,
  preparations,
  guestClaims,
  billingOperations,
  billingQuotes,
  billingProbes,
} from './schema';

export async function guestWasClaimed(owner: string) {
  const [claim] = await db()
    .select({ owner: guestClaims.owner })
    .from(guestClaims)
    .where(eq(guestClaims.owner, owner));
  return Boolean(claim);
}
export async function claimGuest(owner: string, userId: string) {
  if (!owner.startsWith('anon:')) throw new Error('Only guest work can be claimed');
  await db().transaction(async (tx) => {
    // Match upload/task creation locks; sort both locks to avoid account-switch deadlocks.
    for (const key of [owner, `user:${userId}`].sort())
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [claimed] = await tx
      .insert(guestClaims)
      .values({ owner, userId })
      .onConflictDoNothing()
      .returning();
    if (!claimed) return;
    for (const table of [
      assets,
      jobs,
      batches,
      preparations,
      billingOperations,
      billingQuotes,
      billingProbes,
    ])
      await tx
        .update(table)
        .set({ owner: `user:${userId}` })
        .where(eq(table.owner, owner));
  });
}
