import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** A parsed Compose service. Values stay unknown; each assertion narrows what it reads. */
type Service = Record<string, unknown> & { healthcheck?: { test: string[] } };
type Compose = {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
/** One secretspec declaration as this test reads it. */
type Decl = { description?: string; default?: string; required?: boolean; providers?: string[] };
type Manifest = {
  project: { name: string; revision: string };
  providers: Record<string, string>;
  profiles: Record<string, Record<string, Decl> & { defaults?: Record<string, unknown> }>;
};

const compose = (): Compose => parseYaml(read('compose.yaml')) as Compose;
const manifest = (): Manifest => parseToml(read('secretspec.toml')) as Manifest;

/** DEV-030: every secret the spec names, with its requiredness. */
const DEV_030_SECRETS = [
  'POSTGRES_PASSWORD',
  'BETTER_AUTH_SECRET',
  'ENTRA_CLIENT_ID',
  'ENTRA_CLIENT_SECRET',
  'BITBUCKET_CREDENTIALS',
  'GITHUB_APP_PRIVATE_KEY',
  'ATLASSIAN_ADMIN_API_KEY',
  'GM_TEST_USER_PASSWORD',
] as const;

/** ENV set by the Dockerfile `dev` stage, with `\` line continuations joined first. */
function devStageEnv(): Map<string, string> {
  const dockerfile = read('deploy/docker/Dockerfile');
  const stage = dockerfile.slice(dockerfile.indexOf('FROM base AS dev'));
  const env = new Map<string, string>();
  for (const line of stage.replace(/\\\n\s*/g, ' ').split('\n')) {
    const match = /^ENV (.+)$/.exec(line.trim());
    if (!match) continue;
    for (const pair of (match[1] ?? '').trim().split(/\s+/)) {
      const eq = pair.indexOf('=');
      env.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  return env;
}

/** `.env.test` as key/value pairs (single-quoted values unwrapped). */
function parseDotenv(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const value = line.slice(eq + 1);
    const unquoted = /^'.*'$/.test(value) ? value.slice(1, -1) : value;
    pairs.set(line.slice(0, eq), unquoted);
  }
  return pairs;
}

describe('development environment files', () => {
  it('[DEV-001] devenv and Compose start the same web and worker commands', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toBe('turbo run dev');
    const nix = read('devenv.nix');
    expect(nix).toContain('pnpm --filter @git-migrator/web dev');
    expect(nix).toContain('pnpm --filter @git-migrator/worker dev -- --role all');
    expect(compose().services.dev?.command).toBeUndefined();
    expect(read('deploy/docker/Dockerfile')).toContain('CMD ["pnpm", "dev"]');
    expect(read('deploy/docker/Dockerfile')).not.toMatch(/CMD .*pnpm install/);
    // Worker parity: devenv and Compose (through turbo) run the same worker command.
    const worker = JSON.parse(read('apps/worker/package.json')) as {
      scripts: Record<string, string>;
    };
    expect(worker.scripts.dev).toBe('node --watch src/dev-worker.ts --role all');
  });

  it('[DEV-020] the dev image sets GM_INSTALL_ORIGIN=container so the install guard records container', () => {
    expect(devStageEnv().get('GM_INSTALL_ORIGIN')).toBe('container');
  });

  it('[DEV-040] the dev image binds every interface on port 3000 so Compose can publish it', () => {
    expect(devStageEnv().get('HOST')).toBe('0.0.0.0');
    expect(devStageEnv().get('PORT')).toBe('3000');
  });
  it('[DEV-020] postgres, dev and fakes match the Compose table', () => {
    const c = compose();
    const pg = c.services.postgres as Service;
    expect(pg.image).toMatch(/^postgres:16@sha256:[0-9a-f]{64}$/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose variable substitution, not a JS template
    expect(pg.ports).toEqual(['127.0.0.1:${POSTGRES_HOST_PORT:-5432}:5432']);
    expect(pg.volumes).toEqual(['postgres-data:/var/lib/postgresql/data']);
    expect(pg.healthcheck?.test[1]).toContain('pg_isready');
    expect(c.volumes).toHaveProperty('postgres-data');

    const dev = c.services.dev as Service;
    expect(dev.build).toMatchObject({ target: 'dev', dockerfile: 'deploy/docker/Dockerfile' });
    expect(dev.ports).toEqual(['127.0.0.1:3000:3000']);
    expect(dev.depends_on).toEqual({
      postgres: { condition: 'service_healthy' },
      install: { condition: 'service_completed_successfully' },
    });
    expect(dev.healthcheck?.test[1]).toContain('127.0.0.1:3000');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose variable substitution, not a JS template
    expect(dev.user).toBe('${UID:-1000}:${GID:-1000}');
    expect(dev.profiles).toBeUndefined();

    const fakes = c.services.fakes as Service;
    expect(fakes.profiles).toEqual(['test']);
    expect(fakes.ports).toEqual([
      '127.0.0.1:4010:4010',
      '127.0.0.1:4020:4020',
      '127.0.0.1:4030:4030',
    ]);
    expect(fakes.depends_on).toEqual({
      install: { condition: 'service_completed_successfully' },
    });
    expect(fakes.environment).toMatchObject({
      FAKES_HOST: '0.0.0.0',
      FAKE_GIT_PUBLIC_URL: 'http://fakes:4030',
      FAKE_GIT_BASE_URL: 'http://fakes:4030/source',
    });
    expect(fakes.command).toEqual(['pnpm', '--filter', '@git-migrator/provider-fakes', 'start']);
  });

  it('[DEV-020] the checkout is the only bind mount; node_modules is never a nested volume', () => {
    const c = compose();
    for (const name of ['dev', 'fakes', 'install']) {
      const mounts = (c.services[name] as { volumes: string[] }).volumes;
      expect(mounts, name).toContain('.:/workspace');
      expect(
        mounts.some((m) => m.includes('/node_modules')),
        name,
      ).toBe(false);
    }
    const volumeNames = Object.keys(c.volumes);
    expect(volumeNames.filter((v) => v.startsWith('nm-'))).toEqual([]);
    expect(volumeNames.sort()).toEqual(['fake-git-data', 'pnpm-store', 'postgres-data']);
    for (const name of ['dev', 'fakes', 'install']) {
      expect((c.services[name] as { volumes: string[] }).volumes, name).toContain(
        'pnpm-store:/pnpm-store',
      );
    }
  });

  it('[DEV-020] the install runs as the host UID with setpriv --clear-groups and no --init-groups', () => {
    const script = read('deploy/docker/install-deps.sh');
    expect(script).toMatch(/setpriv --reuid="\$uid" --regid="\$gid" --clear-groups/);
    expect(script).not.toContain('--init-groups');
    expect(script).toContain('pnpm install --frozen-lockfile');
    expect(script).not.toMatch(/nm-|chown/);
    expect(read('package.json')).toContain('"preinstall": "node tools/install-origin.ts"');
  });

  it('[DEV-020] the install service is one-shot and the fakes do not wait for dev', () => {
    const c = compose();
    const install = c.services.install as Service;
    expect(install.restart).toBe('no');
    expect(install.user).toBe('root');
    expect(install.command).toEqual(['sh', '/workspace/deploy/docker/install-deps.sh']);
    expect(c.services.fakes?.depends_on).toEqual({
      install: { condition: 'service_completed_successfully' },
    });
    expect(c.services.dev?.depends_on).toMatchObject({
      install: { condition: 'service_completed_successfully' },
    });
  });

  it('[DEV-010] devenv.yaml enables secretspec for the development profile with the git-hooks input', () => {
    const yaml = parseYaml(read('devenv.yaml')) as {
      secretspec?: unknown;
      inputs?: Record<string, unknown>;
    };
    expect(yaml.secretspec).toEqual({ enable: true, provider: 'keyring', profile: 'development' });
    expect(yaml.inputs).toHaveProperty('git-hooks');
  });

  it('[DEV-010] devenv.nix declares the Node 24, pnpm, PostgreSQL 16 and process set by name', () => {
    const nix = read('devenv.nix');
    const must = [
      'package = pkgs.nodejs_24;',
      'package = pkgs.pnpm_12;',
      'package = pkgs.postgresql_16;',
      'listen_addresses = "127.0.0.1";',
      'port = 5432;',
      'name = "git_migrator";',
      'user = "git_migrator";',
      'postgres-password = {',
      'restart.on = "never";',
      'web.exec =',
      'worker.exec =',
      "enterTest = ''",
      'pnpm turbo run lint typecheck test',
      'git-hooks.hooks.biome = {',
    ];
    for (const fragment of must) expect(nix, fragment).toContain(fragment);
    expect(nix).toContain('secretspec run --');
  });

  it('[DEV-010] devenv.nix keeps the Postgres password out of Nix evaluation', () => {
    const nix = read('devenv.nix');
    expect(nix).not.toMatch(/\bpass\s*=/);
    expect(nix).toContain('ALTER ROLE git_migrator WITH LOGIN PASSWORD');
    expect(nix).toContain('printf "ALTER ROLE');
  });

  it('[DEV-010] devenv initdb authenticates TCP with scram and keeps the socket on trust', () => {
    const nix = read('devenv.nix');
    expect(nix).toContain('"--auth-host=scram-sha-256"');
    expect(nix).toContain('"--auth-local=trust"');
    expect(nix).toContain('"--locale=C"');
    expect(nix).toContain('"--encoding=UTF8"');
  });

  it('[DEV-010] set-postgres-password waits for TCP and for the role, with a bound', () => {
    const nix = read('devenv.nix');
    expect(nix).toContain('pg_isready -q -h 127.0.0.1');
    expect(nix).toContain("WHERE rolname = 'git_migrator'");
    expect(nix).toMatch(/seq 1 120/);
    expect(nix).toContain('not ready after 120 s');
  });

  it('[DEV-010] the git hook reports only and never rewrites staged files', () => {
    const nix = read('devenv.nix');
    const entry =
      /entry = "([^"]*)"/.exec(nix.slice(nix.indexOf('git-hooks.hooks.biome')))?.[1] ?? '';
    expect(entry).toContain('biome check');
    expect(entry).not.toContain('--write');
  });

  it('[DEV-030] the secretspec manifest parses with the pinned project and providers', () => {
    const m = manifest();
    expect(m.project).toEqual({ name: 'git-migrator', revision: '1.0' });
    expect(m.providers).toEqual({
      fixtures: 'file:./testing/fixtures',
      test_env: 'dotenv:.env.test',
    });
  });

  it('[DEV-030] every DEV-030 secret is declared in every profile (inherited or explicit)', () => {
    const m = manifest();
    const defaults = Object.keys(m.profiles.default ?? {});
    for (const profile of ['development', 'test', 'e2e']) {
      const own = Object.keys(m.profiles[profile] ?? {});
      const inherits = m.profiles[profile]?.defaults?.inherit !== false;
      const effective = new Set([...own, ...(inherits ? defaults : [])]);
      for (const secret of DEV_030_SECRETS) {
        expect(effective.has(secret), `${secret} missing from ${profile}`).toBe(true);
      }
    }
  });

  it('[DEV-030] the test profile is standalone and its defaults equal the development defaults', () => {
    const m = manifest();
    expect(m.profiles.test?.defaults).toMatchObject({ inherit: false });
    const dev = m.profiles.development ?? {};
    const test = m.profiles.test ?? {};
    for (const [key, decl] of Object.entries(dev)) {
      if (decl.default === undefined) continue;
      expect(test[key]?.default, `${key} default`).toBe(decl.default);
      expect(test[key]?.description, `${key} description`).toBeTypeOf('string');
    }
  });

  it('[DEV-030] development takes the GitHub App key from the fixture file provider, not an inline value', () => {
    const decl = manifest().profiles.development?.GITHUB_APP_PRIVATE_KEY;
    expect(decl).toEqual({ providers: ['fixtures'], ref: { item: 'fake-github-app.pem' } });
    expect(existsSync(join(root, 'testing/fixtures/fake-github-app.pem'))).toBe(true);
  });

  it('[DEV-030] .env.test holds exactly the test profile defaults, all fake, in both directions', () => {
    const test = manifest().profiles.test ?? {};
    const env = parseDotenv(read('.env.test'));
    // Every test secret that has a default value must be in .env.test with the same value.
    const withDefault = Object.entries(test).filter(([, decl]) => decl.default !== undefined);
    expect(withDefault.length).toBeGreaterThan(0);
    for (const [key, decl] of withDefault) {
      expect(env.has(key), `${key} has a test default but is missing from .env.test`).toBe(true);
      expect(env.get(key), `${key} differs from its test default`).toBe(decl.default);
    }
    // Every .env.test key must be a test secret with a default (no extra or real values).
    for (const key of env.keys()) {
      expect(test[key]?.default, `${key} in .env.test has no test default`).toBeDefined();
    }
    expect(read('.env.test')).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('[DEP-001] the Docker build context excludes VCS data, secrets, keys and build output', () => {
    const ignore = read('.dockerignore').split('\n');
    for (const pattern of [
      '.git',
      '**/.env',
      '**/.env.*',
      '!**/.env.test',
      '**/node_modules',
      '**/*.pem',
      '.pre-commit-config.yaml',
      '.claude/settings.local.json',
      '.devenv',
    ]) {
      expect(ignore, pattern).toContain(pattern);
    }
  });

  it('[DEP-001] base images are pinned by digest in the Dockerfile and compose', () => {
    const dockerfile = read('deploy/docker/Dockerfile');
    expect(dockerfile).toMatch(
      /^FROM rust:1.99.0-slim-bookworm@sha256:[0-9a-f]{64} AS secretspec-cli$/m,
    );
    expect(dockerfile).toMatch(/^FROM node:24-slim@sha256:[0-9a-f]{64} AS base$/m);
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('ENTRYPOINT ["tini", "-g", "--"]');
  });

  it('[DEP-001] the install script exists and is executable', () => {
    expect(statSync(join(root, 'deploy/docker/install-deps.sh')).mode & 0o111).not.toBe(0);
    expect(relative(root, join(root, 'deploy/docker/install-deps.sh'))).toBe(
      'deploy/docker/install-deps.sh',
    );
  });
});
