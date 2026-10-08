import type { Db } from './client.ts';

/** One seeded Actor per role (AUTH-012). Better Auth users for them are created by T-020. */
export const TEST_ACTORS = [
  { email: 'viewer@test.local', displayName: 'Test Viewer', role: 'viewer' },
  { email: 'operator@test.local', displayName: 'Test Operator', role: 'operator' },
  { email: 'admin@test.local', displayName: 'Test Admin', role: 'admin' },
] as const;

export const SAMPLE_WAVE_NAME = 'Sample wave';
export const SAMPLE_ALLOWLIST_PATTERN = 'https://hooks.example.test/*';

export interface SeedResult {
  readonly actors: number;
  readonly wave: boolean;
  readonly allowlistEntry: boolean;
}

/**
 * `pnpm db:seed` (DATA-040), dev and test only. Idempotent: it never duplicates a row and never
 * overwrites one an operator changed. The Wave and allowlist samples attach to `routeId` (the first
 * non-retired Route when omitted) and are skipped when no Route exists yet. The provider-fake
 * fixture world of the `test` profile (TST-012) is seeded by `testing/fixtures`.
 */
export async function seedDev(db: Db, options: { routeId?: string } = {}): Promise<SeedResult> {
  let actors = 0;
  for (const spec of TEST_ACTORS) {
    const existing = await db.actor.findFirst({
      where: { email: spec.email },
      select: { id: true },
    });
    if (existing) continue;
    await db.actor.create({ data: { kind: 'human', ...spec } });
    actors++;
  }

  const route = options.routeId
    ? await db.route.findUnique({ where: { id: options.routeId }, select: { id: true } })
    : await db.route.findFirst({
        where: { retiredAt: null },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
  let wave = false;
  let allowlistEntry = false;
  if (route) {
    if (!(await db.wave.findUnique({ where: { name: SAMPLE_WAVE_NAME }, select: { id: true } }))) {
      await db.wave.create({
        data: { name: SAMPLE_WAVE_NAME, description: 'Created by pnpm db:seed' },
      });
      wave = true;
    }
    const entry = await db.webhookAllowlistEntry.findFirst({
      where: { routeId: route.id, pattern: SAMPLE_ALLOWLIST_PATTERN },
      select: { id: true },
    });
    if (!entry) {
      await db.webhookAllowlistEntry.create({
        data: { routeId: route.id, pattern: SAMPLE_ALLOWLIST_PATTERN, note: 'Sample entry' },
      });
      allowlistEntry = true;
    }
  }
  return { actors, wave, allowlistEntry };
}
