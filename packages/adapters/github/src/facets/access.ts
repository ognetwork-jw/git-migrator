/** access-control (FAC-ACL) and code-ownership (FAC-COD) drivers. */
import type { FacetDriver } from '@git-migrator/adapter-sdk';
import type {
  AccessControl,
  AccessRole,
  CodeOwnership,
  PrincipalRef,
} from '@git-migrator/canonical';
import { partialMutations } from '../change-requests.ts';
import { Directory } from '../directory.ts';
import { Collector, type Json, obj, repoPath, str } from '../gh.ts';
import { type DriverDeps, ghOf, itemPath, mutation, repoTarget, sortBy } from './common.ts';

const TO_API: Record<AccessRole, string> = {
  read: 'pull',
  triage: 'triage',
  write: 'push',
  maintain: 'maintain',
  admin: 'admin',
};

const ROLE_OF: Record<string, AccessRole> = {
  pull: 'read',
  read: 'read',
  triage: 'triage',
  push: 'write',
  write: 'write',
  maintain: 'maintain',
  admin: 'admin',
};

/** The role of a collaborator or team entry; custom role names fall back to their permission flags. */
export function roleOf(entry: Json): AccessRole | undefined {
  const named = ROLE_OF[str(entry.role_name) || str(entry.permission)];
  if (named) return named;
  const p = obj(entry.permissions);
  if (p.admin === true) return 'admin';
  if (p.maintain === true) return 'maintain';
  if (p.push === true) return 'write';
  if (p.triage === true) return 'triage';
  if (p.pull === true) return 'read';
  return undefined;
}

const key = (p: PrincipalRef) => `${p.kind}:${p.id}`;

export function accessControlDriver(deps: DriverDeps): FacetDriver<AccessControl> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const gh = ghOf(ctx, collector);
      const directory = new Directory(ghOf(ctx), deps.org);
      const base = repoPath(deps.org, repo.slug);
      const [collaborators, teams, owners] = await Promise.all([
        gh.list<Json>(`${base}/collaborators`, { affiliation: 'direct' }),
        gh.list<Json>(`${base}/teams`),
        directory.admins(),
      ]);
      const grants: AccessControl['grants'] = [];
      for (const c of collaborators) {
        const id = typeof c.id === 'number' ? String(c.id) : undefined;
        // Org owners and the App itself are implicit (FAC-ACL-002).
        if (
          id === undefined ||
          owners.has(id) ||
          c.type === 'Bot' ||
          str(c.login).endsWith('[bot]')
        ) {
          continue;
        }
        const role = roleOf(c);
        if (role === undefined) {
          collector.warn('access-control.unknown-role', [], { login: str(c.login) });
          continue;
        }
        grants.push({ principal: { kind: 'identity', id }, role });
      }
      for (const t of teams) {
        const role = roleOf(t);
        if (typeof t.id !== 'number' || role === undefined) {
          collector.warn('access-control.unknown-role', [], { team: str(t.slug) });
          continue;
        }
        grants.push({ principal: { kind: 'group', id: String(t.id) }, role });
      }
      return collector.result({ grants: sortBy(grants, (g) => key(g.principal)) });
    },
    async *apply(ctx, target, desired, current) {
      const repo = repoTarget(target);
      const gh = ghOf(ctx);
      const directory = new Directory(gh, deps.org);
      const have = new Map(
        (current ?? (await this.read(ctx, target)).data).grants.map((g) => [key(g.principal), g]),
      );
      const base = repoPath(deps.org, repo.slug);
      // Organization owners are implicit, never read as grants, so writing one would repeat forever.
      const owners = await directory.admins();
      for (const grant of sortBy(desired.grants, (g) => key(g.principal))) {
        if (grant.principal.kind === 'identity' && owners.has(grant.principal.id)) {
          ctx.logger.warn({ principal: key(grant.principal) }, 'organization owner; grant skipped');
          continue;
        }
        const existing = have.get(key(grant.principal));
        if (existing?.role === grant.role) continue;
        const path = itemPath('grants', 'principal', key(grant.principal));
        const resourceRef = {
          kind: 'access-grant',
          repository: repo.slug,
          principal: key(grant.principal),
        };
        if (grant.principal.kind === 'group') {
          const team = (await directory.teams()).find((t) => t.id === grant.principal.id);
          if (!team) {
            ctx.logger.warn({ principal: key(grant.principal) }, 'team not found; grant skipped');
            continue;
          }
          await gh.send(
            'PUT',
            `/orgs/${deps.org}/teams/${team.slug}/repos/${deps.org}/${repo.slug}`,
            {
              permission: TO_API[grant.role],
            },
          );
        } else {
          // Direct collaborators only for organization members: PUT for anyone else would send an
          // outside-collaborator invitation, which the framework never does (FAC-ACL-002).
          const user = (await directory.members()).find((m) => m.id === grant.principal.id);
          if (!user) {
            ctx.logger.warn(
              { principal: key(grant.principal) },
              'not an organization member; no outside-collaborator invitation is sent',
            );
            continue;
          }
          await gh.send('PUT', `${base}/collaborators/${encodeURIComponent(user.login)}`, {
            permission: TO_API[grant.role],
          });
        }
        yield mutation(
          'access-control',
          existing ? 'update' : 'create',
          resourceRef,
          [path],
          existing ?? null,
          grant,
        );
      }
    },
  };
}

