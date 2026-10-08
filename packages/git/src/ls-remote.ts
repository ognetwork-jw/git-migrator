/**
 * Parsing of `git ls-remote --symref` output (FAC-GIT-001). Annotated tags are listed twice: the
 * tag object under `refs/tags/x` and the commit it points to as `refs/tags/x^{}`. The result
 * records `sha` as the tag object and `peeled` as the commit.
 */
import type { GitLsRemoteResult, GitRemoteRef } from '@git-migrator/adapter-sdk';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function parseLsRemote(output: string): GitLsRemoteResult {
  const refs = new Map<string, { sha: string; peeled?: string }>();
  let headSymref: string | undefined;
  const peeledLines: [string, string][] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (line.startsWith('ref: ')) {
      const [target, name] = line.slice(5).split('\t');
      if (name === 'HEAD' && target) headSymref = target;
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const sha = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (!SHA.test(sha) || name === 'HEAD' || !name.startsWith('refs/')) continue;
    if (name.endsWith('^{}')) peeledLines.push([name.slice(0, -3), sha]);
    else refs.set(name, { sha });
  }
  for (const [name, peeled] of peeledLines) {
    const ref = refs.get(name);
    if (ref !== undefined) ref.peeled = peeled;
  }
  const list: GitRemoteRef[] = [...refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, ref]) => ({
      name,
      sha: ref.sha,
      ...(ref.peeled !== undefined ? { peeled: ref.peeled } : {}),
    }));
  return { refs: list, ...(headSymref !== undefined ? { headSymref } : {}) };
}
