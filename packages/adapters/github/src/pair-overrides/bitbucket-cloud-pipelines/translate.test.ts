// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are workflow expressions, not templates
// biome-ignore-all lint/suspicious/noExplicitAny: parsed workflow documents are inspected loosely
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ACTIONS,
  BUILT_IN_VARIABLES,
  globMatches,
  MAX_EXCLUSIONS,
  MAX_JOBS_PER_WORKFLOW,
  MAX_LIST_ENTRIES,
  MAX_PATTERNS,
  MAX_REPORTS,
  MAX_TOTAL_JOBS,
  MAX_WORKFLOW_BYTES,
  PREDEFINED_CACHES,
  WORKFLOW_ESTIMATE_LIMIT,
} from './constants.ts';
import { NO_NAMES, variableNames } from './names.ts';
import { isMapping } from './safe.ts';
import { MAX_SOURCE_LENGTH, translatePipelinesYaml } from './translate.ts';

type Json = Record<string, any>;

const names = variableNames(
  {
    variables: [
      { scope: 'repository', name: 'API_URL' },
      { scope: 'environment:production', name: 'REGION' },
    ],
  },
  { secrets: [{ scope: 'repository', name: 'TOKEN' }] },
  { variables: ['WS_VAR'], secrets: ['WS_SECRET'] },
);

function translate(source: string, n = names) {
  return translatePipelinesYaml(source, n);
}

/** The single workflow of a source file, parsed. */
function only(source: string, n = names): { wf: Json; unsupported: string[]; text: string } {
  const r = translate(source, n);
  expect(r.workflows).toHaveLength(1);
  const w = r.workflows[0] as { content: string };
  return {
    wf: parse(w.content) as Json,
    unsupported: r.unsupported.map((u) => u.path),
    text: w.content,
  };
}

const step = (body: string, indent = '    ') =>
  body
    .split('\n')
    .map((l) => (l === '' ? l : `${indent}${l}`))
    .join('\n');

const pipeline = (stepBody: string) =>
  `pipelines:\n  default:\n    - step:\n${step(stepBody, '        ')}\n`;

describe('FAC-PIP-002 image', () => {
  it('[FAC-PIP-002] a global image becomes container: on every job', () => {
    const { wf } = only(`image: node:20\n${pipeline('script:\n  - make')}`);
    expect(wf.jobs['step-1'].container).toEqual({ image: 'node:20' });
  });

  it('[FAC-PIP-002] a step image overrides the global image', () => {
    const { wf } = only(`image: node:20\n${pipeline('image: python:3.12\nscript:\n  - make')}`);
    expect(wf.jobs['step-1'].container.image).toBe('python:3.12');
  });

  it('[FAC-PIP-002] username and password that reference variables become credentials from secrets', () => {
    const { wf } = only(
      pipeline(
        'image:\n  name: registry.example.test/team/img:1\n  username: $API_URL\n  password: ${TOKEN}\nscript:\n  - make',
      ),
    );
    expect(wf.jobs['step-1'].container).toEqual({
      image: 'registry.example.test/team/img:1',
      credentials: { username: '${{ vars.API_URL }}', password: '${{ secrets.TOKEN }}' },
    });
  });

  it('[FAC-PIP-002] literal or unknown credentials are never copied: they are unsupported', () => {
    const r = only(
      pipeline('image:\n  name: img:1\n  username: me\n  password: hunter2\nscript:\n  - make'),
    );
    expect(r.wf.jobs['step-1'].container).toEqual({ image: 'img:1' });
    expect(r.unsupported).toEqual([
      'pipelines.default[0].step.image.username',
      'pipelines.default[0].step.image.password',
    ]);
    expect(r.text).not.toContain('hunter2');
    const unknown = only(
      pipeline('image:\n  name: img:1\n  username: $NOPE\n  password: $TOKEN\nscript:\n  - make'),
    );
    expect(unknown.wf.jobs['step-1'].container.credentials).toBeUndefined();
    expect(unknown.unsupported).toEqual(['pipelines.default[0].step.image.username']);
  });

  it('[FAC-PIP-002] other image options (aws, run-as-user) and non-public names are unsupported', () => {
    const aws = only(
      pipeline('image:\n  name: img:1\n  aws:\n    access-key: x\nscript:\n  - make'),
    );
    expect(aws.unsupported).toEqual(['pipelines.default[0].step.image.aws']);
    const variable = only(pipeline('image: $PRIVATE_IMAGE\nscript:\n  - make'));
    expect(variable.wf.jobs['step-1'].container).toBeUndefined();
    expect(variable.unsupported).toEqual(['pipelines.default[0].step.image']);
  });
});

describe('FAC-PIP-002 triggers', () => {
  const source = `pipelines:
  default:
    - step: {script: [a]}
  branches:
    main:
      - step: {script: [b]}
    'release/**':
      - step: {script: [c]}
  tags:
    'v*':
      - step: {script: [d]}
  custom:
    Nightly build:
      - step: {script: [e]}
`;
  const r = translate(source);
  const byPath = (p: string) =>
    parse((r.workflows.find((w) => w.path.endsWith(p)) as { content: string }).content) as Json;

  it('[FAC-PIP-002] pipelines.default becomes on.push on all branches plus on.pull_request', () => {
    const on = byPath('/ci.yml').on;
    expect(on.push.branches[0]).toBe('**');
    expect(on).toHaveProperty('pull_request');
  });

  it('[FAC-PIP-002] the default pipeline excludes the branches that have their own pipeline', () => {
    expect(byPath('/ci.yml').on.push.branches).toEqual(['**', '!main', '!release/**']);
  });

  it('[FAC-PIP-002] pipelines.branches.<glob> becomes on.push.branches', () => {
    expect(byPath('/branch-main.yml').on).toEqual({ push: { branches: ['main'] } });
    expect(byPath('/branch-release.yml').on).toEqual({ push: { branches: ['release/**'] } });
  });

  it('[FAC-PIP-002] pipelines.tags.<glob> becomes on.push.tags', () => {
    expect(byPath('/tag-v.yml').on).toEqual({ push: { tags: ['v*'] } });
  });

  it('[FAC-PIP-002] pipelines.custom.<name> becomes a separate workflow with on.workflow_dispatch', () => {
    expect(byPath('/custom-nightly-build.yml').on).toEqual({ workflow_dispatch: {} });
    expect(r.workflows.map((w) => w.path)).toEqual([
      '.github/workflows/branch-main.yml',
      '.github/workflows/branch-release.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/custom-nightly-build.yml',
      '.github/workflows/tag-v.yml',
    ]);
    expect(r.unsupported).toEqual([]);
  });

  it('[FAC-PIP-002] file names that collide after slugging get a numeric suffix', () => {
    const c = translate(`pipelines:
  branches:
    'feature/*':
      - step: {script: [a]}
    'feature/**':
      - step: {script: [b]}
`);
    expect(c.workflows.map((w) => w.path)).toEqual([
      '.github/workflows/branch-feature-2.yml',
      '.github/workflows/branch-feature.yml',
    ]);
  });

  it('[FAC-PIP-002] globs with characters outside the safe set are unsupported and generate nothing', () => {
    const c = translate(`pipelines:
  branches:
    '{a,b}/x':
      - step: {script: [a]}
    'it''s':
      - step: {script: [b]}
  tags:
    'v[0-9]+':
      - step: {script: [c]}
`);
    expect(c.workflows).toEqual([]);
    expect(c.unsupported.map((u) => u.path)).toEqual([
      "pipelines.branches['{a,b}/x']",
      "pipelines.branches['it\"s']",
      "pipelines.tags['v[0-9]+']",
    ]);
  });
});