// -- code-ownership -----------------------------------------------------------------------------

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
export const CODEOWNERS_PURPOSE = 'codeowners';

/** Renders a CODEOWNERS file; `name` turns a principal into `@login` or `@org/team`. */
export function renderCodeowners(
  doc: CodeOwnership,
  name: (p: PrincipalRef) => string | undefined,
): string {
  const lines = ['# Generated by git-migrator'];
  for (const o of sortBy(doc.owners, (x) => x.pattern)) {
    const names = o.principals.flatMap((p) => name(p.principal) ?? []);
    lines.push([o.pattern, ...names].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

/** Parses CODEOWNERS. A repeated pattern keeps the last line, like GitHub. */
export function parseCodeowners(text: string): { pattern: string; owners: string[] }[] {
  const byPattern = new Map<string, string[]>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern) byPattern.set(pattern, owners);
  }
  return [...byPattern].map(([pattern, owners]) => ({ pattern, owners }));
}

async function readCodeowners(
  gh: ReturnType<typeof ghOf>,
  base: string,
): Promise<string | undefined> {
  for (const path of CODEOWNERS_PATHS) {
    const file = await gh.getOrNull<Json>(`${base}/contents/${path}`);
    if (file && typeof file.content === 'string' && !Array.isArray(file)) {
      return Buffer.from(file.content, 'base64').toString('utf8');
    }
  }
  return undefined;
}

export function codeOwnershipDriver(deps: DriverDeps): FacetDriver<CodeOwnership> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const gh = ghOf(ctx, collector);
      const directory = new Directory(ghOf(ctx), deps.org);
      const text = await readCodeowners(gh, repoPath(deps.org, repo.slug));
      const owners: CodeOwnership['owners'] = [];
      for (const entry of parseCodeowners(text ?? '')) {
        const principals: CodeOwnership['owners'][number]['principals'] = [];
        for (const owner of entry.owners) {
          const m = /^@([^/\s]+)(?:\/([^/\s]+))?$/.exec(owner);
          if (!m) {
            collector.warn('code-ownership.owner-unrepresentable', [], { pattern: entry.pattern });
            continue;
          }
          if (m[2] !== undefined) {
            const team = await directory.teamBySlug(m[2]);
            if (team) principals.push({ principal: { kind: 'group', id: team.id } });
            else collector.warn('code-ownership.owner-unresolved', [], { owner });
          } else {
            const user = await directory.userByLogin(m[1] as string, repo.slug);
            if (user) principals.push({ principal: { kind: 'identity', id: user.id } });
            else collector.warn('code-ownership.owner-unresolved', [], { owner });
          }
        }
        owners.push({
          pattern: entry.pattern,
          principals: sortBy(principals, (p) => key(p.principal)),
        });
      }
      return collector.result({ owners: sortBy(owners, (o) => o.pattern) });
    },
    /** Delivers CODEOWNERS through a Change Request (LIF-047); idempotent. */
    async *apply(ctx, target, desired, current) {
      const repo = repoTarget(target);
      const read = current ?? (await this.read(ctx, target)).data;
      const same = (a: CodeOwnership, b: CodeOwnership) =>
        JSON.stringify(
          sortBy(a.owners, (o) => o.pattern).map((o) => [
            o.pattern,
            o.principals.map((p) => key(p.principal)).sort(),
          ]),
        ) ===
        JSON.stringify(
          sortBy(b.owners, (o) => o.pattern).map((o) => [
            o.pattern,
            o.principals.map((p) => key(p.principal)).sort(),
          ]),
        );
      if (same(read, desired)) return;
      const directory = new Directory(ghOf(ctx), deps.org);
      const users = await directory.users(repo.slug);
      const teams = await directory.teams();
      const content = renderCodeowners(desired, (p) =>
        p.kind === 'group'
          ? ((t) => (t ? `@${deps.org}/${t.slug}` : undefined))(teams.find((x) => x.id === p.id))
          : ((u) => (u ? `@${u.login}` : undefined))(users.get(p.id)),
      );
      let result: Awaited<ReturnType<typeof deps.changeRequests.upsert>>;
      try {
        result = await deps.changeRequests.upsert(repo, {
          purpose: CODEOWNERS_PURPOSE,
          branch: `git-migrator/${CODEOWNERS_PURPOSE}`,
          title: 'Add CODEOWNERS (git-migrator)',
          body: 'This change request was opened by git-migrator. It adds the CODEOWNERS file translated from the source repository. Review and merge it.',
          files: [{ path: '.github/CODEOWNERS', content }],
        });
      } catch (error) {
        // The branch and commit written before the failure are real: yield them so they are ledgered.
        for (const m of partialMutations(error)) yield m;
        throw error;
      }
      for (const m of result.mutations) yield m;
    },
  };
}
