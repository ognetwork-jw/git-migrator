/**
 * The bitbucket-cloud to github pipelines translation (FAC-PIP-002): pipeline YAML text in,
 * workflow files and the YAML paths that were not translated out. Pure and deterministic.
 *
 * Safety (docs/adr/0161-pipelines-translation-safety.md): a source value reaches the output only
 * through the checks in `safe.ts`. Nothing from the source is placed inside a `${{ }}` expression
 * or built into a `run:` line. Built-in and repository variables reach scripts as `env:` entries
 * on the job, so the shell reads them as data. Actions are pinned to commit SHAs and each
 * workflow asks for `contents: read` only.
 *
 * Shape (docs/adr/0162-pipelines-translation-structure.md): one workflow per pipeline, one job per
 * step, stages chained by `needs`.
 */
import { type Document, isMap, isScalar, parseDocument, Scalar, stringify, visit } from 'yaml';
import {
  ACTIONS,
  builtInVariable,
  DEFAULT_LOCKFILES,
  DEPLOYMENT_VARIABLE,
  DROPPED_CACHES,
  globRelation,
  MAX_ARTIFACT_GLOBS,
  MAX_CACHES_PER_STEP,
  MAX_EXCLUSIONS,
  MAX_JOBS_PER_WORKFLOW,
  MAX_LIST_ENTRIES,
  MAX_PATTERNS,
  MAX_REPORTS,
  MAX_SCRIPT_ENTRIES,
  MAX_SERVICES_PER_STEP,
  MAX_TEXT_BUDGET,
  MAX_TOTAL_JOBS,
  MAX_WORKFLOW_BYTES,
  PREDEFINED_CACHES,
  REASONS,
  RUNNER,
  SERVICE_PORTS,
  SOURCE_FILE,
  type Trigger,
  WORKFLOW_DIR,
  WORKFLOW_ESTIMATE_LIMIT,
} from './constants.ts';
import { resolveVariable, type VariableNames } from './names.ts';
import {
  indexPath,
  isIdentifier,
  isMapping,
  isSafeGlob,
  isSafeHashGlob,
  isSafeImage,
  isSafeLine,
  isSafeName,
  isSafeText,
  isWord,
  keyPath,
  type Mapping,
  own,
  printable,
  slug,
  variableReferences,
  wholeReference,
} from './safe.ts';

export interface Unsupported {
  /** YAML path in the source file. */
  readonly path: string;
  readonly reason: string;
}

export interface Workflow {
  readonly path: string;
  readonly content: string;
}

export interface YamlTranslation {
  readonly workflows: Workflow[];
  readonly unsupported: Unsupported[];
}

/** Input limit: larger files are reported as not translated. */
export const MAX_SOURCE_LENGTH = 1_000_000;
const MAX_ALIASES = 100;

type Out = Map<string, unknown>;

/** A mapping that keeps insertion order and skips undefined values. */
function obj(...pairs: [string, unknown][]): Out {
  const out: Out = new Map();
  for (const [k, v] of pairs) if (v !== undefined) out.set(k, v);
  return out;
}

function pinned(action: { uses: string; version: string }): Scalar {
  const s = new Scalar(action.uses);
  s.comment = ` ${action.version}`;
  return s;
}

const STEP_KEYS = new Set([
  'name',
  'script',
  'after-script',
  'max-time',
  'clone',
  'caches',
  'artifacts',
  'deployment',
  'services',
  'image',
]);
const STEP_REASONS: Readonly<Record<string, string>> = {
  trigger: REASONS.gated,
  condition: REASONS.gated,
  oidc: REASONS.oidc,
  'runs-on': REASONS.runner,
  size: REASONS.runner,
};
const PIPELINES_REASONS: Readonly<Record<string, string>> = {
  'pull-requests': REASONS.pullRequests,
};
const KNOWN_PIPELINES = new Set(['default', 'branches', 'tags', 'custom']);

function reasonFor(table: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(table, key) ? (table[key] as string) : REASONS.generic;
}

interface JobInfo {
  readonly id: string;
  readonly artifacts: boolean;
  /** Steps before the job's own work: the checkout and the cache restores. */
  readonly setup: number;
}

interface Pending {
  readonly path: string;
  readonly title: string;
  readonly scope: string;
  readonly on: Out;
  readonly jobs: Out;
}

interface Binding {
  readonly env: Map<string, string>;
  /** Variables that the script sets itself (the container case of BITBUCKET_CLONE_DIR). */
  readonly exports: Set<string>;
  readonly container: boolean;
}

/** True when a node (a stage, which is not translated) holds a step that waits for approval. */
/** True when a mapping repeats a scalar key (linear in the size of the document). */
function hasDuplicateKeys(doc: Document): boolean {
  let duplicate = false;
  visit(doc, {
    Map(_key, map) {
      const seen = new Set<unknown>();
      for (const pair of map.items) {
        if (!isScalar(pair.key)) continue;
        const k = pair.key.value;
        if (seen.has(k)) {
          duplicate = true;
          return visit.BREAK;
        }
        seen.add(k);
      }
      return undefined;
    },
  });
  return duplicate;
}