describe('FAC-PIP-002 step fields', () => {
  it('[FAC-PIP-002] name becomes the job name and script strings become one run step', () => {
    const { wf } = only(pipeline('name: Build it\nscript:\n  - cd app\n  - make\n'));
    const job = wf.jobs['step-1'];
    expect(job.name).toBe('Build it');
    expect(job.steps.at(-1)).toEqual({ name: 'Script', run: 'cd app\nmake' });
  });

  it('[FAC-PIP-002] after-script becomes a step with if: always() after the script', () => {
    const { wf } = only(pipeline('script:\n  - make\nafter-script:\n  - echo done\n'));
    const steps = wf.jobs['step-1'].steps;
    expect(steps.at(-1)).toEqual({ name: 'After script', if: 'always()', run: 'echo done' });
    expect(steps.at(-2).run).toBe('make');
  });

  it('[FAC-PIP-002] max-time becomes timeout-minutes; invalid values are unsupported', () => {
    expect(
      only(pipeline('max-time: 15\nscript:\n  - make')).wf.jobs['step-1']['timeout-minutes'],
    ).toBe(15);
    const bad = only(pipeline('max-time: soon\nscript:\n  - make'));
    expect(bad.wf.jobs['step-1']['timeout-minutes']).toBeUndefined();
    expect(bad.unsupported).toEqual(['pipelines.default[0].step.max-time']);
  });

  it('[FAC-PIP-002] clone.depth becomes fetch-depth (full is 0); other clone options are unsupported', () => {
    const depth = (body: string) =>
      only(pipeline(`${body}\nscript:\n  - make`)).wf.jobs['step-1'].steps[0].with['fetch-depth'];
    expect(depth('clone:\n  depth: full')).toBe(0);
    expect(depth('clone:\n  depth: 7')).toBe(7);
    expect(depth('clone:\n  depth: 0')).toBeUndefined();
    const lfs = only(pipeline('clone:\n  lfs: true\n  enabled: false\nscript:\n  - make'));
    expect(lfs.unsupported).toEqual([
      'pipelines.default[0].step.clone.lfs',
      'pipelines.default[0].step.clone.enabled',
    ]);
  });

  it('[FAC-PIP-002] deployment becomes environment', () => {
    expect(
      only(pipeline('deployment: production\nscript:\n  - make')).wf.jobs['step-1'].environment,
    ).toBe('production');
    const odd = only(pipeline('deployment: "a\\nb"\nscript:\n  - make'));
    expect(odd.wf.jobs['step-1'].environment).toBeUndefined();
    expect(odd.unsupported).toEqual(['pipelines.default[0].step.deployment']);
  });

  it('[FAC-PIP-002] the checkout is pinned and does not persist credentials', () => {
    const { wf } = only(pipeline('script:\n  - make'));
    expect(wf.jobs['step-1'].steps[0]).toEqual({
      uses: ACTIONS.checkout.uses,
      with: { 'persist-credentials': false },
    });
  });
});

describe('FAC-PIP-002 caches', () => {
  const cacheSteps = (caches: string[], defs = '') =>
    only(
      `${defs}${pipeline(`caches:\n${caches.map((c) => `  - ${c}`).join('\n')}\nscript:\n  - make`)}`,
    ).wf.jobs['step-1'].steps.filter((s: Json) =>
      String(s.uses ?? '').startsWith('actions/cache@'),
    );

  it.each(Object.keys(PREDEFINED_CACHES))('[FAC-PIP-002] predefined cache %s', (name) => {
    const [cache] = cacheSteps([name]);
    const def = PREDEFINED_CACHES[name] as { path: string; files: string[] };
    expect(cache.uses).toBe(ACTIONS.cache.uses);
    expect(cache.with.path).toBe(def.path);
    expect(cache.with.key).toBe(
      `\${{ runner.os }}-${name}-\${{ hashFiles(${def.files.map((f) => `'${f}'`).join(', ')}) }}`,
    );
  });

  it('[FAC-PIP-002] the docker cache is dropped without being unsupported', () => {
    const r = only(pipeline('caches:\n  - docker\nscript:\n  - make'));
    expect(r.wf.jobs['step-1'].steps).toHaveLength(2);
    expect(r.unsupported).toEqual([]);
  });

  it('[FAC-PIP-002] custom caches use their path and key.files', () => {
    const defs = `definitions:
  caches:
    plain: build/out
    keyed:
      path: ~/.cache/thing
      key:
        files:
          - Gemfile.lock
          - "**/*.gemspec"
`;
    const [plain, keyed] = cacheSteps(['plain', 'keyed'], defs);
    expect(plain.with.path).toBe('build/out');
    expect(plain.with.key).toContain("hashFiles('**/package-lock.json'");
    expect(keyed.with).toEqual({
      path: '~/.cache/thing',
      key: "${{ runner.os }}-keyed-${{ hashFiles('Gemfile.lock', '**/*.gemspec') }}",
    });
  });

  it('[FAC-PIP-002] an undefined cache is unsupported', () => {
    const r = only(pipeline('caches:\n  - missing\nscript:\n  - make'));
    expect(r.unsupported).toEqual(['pipelines.default[0].step.caches[0]']);
  });
});

