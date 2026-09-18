import { requireAdminSession } from '@/lib/admin-auth';
import { adminResponse, adminError } from '@/lib/admin-api';
export const runtime = 'nodejs';
export async function GET() {
  try {
    return adminResponse({ session: await requireAdminSession() });
  } catch (error) {
    return adminError(error);
  }
}