/** The number of characters a value will take in the serialized workflow (keys, strings, numbers). */
function approxSize(node: unknown): number {
  if (typeof node === 'string') return node.length + 4;
  if (node instanceof Scalar) return String(node.value).length + 4;
  if (Array.isArray(node)) return node.reduce((n: number, v) => n + 4 + approxSize(v), 0);
  if (node instanceof Map) {
    let n = 0;
    for (const [k, v] of node) n += String(k).length + 4 + approxSize(v);
    return n;
  }
  return 8;
}

function hasGate(node: unknown): boolean {
  let seen = 0;
  const walk = (n: unknown, depth: number): boolean => {
    if (++seen > 10_000 || depth > 12) return true; // too deep to inspect: assume a gate
    if (Array.isArray(n)) return n.some((v) => walk(v, depth + 1));
    if (isMapping(n)) {
      const t = own(n, 'trigger');
      if (t !== undefined && t !== 'automatic') return true;
      return Object.values(n).some((v) => walk(v, depth + 1));
    }
    return false;
  };
  return walk(node, 0);
}

class Translator {
  private readonly unsupported = new Map<string, string>();
  private readonly names: VariableNames;
  private globalImage: unknown;
  private definitions: Mapping = {};
  private readonly usedPaths = new Set<string>();
  private trigger: Trigger = 'default';
  /** Set by a step that waits for approval: later items of the pipeline must not run unattended. */
  private gate = false;
  private jobTotal = 0;
  private textBudget = MAX_TEXT_BUDGET;
  private overflow = false;
  /** Running estimate of the size of the workflow being built (checked before each step). */
  private bytes = 0;
  private doc: Document | undefined;

  constructor(names: VariableNames) {
    this.names = names;
  }

  report(path: string, reason: string): void {
    // Paths and reasons are quoted into comments and findings: nothing in them may read as an expression.
    const clean = (text: string, max?: number) => printable(text, max).replaceAll('${{', '$ {{');
    const p = clean(path);
    if (this.unsupported.has(p)) return;
    if (this.unsupported.size >= MAX_REPORTS) this.overflow = true;
    else this.unsupported.set(p, clean(reason, 200));
  }

  run(text: string): YamlTranslation {
    const parsed = this.parse(text);
    if (parsed === undefined) return this.finish([]);

    for (const key of this.keysOf(parsed, '')) {
      if (!['image', 'definitions', 'pipelines'].includes(key)) {
        this.report(keyPath('', key), REASONS.generic);
      }
    }
    this.globalImage = own(parsed, 'image');
    const defs = own(parsed, 'definitions');
    if (isMapping(defs)) {
      this.definitions = defs;
      for (const key of this.keysOf(defs, 'definitions')) {
        // `steps` only holds anchors, which are resolved before translation.
        if (!['caches', 'services', 'steps'].includes(key)) {
          this.report(keyPath('definitions', key), REASONS.generic);
        }
      }
    } else if (defs !== undefined) {
      this.report('definitions', REASONS.generic);
    }

    const pipelines = own(parsed, 'pipelines');
    if (!isMapping(pipelines)) {
      this.report('pipelines', 'no pipelines section to translate');
      return this.finish([]);
    }
    if (Object.keys(pipelines).length === 0) this.report('pipelines', 'it defines no pipeline');
    const pending = this.pipelines(pipelines);
    if (pending.length === 0 && this.unsupported.size === 0) {
      this.report(SOURCE_FILE, 'no workflow could be generated');
    }
    return this.finish(pending);
  }

  private parse(text: string): Mapping | undefined {
    if (text.length > MAX_SOURCE_LENGTH) {
      this.report(SOURCE_FILE, 'the file is too large to translate');
      return undefined;
    }
    try {
      const doc = parseDocument(text, { merge: true, strict: true, uniqueKeys: false });
      // The library's own duplicate-key check is quadratic in the size of a mapping.
      if (doc.errors.length > 0 || doc.warnings.length > 0 || hasDuplicateKeys(doc)) {
        this.report(SOURCE_FILE, 'the file is not valid YAML');
        return undefined;
      }
      const value: unknown = doc.toJS({ maxAliasCount: MAX_ALIASES });
      this.doc = doc;
      if (!isMapping(value)) {
        this.report(SOURCE_FILE, 'the file is not a mapping');
        return undefined;
      }
      return value;
    } catch {
      this.report(SOURCE_FILE, 'the file could not be parsed (for example too many aliases)');
      return undefined;
    }
  }

  /**
   * The first `max` entries of a list; the rest is reported once and never looked at. With `scan`
   * the dropped tail is searched for a step that waits for approval, because whatever comes after
   * the list would otherwise run without it.
   */
  private limit<T>(list: readonly T[], max: number, path: string, scan = false): readonly T[] {
    if (list.length <= max) return list;
    this.report(indexPath(path, max), REASONS.tooMany);
    if (scan && hasGate(list.slice(max))) this.gate = true;
    return list.slice(0, max);
  }

