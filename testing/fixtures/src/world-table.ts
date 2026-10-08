import {
  type ExpectedOutcome,
  type FindingSeverity,
  type Readiness,
  WORLD_REPOSITORIES,
} from './world-spec.ts';

const READINESS_LABEL: Record<Readiness, string> = {
  ready: 'Ready',
  needs_attention: 'NeedsAttention',
  blocked: 'Blocked',
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocker: 'B',
  pre: 'pre',
  post: 'post',
  warning: 'W',
};

const cell = (o: ExpectedOutcome): string => {
  const findings = o.findings.map((x) => `\`${x.code}\` (${SEVERITY_LABEL[x.severity]})`);
  return `${READINESS_LABEL[o.readiness]}${findings.length ? `: ${findings.join(', ')}` : ''}`;
};

/**
 * The Markdown table of the README ("Expected readiness and findings"). A test keeps the README
 * equal to this output, so the doc cannot drift from the data.
 */
export function renderExpectationTable(): string {
  const rows = WORLD_REPOSITORIES.map((r) => {
    const later = (r.stages ?? []).map((s) => `After ${s.after}: ${cell(s)}`).join('<br>');
    return `| \`${r.key}\` | ${r.plannedTargetName} | ${cell(r.analysis)} | ${later || '-'} |`;
  });
  return [
    '| Repository | Planned target | Expected after Analysis | Later |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

if (process.argv[1]?.endsWith('world-table.ts')) console.log(renderExpectationTable());
