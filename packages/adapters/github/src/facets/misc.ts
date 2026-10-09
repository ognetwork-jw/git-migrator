/** pipelines, change-requests, members and teams drivers. */
import type { FacetDriver } from '@git-migrator/adapter-sdk';
import type { ChangeRequests, Members, Pipelines, Teams } from '@git-migrator/canonical';
import { sha256Hex } from '@git-migrator/core';
import { Directory } from '../directory.ts';
import { Collector, type Json, obj, repoPath, str } from '../gh.ts';
import {
  cannotUndo,
  type DriverDeps,
  ghOf,
  ignoreGone,
  itemPath,
  mutation,
  orgTarget,
  repoTarget,
  sortBy,
  teamStillIs,
  undoDirectory,
} from './common.ts';

export const FRAMEWORK_BRANCH_PREFIX = 'git-migrator/';

// -- pipelines (read only: delivery is a Change Request, FAC-PIP-003) ---------------------------

export function pipelinesDriver(deps: DriverDeps): FacetDriver<Pipelines> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const gh = ghOf(ctx, collector);
      const base = repoPath(deps.org, repo.slug);
      const dir = await gh.getOrNull<unknown>(`${base}/contents/.github/workflows`);
      const files: Pipelines['files'] = [];
      if (Array.isArray(dir)) {
        for (const entry of dir as Json[]) {
          const path = str(entry.path);
          if (entry.type !== 'file' || !/\.ya?ml$/i.test(path)) continue;
          const file = await gh.getOrNull<Json>(`${base}/contents/${path}`);
          if (!file || typeof file.content !== 'string') continue;
          files.push({ path, sha256: sha256Hex(Buffer.from(file.content, 'base64')) });
        }
      }
      return collector.result({
        files: sortBy(files, (f) => f.path),
        enabled: true,
        translation: { supported: true, unsupported: [] },
      });
    },
  };
}

// -- change-requests (read only; framework Change Requests are ignored) -------------------------

export function changeRequestsDriver(deps: DriverDeps): FacetDriver<ChangeRequests> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const list = await ghOf(ctx, collector).list<Json>(`${repoPath(deps.org, repo.slug)}/pulls`, {
        state: 'open',
      });
      const open: ChangeRequests['open'] = list.flatMap((p) =>
        str(obj(p.head).ref).startsWith(FRAMEWORK_BRANCH_PREFIX) || typeof p.number !== 'number'
          ? []
          : [{ id: String(p.number), title: str(p.title), url: str(p.html_url) }],
      );
      return collector.result({ open: sortBy(open, (c) => c.id) });
    },
  };
}

// -- members (read only: invitations go through approved batches, AUTH-061) ---------------------

export function membersDriver(_deps: DriverDeps): FacetDriver<Members> {
  return {
    async read(ctx, target) {
      const collector = new Collector();
      const directory = new Directory(ghOf(ctx, collector), orgTarget(target));
      const [members, admins] = await Promise.all([directory.members(), directory.admins()]);
      return collector.result({
        members: sortBy(
          members.map((m) => ({
            principal: { kind: 'identity' as const, id: m.id },
            role: admins.has(m.id) ? ('admin' as const) : ('member' as const),
          })),
          (m) => m.principal.id,
        ),
      });
    },
  };
}

