import { isLocale } from '@/i18n/registry';
import { namespaces, type Namespace } from '@/i18n/imports';
import { loadMessages } from '@/i18n/server';
import { messageVersion } from '@/i18n/version';
export async function GET(request: Request) {
  const url = new URL(request.url),
    locale = url.searchParams.get('locale');
  const names = [...new Set((url.searchParams.get('namespaces') ?? '').split(','))];
  if (
    !isLocale(locale) ||
    names.length > 16 ||
    names.some(
      (name) =>
        !namespaces.includes(name as Namespace) ||
        ['content', 'email', 'tool_information', 'page', 'homeServer', 'guide'].includes(name),
    )
  )
    return Response.json({ error: 'INVALID_MESSAGES' }, { status: 400 });
  if (url.searchParams.get('v') !== messageVersion)
    return Response.json({ error: 'MESSAGES_VERSION' }, { status: 409 });
  return Response.json(await loadMessages(locale, names as Namespace[]), {
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}
