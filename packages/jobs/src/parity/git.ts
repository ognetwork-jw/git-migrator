/**
 * The two git checks that go beyond the `git-refs` Facet's strict `compare`: LFS parity
 * (FAC-GIT-005) and post-cutover containment (FAC-GIT-006). The provider calls are injected, so
 * everything here goes through the adapter's `ProviderHttpClient` and the quota service
 * (ADP-060). Decisions: docs/adr/0397-parity-git-checks.md.
 */
import { isAdapterError } from '@git-migrator/adapter-sdk';
import { type FieldDiff, parseFieldPath } from '@git-migrator/core';
import { type LfsBatchClient, verifyLfsParity } from '@git-migrator/git';

export type RefRelation = 'identical' | 'ahead' | 'behind' | 'diverged';

interface RefLike {
  readonly name: string;
  readonly target: string;
  readonly peeled?: string;
}
interface RefsDocument {
  readonly refs: readonly RefLike[];
}

/** The commit a ref points at: the peeled commit of an annotated tag, otherwise the target. */
const tip = (ref: RefLike): string => ref.peeled ?? ref.target;

/** The ref name a diff path addresses (`/refs[name=refs/heads/main]/target`), if it addresses one. */
function refNameOf(path: string): string | undefined {
  try {
    const first = parseFieldPath(path)[0];
    return first?.name === 'refs' ? first.key?.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * FAC-GIT-006. The strict diffs of `git-refs` are relaxed: a ref that exists only on the target is
 * allowed, and a ref that differs passes when the target's commit is `identical` to the source's or
 * `ahead` of it (it descends from it). A ref missing on the target, a target that is `behind` or
 * `diverged`, and a commit the target does not know stay as diffs. Diffs that address no ref (the
 * default branch) are kept: containment relaxes refs only.
 *
 * `compare(base, head)` is the target's compare API; an `AdapterError` `not_found` (the target has
 * not got the source's commit) counts as `diverged`.
 */
export async function applyContainment(input: {
  readonly diffs: readonly FieldDiff[];
  readonly desired: RefsDocument;
  readonly actual: RefsDocument;
  readonly compare: (base: string, head: string) => Promise<RefRelation>;
}): Promise<FieldDiff[]> {
  const desired = new Map(input.desired.refs.map((r) => [r.name, r]));
  const actual = new Map(input.actual.refs.map((r) => [r.name, r]));
  const verdicts = new Map<string, boolean>();
  const contained = async (name: string): Promise<boolean> => {
    const cached = verdicts.get(name);
    if (cached !== undefined) return cached;
    const want = desired.get(name);
    const have = actual.get(name);
    let ok: boolean;
    if (want === undefined)
      ok = true; // only on the target: extra target refs are allowed
    else if (have === undefined) ok = false;
    else if (tip(want) === tip(have)) ok = true;
    else {
      let relation: RefRelation;
      try {
        relation = await input.compare(tip(want), tip(have));
      } catch (error) {
        if (!(isAdapterError(error) && error.code === 'not_found')) throw error;
        relation = 'diverged';
      }
      ok = relation === 'identical' || relation === 'ahead';
    }
    verdicts.set(name, ok);
    return ok;
  };
  const kept: FieldDiff[] = [];
  for (const diff of input.diffs) {
    const name = refNameOf(diff.path);
    if (name === undefined || !(await contained(name))) kept.push(diff);
  }
  return kept;
}

/** How many missing object ids one stored diff lists. */
export const MAX_LISTED_OIDS = 100;

export interface LfsCheck {
  readonly checked: number;
  /** One diff at `/lfs/oids` listing (some of) the missing object ids, or none. */
  readonly diffs: FieldDiff[];
}

/**
 * FAC-GIT-005. Every LFS object the source's refs reference MUST be downloadable from the target.
 * `missing` asks the target's LFS batch API (`download` operation) which of the ids it cannot
 * serve; `@git-migrator/git` chunks the objects and interprets the answers. An object the target
 * answers with another error is not known to be missing, so the check throws and the caller reports
 * the Facet `unverifiable` (ADR-0240).
 */
export async function checkLfsObjects(input: {
  readonly objects: readonly { readonly oid: string; readonly size: number }[];
  readonly missing: (oids: string[]) => Promise<readonly string[]>;
}): Promise<LfsCheck> {
  if (input.objects.length === 0) return { checked: 0, diffs: [] };
  const batch: LfsBatchClient = {
    async download(group) {
      const gone = new Set(await input.missing(group.map((o) => o.oid)));
      return group.map((o) =>
        gone.has(o.oid)
          ? { oid: o.oid, error: { code: 404 } }
          : { oid: o.oid, actions: { download: {} } },
      );
    },
  };
  const result = await verifyLfsParity(batch, input.objects);
  if (result.failed.length > 0) {
    throw new Error(`${result.failed.length} LFS objects could not be checked`);
  }
  if (result.missing.length === 0) return { checked: result.checked, diffs: [] };
  const listed = [...result.missing].sort().slice(0, MAX_LISTED_OIDS);
  return {
    checked: result.checked,
    diffs: [{ path: '/lfs/oids', desired: listed, actual: [] }],
  };
}
