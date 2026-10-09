/**
 * Checks the agent role definitions (.claude/agents, PROC-007) and the CI workflow (DEP-060)
 * against the rules they must follow. These are static checks on the files themselves.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** The YAML-like frontmatter of an agent file, as key/value strings. */
function frontmatter(rel: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(read(rel));
  if (!match) throw new Error(`${rel} has no frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

const roles: Record<string, string> = {
  orchestrator: 'opus',
  implementor: 'sonnet',
  'reviewer-spec': 'sonnet',
  'reviewer-adversarial': 'sonnet',
  'merge-agent': 'haiku',
};

describe('PROC-007 agent role definitions', () => {
  it('[PROC-007] defines exactly the five roles of the workflow', () => {
    const files = readdirSync(join(root, '.claude/agents'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual(Object.keys(roles).sort());
  });

  for (const [role, model] of Object.entries(roles)) {
    it(`[PROC-007] ${role} defaults to model ${model}`, () => {
      const fields = frontmatter(`.claude/agents/${role}.md`);
      expect(fields.name).toBe(role);
      expect(fields.model).toBe(model);
      expect(fields.description?.length ?? 0).toBeGreaterThan(20);
    });
  }

  it('[PROC-007] never uses the fable tier', () => {
    for (const role of Object.keys(roles)) {
      expect(read(`.claude/agents/${role}.md`)).not.toMatch(/\bfable\b/i);
    }
  });

  it('[PROC-007] every role points to AGENTS.md and the workflow, and reviewers to the review rubric', () => {
    for (const role of Object.keys(roles)) {
      const text = read(`.claude/agents/${role}.md`);
      expect(text, role).toContain('AGENTS.md');
      expect(text, role).toContain('docs/process/workflow.md');
      if (role !== 'merge-agent') expect(text, role).toContain('docs/process/review.md');
    }
  });

  it('[PROC-007] the merge agent integrates into ai-main and never pushes to main', () => {
    const text = read('.claude/agents/merge-agent.md');
    expect(text).toContain('ai-main');
    expect(text).toMatch(/never push(es)? to `main`/);
    expect(text).toContain('origin/ai-main');
  });

  it('[PROC-007] reviewers cannot edit files (disallowedTools) and Bash is read-only by instruction', () => {
    for (const role of ['reviewer-spec', 'reviewer-adversarial']) {
      const fields = frontmatter(`.claude/agents/${role}.md`);
      const denied = (fields.disallowedTools ?? '').split(',').map((t) => t.trim());
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        expect(denied, `${role} ${tool}`).toContain(tool);
      }
      expect(read(`.claude/agents/${role}.md`)).toContain('read-only');
    }
  });

  it('[PROC-007] the implementor file does not hard-code a session URL (PROC-004)', () => {
    expect(read('.claude/agents/implementor.md')).not.toMatch(/claude\.ai\/code/);
  });
});

describe('DEP-060 CI workflow', () => {
  const ci = read('.github/workflows/ci.yml');
  // Step keys (run:, uses:) without comments or list markers.
  const steps = ci
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').replace(/^- /, '').trim())
    .filter((line) => line.length > 0);

  it('[DEP-060] runs on push and pull_request for ai-main and main', () => {
    expect(ci).toMatch(/on:\n\s+push:\n\s+branches: \[ai-main, main\]/);
    expect(ci).toMatch(/pull_request:\n\s+branches: \[ai-main, main\]/);
  });

  it('[DEP-060] uses Node 24 and installs with the frozen lockfile', () => {
    expect(ci).toMatch(/node-version: 24\b/);
    expect(steps).toContain('run: pnpm install --frozen-lockfile');
  });

  it('[DEP-060] runs root lint, typecheck and test, not per-package turbo test (ADR-0030)', () => {
    expect(steps).toContain('run: pnpm lint');
    expect(steps).toContain('run: pnpm typecheck');
    expect(steps).toContain('run: pnpm test');
    expect(steps.some((s) => s.includes('turbo'))).toBe(false);
  });

  it('[DEP-060] gates spec coverage in strict mode (TST-002, ADR-0029)', () => {
    expect(steps).toContain('run: pnpm spec:coverage -- --strict');
  });

  it('[DEP-060] pins every action to a full commit SHA', () => {
    const uses = steps.filter((s) => s.startsWith('uses: '));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, line).toMatch(/^uses: [\w/-]+@[0-9a-f]{40}$/);
    }
  });

  it('[DEP-060] scans history with the pinned gitleaks binary, verified by SHA-256 (not the action)', () => {
    expect(steps.some((step) => step.includes('gitleaks-action'))).toBe(false);
    expect(ci).toMatch(/GITLEAKS_VERSION: 8\.30\.1/);
    expect(ci).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}/);
    expect(ci).toContain('sha256sum --check --strict');
    expect(steps).toContain(
      'run: gitleaks git --config .gitleaks.toml --log-opts "HEAD" --redact --no-banner',
    );
    expect(ci).toContain('fetch-depth: 0');
  });

  it('[DEP-060] gitleaks allowlists exact paths and fingerprints, and keeps the two whole-file entries', () => {
    const toml = read('.gitleaks.toml');
    expect(toml).toContain('useDefault = true');
    expect(toml).toContain("'''^testing/provider-fakes/specs/github\\.openapi\\.json$'''");
    expect(toml).toContain("'''^testing/fixtures/fake-github-app\\.pem$'''");
    const ignore = read('.gitleaksignore')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(ignore).toHaveLength(3);
    for (const line of ignore)
      expect(line).toMatch(/^[0-9a-f]{40}:testing\/provider-fakes\/specs\/[^:]+:[a-z-]+:\d+$/);
  });

  it('[DEP-060] the PR template has a requirement-ID checklist and an acceptance checklist', () => {
    const path = '.github/pull_request_template.md';
    expect(existsSync(join(root, path))).toBe(true);
    const template = read(path);
    expect(template).toContain('Requirement-ID checklist');
    expect(template).toContain('Acceptance checklist');
    expect(template).toContain('- [ ]');
  });
});