  /** The first `max` keys of a mapping, with the same rules as `limit`. */
  private keysOf(map: Mapping, path: string, scan = false, max = MAX_LIST_ENTRIES): string[] {
    const keys = Object.keys(map);
    if (keys.length <= max) return keys;
    this.report(indexPath(path, max), REASONS.tooMany);
    if (scan && hasGate(keys.slice(max).map((k) => own(map, k)))) this.gate = true;
    return keys.slice(0, max);
  }

  /** Set when the document order of the last `orderedKeys` call could not be read. */
  private orderUnknown = false;

  /**
   * The keys of a mapping under `pipelines` in file order. `Object.keys` puts integer-like keys
   * first, so the order is read from the parsed document when it can be.
   */
  private orderedKeys(map: Mapping, section: string): string[] {
    const keys = Object.keys(map);
    this.orderUnknown = true;
    const node = this.doc?.getIn(['pipelines', section], true);
    if (isMap(node)) {
      const fromDoc = node.items.map((p) => (isScalar(p.key) ? String(p.key.value) : undefined));
      const known = new Set(keys);
      if (fromDoc.length === keys.length && fromDoc.every((k) => k !== undefined && known.has(k))) {
        this.orderUnknown = false;
        return fromDoc as string[];
      }
    }
    return keys;
  }

  /** Charges `n` characters to the file-wide text budget; false when it is used up. */
  private spend(n: number): boolean {
    this.textBudget -= n;
    return this.textBudget >= 0;
  }

  // -- pipelines and triggers ------------------------------------------------------------------

  private pipelines(pipelines: Mapping): Pending[] {
    const pending: Pending[] = [];
    const branchGlobs: string[] = [];
    const branches = own(pipelines, 'branches');
    if (isMapping(branches)) {
      for (const glob of this.orderedKeys(branches, 'branches')) {
        if (isSafeGlob(glob) && branchGlobs.length < MAX_EXCLUSIONS) branchGlobs.push(glob);
      }
    }

    for (const key of this.keysOf(pipelines, 'pipelines')) {
      if (!KNOWN_PIPELINES.has(key)) {
        this.report(keyPath('pipelines', key), reasonFor(PIPELINES_REASONS, key));
      }
    }

    const def = own(pipelines, 'default');
    if (def !== undefined) {
      const base = 'pipelines.default';
      const jobs = this.items(def, base, 'default');
      if (jobs !== undefined) {
        pending.push({
          path: this.workflowPath('ci'),
          title: 'Default',
          scope: base,
          on: obj(
            ['push', obj(['branches', ['**', ...branchGlobs.map((g) => `!${g}`)]])],
            ['pull_request', new Map()],
          ),
          jobs,
        });
      }
    }

    for (const [kind, section, trigger] of [
      ['branch', 'branches', 'branches'],
      ['tag', 'tags', 'tags'],
    ] as const) {
      const group = own(pipelines, section);
      if (group === undefined) continue;
      const base = `pipelines.${section}`;
      if (!isMapping(group) || Object.keys(group).length === 0) {
        this.report(base, REASONS.generic);
        continue;
      }
      const keys = this.orderedKeys(group, section);
      const examined = this.limit(keys, MAX_PATTERNS, base);
      const globs = examined.filter(isSafeGlob);
      const order = new Map(globs.map((g, i) => [g, i]));
      // Integer-like keys lose their place in `Object.keys`: if the document order is not known,
      // they are compared as if either could come first.
      const unordered = (g: string) => this.orderUnknown && /^(0|[1-9][0-9]*)$/.test(g);
      for (const glob of examined) {
        const path = keyPath(base, glob);
        if (!isSafeGlob(glob)) {
          this.report(path, REASONS.unsafe);
          continue;
        }
        const jobs = this.items(own(group, glob), path, kind);
        if (jobs === undefined) continue;
        // A ref that also matches a more specific pattern runs that pipeline only.
        const excluded: string[] = [];
        for (const other of globs) {
          if (other === glob) continue;
          const relation = globRelation(glob, other);
          if (relation === 'covers') {
            excluded.push(`!${other}`);
            // The broader pattern is listed first: if the source picks by file order, the
            // narrower pipeline would be the one that never runs. Which rule applies is unconfirmed.
            if (
              (order.get(glob) ?? 0) < (order.get(other) ?? 0) ||
              unordered(glob) ||
              unordered(other)
            ) {
              this.report(path, `${REASONS.fileOrder}: ${other}`);
              this.report(keyPath(base, other), `${REASONS.fileOrder}: ${glob}`);
            }
          } else if (relation === 'unknown') {
            this.report(path, `${REASONS.overlap}: ${other}`);
            this.report(keyPath(base, other), `${REASONS.overlap}: ${glob}`);
          }
        }
        // Exclusions are part of the output: bounded and charged, and a workflow that would need
        // more than the bound is not written (it would run on refs that belong to another pipeline).
        const cost = excluded.reduce((n, e) => n + e.length, 0);
        if (excluded.length > MAX_EXCLUSIONS || !this.spend(cost)) {
          this.report(path, REASONS.tooMany);
          continue;
        }
        pending.push({
          path: this.workflowPath(`${kind}-${slug(glob)}`),
          title: `${kind === 'branch' ? 'Branch' : 'Tag'} ${glob}`,
          scope: path,
          on: obj(['push', obj([trigger, [glob, ...excluded]])]),
          jobs,
        });
      }
    }

    const custom = own(pipelines, 'custom');
    if (custom !== undefined) {
      const base = 'pipelines.custom';
      if (!isMapping(custom)) this.report(base, REASONS.generic);
      else {
        for (const name of this.limit(this.orderedKeys(custom, 'custom'), MAX_PATTERNS, base)) {
          const path = keyPath(base, name);
          if (!isSafeLine(name)) {
            this.report(path, REASONS.expression);
            continue;
          }
          const jobs = this.items(own(custom, name), path, 'custom');
          if (jobs === undefined) continue;
          pending.push({
            path: this.workflowPath(`custom-${slug(name)}`),
            title: `Custom ${printable(name, 80)}`,
            scope: path,
            on: obj(['workflow_dispatch', new Map()]),
            jobs,
          });
        }
      }
    }
    return pending;
  }

