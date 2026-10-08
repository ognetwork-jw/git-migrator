import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schema } from './generated/schema.ts';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const zmodel = readFileSync(join(PACKAGE_DIR, 'schema.zmodel'), 'utf8');

type Attr = { name: string; args?: { value?: { value?: unknown; call?: string } }[] };
type Field = {
  type: string;
  array?: boolean;
  id?: boolean;
  default?: { function?: string; args?: { value?: unknown }[] };
  attributes?: Attr[];
  relation?: { onDelete?: string; fields?: string[] };
};
type Model = { fields: Record<string, Field>; attributes?: Attr[]; idFields: string[] };
const models = schema.models as unknown as Record<string, Model>;
const enums = schema.enums as unknown as Record<string, { values: unknown }>;
const attrNames = (a?: Attr[]) => (a ?? []).map((x) => x.name);
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const APPEND_ONLY = ['QuotaEvent', 'RunLog', 'AuditEvent'];

describe('[DOM-003] conventions', () => {
  it('[DATA-001] uses schema app as the default and only schema, with no Better Auth tables', () => {
    expect(schema.provider).toMatchObject({ type: 'postgresql', defaultSchema: 'app' });
    expect(zmodel).toMatch(/schemas\s*=\s*\['app'\]/);
    expect(zmodel).toMatch(/defaultSchema\s*=\s*'app'/);
    for (const name of Object.keys(models)) {
      expect(name.toLowerCase(), name).not.toMatch(/^(session|account|verification|user)$/);
    }
  });

  it('[DOM-003] every model and enum is @@schema(app) and @@map snake_case', () => {
    for (const [name, model] of Object.entries(models)) {
      expect(attrNames(model.attributes), name).toContain('@@schema');
      expect(attrNames(model.attributes), name).toContain('@@map');
      const map = model.attributes?.find((a) => a.name === '@@map')?.args?.[0]?.value?.value;
      expect(map, name).toBe(snake(name));
    }
    const text = zmodel.replaceAll(/\/\/.*$/gm, '');
    const declarations = [...text.matchAll(/^(model|enum) (\w+) \{([\s\S]*?)^\}/gm)];
    expect(declarations.length).toBe(Object.keys(models).length + Object.keys(enums).length);
    for (const [, kind, name, body] of declarations) {
      expect(body, `${kind} ${name}`).toMatch(/@@schema\('app'\)/);
      expect(body, `${kind} ${name}`).toMatch(/@@map\("[a-z_]+"\)/);
    }
  });

  it('[DOM-003] ids are UUIDv7 except the config slugs and the two bigint ledgers', () => {
    const exceptions = new Set(['Endpoint', 'Route', 'QuotaState', 'QuotaEvent', 'QuotaLease']);
    for (const [name, model] of Object.entries(models)) {
      if (exceptions.has(name)) continue;
      const id = model.fields.id as Field;
      expect(id.default?.function, name).toBe('uuid');
      expect(id.default?.args?.[0]?.value, name).toBe(7);
    }
  });

  it('[DOM-003] every scalar column is @map snake_case and every DateTime is timestamptz', () => {
    for (const [name, model] of Object.entries(models)) {
      for (const [field, f] of Object.entries(model.fields)) {
        if (f.relation || models[f.type]) continue;
        const map = f.attributes?.find((a) => a.name === '@map')?.args?.[0]?.value?.value;
        expect(map ?? field, `${name}.${field}`).toBe(snake(field));
        if (f.type === 'DateTime') {
          expect(attrNames(f.attributes), `${name}.${field}`).toContain('@db.Timestamptz');
        }
      }
    }
  });

  it('[DOM-003] every model has createdAt and updatedAt except the append-only ledgers', () => {
    for (const [name, model] of Object.entries(models)) {
      const has = (f: string) => f in model.fields;
      if (APPEND_ONLY.includes(name)) {
        expect(has('updatedAt'), name).toBe(false);
      } else {
        expect(has('createdAt') && has('updatedAt'), name).toBe(true);
        // Migration and ManualTask have updated_at set by a database trigger (DOM-011), not @updatedAt.
        const byTrigger = ['Migration', 'ManualTask'].includes(name);
        expect(attrNames(model.fields.updatedAt?.attributes), name).toContain(
          byTrigger ? '@default' : '@updatedAt',
        );
      }
    }
  });
});

