/**
 * Cached, shared reads behind the Facet drivers and the inventory. Caches are per connection and
 * short-lived: the call budget (provider doc, "Analysis call budget") counts project data once per
 * Analysis batch, and `variables`/`secrets`/`environments` share their fetches.
 */
import { AdapterError, type DriverContext, type GitAccess } from '@git-migrator/adapter-sdk';
import { z } from 'zod';
import {
  type Account,
  account,
  enc,
  type Fetched,
  getOne,
  listAll,
  Memo,
  obj,
  type Repository,
  type Req,
  repository,
} from './api.ts';
import {
  deployKeyRow,
  environmentRow,
  groupPermission,
  userPermission,
  variableRow,
} from './mappers.ts';

export type Ctx = Pick<DriverContext, 'http' | 'git' | 'pool' | 'signal' | 'logger'>;

export interface RepoKey {
  readonly slug: string;
  readonly projectKey: string;
}

export const legacyGroup = obj({
  slug: z.string(),
  name: z.string().optional(),
  permission: z.string().optional(),
  members: z.array(account).optional(),
});
export type LegacyGroup = z.infer<typeof legacyGroup>;

const PER_REPO_TTL_MS = 30_000;
const PER_BATCH_TTL_MS = 10 * 60_000;

export class Reader {
  readonly workspace: string;
  readonly git: GitAccess;
  readonly #repoMemo: Memo;
  readonly #batchMemo: Memo;

  constructor(options: { workspace: string; git: GitAccess; now?: () => number }) {
    this.workspace = options.workspace;
    this.git = options.git;
    this.#repoMemo = new Memo(PER_REPO_TTL_MS, options.now);
    this.#batchMemo = new Memo(PER_BATCH_TTL_MS, options.now);
  }

  static req(ctx: Ctx): Req {
    return { http: ctx.http, ctx };
  }

  repoPath(slug: string): string {
    return `/2.0/repositories/${enc(this.workspace)}/${enc(slug)}`;
  }

  wsPath(): string {
    return `/2.0/workspaces/${enc(this.workspace)}`;
  }

  projectPath(key: string): string {
    return `${this.wsPath()}/projects/${enc(key)}`;
  }

  /** The repository document (shared by settings, merge-settings, pipelines and extras reads). */
  repository(ctx: Ctx, slug: string): Promise<{ repo: Repository; rawResponseIds: string[] }> {
    return this.#repoMemo.get(`repo:${slug}`, async () => {
      const { data, rawResponseIds } = await getOne(
        Reader.req(ctx),
        this.repoPath(slug),
        repository,
        'repository',
      );
      return { repo: data as Repository, rawResponseIds };
    });
  }

  /** Project permissions, read once per project and batch. */
  projectPermissions(ctx: Ctx, key: string) {
    return this.#batchMemo.get(`project-permissions:${key}`, async () => {
      const r = Reader.req(ctx);
      const base = `${this.projectPath(key)}/permissions-config`;
      const [users, groups] = await Promise.all([
        listAll(r, `${base}/users`, userPermission, 'project user permissions'),
        listAll(r, `${base}/groups`, groupPermission, 'project group permissions'),
      ]);
      return { users, groups };
    });
  }

  projectDeployKeys(ctx: Ctx, key: string) {
    return this.#batchMemo.get(`project-keys:${key}`, () =>
      listAll(
        Reader.req(ctx),
        `${this.projectPath(key)}/deploy-keys`,
        deployKeyRow,
        'project deploy keys',
      ),
    );
  }

  /**
   * `GET /1.0/groups/{ws}` is not in the published reference (ADR-0036 item 2): tried once per
   * workspace and batch, `null` on 404/410 (the documented fallback applies).
   */
  legacyGroups(ctx: Ctx): Promise<{ groups: LegacyGroup[] | null; rawResponseIds: string[] }> {
    return this.#batchMemo.get('legacy-groups', async () => {
      try {
        const res = await ctx.http.request({
          path: `/1.0/groups/${enc(this.workspace)}`,
          pool: ctx.pool,
          signal: ctx.signal,
          capture: true,
        });
        const rows = Array.isArray(res.body) ? res.body : [];
        const groups = rows.flatMap((row) => {
          const parsed = legacyGroup.safeParse(row);
          return parsed.success ? [parsed.data] : [];
        });
        return { groups, rawResponseIds: res.rawResponseId ? [res.rawResponseId] : [] };
      } catch (error) {
        if (error instanceof AdapterError && error.code === 'not_found') {
          return { groups: null, rawResponseIds: [] };
        }
        throw error;
      }
    });
  }

  /** Workspace owners (implicit admins); `null` when the permission list cannot be read. */
  owners(ctx: Ctx): Promise<{ ids: Set<string> | null; rawResponseIds: string[] }> {
    return this.#batchMemo.get('owners', async () => {
      try {
        const rows = await listAll(
          Reader.req(ctx),
          `${this.wsPath()}/permissions`,
          obj({ permission: z.string().optional(), user: account.optional() }),
          'workspace permissions',
        );
        const ids = new Set<string>();
        for (const row of rows.items) {
          const id = row.user?.account_id ?? row.user?.uuid;
          if (row.permission === 'owner' && id !== undefined) ids.add(id);
        }
        return { ids, rawResponseIds: rows.rawResponseIds };
      } catch (error) {
        if (
          error instanceof AdapterError &&
          (error.code === 'not_found' || error.code === 'forbidden')
        ) {
          return { ids: null, rawResponseIds: [] };
        }
        throw error;
      }
    });
  }

  /** Environments with their variables: one fetch for `environments`, `variables` and `secrets`. */
  environments(ctx: Ctx, slug: string) {
    return this.#repoMemo.get(`environments:${slug}`, () =>
      listAll(
        Reader.req(ctx),
        `${this.repoPath(slug)}/environments`,
        environmentRow,
        'environments',
      ),
    );
  }

  repoVariables(ctx: Ctx, slug: string) {
    return this.#repoMemo.get(`variables:${slug}`, async () => {
      const r = Reader.req(ctx);
      const repoVars = await listAll(
        r,
        `${this.repoPath(slug)}/pipelines_config/variables`,
        variableRow,
        'pipeline variables',
      );
      const envs = await this.environments(ctx, slug);
      const perEnv: Array<{ name: string; vars: Fetched<z.infer<typeof variableRow>> }> = [];
      for (const env of envs.items) {
        perEnv.push({
          name: env.name,
          vars: await listAll(
            r,
            `${this.repoPath(slug)}/deployments_config/environments/${enc(env.uuid)}/variables`,
            variableRow,
            'deployment variables',
          ),
        });
      }
      return { repoVars, perEnv, envs };
    });
  }
}

export type { Account };