  private workflowPath(base: string): string {
    let candidate = `${WORKFLOW_DIR}/${base}.yml`;
    for (let n = 2; this.usedPaths.has(candidate); n++)
      candidate = `${WORKFLOW_DIR}/${base}-${n}.yml`;
    this.usedPaths.add(candidate);
    return candidate;
  }

  // -- steps, stages and jobs ------------------------------------------------------------------

  /** The jobs of one pipeline, or undefined when it holds no translatable step. */
  private items(raw: unknown, path: string, trigger: Trigger): Out | undefined {
    if (!Array.isArray(raw) || raw.length === 0) {
      this.report(path, Array.isArray(raw) ? 'the pipeline has no steps' : REASONS.generic);
      return undefined;
    }
    this.trigger = trigger;
    this.gate = false;
    this.bytes = 0;
    const jobs: Out = new Map();
    const stages: JobInfo[][] = [];
    let counter = 0;

    const addStep = (step: unknown, stepPath: string): JobInfo | undefined => {
      if (counter >= MAX_JOBS_PER_WORKFLOW || this.jobTotal >= MAX_TOTAL_JOBS) {
        this.report(stepPath, REASONS.tooMany);
        return undefined;
      }
      if (this.bytes > WORKFLOW_ESTIMATE_LIMIT) {
        this.report(stepPath, REASONS.tooLarge);
        return undefined;
      }
      const id = `step-${counter + 1}`;
      const built = this.step(step, stepPath, id);
      if (built === undefined) return undefined;
      if (this.bytes + built.size > WORKFLOW_ESTIMATE_LIMIT) {
        this.report(stepPath, REASONS.tooLarge);
        return undefined;
      }
      counter++;
      this.jobTotal++;
      this.bytes += built.size;
      jobs.set(id, built.job);
      return { id, artifacts: built.artifacts, setup: built.setup };
    };

    let halted = false;
    raw.forEach((item, i) => {
      const itemPath = indexPath(path, i);
      if (halted) {
        // Everything after an approval gate would run without the approval.
        this.report(itemPath, REASONS.afterGate);
        return;
      }
      if (!isMapping(item)) {
        this.report(itemPath, REASONS.generic);
        return;
      }
      for (const key of this.keysOf(item, itemPath, true)) {
        const keyed = keyPath(itemPath, key);
        if (this.gate) {
          // A sibling key of a gated one would also run without the approval.
          this.report(keyed, REASONS.afterGate);
          continue;
        }
        if (key === 'step') {
          const job = addStep(own(item, key), keyed);
          if (job !== undefined) stages.push([job]);
        } else if (key === 'parallel') {
          const group = this.parallel(own(item, key), keyed, addStep);
          if (group.length > 0) stages.push(group);
        } else if (key === 'stage') {
          this.report(keyed, REASONS.stages);
          if (hasGate(own(item, key))) this.gate = true;
        } else if (key === 'variables') {
          this.report(keyed, 'prompted variables of custom pipelines have no equivalent');
        } else {
          this.report(keyed, REASONS.generic);
          if (hasGate(own(item, key))) this.gate = true;
        }
      }
      if (this.gate) halted = true;
    });
    // `needs` can only be known once the stages are: rebuild it from the recorded structure.
    this.chain(jobs, stages);
    return jobs.size === 0 ? undefined : jobs;
  }

  private parallel(
    raw: unknown,
    path: string,
    add: (step: unknown, path: string) => JobInfo | undefined,
  ): JobInfo[] {
    let list: unknown = raw;
    let listPath = path;
    if (isMapping(raw)) {
      for (const key of this.keysOf(raw, path, true)) {
        if (key === 'steps') continue;
        this.report(keyPath(path, key), REASONS.generic);
        if (hasGate(own(raw, key))) this.gate = true;
      }
      list = own(raw, 'steps');
      listPath = keyPath(path, 'steps');
    }
    if (!Array.isArray(list)) {
      this.report(path, REASONS.generic);
      return [];
    }
    const group: JobInfo[] = [];
    this.limit(list, MAX_LIST_ENTRIES, listPath, true).forEach((member, i) => {
      const memberPath = indexPath(listPath, i);
      if (!isMapping(member)) {
        this.report(memberPath, REASONS.generic);
        return;
      }
      for (const key of this.keysOf(member, memberPath, true)) {
        const keyed = keyPath(memberPath, key);
        if (key === 'step') {
          const job = add(own(member, key), keyed);
          if (job !== undefined) group.push(job);
        } else {
          this.report(keyed, key === 'stage' ? REASONS.stages : REASONS.generic);
          if (hasGate(own(member, key))) this.gate = true;
        }
      }
    });
    return group;
  }