describe('[DOM-004] relations', () => {
  it('declares an @relation for every …Id field that names another model', () => {
    for (const [name, model] of Object.entries(models)) {
      const fks = new Set(
        Object.values(model.fields).flatMap((f) => (f.relation?.fields ?? []) as string[]),
      );
      for (const [field, f] of Object.entries(model.fields)) {
        if (!field.endsWith('Id') || f.relation || f.array || field === 'id') continue;
        // Polymorphic or logical references: no FK by design.
        const logical = ['authUserId', 'providerId', 'providerInvitationId', 'subjectId'];
        if (logical.includes(field)) continue;
        expect(fks.has(field), `${name}.${field} needs an @relation`).toBe(true);
      }
    }
  });

  it('[DOM-004] deletion is restricted; cascades only Run to RunStep/RunLog and Analysis to PlanItem', () => {
    const cascades: string[] = [];
    const setNull: string[] = [];
    for (const [name, model] of Object.entries(models)) {
      for (const [field, f] of Object.entries(model.fields)) {
        if (!f.relation?.fields) continue;
        const action = f.relation.onDelete;
        if (action === 'Cascade') cascades.push(`${name}.${field}`);
        else if (action === 'SetNull') setNull.push(`${name}.${field}`);
        else expect(['Restrict', 'NoAction'], `${name}.${field}`).toContain(action);
      }
    }
    expect(cascades.sort()).toEqual(['PlanItem.analysis', 'RunLog.run', 'RunStep.run']);
    // Migration.latestAnalysisId and ManualTask.sourcePlanItemId (DOM-004); Migration.waveId (DOM-013).
    expect(setNull.sort()).toEqual([
      'ManualTask.sourcePlanItem',
      'Migration.latestAnalysis',
      'Migration.wave',
    ]);
  });
});

describe('[DOM-005] policy declarations', () => {
  it('[DOM-005] no model grants create, update or delete beyond the API-012 allow-list', () => {
    const grants: Record<string, string[]> = {};
    for (const [name, model] of Object.entries(models)) {
      const ops = (model.attributes ?? [])
        .filter((a) => a.name === '@@allow')
        .map((a) => String(a.args?.[0]?.value?.value))
        .filter((o) => o !== 'read');
      if (ops.length) grants[name] = ops;
    }
    expect(grants).toEqual({
      Migration: ['update'],
      ManualTask: ['update'],
      Wave: ['create,update,delete'],
      NamingRule: ['create,update,delete'],
      WebhookAllowlistEntry: ['create,update,delete'],
      Overlay: ['create,update,delete'],
    });
    expect(zmodel).not.toMatch(/@@allow\('(all|create)'[^)]*\)\s*$/m);
  });
});

describe('generated client', () => {
  it('[DATA-031] src/generated matches schema.zmodel (run pnpm generate after editing it)', () => {
    const out = mkdtempSync(join(tmpdir(), 'gm-db-generate-'));
    try {
      const require = createRequire(import.meta.url);
      const cli = join(dirname(require.resolve('@zenstackhq/cli/package.json')), 'bin', 'cli');
      const run = spawnSync(
        process.execPath,
        [
          cli,
          'generate',
          '--schema',
          join(PACKAGE_DIR, 'schema.zmodel'),
          '-o',
          out,
          '--no-version-check',
          '--no-tips',
          '--silent',
        ],
        { encoding: 'utf8' },
      );
      expect(run.status, run.stderr).toBe(0);
      for (const file of readdirSync(out)) {
        expect(readFileSync(join(out, file), 'utf8'), file).toBe(
          readFileSync(join(PACKAGE_DIR, 'src', 'generated', file), 'utf8'),
        );
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('[DOM-002] promoted columns', () => {
  it('[DOM-002] keeps the filterable Facet values as real columns', () => {
    const fields = (model: string) => Object.keys(models[model]?.fields ?? {});
    expect(fields('Repository')).toEqual(
      expect.arrayContaining(['sizeBytes', 'sizeClass', 'fullPath', 'presence']),
    );
    expect(fields('Migration')).toEqual(
      expect.arrayContaining(['blockerCodes', 'readiness', 'readinessCounts', 'status']),
    );
    expect(models.Migration?.fields.blockerCodes).toMatchObject({ type: 'String', array: true });
  });
});
