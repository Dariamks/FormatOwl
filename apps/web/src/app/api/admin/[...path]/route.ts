import { z } from 'zod';
import { adminApi, adminJsonBody } from '@/lib/admin-api';
import {
  adminOverview,
  adminRechargeUser,
  adminUserDetail,
  listAdminTools,
  listAdminUsers,
  setToolPublished,
  setUserBlocked,
} from '@filemorph/core/admin';
import { ServiceError } from '@filemorph/core/service-error';

export const runtime = 'nodejs';
const idSchema = z.string().min(1).max(200);

export const GET = adminApi(async (request, path) => {
  if (path.join('/') === 'overview') return adminOverview();
  if (path.join('/') === 'tools') return { tools: await listAdminTools() };
  if (path.join('/') === 'users') {
    const query = new URL(request.url).searchParams;
    return listAdminUsers({
      query: query.get('query') || undefined,
      status: z
        .enum(['all', 'active', 'blocked'])
        .catch('all')
        .parse(query.get('status') || 'all'),
      page: z.coerce
        .number()
        .int()
        .min(1)
        .catch(1)
        .parse(query.get('page') || '1'),
      pageSize: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .catch(20)
        .parse(query.get('pageSize') || '20'),
    });
  }
  if (path[0] === 'users' && path.length === 2)
    return adminUserDetail(
      idSchema.parse(path[1]),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .parse(new URL(request.url).searchParams.get('historyPage') || 1),
    );
  throw new ServiceError(404, 'NOT_FOUND');
});

export const POST = adminApi(async (request, path, admin) => {
  if (path[0] === 'users' && path.length === 3 && path[2] === 'recharge') {
    const body = z
      .object({
        receipt: z.string().trim().min(1).max(200),
        amountCny: z.number().finite().min(0),
        credits: z.number().int().positive().max(1_000_000_000),
        note: z.string().trim().max(500).optional(),
      })
      .strict()
      .parse(await adminJsonBody(request));
    return {
      recharge: await adminRechargeUser({
        userId: idSchema.parse(path[1]),
        ...body,
        adminUsername: admin.username,
      }),
    };
  }
  throw new ServiceError(404, 'NOT_FOUND');
});

export const PATCH = adminApi(async (request, path) => {
  if (path[0] === 'users' && path.length === 3 && path[2] === 'status') {
    const body = z
      .object({ blocked: z.boolean(), reason: z.string().trim().max(500).optional() })
      .strict()
      .parse(await adminJsonBody(request));
    return { profile: await setUserBlocked(idSchema.parse(path[1]), body.blocked, body.reason) };
  }
  if (path[0] === 'tools' && path.length === 2) {
    const body = z
      .object({ published: z.boolean() })
      .strict()
      .parse(await adminJsonBody(request));
    return { tool: await setToolPublished(idSchema.parse(path[1]), body.published) };
  }
  throw new ServiceError(404, 'NOT_FOUND');
});
