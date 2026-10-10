import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ciValueFiles,
  DEFAULT_CHART,
  helmCheck,
  KUBERNETES_VERSION,
  parseArgs,
} from './helm-check.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const dockerfile = read('deploy/docker/Dockerfile');
const entrypoint = join(root, 'deploy/docker/entrypoint.sh');

describe('image (DEP-001)', () => {
  it('[DEP-001] has the stages secretspec-cli, base, dev, build, runtime in order, runtime last', () => {
    const stages = [...dockerfile.matchAll(/^FROM .* AS (\S+)$/gm)].map((m) => m[1]);
    expect(stages).toEqual(['secretspec-cli', 'base', 'dev', 'build', 'runtime']);
  });

  it('[DEP-001] the runtime stage creates gm with UID and GID 10001 and runs as 10001', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime).toMatch(/groupadd --gid 10001 gm/);
    expect(runtime).toMatch(/useradd --uid 10001 --gid 10001 --home-dir \/home\/gm/);
    expect(runtime).toMatch(/^USER 10001:10001$/m);
    expect(runtime).not.toMatch(/^USER (root|0)/m);
  });

  it('[DEP-001] the entrypoint is tini plus entrypoint.sh, and the default command is web', () => {
    expect(dockerfile).toMatch(/^ENTRYPOINT \["tini", "-g", "--", "\/app\/bin\/entrypoint.sh"\]$/m);
    expect(dockerfile).toMatch(/^CMD \["web"\]$/m);
    expect(dockerfile).toMatch(
      /COPY --chmod=0755 deploy\/docker\/entrypoint.sh \/app\/bin\/entrypoint.sh/,
    );
  });

  it('[DEP-001] git is configured system-wide with no askPass helper (ADP-071)', () => {
    const base = dockerfile.slice(dockerfile.indexOf('AS base'), dockerfile.indexOf('AS dev'));
    expect(base).toContain('git config --system init.defaultBranch main');
    expect(base).toContain('git config --system lfs.concurrenttransfers 8');
    expect(base).toContain('--unset-all core.askPass');
  });

  it('[DEP-001] the build stage installs, generates, builds and prunes to production dependencies', () => {
    const build = dockerfile.slice(
      dockerfile.indexOf('AS build'),
      dockerfile.indexOf('AS runtime'),
    );
    const order = [
      'pnpm install --frozen-lockfile',
      'pnpm generate',
      'pnpm turbo run build',
      'pnpm install --frozen-lockfile --prod',
    ].map((step) => build.indexOf(step));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('[DEP-002] each /app/dist/<command>.js shim imports an entrypoint that exists and runs it', () => {
    const shims: Record<string, string> = {
      web: 'apps/web/src/web.ts',
      worker: 'apps/worker/src/worker.ts',
      migrate: 'apps/worker/src/migrate.ts',
    };
    for (const [command, source] of Object.entries(shims)) {
      expect(dockerfile).toContain(`../${source}`);
      expect(dockerfile).toContain(`/app/dist/${command}.js`);
      expect(existsSync(join(root, source))).toBe(true);
    }
    // web and worker are guarded by import.meta.main, so their shims call the exported main().
    expect(read('apps/web/src/web.ts')).toMatch(/export async function main\(\)/);
    expect(read('apps/worker/src/worker.ts')).toMatch(/export async function main\(\)/);
  });

  it('[DEP-002] web.js starts the Next.js standalone server, with its static assets, in the image', () => {
    // next build writes the standalone server for apps/web.
    expect(read('apps/web/next.config.ts')).toMatch(/output: 'standalone'/);
    // web.ts (the web shim's entrypoint) loads that build and serves it; it no longer serves the
    // API on its own.
    const web = read('apps/web/src/web.ts');
    expect(web).toMatch(/'\.next', 'standalone', 'apps', 'web'/);
    expect(web).toMatch(/await prepareNextHandler\(/);
    expect(web).toMatch(/startWebServer\(\{ handler: nextApp\.handler/);
    expect(web).not.toMatch(/runtime\.app\.fetch/);
    // The build stage completes the standalone folder after `next build` and before the prune.
    const build = dockerfile.slice(
      dockerfile.indexOf('AS build'),
      dockerfile.indexOf('AS runtime'),
    );
    const standalone = 'apps/web/.next/standalone/apps/web';
    expect(build).toContain(`standalone=${standalone}`);
    expect(build).toContain('test -f "$standalone/server.js"');
    expect(build).toContain('cp -R apps/web/.next/static "$standalone/.next/static"');
    expect(build).toContain('cp -R apps/web/public "$standalone/public"');
    const order = ['pnpm turbo run build', 'cp -R apps/web/.next/static', '--prod'].map((s) =>
      build.indexOf(s),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The runtime stage copies apps/, which holds the standalone folder.
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime).toContain('COPY --from=build /app/apps ./apps');
  });

  it('[DEP-003] the standalone server caches under the chart-mounted .next/cache', () => {
    const build = dockerfile.slice(
      dockerfile.indexOf('AS build'),
      dockerfile.indexOf('AS runtime'),
    );
    // standalone/apps/web/.next/cache -> apps/web/.next/cache, the emptyDir mount of the chart.
    expect(build).toContain('ln -s ../../../../cache "$standalone/.next/cache"');
    expect(build).toContain('mkdir apps/web/.next/cache');
    // A cache directory that next build left in the standalone folder would make ln -s create
    // the link inside it instead of failing.
    expect(build.indexOf('test ! -e "$standalone/.next/cache"')).toBeGreaterThan(-1);
    expect(build.indexOf('test ! -e "$standalone/.next/cache"')).toBeLessThan(
      build.indexOf('ln -s ../../../../cache'),
    );
    // The smoke test writes through the link and finds the file on the mounted volume.
    expect(read('deploy/docker/smoke.sh')).toContain(
      'touch /app/apps/web/.next/standalone/apps/web/.next/cache/.w && test -f /app/apps/web/.next/cache/.w',
    );
    const linkDir = 'apps/web/.next/standalone/apps/web/.next';
    expect(join('/app', linkDir, '../../../../cache')).toBe('/app/apps/web/.next/cache');
    expect(read('deploy/helm/git-migrator/templates/deployment-web.yaml')).toContain(
      'mountPath: /app/apps/web/.next/cache',
    );
    expect(read('deploy/docker/smoke.sh')).toContain('--tmpfs /app/apps/web/.next/cache');
  });

  it('[DEP-003] the image sets HOME, GM_SCRATCH_DIR and TMPDIR and owns the scratch directory', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime).toMatch(/HOME=\/home\/gm/);
    expect(runtime).toMatch(/GM_SCRATCH_DIR=\/scratch/);
    expect(runtime).toMatch(/TMPDIR=\/tmp/);
    expect(runtime).toMatch(/install -d -o 10001 -g 10001 -m 0755 \/scratch/);
  });

  it('[DEP-001] no secret or key material is copied into the image', () => {
    expect(dockerfile).not.toMatch(/\.pem|\.env|PRIVATE KEY/);
    const ignore = read('.dockerignore');
    expect(ignore).toContain('**/*.pem');
    expect(ignore).toContain('**/.env');
  });
});

describe('entrypoint.sh (DEP-002)', () => {
  let dir: string;
  let log: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gm-entrypoint-'));
    log = join(dir, 'calls.log');
    for (const name of ['node', 'secretspec']) {
      const stub = join(dir, name);
      writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "${log}"\n`);
      chmodSync(stub, 0o755);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[], env: Record<string, string> = {}) {
    rmSync(log, { force: true });
    const result = spawnSync('sh', [entrypoint, ...args], {
      env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
      encoding: 'utf8',
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim() : '';
    return { status: result.status, stderr: result.stderr, calls };
  }

  it('[DEP-002] without a secretspec provider it starts node on /app/dist/<command>.js', () => {
    expect(run(['web']).calls).toBe('node /app/dist/web.js');
  });

  it('[DEP-002] it passes the remaining arguments through (worker --role)', () => {
    expect(run(['worker', '--role', 'large']).calls).toBe('node /app/dist/worker.js --role large');
  });

  it('[DEP-002][DEP-020] with a provider it wraps node in secretspec run for the production profile', () => {
    const { calls } = run(['migrate'], {
      GM_SECRETSPEC_PROVIDER: 'akv://kv?auth=workload_identity',
    });
    expect(calls).toBe(
      'secretspec run --profile production --provider akv://kv?auth=workload_identity -- node /app/dist/migrate.js',
    );
  });

  it('[DEP-002] GM_SECRETSPEC_PROFILE selects the profile', () => {
    const { calls } = run(['web'], {
      GM_SECRETSPEC_PROVIDER: 'p',
      GM_SECRETSPEC_PROFILE: 'staging',
    });
    expect(calls).toContain('--profile staging');
  });

  it('[DEP-002] an unknown or missing command exits 64 and starts nothing', () => {
    const unknown = run(['shell']);
    expect(unknown.status).toBe(64);
    expect(unknown.calls).toBe('');
    expect(run([]).status).toBe(64);
  });

  it('[DEP-002] the script is POSIX sh (no bash shebang) and executable', () => {
    expect(read('deploy/docker/entrypoint.sh').startsWith('#!/bin/sh\n')).toBe(true);
    expect(spawnSync('test', ['-x', entrypoint]).status).toBe(0);
  });
});

describe('chart values (DEP-031)', () => {
  const values = parse(read('deploy/helm/git-migrator/values.yaml')) as Record<string, any>;

  it('[DEP-031] has the values surface of the spec with its defaults', () => {
    expect(Object.keys(values)).toEqual(
      expect.arrayContaining([
        'image',
        'imagePullSecrets',
        'serviceAccount',
        'azure',
        'secretspec',
        'postgres',
        'web',
        'worker',
        'migrateJob',
        'ingress',
        'metrics',
        'networkPolicy',
        'observability',
        'config',
      ]),
    );
    expect(values.image).toMatchObject({
      registry: 'ghcr.io',
      tag: '',
      pullPolicy: 'IfNotPresent',
    });
    expect(values.postgres).toMatchObject({
      port: 5432,
      sslmode: 'require',
      auth: 'password',
      pool: { app: 10 },
    });
    expect(values.web).toMatchObject({
      replicas: 2,
      hpa: { enabled: false },
      pdb: { enabled: false },
    });
    expect(values.worker.standard).toMatchObject({
      replicas: 2,
      concurrency: { runs: 4, analysis: 8, inventory: 2, parity: 4 },
      scratch: { sizeLimit: '15Gi' },
    });
    expect(values.worker.large).toMatchObject({
      replicas: 1,
      concurrency: { runs: 1 },
      scratch: { size: '60Gi' },
    });
    expect(values.ingress).toMatchObject({ enabled: true, className: 'nginx' });
    expect(values.metrics).toEqual({ enabled: true, port: 9464 });
    expect(values.config).toEqual({});
  });

  it('[DEP-031] ships no secret: no credential-like key holds a value', () => {
    const text = read('deploy/helm/git-migrator/values.yaml');
    expect(text).not.toMatch(
      /^\s*(password|apiToken|privateKey|clientSecret|authSecret)\w*:\s*\S/im,
    );
  });

  it('[DEP-033] every ci value file parses and the chart has a unit-test suite', () => {
    const files = ciValueFiles(DEFAULT_CHART);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) expect(parse(readFileSync(file, 'utf8'))).toBeTypeOf('object');
    expect(existsSync(join(DEFAULT_CHART, 'tests'))).toBe(true);
  });

  it('[DEP-030] has the templates the spec lists', () => {
    for (const name of [
      'deployment-web',
      'deployment-worker-standard',
      'deployment-worker-large',
      'job-migrate',
      'configmap',
      'serviceaccount',
      'service',
      'ingress',
      'hpa',
      'pdb',
      'networkpolicy',
    ]) {
      expect(existsSync(join(DEFAULT_CHART, 'templates', `${name}.yaml`))).toBe(true);
    }
  });

  it('[DEP-010] every workload template uses the shared security context helpers', () => {
    for (const name of [
      'deployment-web',
      'deployment-worker-standard',
      'deployment-worker-large',
      'job-migrate',
    ]) {
      const text = read(`deploy/helm/git-migrator/templates/${name}.yaml`);
      expect(text).toContain('git-migrator.podSecurityContext');
      expect(text).toContain('git-migrator.containerSecurityContext');
      expect(text).toContain('automountServiceAccountToken: false');
    }
    const helpers = read('deploy/helm/git-migrator/templates/_helpers.tpl');
    expect(helpers).toContain('readOnlyRootFilesystem: true');
    expect(helpers).toContain('runAsUser: 10001');
    expect(helpers).toContain('allowPrivilegeEscalation: false');
    expect(helpers).toContain('drop: ["ALL"]');
  });
});

describe('helm:check (DEP-033)', () => {
  it('[DEP-033] parses its arguments and rejects unknown ones', () => {
    expect(parseArgs([], {}).kubeVersion).toBe(KUBERNETES_VERSION);
    expect(parseArgs(['--kube-version', '1.35.1'], {}).kubeVersion).toBe('1.35.1');
    expect(() => parseArgs(['--kube-version', 'latest'], {})).toThrow(/look like/);
    expect(() => parseArgs(['--chart'], {})).toThrow(/needs a value/);
    expect(() => parseArgs(['--nope'], {})).toThrow(/unknown argument/);
  });

  it('[DEP-033] requires helm-unittest under CI and when asked', () => {
    expect(parseArgs([], { CI: 'true' }).requireUnittest).toBe(true);
    expect(parseArgs([], {}).requireUnittest).toBe(false);
    expect(parseArgs(['--require-unittest'], {}).requireUnittest).toBe(true);
  });

  it('[DEP-033] fails, naming the tools, when helm or kubeconform is missing', () => {
    const lines: string[] = [];
    const code = helmCheck(parseArgs([], {}), { PATH: '' }, (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/missing tools on PATH: helm, kubeconform/);
  });

  it('[DEP-033] the root helm:check script runs this tool', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['helm:check']).toBe('node tools/helm-check.ts');
  });
});

describe('workflows (DEP-060)', () => {
  const release = parse(read('.github/workflows/release.yml')) as Record<string, any>;
  const ci = parse(read('.github/workflows/ci.yml')) as Record<string, any>;

  it('[DEP-060] release.yml runs on v* tags only', () => {
    expect(release.on).toEqual({ push: { tags: ['v*'] } });
  });

  it('[DEP-060] release.yml pushes a multi-arch image and the chart as an OCI artifact', () => {
    const text = read('.github/workflows/release.yml');
    expect(text).toContain('platforms: linux/amd64,linux/arm64');
    expect(text).toContain('ghcr.io/${{ needs.verify.outputs.owner }}/git-migrator');
    expect(text).toContain('oci://ghcr.io/${OWNER}/charts');
    expect(text).toContain('--app-version "${TAG}"');
    expect(text).toContain('--version "${VERSION}"');
  });

  it('[DEP-060] release.yml needs only the built-in token, with write access scoped to the publishing jobs', () => {
    const text = read('.github/workflows/release.yml');
    const secrets = [...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']));
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(release.jobs.image.permissions.packages).toBe('write');
    expect(release.jobs.chart.permissions.packages).toBe('write');
    expect(release.jobs.verify.permissions).toBeUndefined();
  });

  it('[DEP-060] the chart is published only after the image', () => {
    expect(release.jobs.chart.needs).toContain('image');
    expect(release.jobs.image.needs).toBe('verify');
  });

  it('[DEP-060] every action is pinned to a commit SHA', () => {
    for (const file of ['release.yml', 'ci.yml']) {
      const uses = [...read(`.github/workflows/${file}`).matchAll(/uses: (\S+)/g)].map(
        (m) => m[1] as string,
      );
      for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('[DEP-060] ci.yml builds the image without pushing and smoke-tests it', () => {
    const image = ci.jobs.image;
    const build = image.steps.find((s: any) => s.uses?.startsWith('docker/build-push-action'));
    expect(build.with.push).toBe(false);
    expect(build.with.target).toBe('runtime');
    expect(image.steps.some((s: any) => /deploy\/docker\/smoke\.sh/.test(s.run ?? ''))).toBe(true);
  });

  it('[DEP-033][DEP-060] ci.yml runs helm:check with helm-unittest installed', () => {
    const steps = ci.jobs.helm.steps as Array<{ run?: string }>;
    expect(steps.some((s) => s.run === 'pnpm helm:check')).toBe(true);
    expect(
      steps.some((s) => /untt/.test(s.run ?? '') && /sha256sum --check --strict/.test(s.run ?? '')),
    ).toBe(true);
  });

  it('[DEP-001][DEP-003] the smoke script runs read-only as UID 10001 and probes the health endpoints', () => {
    const smoke = read('deploy/docker/smoke.sh');
    expect(smoke).toContain('--read-only');
    expect(smoke).toContain('--user 10001:10001');
    expect(smoke).toContain('--cap-drop ALL');
    expect(smoke).toContain('--tmpfs /tmp');
    expect(smoke).toContain('/api/healthz');
    expect(smoke).toContain('/api/readyz');
    expect(smoke).toContain('8081/readyz');
  });

  it('[DEP-002] the smoke script checks that web serves the UI: /, the sign-in page and its assets', () => {
    const smoke = read('deploy/docker/smoke.sh');
    expect(smoke).toContain('expect_html / "$(page / ');
    expect(smoke).toContain('expect_html /signin "$(page /signin ');
    expect(smoke).toContain("grep -q 'Sign in to git-migrator'");
    expect(smoke).toContain('/_next/static/');
    // The text the smoke script looks for is the sign-in page's title.
    const en = JSON.parse(read('apps/web/messages/en.json'));
    expect(en.auth.signin.title).toBe('Sign in to git-migrator');
  });
});

describe('docs/deployment.md (DEP-020)', () => {
  const doc = read('docs/deployment.md');

  it('[AUTH-002][DEP-020] the documented Entra redirect URI uses the sign-in provider id', () => {
    const id = read('packages/auth/src/auth.ts').match(/ENTRA_PROVIDER_ID = '([^']+)'/)?.[1];
    expect(id).toBe('microsoft');
    expect(doc).toContain(`\`<publicUrl>/api/auth/callback/${id}\``);
    expect(doc).not.toMatch(/\/api\/auth\/callback\/entra/);
  });

  it('[DEP-020] covers Azure prerequisites, Key Vault secrets, workload identity, extensions and connections', () => {
    for (const heading of [
      '## Azure prerequisites',
      '## Key Vault secrets',
      '## Workload identity',
      '## PostgreSQL extensions',
      '## Worker database connections',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('[DEP-020] names every required secretspec key of the production profile', () => {
    for (const key of [
      'POSTGRES_PASSWORD',
      'BETTER_AUTH_SECRET',
      'ENTRA_CLIENT_ID',
      'ENTRA_CLIENT_SECRET',
      'BITBUCKET_CREDENTIALS',
      'GITHUB_APP_PRIVATE_KEY',
      'ATLASSIAN_ADMIN_API_KEY',
    ]) {
      expect(doc).toContain(key);
      expect(read('secretspec.toml')).toContain(key);
    }
    expect(doc).toContain('Key Vault Secrets User');
    expect(doc).toContain('azure.extensions');
    expect(doc).toMatch(/system:serviceaccount:<namespace>:<release>-migrate/);
  });
});

describe('secretspec in the image (DEP-002, DEP-020)', () => {
  it('[DEP-020] secretspec.toml declares the production profile the entrypoint selects', () => {
    const manifest = parseToml(read('secretspec.toml')) as { profiles: Record<string, unknown> };
    expect(Object.keys(manifest.profiles)).toContain('production');
    expect(read('deploy/helm/git-migrator/values.yaml')).toMatch(/profile: production/);
  });

  it('[DEP-002] the runtime stage copies the manifest into the working directory', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime).toContain('WORKDIR /app');
    expect(runtime).toMatch(/COPY --from=build \/app\/secretspec\.toml \.\/secretspec\.toml/);
  });

  it('[DEP-002][DEP-020] the smoke script runs every process through secretspec and the production profile', () => {
    const smoke = read('deploy/docker/smoke.sh');
    expect(smoke).toContain('GM_SECRETSPEC_PROVIDER=dotenv:/run/gm-secrets/prod.env');
    expect(smoke).toContain('GM_SECRETSPEC_PROFILE=production');
    expect(smoke).toMatch(/missing\.env/);
    for (const key of [
      'POSTGRES_PASSWORD',
      'BETTER_AUTH_SECRET',
      'ENTRA_CLIENT_ID',
      'ENTRA_CLIENT_SECRET',
    ]) {
      expect(smoke).toContain(`${key}=`);
    }
  });

  it('[DEP-050] the smoke script reads the metrics endpoint of web and worker', () => {
    const matches = read('deploy/docker/smoke.sh').match(/127\.0\.0\.1:9464\/metrics/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('[DEP-001] the smoke script waits for Postgres over TCP, retries migrate and checks the read-only flag', () => {
    const smoke = read('deploy/docker/smoke.sh');
    expect(smoke).toContain('pg_isready -h 127.0.0.1');
    expect(smoke).toMatch(/for attempt in 1 2 3 4 5/);
    expect(smoke).toContain('ReadonlyRootfs');
    expect(smoke).toContain('touch /scratch/should-fail');
  });

  it('[DEP-020] the documented Key Vault secret names follow the secretspec Base32 convention', () => {
    const b32 = (value: string): string => {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
      let bits = '';
      for (const byte of Buffer.from(value)) bits += byte.toString(2).padStart(8, '0');
      let out = '';
      for (let i = 0; i < bits.length; i += 5)
        out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
      return out;
    };
    // The example in secretspec's own tests: project "myapp", profile "prod", key "DB_URL".
    expect(`secretspec--${b32('myapp')}--${b32('prod')}--${b32('DB_URL')}`).toBe(
      'secretspec--nv4wc4dq--obzg6za--irbf6vksjq',
    );
    const doc = read('docs/deployment.md');
    for (const key of [
      'POSTGRES_PASSWORD',
      'BETTER_AUTH_SECRET',
      'ENTRA_CLIENT_ID',
      'ENTRA_CLIENT_SECRET',
      'BITBUCKET_CREDENTIALS',
      'GITHUB_APP_PRIVATE_KEY',
      'ATLASSIAN_ADMIN_API_KEY',
    ]) {
      const name = `secretspec--${b32('git-migrator')}--${b32('production')}--${b32(key)}`;
      expect(doc).toContain(`\`${key}\``);
      expect(doc).toContain(`\`${name}\``);
    }
  });
});

describe('release gate (DEP-060)', () => {
  const text = read('.github/workflows/release.yml');
  const release = parse(text) as Record<string, any>;

  it('[DEP-060] the tagged commit must be an ancestor of origin/main', () => {
    expect(text).toContain('git merge-base --is-ancestor "${GITHUB_SHA}" origin/main');
    expect(release.jobs.verify.steps[0].with['fetch-depth']).toBe(0);
  });

  it('[DEP-060] the publishing jobs run in the release environment', () => {
    expect(release.jobs.image.environment).toBe('release');
    expect(release.jobs.chart.environment).toBe('release');
  });

  it('[DEP-060] the amd64 image is smoke-tested before login and push', () => {
    const steps = release.jobs.image.steps as Array<{ name: string; run?: string; uses?: string }>;
    const index = (needle: RegExp): number =>
      steps.findIndex((s) => needle.test(`${s.name} ${s.run ?? ''}`));
    const smoke = index(/smoke\.sh/);
    expect(smoke).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(index(/Log in to ghcr/));
    expect(smoke).toBeLessThan(index(/^Build and push/));
  });

  it('[DEP-060] an existing image tag or chart version is never overwritten', () => {
    expect(text).toContain('docker buildx imagetools inspect');
    expect(text).toContain('helm show chart');
    const imageSteps = release.jobs.image.steps as Array<{ name: string }>;
    const names = imageSteps.map((s) => s.name);
    expect(names.indexOf('Refuse to overwrite an existing image tag')).toBeLessThan(
      names.indexOf('Build and push'),
    );
  });
});
