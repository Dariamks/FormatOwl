import { getAuth } from '@/lib/auth';
export const runtime = 'nodejs';
async function handle(request: Request) {
  try {
    const response = await getAuth().handler(request);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch {
    return Response.json(
      { code: 'AUTH_UNAVAILABLE', message: 'Authentication is temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
export const GET = handle;
export const POST = handle;
