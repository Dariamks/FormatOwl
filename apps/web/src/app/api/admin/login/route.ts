import { z } from 'zod';
import { checkAdminCredentials, createAdminSession, limitAdminLogin } from '@/lib/admin-auth';
import { adminError, adminJsonBody, adminResponse, assertAdminOrigin } from '@/lib/admin-api';
import { ServiceError } from '@filemorph/core/service-error';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertAdminOrigin(request);
    await limitAdminLogin();
    const body = z
      .object({ username: z.string().min(1).max(200), password: z.string().min(1).max(512) })
      .strict()
      .parse(await adminJsonBody(request));
    if (!checkAdminCredentials(body.username, body.password))
      throw new ServiceError(401, 'ADMIN_INVALID_CREDENTIALS');
    return adminResponse({ session: await createAdminSession() });
  } catch (error) {
    return adminError(error);
  }
}
