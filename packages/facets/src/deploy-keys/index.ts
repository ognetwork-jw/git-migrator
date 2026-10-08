/**
 * deploy-keys facet (FAC-DKY). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * Decisions: docs/adr/0142-deploy-keys-facet.md.
 */
import { type DeployKeys, deployKeysFacet } from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FacetTaskRef,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  itemSeg,
  joinFieldPath,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';

export const KEY_IN_USE = 'deploy-keys.key-in-use';

/** Used for the guidance `keyName` when a key has no title. */
export const FALLBACK_KEY_NAME = 'deploy-key';

function keyPath(publicKey: string, ...rest: string[]): string {
  const base = joinFieldPath('', itemSeg('keys', 'publicKey', publicKey));
  return rest.length === 0 ? base : `${base}/${rest.join('/')}`;
}

/**
 * `ctx.routeIndex.deployKeyUsage`: `Record<publicKey, number>`, the number of source repositories
 * on the Route that carry the key (FAC-DKY-003). Absent means no cross-repository facts; present
 * but malformed throws rather than hiding a duplicate.
 */
export function deployKeyUsage(routeIndex: TranslateContext['routeIndex']): Record<string, number> {
  const usage = routeIndex.deployKeyUsage;
  if (usage === undefined) return {};
  if (
    typeof usage !== 'object' ||
    usage === null ||
    Array.isArray(usage) ||
    Object.values(usage).some((n) => !Number.isInteger(n) || (n as number) < 0)
  ) {
    throw new TypeError('routeIndex.deployKeyUsage must map public keys to non-negative integers');
  }
  return usage as Record<string, number>;
}

export function normalizeDeployKeys(data: DeployKeys): DeployKeys {
  return { keys: data.keys.map((k) => ({ ...k })) };
}

export function translateDeployKeys(
  source: DeployKeys,
  ctx: TranslateContext,
): TranslationResult<DeployKeys> {
  const usage = deployKeyUsage(ctx.routeIndex);
  const decisions: FieldDecision[] = [];
  const postTasks: Finding[] = [];
  const keys = source.keys.map((k) => {
    if (!k.readOnly) {
      // Deploy keys are always created read-only on the target (FAC-DKY-002).
      decisions.push({
        path: keyPath(k.publicKey, 'readOnly'),
        fidelity: 'translated',
        accepted: false,
      });
    }
    if ((usage[k.publicKey] ?? 0) > 1) {
      postTasks.push({
        code: KEY_IN_USE,
        paths: [keyPath(k.publicKey)],
        params: {
          keyName: k.title.trim() === '' ? FALLBACK_KEY_NAME : k.title,
          publicKey: k.publicKey,
        },
      });
    }
    return { publicKey: k.publicKey, title: k.title, readOnly: true };
  });
  return { desired: { keys }, decisions, blockers: [], preTasks: [], postTasks, warnings: [] };
}

/** FAC-DKY-002 completion: the target has the key. */
export function isDeployKeyTaskSatisfied(task: FacetTaskRef, target: DeployKeys): boolean {
  if (task.code !== KEY_IN_USE) return false;
  const params = task.params;
  const publicKey =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>).publicKey
      : undefined;
  return typeof publicKey === 'string' && target.keys.some((k) => k.publicKey === publicKey);
}

export const deployKeysDefinition: FacetDefinition<DeployKeys> = {
  key: deployKeysFacet.key,
  scope: deployKeysFacet.scope,
  schemaVersion: deployKeysFacet.schemaVersion,
  schema: deployKeysFacet.schema,
  compareMode: 'full',
  collections: deployKeysFacet.collections,
  sets: deployKeysFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeDeployKeys,
  translate: translateDeployKeys,
  compare: (desired, actual): FieldDiff[] =>
    diffDocuments(desired, actual, {
      collections: deployKeysFacet.collections,
      sets: deployKeysFacet.sets ?? [],
    }),
  isTaskSatisfied: (task, target) => isDeployKeyTaskSatisfied(task, target),
  findingCodes: {
    [KEY_IN_USE]: { kind: 'post', completion: 'parity' },
  },
  policyKeys: [],
};
