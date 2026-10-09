/**
 * FAC-002 drift guard: the finding-code list in `codes.ts` must match docs/spec/05-facets.md, and
 * every dotted name the spec writes in backticks must be accounted for (ADR-0091). The spec is
 * normative (AGENTS.md), so when it changes this test fails until the source list follows.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FINDING_CODES, FINDING_SPECS, PRINCIPAL_FACETS, type Severity } from './codes.ts';

/** The repository's docs/spec, found by walking up from this file (no path leaves the package). */
function specFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'docs', 'spec', '05-facets.md');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('docs/spec/05-facets.md not found above this package');
    dir = parent;
  }
}

const SPEC = specFile();
const spec = readFileSync(SPEC, 'utf8');
const lines = spec.split('\n');

/**
 * LIF-031 blockers are raised by the Migration lifecycle, not by a Facet, so the spec names them in
 * docs/spec/06-migration-lifecycle.md.
 */
const LIFECYCLE_SPEC = join(dirname(SPEC), '06-migration-lifecycle.md');
const lifecycleSpec = readFileSync(LIFECYCLE_SPEC, 'utf8');

/**
 * Exempt from the LIF-031 checks, each with its reason. `target.exists-foreign-adopted` is
 * information only (LIF-031), so it has no guidance (ADR-0090).
 */
const LIF031_EXEMPT: Readonly<Record<string, string>> = {
  'target.exists-foreign-adopted': 'information only, no guidance (ADR-0090)',
};

