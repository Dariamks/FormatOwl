import { destroyAdminSession, requireAdminSession } from '@/lib/admin-auth';
import { adminResponse, adminError, assertAdminOrigin } from '@/lib/admin-api';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertAdminOrigin(request);
    await requireAdminSession();
    await destroyAdminSession();
    return adminResponse({ ok: true });
  } catch (error) {
    return adminError(error);
  }
}