describe('FAC-PIP-002 artifacts', () => {
  const source = `pipelines:
  default:
    - step:
        name: A
        script: [a]
        artifacts: ["dist/**", "out/*.bin"]
    - step:
        name: B
        script: [b]
    - parallel:
        - step:
            name: C
            script: [c]
        - step:
            name: D
            script: [d]
            artifacts: [d.txt]
    - step:
        name: E
        script: [e]
`;
  const jobs = only(source).wf.jobs as Json;
  const downloads = (id: string) =>
    jobs[id].steps
      .filter((s: Json) => String(s.uses).startsWith('actions/download-artifact@'))
      .map((s: Json) => s.with.name);

  it('[FAC-PIP-002] artifacts become an upload step named after the job', () => {
    const upload = jobs['step-1'].steps.find((s: Json) =>
      String(s.uses).startsWith('actions/upload-artifact@'),
    );
    expect(upload.uses).toBe(ACTIONS.uploadArtifact.uses);
    expect(upload.with).toEqual({
      name: 'artifact-step-1',
      path: 'dist/**\nout/*.bin',
      'if-no-files-found': 'error',
    });
  });

  it('[FAC-PIP-002] later jobs download the artifacts of every earlier job that produced some', () => {
    expect(downloads('step-1')).toEqual([]);
    expect(downloads('step-2')).toEqual(['artifact-step-1']);
    expect(downloads('step-3')).toEqual(['artifact-step-1']);
    expect(downloads('step-4')).toEqual(['artifact-step-1']);
    expect(downloads('step-5')).toEqual(['artifact-step-1', 'artifact-step-4']);
  });

  it('[FAC-PIP-002] downloads come after the checkout and before the script', () => {
    const order = jobs['step-2'].steps.map((s: Json) => s.name ?? 'checkout');
    expect(order).toEqual(['checkout', 'Download artifacts of step-1', 'Script']);
  });

  it('[FAC-PIP-002] artifacts that must not be downloaded are unsupported', () => {
    const r = only(
      pipeline('script:\n  - make\nartifacts:\n  download: false\n  paths:\n    - a/**'),
    );
    expect(r.unsupported).toEqual(['pipelines.default[0].step.artifacts.download']);
  });
});

describe('FAC-PIP-002 job chaining', () => {
  it('[FAC-PIP-002] sequential steps are jobs chained by needs', () => {
    const { wf } = only(`pipelines:
  default:
    - step: {script: [a]}
    - step: {script: [b]}
    - step: {script: [c]}
`);
    expect(wf.jobs['step-1'].needs).toBeUndefined();
    expect(wf.jobs['step-2'].needs).toEqual(['step-1']);
    expect(wf.jobs['step-3'].needs).toEqual(['step-2']);
  });

  it('[FAC-PIP-002] a parallel group shares the previous job as needs and the next step waits for all', () => {
    const { wf } = only(`pipelines:
  default:
    - step: {script: [a]}
    - parallel:
        - step: {script: [b]}
        - step: {script: [c]}
    - step: {script: [d]}
`);
    expect(wf.jobs['step-2'].needs).toEqual(['step-1']);
    expect(wf.jobs['step-3'].needs).toEqual(['step-1']);
    expect(wf.jobs['step-4'].needs).toEqual(['step-2', 'step-3']);
  });

  it('[FAC-PIP-002] the parallel steps: form is accepted; fail-fast is unsupported', () => {
    const r = only(`pipelines:
  default:
    - parallel:
        fail-fast: true
        steps:
          - step: {script: [a]}
`);
    expect(Object.keys(r.wf.jobs)).toEqual(['step-1']);
    expect(r.unsupported).toEqual(['pipelines.default[0].parallel.fail-fast']);
  });
});

describe('FAC-PIP-002 services', () => {
  const defs = `definitions:
  services:
    db:
      image: postgres:16
      variables:
        POSTGRES_PASSWORD: $TOKEN
        POSTGRES_DB: app
    odd:
      image: custom/thing:1
`;
  it('[FAC-PIP-002] definitions.services with image and variables become job services', () => {
    const { wf } = only(`${defs}${pipeline('script:\n  - make\nservices:\n  - db\n  - odd')}`);
    expect(wf.jobs['step-1'].services).toEqual({
      db: {
        image: 'postgres:16',
        env: { POSTGRES_PASSWORD: '${{ secrets.TOKEN }}', POSTGRES_DB: 'app' },
        ports: ['5432:5432'],
      },
      odd: { image: 'custom/thing:1' },
    });
  });

  it('[FAC-PIP-002] the docker service is dropped', () => {
    const r = only(pipeline('script:\n  - make\nservices:\n  - docker'));
    expect(r.wf.jobs['step-1'].services).toBeUndefined();
    expect(r.unsupported).toEqual([]);
  });

  it('[FAC-PIP-002] a service with unsupported options, or an undefined one, is unsupported', () => {
    const r = only(`definitions:
  services:
    big:
      image: redis:7
      memory: 2048
${pipeline('script:\n  - make\nservices:\n  - big\n  - nope')}`);
    expect(r.wf.jobs['step-1'].services).toBeUndefined();
    expect(r.unsupported).toEqual([
      'pipelines.default[0].step.services[0]',
      'definitions.services.big.memory',
      'pipelines.default[0].step.services[1]',
    ]);
  });

  it('[FAC-PIP-002] a service variable that references an unknown variable is dropped and reported', () => {
    const r = only(`definitions:
  services:
    db:
      image: mysql:8
      variables:
        MYSQL_ROOT_PASSWORD: $NOPE
${pipeline('script:\n  - make\nservices:\n  - db')}`);
    expect(r.wf.jobs['step-1'].services.db.env).toBeUndefined();
    expect(r.unsupported).toEqual(['definitions.services.db.variables.MYSQL_ROOT_PASSWORD']);
  });

  it('[FAC-PIP-002] a job in a container gets no published ports', () => {
    const { wf } = only(
      `image: node:20\n${defs}${pipeline('script:\n  - make\nservices:\n  - db')}`,
    );
    expect(wf.jobs['step-1'].services.db.ports).toBeUndefined();
  });
});

