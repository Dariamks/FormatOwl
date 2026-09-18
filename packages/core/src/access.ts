import { db, eq } from './db';
import { adminUserProfiles, toolVisibility } from './schema';
import { tools } from './catalog';
import { ServiceError } from './service-error';

type AccessStore =
  | ReturnType<typeof db>
  | Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

const catalogIds = new Set<string>(tools.map((tool) => tool.id));

export async function listPublishedToolIds() {
  const rows = await db().select().from(toolVisibility);
  const states = new Map(rows.map((row) => [row.toolId, row.published]));
  return tools.filter((tool) => states.get(tool.id) !== false).map((tool) => tool.id);
}

export async function isToolPublished(toolId: string, store: AccessStore = db()) {
  if (!catalogIds.has(toolId)) return false;
  const [row] = await store.select().from(toolVisibility).where(eq(toolVisibility.toolId, toolId));
  return row?.published !== false;
}

export async function assertToolPublished(toolId: string, store: AccessStore = db()) {
  if (!(await isToolPublished(toolId, store))) throw new ServiceError(404, 'TOOL_UNPUBLISHED');
}

export async function listAdminTools() {
  const rows = await db().select().from(toolVisibility);
  const states = new Map(rows.map((row) => [row.toolId, row.published]));
  return tools.map((tool) => ({
    id: tool.id,
    group: tool.group,
    icon: tool.icon,
    formats: tool.formats,
    ready: tool.ready,
    published: states.get(tool.id) !== false,
  }));
}

export async function setToolPublished(toolId: string, published: boolean) {
  if (!catalogIds.has(toolId)) throw new ServiceError(404, 'NOT_FOUND');
  const [row] = await db()
    .insert(toolVisibility)
    .values({ toolId, published, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: toolVisibility.toolId,
      set: { published, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function isUserBlocked(userId: string, store: AccessStore = db()) {
  const [row] = await store
    .select({ blocked: adminUserProfiles.blocked })
    .from(adminUserProfiles)
    .where(eq(adminUserProfiles.userId, userId));
  return row?.blocked === true;
}

export async function assertOwnerNotBlocked(owner: string, store: AccessStore = db()) {
  if (!owner.startsWith('user:')) return;
  if (await isUserBlocked(owner.slice('user:'.length), store))
    throw new ServiceError(403, 'USER_BLOCKED');
}

export async function listPublishedTools() {
  const ids = new Set(await listPublishedToolIds());
  return tools.filter((tool) => ids.has(tool.id));
}