  /** Sets `needs` (and the artifact downloads) of every job from the final stage structure. */
  private chain(jobs: Out, stages: JobInfo[][]): void {
    stages.forEach((stage, index) => {
      const previous = stages[index - 1] ?? [];
      const producers = stages
        .slice(0, index)
        .flat()
        .filter((j) => j.artifacts);
      for (const info of stage) {
        const job = jobs.get(info.id) as Out;
        const rebuilt: Out = new Map();
        for (const [k, v] of job) {
          if (k === 'runs-on') {
            rebuilt.set(k, v);
            if (previous.length > 0)
              rebuilt.set(
                'needs',
                previous.map((p) => p.id),
              );
          } else if (k === 'steps') {
            const steps = v as Out[];
            const downloads = producers.map((p) =>
              obj(
                ['name', `Download artifacts of ${p.id}`],
                ['uses', pinned(ACTIONS.downloadArtifact)],
                ['with', obj(['name', `artifact-${p.id}`])],
              ),
            );
            // Downloads go after the checkout and the cache restores.
            rebuilt.set(k, [
              ...steps.slice(0, info.setup),
              ...downloads,
              ...steps.slice(info.setup),
            ]);
          } else rebuilt.set(k, v);
        }
        jobs.set(info.id, rebuilt);
      }
    });
  }

  private step(
    raw: unknown,
    path: string,
    id: string,
  ): { job: Out; artifacts: boolean; setup: number; size: number } | undefined {
    if (!isMapping(raw)) {
      this.report(path, REASONS.generic);
      return undefined;
    }
    // A step that is gated (manual, conditional) must not run unconditionally: it is not generated.
    let gated = false;
    // The gate keys are read directly, so a long key list cannot hide them.
    const trigger = own(raw, 'trigger');
    if (trigger !== undefined && trigger !== 'automatic') {
      gated = true;
      this.gate = true;
    }
    if (own(raw, 'condition') !== undefined) gated = true;
    for (const key of this.keysOf(raw, path)) {
      if (STEP_KEYS.has(key) || (key === 'trigger' && trigger === 'automatic')) continue;
      this.report(keyPath(path, key), reasonFor(STEP_REASONS, key));
    }
    if (gated) return undefined;

    let environment: string | undefined;
    const deployment = own(raw, 'deployment');
    if (deployment !== undefined) {
      if (isSafeName(deployment)) environment = deployment;
      else this.report(keyPath(path, 'deployment'), REASONS.unsafe);
    }

    const scriptPath = keyPath(path, 'script');
    const scriptRaw = own(raw, 'script');
    if (!Array.isArray(scriptRaw) || scriptRaw.length === 0) {
      this.report(scriptPath, 'a step needs a non-empty script list');
      return undefined;
    }
    const image = this.image(
      own(raw, 'image') ?? this.globalImage,
      own(raw, 'image') === undefined ? 'image' : keyPath(path, 'image'),
      environment,
    );
    const env: Map<string, string> = new Map();
    const binding: Binding = { env, exports: new Set(), container: image !== undefined };
    const script = this.scriptLines(scriptRaw, scriptPath, environment, binding);
    if (script.length === 0) {
      this.report(scriptPath, 'no script entry could be translated, so the step is not generated');
      return undefined;
    }
    const afterRaw = own(raw, 'after-script');
    const afterPath = keyPath(path, 'after-script');
    let after: string[] = [];
    if (Array.isArray(afterRaw))
      after = this.scriptLines(afterRaw, afterPath, environment, binding);
    else if (afterRaw !== undefined) this.report(afterPath, REASONS.generic);

    if (binding.exports.has('BITBUCKET_CLONE_DIR')) {
      // A job in a container sees the workspace at another path: the shell reads it from the runner.
      const line = 'export BITBUCKET_CLONE_DIR="$GITHUB_WORKSPACE"';
      script.unshift(line);
      if (after.length > 0) after.unshift(line);
    }

    const steps: Out[] = [];
    steps.push(this.checkout(raw, path));
    for (const cache of this.caches(own(raw, 'caches'), keyPath(path, 'caches'))) steps.push(cache);
    const setup = steps.length;
    if (script.length > 0) steps.push(obj(['name', 'Script'], ['run', script.join('\n')]));
    const artifacts = this.artifactPaths(own(raw, 'artifacts'), keyPath(path, 'artifacts'));
    if (artifacts.length > 0) {
      steps.push(
        obj(
          ['name', 'Upload artifacts'],
          ['uses', pinned(ACTIONS.uploadArtifact)],
          [
            'with',
            obj(
              ['name', `artifact-${id}`],
              ['path', artifacts.join('\n')],
              ['if-no-files-found', 'error'],
            ),
          ],
        ),
      );
    }
    if (after.length > 0) {
      steps.push(obj(['name', 'After script'], ['if', 'always()'], ['run', after.join('\n')]));
    }

    let name: string | undefined;
    const rawName = own(raw, 'name');
    if (rawName !== undefined) {
      if (isSafeLine(rawName)) name = rawName;
      else this.report(keyPath(path, 'name'), REASONS.unsafe);
    }
    let timeout: number | undefined;
    const maxTime = own(raw, 'max-time');
    if (maxTime !== undefined) {
      if (
        typeof maxTime === 'number' &&
        Number.isInteger(maxTime) &&
        maxTime >= 1 &&
        maxTime <= 1440
      ) {
        timeout = maxTime;
      } else this.report(keyPath(path, 'max-time'), REASONS.unsafe);
    }

    const services = this.services(
      own(raw, 'services'),
      keyPath(path, 'services'),
      image !== undefined,
    );

    const job = obj(
      ['name', name],
      ['runs-on', RUNNER],
      ['timeout-minutes', timeout],
      ['environment', environment],
      ['container', image],
      ['services', services],
      ['env', env.size > 0 ? env : undefined],
      ['steps', steps],
    );
    const size = approxSize(job);
    return { job, artifacts: artifacts.length > 0, setup, size };
  }