// -- teams --------------------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function teamsDriver(_deps: DriverDeps): FacetDriver<Teams> {
  return {
    async read(ctx, target) {
      const org = orgTarget(target);
      const collector = new Collector();
      const gh = ghOf(ctx, collector);
      const teams: Teams['teams'] = [];
      for (const t of await new Directory(ghOf(ctx), org).teams()) {
        const members = await gh.list<Json>(`/orgs/${org}/teams/${t.slug}/members`);
        teams.push({
          slug: t.slug,
          name: t.name,
          members: sortBy(
            members.flatMap((m) =>
              typeof m.id === 'number'
                ? [{ principal: { kind: 'identity' as const, id: String(m.id) } }]
                : [],
            ),
            (m) => m.principal.id,
          ),
        });
      }
      return collector.result({ teams: sortBy(teams, (t) => t.slug) });
    },
    async *apply(ctx, target, desired, current) {
      const org = orgTarget(target);
      const gh = ghOf(ctx);
      const directory = new Directory(gh, org);
      const have = new Map(
        (current ?? (await this.read(ctx, target)).data).teams.map((t) => [t.slug, t]),
      );
      const members = await directory.members();
      // Provider ids of the teams written to, so a record names exactly its team (an undo never
      // deletes whatever holds the slug later, ADR-0467 round 2).
      const ids = new Map((await directory.teams()).map((t) => [t.slug, t.id]));
      for (const team of sortBy(desired.teams, (t) => t.slug)) {
        let existing = have.get(team.slug);
        if (!existing) {
          // The slug is derived from the name; use the slug as the name if they would disagree.
          const name = slugify(team.name) === team.slug ? team.name : team.slug;
          const created = await gh.send<Json>('POST', `/orgs/${org}/teams`, {
            name,
            privacy: 'closed',
          });
          ids.set(team.slug, String(created.id));
          existing = { slug: team.slug, name, members: [] };
          yield mutation(
            'teams',
            'create',
            { kind: 'team', slug: team.slug, id: String(created.id) },
            [itemPath('teams', 'slug', team.slug)],
            null,
            { slug: team.slug, name, members: [] },
          );
        }
        const present = new Set(existing.members.map((m) => m.principal.id));
        for (const m of team.members) {
          if (present.has(m.principal.id)) continue;
          // Only organization members: PUT would invite anyone else (AUTH-061).
          const user = members.find((x) => x.id === m.principal.id);
          if (!user) {
            ctx.logger.warn({ team: team.slug }, 'not an organization member; membership skipped');
            continue;
          }
          await gh.send(
            'PUT',
            `/orgs/${org}/teams/${team.slug}/memberships/${encodeURIComponent(user.login)}`,
            { role: 'member' },
          );
          yield mutation(
            'teams',
            'create',
            {
              kind: 'team-membership',
              team: team.slug,
              teamId: ids.get(team.slug),
              login: user.login,
            },
            [`${itemPath('teams', 'slug', team.slug)}/members[principal=identity:${user.id}]`],
            null,
            { principal: m.principal },
          );
        }
      }
    },
    async undo(ctx, target, record) {
      const ref = record.resourceRef;
      if (record.action !== 'create') throw cannotUndo(record);
      if (ref.kind !== 'team' && ref.kind !== 'team-membership') throw cannotUndo(record);
      const gh = ghOf(ctx);
      const org = orgTarget(target);
      const directory = undoDirectory(ctx, org);
      const id = String(ref.kind === 'team' ? ref.id : ref.teamId);
      const named = id !== 'undefined' && id !== '';
      const teams = await directory.teamRecords();
      // The team is found by its id, never by the slug alone: a hand-made team may hold the slug
      // now, and a team of the framework may have been renamed.
      const slugOf = String(ref.kind === 'team' ? ref.slug : ref.team);
      const ours = named
        ? teams.find((t) => String(t.id) === id)
        : teams.find((t) => str(t.slug) === slugOf);
      // Newest first: a membership goes before its team. A team that is gone took its members.
      if (!ours) return;
      // A record written before teams were recorded by id: whatever holds the slug now cannot be
      // proven the framework's, so it stays (a slug nobody holds means the team is gone).
      if (!named) return { left: { kind: 'group-unproven', name: slugOf } };
      const slug = str(ours.slug);
      if (ref.kind === 'team-membership') {
        // The slug may hold another team by now (renamed, and a new one made on the old slug).
        if (!(await teamStillIs(ctx, directory, org, slug, id))) {
          return { left: { kind: 'group-changed', name: slug } };
        }
        await ignoreGone(
          gh.send(
            'DELETE',
            `/orgs/${org}/teams/${slug}/memberships/${encodeURIComponent(String(ref.login))}`,
          ),
        );
        return;
      }
      // Renamed: the team keeps its id under another slug; it is left under the name it has now.
      if (slug !== String(ref.slug)) return { left: { kind: 'group-renamed', name: slug } };
      // Deleting a team deletes its child teams too: a team that has any is left.
      if (teams.some((t) => String(obj(t.parent).id ?? '') === id)) {
        return { left: { kind: 'group-has-children', name: slug } };
      }
      // The list above may be older than this record's turn (it is read once per Run): just before
      // the delete, the team itself and its children are read again (ADR-0467 round 4).
      if (!(await teamStillIs(ctx, directory, org, slug, id))) {
        return { left: { kind: 'group-changed', name: slug } };
      }
      const children = await gh.list<Json>(`/orgs/${org}/teams/${slug}/teams`);
      if (children.length > 0) {
        directory.invalidateTeams();
        return { left: { kind: 'group-has-children', name: slug } };
      }
      await ignoreGone(gh.send('DELETE', `/orgs/${org}/teams/${slug}`));
      directory.invalidateTeams();
    },
  };
}