describe('FAC-PIP-002 variables', () => {
  const inTrigger = (name: string, kind: 'default' | 'branch' | 'tag' | 'custom') => {
    const body = `script:\n  - echo "$${name}"`;
    const step = `    - step:\n${body.replace(/^/gm, '        ')}\n`;
    const source =
      kind === 'default'
        ? `pipelines:\n  default:\n${step}`
        : kind === 'custom'
          ? `pipelines:\n  custom:\n    run:\n${step}`
          : `pipelines:\n  ${kind === 'branch' ? 'branches' : 'tags'}:\n    x:\n${step}`;
    return only(source);
  };

  it.each(
    Object.entries(BUILT_IN_VARIABLES).filter(
      ([n]) => n !== 'BITBUCKET_BRANCH' && n !== 'BITBUCKET_TAG',
    ),
  )('[FAC-PIP-002] %s maps to %s through env', (name, expression) => {
    const r = only(pipeline(`script:\n  - echo "$${name}"`));
    expect(r.wf.jobs['step-1'].env).toEqual({ [name]: expression });
    expect(r.wf.jobs['step-1'].steps.at(-1).run).toBe(`echo "$${name}"`);
    expect(r.unsupported).toEqual([]);
  });

  it('[FAC-PIP-002] BITBUCKET_BRANCH is bound in branch and default workflows only; in the default one it is the head ref on pull requests', () => {
    expect(inTrigger('BITBUCKET_BRANCH', 'default').wf.jobs['step-1'].env).toEqual({
      BITBUCKET_BRANCH: '${{ github.head_ref || github.ref_name }}',
    });
    expect(inTrigger('BITBUCKET_BRANCH', 'branch').wf.jobs['step-1'].env).toEqual({
      BITBUCKET_BRANCH: '${{ github.ref_name }}',
    });
    for (const kind of ['tag', 'custom'] as const) {
      const r = inTrigger('BITBUCKET_BRANCH', kind);
      expect(r.wf.jobs['step-1'].env).toBeUndefined();
      expect(r.unsupported).toHaveLength(1);
    }
  });

  it('[FAC-PIP-002] BITBUCKET_TAG is bound in tag workflows only and reported as unset elsewhere', () => {
    expect(inTrigger('BITBUCKET_TAG', 'tag').wf.jobs['step-1'].env).toEqual({
      BITBUCKET_TAG: '${{ github.ref_name }}',
    });
    for (const kind of ['default', 'branch', 'custom'] as const) {
      const r = inTrigger('BITBUCKET_TAG', kind);
      expect(r.wf.jobs['step-1'].env).toBeUndefined();
      expect(r.unsupported).toHaveLength(1);
      expect(
        translate(`pipelines:\n  default:\n    - step: {script: ['echo $BITBUCKET_TAG']}\n`)
          .unsupported[0]?.reason,
      ).toBe('BITBUCKET_TAG is unset in this trigger');
    }
  });

  it('[FAC-PIP-002] the expected expressions are exactly the spec table', () => {
    expect(BUILT_IN_VARIABLES).toEqual({
      BITBUCKET_BRANCH: '${{ github.ref_name }}',
      BITBUCKET_TAG: '${{ github.ref_name }}',
      BITBUCKET_COMMIT: '${{ github.sha }}',
      BITBUCKET_BUILD_NUMBER: '${{ github.run_number }}',
      BITBUCKET_REPO_SLUG: '${{ github.event.repository.name }}',
      BITBUCKET_CLONE_DIR: '${{ github.workspace }}',
      BITBUCKET_PR_ID: '${{ github.event.pull_request.number }}',
      BITBUCKET_PR_DESTINATION_BRANCH: '${{ github.base_ref }}',
    });
  });

  it('[FAC-PIP-002] in a job with a container BITBUCKET_CLONE_DIR is exported from the runner workspace', () => {
    const r = only(
      `image: node:20\n${pipeline('script:\n  - ls "$BITBUCKET_CLONE_DIR"\nafter-script:\n  - ls "$BITBUCKET_CLONE_DIR"')}`,
    );
    const steps = r.wf.jobs['step-1'].steps;
    expect(r.wf.jobs['step-1'].env).toBeUndefined();
    expect(steps.at(-2).run).toBe(
      'export BITBUCKET_CLONE_DIR="$GITHUB_WORKSPACE"\nls "$BITBUCKET_CLONE_DIR"',
    );
    expect(steps.at(-1).run).toBe(
      'export BITBUCKET_CLONE_DIR="$GITHUB_WORKSPACE"\nls "$BITBUCKET_CLONE_DIR"',
    );
  });

  it('[FAC-PIP-002] BITBUCKET_DEPLOYMENT_ENVIRONMENT becomes the environment name literal', () => {
    const r = only(
      pipeline('deployment: Staging\nscript:\n  - echo $BITBUCKET_DEPLOYMENT_ENVIRONMENT'),
    );
    expect(r.wf.jobs['step-1'].env).toEqual({ BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'Staging' });
    const without = only(pipeline('script:\n  - echo $BITBUCKET_DEPLOYMENT_ENVIRONMENT'));
    expect(without.unsupported).toEqual(['pipelines.default[0].step.script[0]']);
  });

  it('[FAC-PIP-002] other BITBUCKET_ variables are unsupported at their script entry', () => {
    const r = only(pipeline('script:\n  - echo $BITBUCKET_STEP_UUID\n  - echo ok'));
    expect(r.unsupported).toEqual(['pipelines.default[0].step.script[0]']);
    expect(r.wf.jobs['step-1'].env).toBeUndefined();
  });

  it('[FAC-PIP-002] repository, deployment and workspace variables become env from vars or secrets', () => {
    const r = only(
      pipeline(
        'deployment: production\nscript:\n  - echo $API_URL $TOKEN ${REGION} $WS_VAR $WS_SECRET $UNKNOWN $HOME',
      ),
    );
    expect(r.wf.jobs['step-1'].env).toEqual({
      API_URL: '${{ vars.API_URL }}',
      TOKEN: '${{ secrets.TOKEN }}',
      REGION: '${{ vars.REGION }}',
      WS_VAR: '${{ vars.WS_VAR }}',
      WS_SECRET: '${{ secrets.WS_SECRET }}',
    });
  });

  it('[FAC-PIP-002] deployment variables are only visible to steps of that deployment', () => {
    const r = only(pipeline('script:\n  - echo $REGION'));
    expect(r.wf.jobs['step-1'].env).toBeUndefined();
  });

  it('[FAC-PIP-002] lower-case references find the upper-cased target name', () => {
    const r = only(pipeline('script:\n  - echo $api_url'));
    expect(r.wf.jobs['step-1'].env).toEqual({ api_url: '${{ vars.API_URL }}' });
  });

  it('[FAC-PIP-002] with no known variables nothing is bound', () => {
    const r = only(pipeline('script:\n  - echo $API_URL'), NO_NAMES);
    expect(r.wf.jobs['step-1'].env).toBeUndefined();
  });
});

describe('FAC-PIP-002 anchors and aliases', () => {
  it('[FAC-PIP-002] anchors, aliases and merge keys are resolved first', () => {
    const { wf } = only(`definitions:
  steps:
    - step: &build
        name: Build
        script: [make]
    - step: &opts
        max-time: 9
        clone: {depth: 2}
pipelines:
  default:
    - step: *build
    - step:
        <<: *opts
        script: [test]
`);
    expect(wf.jobs['step-1'].name).toBe('Build');
    expect(wf.jobs['step-2']['timeout-minutes']).toBe(9);
    expect(wf.jobs['step-2'].steps[0].with['fetch-depth']).toBe(2);
  });

  it('[FAC-PIP-002] an alias bomb is rejected, not expanded', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    let prev = 'a';
    for (let i = 0; i < 12; i++) {
      const name = `b${i}`;
      lines.push(`${name}: &${name} [${Array.from({ length: 9 }, () => `*${prev}`).join(', ')}]`);
      prev = name;
    }
    const r = translate(`${lines.join('\n')}\npipelines: {default: [{step: {script: [x]}}]}\n`);
    expect(r.workflows).toEqual([]);
    expect(r.unsupported.map((u) => u.path)).toEqual(['bitbucket-pipelines.yml']);
  });
});