/** Dotted names in the LIF-031 bullets of the lifecycle spec (the indented block that follows). */
function lif031Names(): string[] {
  const lifecycleLines = lifecycleSpec.split('\n');
  const start = lifecycleLines.findIndex((l) => l.startsWith('- **LIF-031 Blockers:**'));
  const names: string[] = [];
  for (const line of lifecycleLines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9-]*\.[A-Za-z][A-Za-z0-9-]*)`/g)) {
      names.push(m[1] ?? '');
    }
  }
  return names;
}

/** Policy keys (FAC-005): lossy decisions named in the spec. Each has a `<facet>.accept-lossy` task. */
const KNOWN_POLICY_KEYS: readonly string[] = [
  'branch-rules.overlap-unresolved',
  'branch-rules.patterns-merged',
  'org-variables.uppercase-names',
  'org-webhooks.event-dropped',
  'branch-rules.advisory-enforced',
  'branch-rules.approvals-capped',
  'branch-rules.exemptions-dropped',
  'branch-rules.merge-restriction-as-push',
  'branch-rules.pattern-approximated',
  'branch-rules.tasks-as-conversations',
  'code-ownership.default-reviewers-as-codeowners',
  'code-ownership.owner-insufficient-access',
  'environments.category-dropped',
  'merge-settings.ff-only-as-rebase',
  'repository-settings.description-truncated',
  'repository-settings.public-fork-policy',
  'variables.uppercase-names',
  'webhooks.event-dropped',
];

/**
 * Codes that implementors added where the spec is silent (PROC-005). They are in `codes.ts` and have
 * guidance, but the spec does not name them yet. Each one is recorded in an agent-decided ADR.
 */
const AGENT_DECIDED_CODES: Readonly<Record<string, string>> = {
  // Named in the lifecycle spec (LIF-042, LIF-049), not in 05-facets.md (ADR-0380).
  'git-refs.push-too-large': 'run-origin blocker of LIF-042',
  // The run-time observation behind the policy key of the same prefix (ADR-0040, ADR-0380).
  'branch-rules.exemptions-not-applied': 'run-origin post task for a refused bypass list',
  'branch-rules.protection-lifted': 'run-origin post task after a failure that follows step 3a',
  // LIF-070: a write of the source lock whose outcome is unknown blocks target writes (ADR-0425).
  'branch-rules.source-lock-unsettled': 'run-origin blocker while a source lock write is unsettled',
};

/**
 * Policy keys decided by an implementor (agent-decided ADR) and not yet folded into the spec. They
 * stay out of the list above. Remove an entry once the spec names it.
 */
const AGENT_DECIDED_POLICY_KEYS: readonly string[] = [];

/**
 * Dotted names in backticks that are neither finding codes nor policy keys: pipeline YAML and
 * translation fields, CI variables, file paths, placeholders and API fields. Each one must appear in
 * the spec, so a stale entry fails too. `translation.unsupported` is the list of unsupported YAML
 * paths carried inside the pipelines translation. It is a field, not a Finding code (orchestrator
 * decision, ADR-0091).
 */
const NON_CODE_NAMES: readonly string[] = [
  '.github/',
  '.github/git-migrator/bitbucket-pipelines.yml',
  '.github/workflows/*.yml',
  'bitbucket-pipelines.yml',
  'x.y',
  'files[].path',
  'routes[].defaults.mergeSettings',
  'restrictions.{users,teams}',
  'required_status_checks.strict',
  'pipelines_config.enabled',
  'pipelines.default',
  'pipelines.branches.<glob>',
  'pipelines.tags.<glob>',
  'pipelines.custom.<name>',
  'on.push',
  'on.push.branches',
  'on.push.tags',
  'on.pull_request',
  'on.workflow_dispatch',
  'step.services',
  'definitions.services',
  'definitions.caches',
  'key.files',
  'clone.depth',
  'vars.NAME',
  'secrets.NAME',
  'github.base_ref',
  'github.head_ref',
  'github.event.pull_request.number',
  'github.event.repository.name',
  'github.ref_name',
  'github.run_number',
  'github.sha',
  'github.workspace',
  'runner.os',
  'git.prepare',
  'Migration.plannedTargetName',
  'params.policyKey',
  '<repo>.git/wiki',
  '<facet>.<name>',
  '<facet>.accept-lossy',
  '<facet>.unmapped-principal',
  '<facet>.pending-invitation',
  '<facet>.team-missing',
  'translation.unsupported',
];

const SEVERITY_BY_MARK: Record<string, Severity> = {
  B: 'blocker',
  pre: 'pre',
  post: 'post',
  W: 'warning',
};
const BACKTICK = /`([^`\n]+)`/g;
const DOTTED_NAME = /^[A-Za-z][A-Za-z0-9-]*\.[A-Za-z][A-Za-z0-9-]*$/;

/** Dotted names inside one backtick span. A span without whitespace is one name. */
function dottedNamesIn(span: string): string[] {
  if (!/\s/.test(span)) return span.includes('.') ? [span] : [];
  return span.split(/[\s"',[\]()]+/).filter((t) => t.includes('.'));
}

/** Every dotted name the spec writes in backticks, with the text before it (for policy context). */
function specNames(): { name: string; before: string }[] {
  const out: { name: string; before: string }[] = [];
  for (const m of spec.matchAll(BACKTICK)) {
    for (const name of dottedNamesIn(m[1] ?? '')) {
      out.push({ name, before: spec.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0) });
    }
  }
  return out;
}

/** Facet keys from the "## Facet index" table. */
function facetKeys(): Set<string> {
  const start = lines.findIndex((l) => l.startsWith('## Facet index'));
  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const m = /^\| `([a-z-]+)` \|/.exec(line);
    if (m?.[1] !== undefined) keys.add(m[1]);
  }
  return keys;
}

describe('finding code list matches the facets spec (FAC-002)', () => {
  it('[FAC-002] every bare name on a "Findings:" line is a listed code with the same severity and (v) marker', () => {
    let checked = 0;
    for (const line of lines) {
      const at = line.indexOf('**Findings:**');
      if (at === -1) continue;
      const segment = line.slice(at);
      for (const m of segment.matchAll(/`([^`\n]+)`(\s+(pre|post|B|W)\b)?(\s+\(v\))?/g)) {
        const name = m[1] ?? '';
        if (!DOTTED_NAME.test(name)) continue;
        const mark = m[3];
        expect(
          mark,
          `${name} on a Findings line has no recognised mark (pre, post, B or W)`,
        ).toBeDefined();
        const listed = FINDING_SPECS.find((s) => s.code === name);
        expect(listed, `${name} is on a Findings line but missing from codes.ts`).toBeDefined();
        expect(listed?.severity, name).toBe(SEVERITY_BY_MARK[mark ?? ''] ?? 'warning');
        expect(listed?.verifiable, name).toBe(m[4] !== undefined);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('[FAC-002] every dotted name in backticks is a finding code, a policy key, or a listed non-code name', () => {
    const codes = new Set<string>(FINDING_CODES);
    const policy = new Set<string>(KNOWN_POLICY_KEYS);
    const other = new Set<string>(NON_CODE_NAMES);
    const unknown = new Set<string>();
    for (const { name } of specNames()) {
      if (!codes.has(name) && !policy.has(name) && !other.has(name)) unknown.add(name);
    }
    expect([...unknown].sort(), 'unclassified dotted names in docs/spec/05-facets.md').toEqual([]);
  });

  it('[FAC-002] the spec names every facet code in codes.ts, except the FAC-006 generic ones', () => {
    const mentioned = new Set(specNames().map((n) => n.name));
    const generic = /\.(unmapped-principal|pending-invitation|team-missing)$/;
    for (const spec of FINDING_SPECS) {
      if (spec.facet === 'lifecycle' || generic.test(spec.code)) continue;
      if (spec.code in AGENT_DECIDED_CODES) continue;
      expect(mentioned.has(spec.code), `${spec.code} is not named in docs/spec/05-facets.md`).toBe(
        true,
      );
    }
  });

  it('[LIF-031] [FAC-002] the LIF-031 blockers in the lifecycle spec are exactly the lifecycle codes, less the exemptions', () => {
    const specNames = lif031Names();
    expect(specNames.length).toBeGreaterThan(2);
    // Spec to list: every LIF-031 name has guidance, unless it is exempt.
    for (const name of specNames) {
      if (name in LIF031_EXEMPT) continue;
      const listed = FINDING_SPECS.find((s) => s.code === name);
      expect(listed, `${name} is named in LIF-031 but missing from codes.ts`).toBeDefined();
      expect(listed?.facet, name).toBe('lifecycle');
    }
    // List to spec: every lifecycle code is named in LIF-031.
    for (const spec of FINDING_SPECS.filter((s) => s.facet === 'lifecycle')) {
      expect(specNames, `${spec.code} is not named in LIF-031`).toContain(spec.code);
    }
  });

  it('[LIF-031] [FAC-002] information-only LIF-031 names have no guidance entry', () => {
    for (const [name, reason] of Object.entries(LIF031_EXEMPT)) {
      expect(reason.length, name).toBeGreaterThan(0);
      if (reason.startsWith('information only')) {
        expect(
          FINDING_CODES.includes(name as never),
          `${name} is information only and must not be a finding code`,
        ).toBe(false);
      }
    }
  });

  it('[FAC-002] every agent-decided code and policy key is listed and not yet named in the spec', () => {
    const mentioned = new Set(specNames().map((n) => n.name));
    for (const code of Object.keys(AGENT_DECIDED_CODES)) {
      expect(FINDING_CODES.includes(code as never), `${code} is not in codes.ts`).toBe(true);
      expect(mentioned.has(code), `${code} is in the spec now: drop the exemption`).toBe(false);
    }
    for (const key of AGENT_DECIDED_POLICY_KEYS) {
      expect(mentioned.has(key), `${key} is in the spec now: move it to KNOWN_POLICY_KEYS`).toBe(
        false,
      );
    }
  });

  it('[FAC-002] prose-only codes (named outside Findings lines) are recognised as codes', () => {
    const mentioned = new Set(specNames().map((n) => n.name));
    for (const code of ['extras.wiki-not-migrated', 'org-secrets.set-value', 'secrets.set-value']) {
      expect(mentioned.has(code), `${code} is not found in the spec`).toBe(true);
    }
  });

  it('[FAC-002] the policy keys named in the spec are exactly the known set', () => {
    const codes = new Set<string>(FINDING_CODES);
    const other = new Set<string>(NON_CODE_NAMES);
    const derived = new Set<string>();
    for (const { name, before } of specNames()) {
      if (codes.has(name) || other.has(name)) continue;
      if (/lossy|policy|acceptLossy/i.test(before)) derived.add(name);
    }
    expect([...derived].sort()).toEqual([...KNOWN_POLICY_KEYS].sort());
  });

  it('[FAC-002] every non-code name in the allowlist still appears in the spec', () => {
    const named = new Set(specNames().map((n) => n.name));
    const stale = NON_CODE_NAMES.filter((name) => !named.has(name));
    expect(stale).toEqual([]);
  });

  it('[FAC-002] the FAC-006 rule still produces the unmapped and pending codes for principal facets', () => {
    const start = lines.findIndex((l) => l.startsWith('**FAC-006'));
    const end = lines.findIndex((l) => l.startsWith('Only principals that appear'));
    const rule = lines.slice(start, end).join('\n');
    expect(rule).toContain('`<facet>.unmapped-principal`');
    expect(rule).toContain('`<facet>.pending-invitation`');
    for (const facet of PRINCIPAL_FACETS) {
      expect(FINDING_CODES).toContain(`${facet}.unmapped-principal`);
      expect(FINDING_CODES).toContain(`${facet}.pending-invitation`);
    }
  });

  it('[FAC-002] every facet that emits a code is in the facet index', () => {
    const keys = facetKeys();
    expect(keys.size).toBeGreaterThan(15);
    for (const spec of FINDING_SPECS) {
      if (spec.facet === 'lifecycle') continue; // LIF-031, not a Facet
      const facet = spec.code.split('.')[0] ?? '';
      expect(keys.has(facet), `${spec.code}: facet ${facet} is not in the facet index`).toBe(true);
    }
  });

  it('[FAC-002] every policy key has a <facet>.accept-lossy task in the list', () => {
    for (const key of [...KNOWN_POLICY_KEYS, ...AGENT_DECIDED_POLICY_KEYS]) {
      const facet = key.split('.')[0] ?? '';
      expect(FINDING_CODES, key).toContain(`${facet}.accept-lossy`);
    }
  });
});
