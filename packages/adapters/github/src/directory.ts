/**
 * Resolves canonical principal ids (numeric user and team ids, ADR-0230) to the logins, slugs and
 * GraphQL node ids the API needs, and back. Built from the organization's members, outside
 * collaborators and teams, plus a repository's direct collaborators when asked.
 */
import { type Gh, type Json, obj, repoPath, str } from './gh.ts';

export interface UserInfo {
  readonly id: string;
  readonly login: string;
  readonly nodeId: string;
  readonly isBot: boolean;
}

export interface TeamInfo {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly nodeId: string;
}

export function userInfo(raw: unknown): UserInfo | undefined {
  const u = obj(raw);
  if (typeof u.id !== 'number' || typeof u.login !== 'string') return undefined;
  return {
    id: String(u.id),
    login: u.login,
    nodeId: str(u.node_id),
    isBot: u.type === 'Bot' || u.login.endsWith('[bot]'),
  };
}

export function teamInfo(raw: unknown): TeamInfo | undefined {
  const t = obj(raw);
  if (typeof t.id !== 'number' || typeof t.slug !== 'string') return undefined;
  return { id: String(t.id), slug: t.slug, name: str(t.name) || t.slug, nodeId: str(t.node_id) };
}

export class Directory {
  readonly #gh: Gh;
  readonly #org: string;
  #members?: Promise<UserInfo[]>;
  #admins?: Promise<Set<string>>;
  #outside?: Promise<UserInfo[]>;
  #teamRecords?: Promise<Json[]>;
  #teams?: Promise<TeamInfo[]>;
  readonly #collaborators = new Map<string, Promise<UserInfo[]>>();

  constructor(gh: Gh, org: string) {
    this.#gh = gh;
    this.#org = org;
  }

  members(): Promise<UserInfo[]> {
    this.#members ??= this.#gh
      .list<Json>(`/orgs/${this.#org}/members`)
      .then((l) => l.flatMap((u) => userInfo(u) ?? []));
    return this.#members;
  }

  /** Ids of organization owners. */
  admins(): Promise<Set<string>> {
    this.#admins ??= this.#gh
      .list<Json>(`/orgs/${this.#org}/members`, { role: 'admin' })
      .then((l) => new Set(l.flatMap((u) => userInfo(u)?.id ?? [])));
    return this.#admins;
  }

  outsideCollaborators(): Promise<UserInfo[]> {
    this.#outside ??= this.#gh
      .list<Json>(`/orgs/${this.#org}/outside_collaborators`)
      .then((l) => l.flatMap((u) => userInfo(u) ?? []));
    return this.#outside;
  }

  /** The organization's teams as the provider returned them (parent included). */
  teamRecords(): Promise<Json[]> {
    this.#teamRecords ??= this.#gh.list<Json>(`/orgs/${this.#org}/teams`);
    return this.#teamRecords;
  }

  teams(): Promise<TeamInfo[]> {
    this.#teams ??= this.teamRecords().then((l) => l.flatMap((t) => teamInfo(t) ?? []));
    return this.#teams;
  }

  /** Forgets the team list, after a team was created or deleted. */
  invalidateTeams(): void {
    this.#teamRecords = undefined;
    this.#teams = undefined;
  }

  repoCollaborators(repo: string): Promise<UserInfo[]> {
    let hit = this.#collaborators.get(repo);
    if (!hit) {
      hit = this.#gh
        .list<Json>(`${repoPath(this.#org, repo)}/collaborators`, { affiliation: 'direct' })
        .then((l) => l.flatMap((u) => userInfo(u) ?? []));
      this.#collaborators.set(repo, hit);
    }
    return hit;
  }

  /** Every user the directory knows, for id lookups. */
  async users(repo?: string): Promise<Map<string, UserInfo>> {
    const out = new Map<string, UserInfo>();
    const lists = [await this.members(), await this.outsideCollaborators()];
    if (repo !== undefined) lists.push(await this.repoCollaborators(repo));
    for (const list of lists) for (const u of list) out.set(u.id, u);
    return out;
  }

  async userByLogin(login: string, repo?: string): Promise<UserInfo | undefined> {
    const lower = login.toLowerCase();
    for (const u of (await this.users(repo)).values()) {
      if (u.login.toLowerCase() === lower) return u;
    }
    return undefined;
  }

  async teamBySlug(slug: string): Promise<TeamInfo | undefined> {
    return (await this.teams()).find((t) => t.slug.toLowerCase() === slug.toLowerCase());
  }

  async isMember(id: string): Promise<boolean> {
    return (await this.members()).some((m) => m.id === id);
  }
}