describe('FAC-PIP-002 unsupported constructs', () => {
  const unsupportedOf = (body: string) => only(pipeline(`script:\n  - make\n${body}`)).unsupported;

  it('[FAC-PIP-002] pipe: is unsupported at the script entry and the other entries stay', () => {
    const r = only(
      pipeline(
        'script:\n  - make a\n  - pipe: acme/notify:1.0\n    variables:\n      X: y\n  - make b',
      ),
    );
    expect(r.unsupported).toEqual(['pipelines.default[0].step.script[1].pipe']);
    expect(r.wf.jobs['step-1'].steps.at(-1).run).toBe('make a\nmake b');
  });

  it('[FAC-PIP-002] non-string script entries are unsupported', () => {
    const r = only(pipeline('script:\n  - 42\n  - make'));
    expect(r.unsupported).toEqual(['pipelines.default[0].step.script[0]']);
  });

  it('[FAC-PIP-002] a condition omits only its own step', () => {
    const r = only(`pipelines:
  default:
    - step: {script: [a]}
    - step: {name: cond, condition: {changesets: {includePaths: ["x/**"]}}, script: [c]}
    - step: {script: [d]}
`);
    expect(Object.keys(r.wf.jobs)).toEqual(['step-1', 'step-2']);
    expect(r.wf.jobs['step-2'].needs).toEqual(['step-1']);
    expect(r.unsupported).toEqual(['pipelines.default[1].step.condition']);
  });

  it('[FAC-PIP-002] a manual step stops the pipeline: nothing after it is generated', () => {
    const r = only(`pipelines:
  branches:
    main:
      - step: {name: build, script: [make]}
      - step: {name: approve, trigger: manual, script: [echo ok]}
      - step: {name: deploy, deployment: production, script: [./deploy.sh]}
      - parallel:
          - step: {script: [x]}
      - stage: {steps: [{step: {script: [y]}}]}
`);
    expect(Object.keys(r.wf.jobs)).toEqual(['step-1']);
    expect(r.unsupported).toEqual([
      'pipelines.branches.main[1].step.trigger',
      'pipelines.branches.main[2]',
      'pipelines.branches.main[3]',
      'pipelines.branches.main[4]',
    ]);
    expect(r.text).not.toContain('./deploy.sh');
    expect(r.text).not.toContain('production');
  });

  it('[FAC-PIP-002] a manual step as the first step leaves no workflow for that pipeline', () => {
    const r = translate(`pipelines:
  default:
    - step: {trigger: manual, script: [a]}
    - step: {script: [deploy]}
`);
    expect(r.workflows).toEqual([]);
    expect(r.unsupported.map((u) => u.path)).toEqual([
      'pipelines.default[0].step.trigger',
      'pipelines.default[1]',
    ]);
  });

  it('[FAC-PIP-002] a manual step inside a stage or parallel group also stops the pipeline', () => {
    const stage = only(`pipelines:
  default:
    - step: {script: [a]}
    - stage: {steps: [{step: {trigger: manual, script: [b]}}]}
    - step: {script: [deploy]}
`);
    expect(Object.keys(stage.wf.jobs)).toEqual(['step-1']);
    expect(stage.unsupported).toContain('pipelines.default[2]');
    const parallel = only(`pipelines:
  default:
    - step: {script: [a]}
    - parallel:
        - step: {script: [b]}
        - step: {trigger: manual, script: [c]}
    - step: {script: [deploy]}
`);
    expect(Object.keys(parallel.wf.jobs)).toEqual(['step-1', 'step-2']);
    expect(parallel.unsupported).toContain('pipelines.default[2]');
  });

  it('[FAC-PIP-002] no step after a manual gate is generated in any workflow of a gated corpus', () => {
    const r = translate(`pipelines:
  default:
    - step: {script: [first]}
    - step: {trigger: manual, script: [gate]}
    - step: {script: [after-gate-secret-deploy]}
  custom:
    c:
      - step: {trigger: manual, script: [gate]}
      - step: {script: [after-gate-secret-deploy]}
  tags:
    'v*':
      - step: {script: [ok]}
`);
    for (const w of r.workflows) expect(w.content).not.toContain('after-gate-secret-deploy');
    expect(r.workflows.map((w) => w.path)).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/tag-v.yml',
    ]);
  });

  it('[FAC-PIP-002] trigger: automatic is the default and needs no translation', () => {
    expect(only(pipeline('trigger: automatic\nscript:\n  - make')).unsupported).toEqual([]);
  });

  it('[FAC-PIP-002] oidc, runs-on and size are unsupported', () => {
    expect(unsupportedOf('oidc: true\nruns-on: [self.hosted]\nsize: 2x')).toEqual([
      'pipelines.default[0].step.oidc',
      'pipelines.default[0].step.runs-on',
      'pipelines.default[0].step.size',
    ]);
  });

  it('[FAC-PIP-002] pull-requests: triggers are unsupported', () => {
    const r = only(`pipelines:
  default:
    - step: {script: [a]}
  pull-requests:
    '**':
      - step: {script: [b]}
`);
    expect(r.unsupported).toEqual(['pipelines.pull-requests']);
    expect(r.text).toContain('# TODO(git-migrator): pipelines.pull-requests — ');
  });

  it('[FAC-PIP-002] stages are unsupported', () => {
    const r = only(`pipelines:
  default:
    - stage:
        steps:
          - step: {script: [a]}
    - step: {script: [b]}
`);
    expect(r.unsupported).toEqual(['pipelines.default[0].stage']);
    expect(Object.keys(r.wf.jobs)).toEqual(['step-1']);
  });

  it('[FAC-PIP-002] top-level options, clone and unknown definitions are unsupported', () => {
    const r = only(`options: {docker: true}
clone: {depth: 1}
definitions:
  pipelines: {}
  steps: []
${pipeline('script:\n  - make')}`);
    expect(r.unsupported).toEqual(['options', 'clone', 'definitions.pipelines']);
  });

  it('[FAC-PIP-002] unknown step keys are unsupported', () => {
    expect(unsupportedOf('fail-fast: true')).toEqual(['pipelines.default[0].step.fail-fast']);
  });

  it('[FAC-PIP-002] prompted variables of a custom pipeline are unsupported', () => {
    const r = only(`pipelines:
  custom:
    rel:
      - variables:
          - name: V
      - step: {script: [a]}
`);
    expect(r.unsupported).toEqual(['pipelines.custom.rel[0].variables']);
  });

  it('[FAC-PIP-002] every unsupported path has a TODO(git-migrator) comment with its reason', () => {
    const withStep = translate(pipeline('script:\n  - make\n  - pipe: x/y:1\noidc: true'));
    const text = (withStep.workflows[0] as { content: string }).content;
    for (const u of withStep.unsupported) {
      expect(text).toContain(`# TODO(git-migrator): ${u.path} — ${u.reason}`);
    }
    expect(withStep.unsupported).toHaveLength(2);
  });
});