  private checkout(step: Mapping, path: string): Out {
    const withs: Out = obj(['persist-credentials', false]);
    const clone = own(step, 'clone');
    if (clone !== undefined) {
      const clonePath = keyPath(path, 'clone');
      if (!isMapping(clone)) this.report(clonePath, REASONS.generic);
      else {
        for (const key of this.keysOf(clone, clonePath)) {
          if (key !== 'depth') this.report(keyPath(clonePath, key), REASONS.generic);
        }
        const depth = own(clone, 'depth');
        if (depth === 'full') withs.set('fetch-depth', 0);
        else if (typeof depth === 'number' && Number.isInteger(depth) && depth >= 1) {
          withs.set('fetch-depth', depth);
        } else if (depth !== undefined) this.report(keyPath(clonePath, 'depth'), REASONS.unsafe);
      }
    }
    return obj(['uses', pinned(ACTIONS.checkout)], ['with', withs]);
  }

  /** Script lines that are safe to run, binding the variables they reference into `env`. */
  private scriptLines(
    entries: unknown[],
    path: string,
    environment: string | undefined,
    binding: Binding,
  ): string[] {
    const lines: string[] = [];
    this.limit(entries, MAX_SCRIPT_ENTRIES, path).forEach((entry, i) => {
      const entryPath = indexPath(path, i);
      if (typeof entry === 'string') {
        if (!isSafeText(entry)) {
          this.report(entryPath, REASONS.expression);
          return;
        }
        const line = entry.replace(/\n+$/, '');
        if (line.trim() === '') return;
        if (!this.spend(line.length)) {
          this.report(entryPath, REASONS.tooMany);
          return;
        }
        this.bind(line, entryPath, environment, binding);
        lines.push(line);
      } else if (isMapping(entry)) {
        if (Object.hasOwn(entry, 'pipe')) this.report(keyPath(entryPath, 'pipe'), REASONS.pipe);
        else this.report(entryPath, REASONS.scriptEntry);
      } else {
        this.report(entryPath, REASONS.scriptEntry);
      }
    });
    return lines;
  }

  /** Maps the variables a script line reads onto job `env:` entries (the shell reads them as data). */
  private bind(
    line: string,
    path: string,
    environment: string | undefined,
    binding: Binding,
  ): void {
    const { env } = binding;
    for (const name of variableReferences(line)) {
      if (name === DEPLOYMENT_VARIABLE) {
        if (environment === undefined) {
          this.report(path, `${name} needs a deployment environment on the step`);
        } else env.set(name, environment);
      } else if (name.startsWith('BITBUCKET_')) {
        const built = builtInVariable(name, this.trigger);
        if (built === undefined) this.report(path, `${REASONS.variable}: ${name}`);
        else if (built === 'unset') this.report(path, `${name} is unset in this trigger`);
        else if (name === 'BITBUCKET_CLONE_DIR' && binding.container) binding.exports.add(name);
        else env.set(name, built);
      } else {
        const expression = resolveVariable(this.names, name, environment);
        if (expression !== undefined) env.set(name, expression);
      }
    }
  }

  // -- image, services, caches, artifacts ------------------------------------------------------

