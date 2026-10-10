import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactWebhookUrl } from '@git-migrator/canonical';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './test-support.ts';
import { buildWorld, type World } from './test-world.ts';

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
  '20261010000001_secret_params',
  'migration.sql',
);

let t: TestDatabase;
let world: World;

beforeAll(async () => {
  t = await createTestDatabase('gm_t097_');
  world = await buildWorld(t.db.privileged);
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

/** The data part of the migration: what it does to rows written before the columns existed. */
async function runDataMigration(): Promise<void> {
  const text = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !/^ALTER TABLE .* ADD COLUMN/.test(line))
    .join('\n');
  await t.db.pool.query(text);
}

describe('[FAC-WEB-002] task rows written before secret params (ADR-0503)', () => {
  it('[FAC-WEB-002] the migration moves a legacy targetUrl apart and adds its display form, as the application writes it', async () => {
    const urls = [
      'https://bob:LEAKPW@Hooks.Example:443/p/SECRETPATH?token=x',
      'http://ci.example.test:8080/hook',
      'ftp://files.example.test/x',
    ];
    const ids: string[] = [];
    for (const [i, url] of urls.entries()) {
      const task = await t.db.privileged.manualTask.create({
        data: {
          migrationId: (world.where.Migration as { id: string }).id,
          facetKey: 'webhooks',
          code: 'webhooks.recreate-manually',
          phase: 'post',
          origin: 'analysis',
          params: { key: `k${i}`, targetUrl: url, events: ['push'] },
          verifiable: true,
          paramsHash: `legacy-${i}`,
        },
      });
      ids.push(task.id);
    }
    await runDataMigration();
    const rows = await t.db.privileged.manualTask.findMany({ where: { id: { in: ids } } });
    for (const [i, url] of urls.entries()) {
      const row = rows.find((r) => r.id === ids[i]);
      expect(row?.secretParams).toEqual({ targetUrl: url });
      const display = url.startsWith('ftp:') ? {} : { targetUrlDisplay: redactWebhookUrl(url) };
      expect(row?.params).toEqual({ key: `k${i}`, events: ['push'], ...display });
      expect(JSON.stringify(row?.params)).not.toMatch(/LEAKPW|SECRETPATH|token/);
    }
  });
});