describe('FAC-PIP-002 malformed input', () => {
  it.each([
    ['not YAML', 'pipelines: [unclosed'],
    ['a list', '- a\n- b\n'],
    ['a scalar', 'hello'],
    ['empty', ''],
  ])('[FAC-PIP-002] %s yields no workflow and one unsupported path', (_name, text) => {
    const r = translate(text);
    expect(r.workflows).toEqual([]);
    expect(r.unsupported).toHaveLength(1);
  });

  it('[FAC-PIP-002] a file without pipelines is unsupported', () => {
    const r = translate('image: node:20\n');
    expect(r.workflows).toEqual([]);
    expect(r.unsupported.map((u) => u.path)).toEqual(['pipelines']);
  });

  it('[FAC-PIP-002] an oversized file is not parsed', () => {
    const r = translate(`#${'x'.repeat(MAX_SOURCE_LENGTH)}\npipelines: {}\n`);
    expect(r.workflows).toEqual([]);
    expect(r.unsupported[0]?.reason).toContain('too large');
  });

  it('[FAC-PIP-002] duplicate keys are invalid YAML', () => {
    const r = translate('pipelines:\n  default: []\n  default: []\n');
    expect(r.workflows).toEqual([]);
  });

  it('[FAC-PIP-002] steps that are not mappings, and empty pipelines, are unsupported', () => {
    const r = translate(`pipelines:
  default: not-a-list
  branches:
    main:
      - 5
      - step: nope
      - step: {script: []}
`);
    expect(r.workflows).toEqual([]);
    expect(r.unsupported.map((u) => u.path)).toEqual([
      'pipelines.default',
      'pipelines.branches.main[0]',
      'pipelines.branches.main[1].step',
      'pipelines.branches.main[2].step.script',
    ]);
  });

  it('[FAC-PIP-002] keys like __proto__ and constructor never reach a prototype', () => {
    const r = translate(`pipelines:
  default:
    - step:
        script: [make]
        constructor: x
        caches: [constructor, __proto__, toString]
        services: [constructor]
  __proto__: x
`);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(r.unsupported.map((u) => u.path)).toContain('pipelines.default[0].step.caches[0]');
    expect(r.unsupported.map((u) => u.path)).toContain('pipelines.default[0].step.services[0]');
  });
});

describe('FAC-PIP-002 overlapping patterns', () => {
  const branches = (...globs: string[]) =>
    translate(
      `pipelines:\n  branches:\n${globs.map((g) => `    '${g}':\n      - step: {script: [x]}`).join('\n')}\n`,
    );
  const on = (r: ReturnType<typeof translate>, file: string) =>
    (parse((r.workflows.find((w) => w.path.endsWith(file)) as { content: string }).content) as Json)
      .on.push.branches;

  it("[FAC-PIP-002] the '**' workflow excludes a literal branch that has its own pipeline", () => {
    const r = branches('main', '**');
    expect(on(r, 'branch-pipeline.yml')).toEqual(['**', '!main']);
    expect(on(r, 'branch-main.yml')).toEqual(['main']);
    expect(r.unsupported).toEqual([]);
  });

  it('[FAC-PIP-002] a wider pattern excludes the narrower ones whatever their order', () => {
    const r = branches('release/hotfix-*', 'release/1.0', 'release/**');
    expect(on(r, 'branch-release.yml')).toEqual([
      'release/**',
      '!release/hotfix-*',
      '!release/1.0',
    ]);
    expect(on(r, 'branch-release-hotfix.yml')).toEqual(['release/hotfix-*']);
    expect(r.unsupported).toEqual([]);
  });

  it('[FAC-PIP-002] disjoint patterns need no exclusions', () => {
    const r = branches('feature/*', 'bugfix/*', 'main');
    expect(on(r, 'branch-feature.yml')).toEqual(['feature/*']);
    expect(r.unsupported).toEqual([]);
  });

  it('[FAC-PIP-002] patterns that overlap and cannot be ordered are both unsupported', () => {
    const r = branches('feat*', '*fix');
    expect(r.unsupported.map((u) => u.path)).toEqual([
      "pipelines.branches['feat*']",
      "pipelines.branches['*fix']",
    ]);
  });

  it('[FAC-PIP-002] tag patterns are compared among tags only', () => {
    const r = translate(`pipelines:
  branches:
    main: [{step: {script: [a]}}]
  tags:
    '**': [{step: {script: [b]}}]
    'v1': [{step: {script: [c]}}]
`);
    const tags = (
      parse(
        (r.workflows.find((w) => w.path.endsWith('tag-pipeline.yml')) as { content: string })
          .content,
      ) as Json
    ).on.push.tags;
    expect(tags).toEqual(['**', '!v1']);
  });

  it.each([
    ['**', 'anything/at/all', true],
    ['feature/*', 'feature/x', true],
    ['feature/*', 'feature/x/y', false],
    ['feature/**', 'feature/x/y', true],
    ['*fix', 'hotfix', true],
    ['a*b', 'a/b', false],
    ['main', 'main', true],
    ['main', 'mainx', false],
  ])('[FAC-PIP-002] glob %s against %s is %s', (pattern, text, expected) => {
    expect(globMatches(pattern as string, text as string)).toBe(expected);
  });
});

