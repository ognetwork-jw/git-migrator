/**
 * Request classifier and header interpretation for Bitbucket Cloud (JOB-043, ADP-060). User API
 * tokens get no rate-limit headers, so buckets are tracked locally; `X-RateLimit-Limit` and
 * `X-RateLimit-NearLimit` are honoured if they ever appear.
 */
import {
  type BucketSpec,
  bucketKey,
  type Classifier,
  type Interpreter,
  type QuotaFeedback,
  type RequestClass,
} from '@git-migrator/adapter-sdk';
import type { ResourceGroup } from './config.ts';

export const WINDOW_SECONDS = 3600;

/** Documented defaults (provider doc, "Rate limits"; unverified, ADR-0036 item 11). */
export const DEFAULT_LIMITS: Readonly<Record<ResourceGroup, number>> = {
  'repository-data': 1000,
  webhooks: 1000,
  'raw-files': 5000,
  'app-properties': 2000,
  git: 60000,
};

/** A bucket key part may not hold `:`, `#` or whitespace (Atlassian account ids contain `:`). */
export function safeAccountKey(accountKey: string): string {
  const cleaned = accountKey.replace(/[:#\s]+/g, '_');
  return cleaned === '' ? '_' : cleaned;
}

export interface QuotaSetup {
  readonly endpointId: string;
  readonly accountKey: string;
  readonly overrides?: Partial<Record<ResourceGroup, number>>;
}

export function limitOf(group: ResourceGroup, overrides?: QuotaSetup['overrides']): number {
  return overrides?.[group] ?? DEFAULT_LIMITS[group];
}

/** The bucket of a resource group, for the classifier and for the git package's pre-acquire. */
export function bucketSpec(setup: QuotaSetup, group: ResourceGroup, units = 1): BucketSpec {
  return {
    key: bucketKey(setup.endpointId, safeAccountKey(setup.accountKey), group),
    limit: limitOf(group, setup.overrides),
    windowSeconds: WINDOW_SECONDS,
    ...(units !== 1 ? { units } : {}),
  };
}

const HOOKS = /^\/2\.0\/(?:repositories\/[^/]+\/[^/]+|workspaces\/[^/]+)\/hooks(?:\/|$)/;
/** The documented app-property routes only; a repository or branch named `properties` is not one. */
const PROPERTIES = [
  /^\/2\.0\/repositories\/[^/]+\/[^/]+\/properties\/[^/]+\/[^/]+$/,
  /^\/2\.0\/repositories\/[^/]+\/[^/]+\/commit\/[^/]+\/properties\/[^/]+\/[^/]+$/,
  /^\/2\.0\/repositories\/[^/]+\/[^/]+\/pullrequests\/[^/]+\/properties\/[^/]+\/[^/]+$/,
  /^\/2\.0\/users\/[^/]+\/properties\/[^/]+\/[^/]+$/,
];
const SRC_FILE = /^\/2\.0\/repositories\/[^/]+\/[^/]+\/src\/[^/]+\/.*[^/]$/;
const DOWNLOAD_FILE = /^\/2\.0\/repositories\/[^/]+\/[^/]+\/downloads\/.+/;

/** Endpoint labels for metrics: low cardinality, first match wins. */
const LABELS: readonly (readonly [RegExp, string])[] = [
  [/^\/2\.0\/user$/, 'user.get'],
  [/^\/1\.0\/groups\//, 'groups.list'],
  [/^\/2\.0\/workspaces\/[^/]+\/members/, 'members.list'],
  [/^\/2\.0\/workspaces\/[^/]+\/permissions/, 'permissions.list'],
  [/^\/2\.0\/workspaces\/[^/]+\/projects\/[^/]+\/permissions-config/, 'projects.permissions'],
  [/^\/2\.0\/workspaces\/[^/]+\/projects\/[^/]+\/deploy-keys/, 'projects.deploy-keys'],
  [/^\/2\.0\/workspaces\/[^/]+\/projects\/[^/]+\/branching-model/, 'projects.branching-model'],
  [/^\/2\.0\/workspaces\/[^/]+\/projects/, 'projects.list'],
  [/^\/2\.0\/workspaces\/[^/]+\/pipelines-config\/variables/, 'workspace.variables'],
  [/^\/2\.0\/workspaces\/[^/]+\/hooks/, 'workspace.hooks'],
  [/^\/2\.0\/repositories\/[^/]+$/, 'repositories.list'],
  [/^\/2\.0\/repositories\/[^/]+\/[^/]+$/, 'repositories.get'],
  [/\/permissions-config\//, 'repositories.permissions'],
  [/\/branch-restrictions/, 'branch-restrictions'],
  [/\/effective-branching-model$/, 'branching-model.effective'],
  [/\/branching-model\/settings$/, 'branching-model.settings'],
  [/\/effective-default-reviewers$/, 'default-reviewers'],
  [/\/refs\/branches\//, 'refs.branch'],
  [/\/hooks/, 'repository.hooks'],
  [/\/deploy-keys/, 'repository.deploy-keys'],
  [/\/pipelines_config\/variables/, 'pipelines.variables'],
  [/\/pipelines_config$/, 'pipelines.config'],
  [/\/deployments_config\//, 'environments.variables'],
  [/\/environments/, 'environments.list'],
  [/\/pullrequests/, 'pullrequests.list'],
  [/\/issues/, 'issues.count'],
  [/\/downloads/, 'downloads'],
  [/\/src\//, 'src.get'],
];

/** Resource groups a request is counted in (JOB-043). Never empty. */
export function resourceGroups(method: string, path: string): ResourceGroup[] {
  if (PROPERTIES.some((re) => re.test(path))) return ['app-properties'];
  if (HOOKS.test(path)) return ['webhooks'];
  if (method.toUpperCase() === 'GET' && (SRC_FILE.test(path) || DOWNLOAD_FILE.test(path))) {
    return ['raw-files', 'repository-data'];
  }
  return ['repository-data'];
}

/** Route to bucket classifier (ADP-060, JOB-043). */
export function createClassifier(setup: QuotaSetup): Classifier {
  return ({ method, path }): RequestClass => {
    const groups = resourceGroups(method, path);
    const endpoint = LABELS.find(([re]) => re.test(path))?.[1] ?? 'other';
    return {
      endpoint,
      buckets: groups.map((g) => bucketSpec(setup, g)),
      bucketLabel: groups[0] as string,
      // JOB-044: Bitbucket 429 without Retry-After blocks for at least 60 s.
      minBlockSeconds: 60,
    };
  };
}

const POSITIVE_INT = /^\d{1,9}$/;

/**
 * Neutral quota feedback from `X-RateLimit-Limit` / `X-RateLimit-NearLimit` (JOB-043). Applied to
 * the request's first (most specific) bucket. Without either header nothing is reported. Also
 * carries a short provider error message for failing responses.
 */
export function createInterpreter(setup: QuotaSetup): Interpreter {
  const classify = createClassifier(setup);
  return (res) => {
    const out: { feedback?: QuotaFeedback[]; message?: string } = {};
    const limitHeader = res.headers.get('x-ratelimit-limit')?.trim() ?? '';
    const near = res.headers.get('x-ratelimit-nearlimit')?.trim().toLowerCase();
    const limit = POSITIVE_INT.test(limitHeader) ? Number(limitHeader) : undefined;
    const nearLimit = near === 'true' ? true : near === 'false' ? false : undefined;
    const bucket = classify({ method: res.method, path: res.path }).buckets[0];
    if (bucket !== undefined && (limit !== undefined || nearLimit === true)) {
      out.feedback = [
        {
          bucketKey: bucket.key,
          limit: limit !== undefined && limit > 0 ? limit : bucket.limit,
          windowSeconds: bucket.windowSeconds,
          observedSince: res.grantedAt,
          ...(nearLimit === true ? { nearLimit: true } : {}),
        },
      ];
    }
    if (res.status >= 400 && typeof res.body === 'object' && res.body !== null) {
      const message = (res.body as { error?: { message?: unknown } }).error?.message;
      if (typeof message === 'string' && message !== '') out.message = message.slice(0, 300);
    }
    return out.feedback !== undefined || out.message !== undefined ? out : undefined;
  };
}
