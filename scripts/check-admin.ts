import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { db, sqlClient } from '@filemorph/core/db';
import {
  adminRechargeUser,
  adminUserDetail,
  listAdminUsers,
  adminOverview,
  setUserBlocked,
} from '@filemorph/core/admin';
import {
  assertOwnerNotBlocked,
  listPublishedToolIds,
  listAdminTools,
  setToolPublished,
  isToolPublished,
} from '@filemorph/core/access';
import { account } from '@filemorph/core/billing';
import { createUpload } from '@filemorph/core/uploads';
import { createJob, createBatch } from '@filemorph/core/jobs';
import {
  createQuote,
  assertOperationAllowed,
  parseBillingOperation,
} from '@filemorph/core/billing-quotes';
import { tools } from '@filemorph/core/catalog';
const url = new URL(process.env.DATABASE_URL!);
assert(
  ['127.0.0.1', 'localhost'].includes(url.hostname),
  'Only local disposable databases are allowed',
);
const control = sqlClient(),
  name = `filemorph_admin_test_${randomUUID().replaceAll('-', '')}`;
await control.unsafe(`CREATE DATABASE "${name}"`);
url.pathname = `/${name}`;
process.env.DATABASE_URL = url.href;
(globalThis as any).filemorphSql = undefined;
let checked = 0;
const pass = (message: string) => {
  checked++;
  console.log(`PASS ${message}`);
};
try {
  const sql = sqlClient();
  for (const file of (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await sql.unsafe(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  assert.deepEqual((await listPublishedToolIds()).sort(), tools.map((t) => t.id).sort());
  assert.equal((await listAdminTools()).length, 19);
  pass('fresh migrations publish all 19 tools');
  const userId = randomUUID(),
    otherId = randomUUID(),
    owner = `user:${userId}`;
  await sql`insert into auth_users(id,name,email) values(${userId},'Admin fixture','fixture@example.test'),(${otherId},'Other','other@example.test')`;
  const input = {
    userId,
    amountCny: 12.34,
    credits: 1234,
    receipt: randomUUID(),
    note: 'Test receipt',
    adminUsername: 'admin',
  };
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => adminRechargeUser(input)));
  assert.equal(new Set(concurrent.map((r) => r.id)).size, 1);
  assert.equal((await account(owner)).available, 1234);
  assert.equal(Number((await sql`select count(*) as n from credit_ledger`)[0].n), 1);
  pass('concurrent identical receipts grant exactly once');
  await assert.rejects(adminRechargeUser({ ...input, credits: 3 }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await assert.rejects(adminRechargeUser({ ...input, userId: otherId }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await assert.rejects(adminRechargeUser({ ...input, note: 'different' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  pass('idempotency conflicts reject changed amount, user and evidence');
  for (const amountCny of [-1, 0.001, Number.NaN, 1e10])
    await assert.rejects(adminRechargeUser({ ...input, receipt: randomUUID(), amountCny }), {
      code: 'INVALID_REQUEST',
    });
  await assert.rejects(adminRechargeUser({ ...input, receipt: randomUUID(), credits: 1.5 }), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(
    adminRechargeUser({ ...input, userId: randomUUID(), receipt: randomUUID() }),
    { code: 'NOT_FOUND' },
  );
  pass('invalid money, credits and missing users do not mutate balances');
  await Promise.all(
    [100, 200].map((credits) => adminRechargeUser({ ...input, receipt: randomUUID(), credits })),
  );
  assert.equal((await account(owner)).available, 1534);
  assert.equal((await account(`user:${otherId}`)).available, 0);
  pass('independent concurrent recharges preserve all credits and ownership');
  await sql.unsafe(`CREATE FUNCTION reject_admin_test_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test ledger failure'; END $$;
    CREATE TRIGGER reject_admin_test_credit BEFORE INSERT ON credit_ledger FOR EACH ROW EXECUTE FUNCTION reject_admin_test_credit();`);
  const failedReceipt = randomUUID();
  await assert.rejects(adminRechargeUser({ ...input, receipt: failedReceipt }));
  assert.equal(
    (await sql`select id from admin_recharges where receipt=${failedReceipt}`).length,
    0,
  );
  assert.equal((await account(owner)).available, 1534);
  await sql.unsafe(
    'DROP TRIGGER reject_admin_test_credit ON credit_ledger; DROP FUNCTION reject_admin_test_credit();',
  );
  pass('ledger failure rolls back the recharge record and account balance atomically');
  const detail = await adminUserDetail(userId);
  assert.equal(detail.recharges.length, 3);
  assert.equal(detail.ledger.length, 3);
  assert.equal(detail.totals.granted, 1534);
  assert.equal(detail.totals.amountCny, 37.02);
  assert.equal((await listAdminUsers({ query: 'fixture@' })).total, 1);
  assert.equal((await listAdminUsers({ pageSize: 1, page: 2 })).users.length, 1);
  const overview = await adminOverview();
  assert.equal(overview.users, 2);
  assert.equal(overview.availableCredits, 1534);
  pass('user detail, search, pagination and overview aggregate real account records');
  await setUserBlocked(userId, true, 'Integration test');
  await assert.rejects(assertOwnerNotBlocked(owner), { code: 'USER_BLOCKED' });
  await assert.rejects(createUpload(owner, 'test.png', 100), { code: 'USER_BLOCKED' });
  await assert.rejects(
    createJob(owner, randomUUID(), randomUUID(), { preset: 'balanced' }, 'image-compressor'),
    { code: 'USER_BLOCKED' },
  );
  assert.equal((await listAdminUsers({ status: 'blocked' })).total, 1);
  assert.equal((await adminUserDetail(userId)).user.blocked, true);
  await setUserBlocked(userId, false);
  await assertOwnerNotBlocked(owner);
  pass('blocked users cannot upload or submit; history survives and unblocking restores access');
  await setToolPublished('image-converter', false);
  assert.equal(await isToolPublished('image-converter'), false);
  assert.equal((await listPublishedToolIds()).includes('image-converter'), false);
  await assert.rejects(
    createBatch(owner, [randomUUID()], randomUUID(), 'image-converter', { format: 'png' } as any),
    { code: 'TOOL_UNPUBLISHED' },
  );
  const operation = {
    path: 'jobs',
    body: {
      tool: 'image-converter',
      options: { format: 'png' },
      assetId: randomUUID(),
      requestId: randomUUID(),
    },
  };
  await assert.rejects(createQuote(owner, operation), { code: 'TOOL_UNPUBLISHED' });
  await assert.rejects(assertOperationAllowed(owner, parseBillingOperation(operation)), {
    code: 'TOOL_UNPUBLISHED',
  });
  await assert.rejects(setToolPublished('fake', true), { code: 'NOT_FOUND' });
  await setToolPublished('image-converter', true);
  assert.equal(await isToolPublished('image-converter'), true);
  pass('unpublished tools reject direct creation and quotes; only known tools can be published');
  for (let i = 0; i < 51; i++)
    await adminRechargeUser({ ...input, receipt: `page:${i}`, amountCny: 0, credits: 1 });
  const firstPage = await adminUserDetail(userId, 1),
    secondPage = await adminUserDetail(userId, 2);
  assert.equal(firstPage.recharges.length, 50);
  assert.equal(secondPage.recharges.length, 4);
  assert.equal(secondPage.ledger.length, 4);
  assert.equal(secondPage.history.total.recharges, 54);
  assert.equal(
    new Set([...firstPage.recharges, ...secondPage.recharges].map((r) => r.id)).size,
    54,
  );
  assert.equal(secondPage.totals.granted, 1585);
  pass('history pages expose older records without duplicate rows or truncated totals');
  console.log(`${checked} admin integration scenarios passed`);
} finally {
  await sqlClient().end();
  await control.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.end();
}