describe('FAC-PIP-002 limits and plain YAML', () => {
  it('[FAC-PIP-002] 500 artifact-producing steps finish quickly, are capped and reported', () => {
    const steps = Array.from(
      { length: 500 },
      (_, i) => `    - step:\n        script: [make ${i}]\n        artifacts: [out${i}/**]`,
    ).join('\n');
    const started = Date.now();
    const r = translate(`pipelines:\n  default:\n${steps}\n`);
    expect(Date.now() - started).toBeLessThan(5000);
    const w = r.workflows[0] as { content: string };
    expect(Object.keys((parse(w.content) as Json).jobs)).toHaveLength(MAX_JOBS_PER_WORKFLOW);
    expect(w.content.length).toBeLessThan(MAX_WORKFLOW_BYTES);
    expect(r.unsupported).toHaveLength(500 - MAX_JOBS_PER_WORKFLOW);
    expect(r.unsupported[0]?.path).toBe(`pipelines.default[${MAX_JOBS_PER_WORKFLOW}].step`);
  });

  it('[FAC-PIP-002] many pipelines are capped in total', () => {
    const pipelines = Array.from(
      { length: 300 },
      (_, i) => `    b${i}:\n      - step: {script: [make]}\n      - step: {script: [more]}`,
    ).join('\n');
    const r = translate(`pipelines:\n  branches:\n${pipelines}\n`);
    const jobs = r.workflows.reduce(
      (n, w) => n + Object.keys((parse(w.content) as Json).jobs).length,
      0,
    );
    expect(jobs).toBeLessThanOrEqual(MAX_TOTAL_JOBS);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('[FAC-PIP-002] a small file that aliases a big script cannot build an unbounded workflow', () => {
    const big = 'x'.repeat(300_000);
    const aliases = Array.from({ length: 40 }, () => '    - step: *s').join('\n');
    const r = translate(
      `definitions:\n  steps:\n    - step: &s\n        script: ["${big}"]\npipelines:\n  default:\n${aliases}\n`,
    );
    for (const w of r.workflows) expect(w.content.length).toBeLessThanOrEqual(MAX_WORKFLOW_BYTES);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('[FAC-PIP-002] the number of reported paths is bounded', () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `k${i}: 1`).join('\n');
    const r = translate(`${keys}\npipelines:\n  default:\n    - step: {script: [a]}\n`);
    expect(r.unsupported.length).toBeLessThanOrEqual(MAX_REPORTS + 1);
    expect(
      r.unsupported.some(
        (u) => u.reason === 'the file has more steps or script text than are translated',
      ),
    ).toBe(true);
  });

  it('[FAC-PIP-002] empty pipelines and empty lists are unsupported', () => {
    expect(translate('pipelines: {}\n').unsupported.map((u) => u.path)).toEqual(['pipelines']);
    const lists = translate('pipelines:\n  default: []\n  branches: {}\n  custom:\n    x: []\n');
    expect(lists.workflows).toEqual([]);
    expect(lists.unsupported.map((u) => u.path)).toEqual([
      'pipelines.default',
      'pipelines.branches',
      'pipelines.custom.x',
    ]);
  });

  it('[FAC-PIP-002] YAML that is not plain data (omap, sets, binary, timestamps) is unsupported', () => {
    for (const body of [
      'pipelines:\n  default: !!omap\n    - step: {script: [a]}\n',
      'pipelines: !!set {a, b}\n',
      'pipelines:\n  default:\n    - step: {script: [a], max-time: !!timestamp 2001-12-14}\n',
    ]) {
      const r = translate(body);
      expect(r.unsupported.length).toBeGreaterThan(0);
    }
  });

  it('[FAC-PIP-002] isMapping accepts plain objects only', () => {
    expect(isMapping({})).toBe(true);
    expect(isMapping(Object.create(null))).toBe(true);
    for (const v of [new Map(), new Set(), new Date(), [], null, 'x', 1]) {
      expect(isMapping(v)).toBe(false);
    }
  });
});

describe('FAC-PIP-002 overlap and file order', () => {
  it('[FAC-PIP-002] a broader pattern listed before a narrower one is reported on both, exclusions kept', () => {
    const r = translate(
      "pipelines:\n  branches:\n    '**': [{step: {script: [a]}}]\n    main: [{step: {script: [b]}}]\n",
    );
    expect(r.unsupported.map((u) => u.path)).toEqual([
      "pipelines.branches['**']",
      'pipelines.branches.main',
    ]);
    expect(r.unsupported[0]?.reason).toContain('file order');
    const wide = r.workflows.find((w) => w.path.endsWith('branch-pipeline.yml')) as {
      content: string;
    };
    expect(wide.content).toContain('- "!main"');
  });
});

describe('FAC-PIP-002 gates in nested positions', () => {
  it('[FAC-PIP-002] a manual stage inside a parallel group stops the pipeline', () => {
    const r = only(`pipelines:
  default:
    - step: {script: [a]}
    - parallel:
        - step: {script: [b]}
        - stage: {steps: [{step: {trigger: manual, script: [m]}}]}
    - step: {deployment: production, script: [deploy]}
`);
    expect(Object.keys(r.wf.jobs)).toEqual(['step-1', 'step-2']);
    expect(r.text).not.toContain('deploy');
    expect(r.unsupported).toContain('pipelines.default[2]');
  });

  it('[FAC-PIP-002] sibling keys of a gated item do not run', () => {
    const r = only(`pipelines:
  default:
    - step: {script: [a]}
    - stage: {steps: [{step: {trigger: manual, script: [m]}}]}
      step: {script: [sibling-after-gate]}
`);
    expect(Object.keys(r.wf.jobs)).toEqual(['step-1']);
    expect(r.text).not.toContain('sibling-after-gate');
    expect(r.unsupported).toContain('pipelines.default[1].step');
  });
});

describe('FAC-PIP-002 list bounds under aliases', () => {
  const aliased = (step: string, n = 50) =>
    `definitions:\n  steps:\n    - step: &s\n${step}\npipelines:\n  default:\n${Array.from({ length: n }, () => '    - step: *s').join('\n')}\n`;
  const timed = (source: string) => {
    const started = Date.now();
    const r = translate(source);
    expect(Date.now() - started).toBeLessThan(2000);
    return r;
  };

  it('[FAC-PIP-002] 20,000 caches in an aliased step give a small result', () => {
    const caches = Array.from({ length: 20_000 }, () => '          - node').join('\n');
    const r = timed(aliased(`        script: [make]\n        caches:\n${caches}`));
    const w = r.workflows[0] as { content: string };
    expect(w.content.length).toBeLessThan(200_000);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('[FAC-PIP-002] 20,000 distinct caches are capped per step', () => {
    const caches = Array.from({ length: 20_000 }, (_, i) => `          - c${i}`).join('\n');
    const r = timed(aliased(`        script: [make]\n        caches:\n${caches}`, 5));
    for (const w of r.workflows) expect(w.content.length).toBeLessThan(MAX_WORKFLOW_BYTES);
    expect(r.unsupported.length).toBeLessThanOrEqual(501);
  });

  it('[FAC-PIP-002] 20,000 services in an aliased step give a small result', () => {
    const list = Array.from({ length: 20_000 }, (_, i) => `          - s${i}`).join('\n');
    const r = timed(aliased(`        script: [make]\n        services:\n${list}`));
    for (const w of r.workflows) expect(w.content.length).toBeLessThan(MAX_WORKFLOW_BYTES);
  });

  it('[FAC-PIP-002] 20,000 artifact globs in an aliased step give a small result', () => {
    const list = Array.from({ length: 20_000 }, (_, i) => `          - out${i}/**`).join('\n');
    const r = timed(aliased(`        script: [make]\n        artifacts:\n${list}`));
    for (const w of r.workflows) expect(w.content.length).toBeLessThan(MAX_WORKFLOW_BYTES);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('[FAC-PIP-002] 20,000 after-script and script entries are capped', () => {
    const list = Array.from({ length: 20_000 }, (_, i) => `          - echo ${i}`).join('\n');
    const r = timed(aliased(`        script: [make]\n        after-script:\n${list}`));
    for (const w of r.workflows) expect(w.content.length).toBeLessThan(MAX_WORKFLOW_BYTES);
  });

  it('[FAC-PIP-002] a workflow stops growing once its estimated size passes the limit', () => {
    const big = 'x'.repeat(900_000);
    const r = translate(
      `definitions:\n  steps:\n    - step: &s\n        script: ["${big}"]\npipelines:\n  default:\n${Array.from({ length: 6 }, () => '    - step: *s').join('\n')}\n`,
    );
    for (const w of r.workflows) expect(w.content.length).toBeLessThanOrEqual(MAX_WORKFLOW_BYTES);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });
});

describe('FAC-PIP-002 patterns at scale and hidden gates', () => {
  it('[FAC-PIP-002] 500 wildcard patterns and 12,000 literal keys finish in seconds (the quadratic version took minutes)', () => {
    const wild = Array.from(
      { length: 500 },
      (_, i) => `    'w${i}/*':\n      - step: {script: [a]}`,
    );
    const lits = Array.from({ length: 12_000 }, (_, i) => `    l${i}: [{step: {script: [a]}}]`);
    const started = Date.now();
    const r = translate(`pipelines:\n  branches:\n${[...wild, ...lits].join('\n')}\n`);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.workflows.length).toBeLessThanOrEqual(MAX_PATTERNS);
    for (const w of r.workflows) expect(w.content.length).toBeLessThan(200_000);
    expect(r.unsupported.some((u) => u.path === `pipelines.branches[${MAX_PATTERNS}]`)).toBe(true);
  });

  it('[FAC-PIP-002] a workflow that would need more exclusions than the bound is not written', () => {
    const many = Array.from(
      { length: MAX_EXCLUSIONS + 1 },
      (_, i) => `    'a${i}':\n      - step: {script: [a]}`,
    );
    const r = translate(
      `pipelines:\n  branches:\n    '**':\n      - step: {script: [wide]}\n${many.join('\n')}\n`,
    );
    // 101 siblings are examined at most (the bound is on patterns), so '**' keeps its exclusions
    // only while they fit; either way no workflow runs wider than intended.
    const wide = r.workflows.find((w) => w.path.endsWith('branch-pipeline.yml'));
    if (wide !== undefined) {
      expect(
        ((parse(wide.content) as Json).on.push.branches as string[]).length,
      ).toBeLessThanOrEqual(MAX_EXCLUSIONS + 1);
    }
  });

  const filler = (n: number) => Array.from({ length: n }, () => '{foo: 1}').join(', ');

  it('[FAC-PIP-002] a manual step in the truncated tail of a parallel group still halts the pipeline', () => {
    const r = only(`pipelines:
  default:
    - step: {script: [build]}
    - parallel: [${filler(MAX_LIST_ENTRIES)}, {step: {trigger: manual, script: [m]}}]
    - step: {deployment: production, script: [deploy]}
`);
    expect(Object.keys(r.wf.jobs)).toEqual(['step-1']);
    expect(r.text).not.toContain('deploy');
    expect(r.unsupported).toContain('pipelines.default[2]');
  });

  it('[FAC-PIP-002] a manual step in the tail of a long stage halts the pipeline', () => {
    const steps = Array.from(
      { length: 300 },
      (_, i) => `{step: {trigger: ${i === 299 ? 'manual' : 'automatic'}, script: [x]}}`,
    ).join(', ');
    const r = only(`pipelines:
  default:
    - step: {script: [build]}
    - stage: {steps: [${steps}]}
    - step: {deployment: production, script: [deploy]}
`);
    expect(r.text).not.toContain('deploy');
  });

  it('[FAC-PIP-002] a gate key behind 200 other keys of a step or an item is still seen', () => {
    const keys = Array.from({ length: MAX_LIST_ENTRIES + 5 }, (_, i) => `k${i}: 1`).join(', ');
    const step = only(`pipelines:
  default:
    - step: {script: [a]}
    - step: {${keys}, trigger: manual, script: [m]}
    - step: {script: [deploy]}
`);
    expect(step.text).not.toContain('deploy');
    const item = only(`pipelines:
  default:
    - step: {script: [a]}
    - {${keys}, parallel: [{step: {trigger: manual, script: [m]}}]}
    - step: {script: [deploy]}
`);
    expect(item.text).not.toContain('deploy');
  });

  it('[FAC-PIP-002] a hostile aliased step with huge cache keys, service env and unknown keys stays bounded', () => {
    const files = Array.from({ length: 20 }, (_, i) => `- ${'f'.repeat(240)}${i}`).join(
      '\n          ',
    );
    const unknown = Array.from({ length: 20_000 }, (_, i) => `u${i}: 1`).join(', ');
    const env = Array.from({ length: 20_000 }, (_, i) => `V${i}: ${'v'.repeat(1000)}`).join(
      '\n          ',
    );
    const source = `definitions:
  caches:
    big:
      path: ${'p'.repeat(500)}
      key:
        files:
          ${files}
  services:
    db:
      image: postgres:16
      variables:
          ${env}
  steps:
    - step: &s
        script: [make]
        caches: [big]
        services: [db]
        ${unknown ? `x: {${unknown}}` : ''}
pipelines:
  default:
${Array.from({ length: 50 }, () => '    - step: *s').join('\n')}
`;
    const started = Date.now();
    const r = translate(source);
    expect(Date.now() - started).toBeLessThan(3000);
    for (const w of r.workflows) expect(w.content.length).toBeLessThan(MAX_WORKFLOW_BYTES);
  });

  it('[FAC-PIP-002] once the estimate passes the limit no step is added and the rest is reported', () => {
    const big = 'x'.repeat(250_000);
    const r = translate(
      `definitions:\n  steps:\n    - step: &s\n        script: ["${big}"]\npipelines:\n  default:\n${Array.from({ length: 12 }, () => '    - step: *s').join('\n')}\n`,
    );
    const w = r.workflows[0] as { content: string };
    expect(w.content.length).toBeLessThanOrEqual(WORKFLOW_ESTIMATE_LIMIT);
    expect(Object.keys((parse(w.content) as Json).jobs).length).toBeGreaterThan(0);
    expect(r.unsupported.some((u) => u.reason.includes('too large'))).toBe(true);
  });

  it('[FAC-PIP-002] integer-like branch keys keep their file order in the overlap check', () => {
    const r = translate(
      "pipelines:\n  branches:\n    '**': [{step: {script: [a]}}]\n    '2024': [{step: {script: [b]}}]\n",
    );
    expect(r.unsupported.map((u) => u.reason.includes('file order'))).toEqual([true, true]);
    const specificFirst = translate(
      "pipelines:\n  branches:\n    '2024': [{step: {script: [b]}}]\n    '**': [{step: {script: [a]}}]\n",
    );
    expect(specificFirst.unsupported).toEqual([]);
  });
});