  private image(raw: unknown, path: string, environment: string | undefined): Out | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw === 'string') {
      if (isSafeImage(raw)) return obj(['image', raw]);
      this.report(path, REASONS.unsafe);
      return undefined;
    }
    if (!isMapping(raw)) {
      this.report(path, REASONS.generic);
      return undefined;
    }
    for (const key of this.keysOf(raw, path)) {
      if (!['name', 'username', 'password'].includes(key)) {
        this.report(keyPath(path, key), REASONS.generic);
      }
    }
    const name = own(raw, 'name');
    if (!isSafeImage(name)) {
      this.report(keyPath(path, 'name'), REASONS.unsafe);
      return undefined;
    }
    const credential = (field: 'username' | 'password'): string | undefined => {
      const value = own(raw, field);
      if (value === undefined) return undefined;
      const fieldPath = keyPath(path, field);
      const reference = wholeReference(value);
      const expression =
        reference === undefined ? undefined : resolveVariable(this.names, reference, environment);
      if (expression === undefined) {
        this.report(fieldPath, 'credentials must reference a known variable');
      }
      return expression;
    };
    const username = credential('username');
    const password = credential('password');
    const credentials =
      username !== undefined && password !== undefined
        ? obj(['username', username], ['password', password])
        : undefined;
    return obj(['image', name], ['credentials', credentials]);
  }

  private services(raw: unknown, path: string, inContainer: boolean): Out | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      this.report(path, REASONS.generic);
      return undefined;
    }
    const services: Out = new Map();
    const defined = isMapping(this.definitions) ? own(this.definitions, 'services') : undefined;
    const seen = new Set<unknown>();
    this.limit(raw, MAX_LIST_ENTRIES, path).forEach((entry, i) => {
      const entryPath = indexPath(path, i);
      if (entry === 'docker' || seen.has(entry)) return; // dropped: the runner has Docker
      if (seen.size >= MAX_SERVICES_PER_STEP) {
        this.report(entryPath, REASONS.tooMany);
        return;
      }
      seen.add(entry);
      if (!isWord(entry)) {
        this.report(entryPath, REASONS.unsafe);
        return;
      }
      const defPath = keyPath('definitions.services', entry);
      const def = isMapping(defined) ? own(defined, entry) : undefined;
      if (!isMapping(def)) {
        this.report(entryPath, 'the service is not defined in definitions.services');
        return;
      }
      const unknownKeys = this.keysOf(def, defPath).filter(
        (k) => k !== 'image' && k !== 'variables',
      );
      if (unknownKeys.length > 0) {
        this.report(entryPath, REASONS.service);
        for (const k of unknownKeys) this.report(keyPath(defPath, k), REASONS.service);
        return;
      }
      const image = own(def, 'image');
      if (!isSafeImage(image)) {
        this.report(entryPath, REASONS.service);
        this.report(keyPath(defPath, 'image'), REASONS.unsafe);
        return;
      }
      const env = this.serviceEnv(own(def, 'variables'), keyPath(defPath, 'variables'));
      const port = SERVICE_PORTS[baseImage(image)];
      services.set(
        entry,
        obj(
          ['image', image],
          ['env', env.size > 0 ? env : undefined],
          ['ports', port === undefined || inContainer ? undefined : [`${port}:${port}`]],
        ),
      );
    });
    return services.size === 0 ? undefined : services;
  }

  private serviceEnv(raw: unknown, path: string): Out {
    const env: Out = new Map();
    if (raw === undefined) return env;
    if (!isMapping(raw)) {
      this.report(path, REASONS.generic);
      return env;
    }
    for (const key of this.limit(Object.keys(raw), MAX_LIST_ENTRIES, path)) {
      const keyed = keyPath(path, key);
      const value = own(raw, key);
      if (!isIdentifier(key) || !['string', 'number', 'boolean'].includes(typeof value)) {
        this.report(keyed, REASONS.unsafe);
        continue;
      }
      const reference = wholeReference(value);
      if (reference !== undefined) {
        const expression = resolveVariable(this.names, reference, undefined);
        if (expression === undefined)
          this.report(keyed, 'the value references an unknown variable');
        else env.set(key, expression);
      } else if (isSafeText(String(value)) && this.spend(String(value).length)) {
        env.set(key, String(value));
      } else this.report(keyed, REASONS.expression);
    }
    return env;
  }

  private caches(raw: unknown, path: string): Out[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      this.report(path, REASONS.generic);
      return [];
    }
    const steps: Out[] = [];
    const custom = isMapping(this.definitions) ? own(this.definitions, 'caches') : undefined;
    const seen = new Set<string>();
    this.limit(raw, MAX_LIST_ENTRIES, path).forEach((entry, i) => {
      const entryPath = indexPath(path, i);
      if (!isWord(entry)) {
        this.report(entryPath, REASONS.unsafe);
        return;
      }
      if (DROPPED_CACHES.includes(entry) || seen.has(entry)) return;
      if (seen.size >= MAX_CACHES_PER_STEP) {
        this.report(entryPath, REASONS.tooMany);
        return;
      }
      seen.add(entry);
      let cachePath: string;
      let files: readonly string[];
      if (Object.hasOwn(PREDEFINED_CACHES, entry)) {
        const predefined = PREDEFINED_CACHES[entry] as (typeof PREDEFINED_CACHES)[string];
        cachePath = predefined.path;
        files = predefined.files;
      } else {
        const resolved = this.customCache(
          isMapping(custom) ? own(custom, entry) : undefined,
          entry,
        );
        if (resolved === undefined) {
          this.report(entryPath, 'the cache is not predefined or defined in definitions.caches');
          return;
        }
        cachePath = resolved.path;
        files = resolved.files;
      }
      const key = `\${{ runner.os }}-${entry}-\${{ hashFiles(${files.map((f) => `'${f}'`).join(', ')}) }}`;
      if (!this.spend(key.length + cachePath.length)) {
        this.report(entryPath, REASONS.tooMany);
        return;
      }
      steps.push(
        obj(
          ['name', `Cache ${entry}`],
          ['uses', pinned(ACTIONS.cache)],
          ['with', obj(['path', cachePath], ['key', key])],
        ),
      );
    });
    return steps;
  }

  private customCache(
    def: unknown,
    name: string,
  ): { path: string; files: readonly string[] } | undefined {
    const defPath = keyPath('definitions.caches', name);
    if (def === undefined) return undefined;
    let path: unknown = def;
    let files: readonly string[] = DEFAULT_LOCKFILES;
    if (isMapping(def)) {
      for (const key of this.keysOf(def, defPath)) {
        if (key !== 'path' && key !== 'key') this.report(keyPath(defPath, key), REASONS.generic);
      }
      path = own(def, 'path');
      const key = own(def, 'key');
      if (key !== undefined) {
        const keyed = keyPath(defPath, 'key');
        const list = isMapping(key) ? own(key, 'files') : undefined;
        if (isMapping(key)) {
          for (const k of this.keysOf(key, keyed))
            if (k !== 'files') this.report(keyPath(keyed, k), REASONS.generic);
        }
        if (
          Array.isArray(list) &&
          list.length > 0 &&
          list.length <= MAX_ARTIFACT_GLOBS &&
          list.every(isSafeHashGlob)
        ) {
          files = list;
        } else this.report(keyPath(keyed, 'files'), REASONS.unsafe);
      }
    }
    if (!isSafeLine(path)) {
      this.report(keyPath(defPath, 'path'), REASONS.unsafe);
      return undefined;
    }
    return { path, files };
  }

  private artifactPaths(raw: unknown, path: string): string[] {
    if (raw === undefined) return [];
    let list: unknown = raw;
    let listPath = path;
    if (isMapping(raw)) {
      for (const key of this.keysOf(raw, path)) {
        if (key !== 'paths' && key !== 'download') this.report(keyPath(path, key), REASONS.generic);
      }
      if (own(raw, 'download') === false) this.report(keyPath(path, 'download'), REASONS.generic);
      list = own(raw, 'paths');
      listPath = keyPath(path, 'paths');
    }
    if (!Array.isArray(list)) {
      this.report(path, REASONS.generic);
      return [];
    }
    const globs: string[] = [];
    const seen = new Set<string>();
    this.limit(list, MAX_LIST_ENTRIES, listPath).forEach((glob, i) => {
      if (!isSafeLine(glob)) {
        this.report(indexPath(listPath, i), REASONS.unsafe);
      } else if (!seen.has(glob)) {
        seen.add(glob);
        if (globs.length >= MAX_ARTIFACT_GLOBS || !this.spend(glob.length)) {
          this.report(indexPath(listPath, i), REASONS.tooMany);
        } else globs.push(glob);
      }
    });
    return globs;
  }

  // -- output ----------------------------------------------------------------------------------

  private finish(pending: Pending[]): YamlTranslation {
    const sorted = [...pending].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const comments: Map<Pending, Unsupported[]> = new Map(sorted.map((p) => [p, []]));
    const listed = [...this.unsupported].map(([path, reason]) => ({ path, reason }));
    for (const u of listed) {
      const target =
        sorted.find(
          (p) =>
            u.path === p.scope ||
            u.path.startsWith(`${p.scope}.`) ||
            u.path.startsWith(`${p.scope}[`),
        ) ?? sorted[0];
      if (target !== undefined) comments.get(target)?.push(u);
    }
    const workflows: Workflow[] = [];
    for (const p of sorted) {
      const content = render(p, comments.get(p) ?? []);
      if (content.length > MAX_WORKFLOW_BYTES) this.report(p.scope, REASONS.tooLarge);
      else workflows.push({ path: p.path, content });
    }
    if (this.overflow) this.unsupported.set(SOURCE_FILE, REASONS.moreUnsupported);
    const unsupported = [...this.unsupported].map(([path, reason]) => ({ path, reason }));
    return { workflows, unsupported };
  }
}

function baseImage(image: string): string {
  const last = image.split('/').at(-1) ?? image;
  return (last.split('@')[0] ?? last).split(':')[0] ?? last;
}

function render(p: Pending, todo: Unsupported[]): string {
  const workflow = obj(
    ['name', p.title],
    ['on', p.on],
    ['permissions', obj(['contents', 'read'])],
    ['jobs', p.jobs],
  );
  const header = [
    `# Generated by git-migrator from ${SOURCE_FILE} (${p.scope}). Review it before merging.`,
    ...todo.map((u) => `# TODO(git-migrator): ${u.path} — ${u.reason}`),
  ];
  return `${header.join('\n')}\n${stringify(workflow, { lineWidth: 0, indent: 2 })}`;
}

/** Translates the text of a source pipelines file. Never throws on any input. */
export function translatePipelinesYaml(text: string, names: VariableNames): YamlTranslation {
  return new Translator(names).run(text);
}
