import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.ts';
import { formatPath, loadConfig, resolveConfig } from './load.ts';

const validYaml = `
environment: test
endpoints:
  - id: github-main
    provider: github
    options: { org: acme, appId: 1, installationId: 2 }
`;

function issuesOf(fn: () => unknown): ConfigError['issues'] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('configuration loading (ARC-030, DEP-040)', () => {
  it('[ARC-030] reads the YAML document and applies the schema defaults to missing keys', () => {
    const config = resolveConfig({ text: validYaml, env: {} });
    expect(config.environment).toBe('test');
    expect(config.endpoints[0]).toMatchObject({
      id: 'github-main',
      baseUrl: 'https://api.github.com',
      options: { org: 'acme', appId: 1, installationId: 2 },
    });
    expect(config.git.maxPushBytes).toBe(1_610_612_736);
  });

  it('[ARC-030] an empty file is a valid configuration of defaults', () => {
    expect(resolveConfig({ text: '', env: {} }).environment).toBe('development');
    expect(resolveConfig({ text: '# only a comment\n', env: {} }).environment).toBe('development');
  });

  it('[ARC-030] environment overrides win over values in the file', () => {
    const config = resolveConfig({
      text: validYaml,
      env: {
        GM_ENVIRONMENT: 'production',
        GM_PUBLIC_URL: 'https://git.example',
        GM_AUTH_ENTRA_TENANT_ID: ' 00000000-0000-4000-8000-000000000001 ',
      },
    });
    expect(config.environment).toBe('production');
    expect(config.publicUrl).toBe('https://git.example');
    expect(config.auth.entra.tenantId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('[ARC-030] a file that is not valid YAML is reported with the parser message', () => {
    const issues = issuesOf(() => resolveConfig({ text: 'environment: [unclosed', env: {} }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('');
    expect(issues[0]?.message).toMatch(/^is not valid YAML: /);
  });

  it('[ARC-030] duplicate keys in the file are an error, not a silent last-wins', () => {
    const issues = issuesOf(() =>
      resolveConfig({ text: 'environment: test\nenvironment: test\n', env: {} }),
    );
    expect(issues[0]?.message).toMatch(/^is not valid YAML/);
  });

  it('[ARC-030] a file whose top level is a list or scalar is rejected', () => {
    expect(issuesOf(() => resolveConfig({ text: '- a\n- b\n', env: {} }))).toEqual([
      { path: '', message: 'must be a mapping of configuration keys' },
    ]);
    expect(issuesOf(() => resolveConfig({ text: 'just text', env: {} }))[0]?.message).toBe(
      'must be a mapping of configuration keys',
    );
  });

  it('[ARC-030] every schema problem is reported at once, with its path', () => {
    const issues = issuesOf(() =>
      resolveConfig({
        text: `
publicUrl: nope
endpoints:
  - id: github-main
    provider: github
    options: { org: acme, appId: -1, installationId: 2 }
`,
        env: {},
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(['publicUrl', 'endpoints[0].options.appId']);
  });

  it('[ARC-030] a problem that came from an environment override names its variable', () => {
    const issues = issuesOf(() =>
      resolveConfig({ text: validYaml, env: { GM_GIT_MAX_PUSH_BYTES: '-5' } }),
    );
    expect(issues).toEqual([
      {
        path: 'git.maxPushBytes',
        message: 'must be greater than 0',
        envVar: 'GM_GIT_MAX_PUSH_BYTES',
      },
    ]);
  });

  it('[ARC-030] loadConfig with no GM_CONFIG_FILE uses the defaults and the environment', () => {
    const config = loadConfig({ env: { GM_METRICS_PORT: '9999' } });
    expect(config.environment).toBe('development');
    expect(config.metrics.port).toBe(9999);
  });

  it('[ARC-030] loadConfig reads the file named by GM_CONFIG_FILE', () => {
    const paths: string[] = [];
    const config = loadConfig({
      env: { GM_CONFIG_FILE: '/etc/git-migrator/config.yaml' },
      readFile: (path) => {
        paths.push(path);
        return validYaml;
      },
    });
    expect(paths).toEqual(['/etc/git-migrator/config.yaml']);
    expect(config.endpoints).toHaveLength(1);
  });

  it('[ARC-030] an empty GM_CONFIG_FILE counts as unset', () => {
    const reads: string[] = [];
    loadConfig({
      env: { GM_CONFIG_FILE: '' },
      readFile: (path) => {
        reads.push(path);
        return '';
      },
    });
    expect(reads).toEqual([]);
  });

  it('[ARC-030] a configuration file that cannot be read is a ConfigError naming the file', () => {
    const issues = issuesOf(() =>
      loadConfig({
        env: { GM_CONFIG_FILE: '/missing.yaml' },
        readFile: () => {
          throw new Error('ENOENT: no such file');
        },
      }),
    );
    expect(issues).toEqual([
      { path: '', message: 'cannot read the file named by GM_CONFIG_FILE (ENOENT: no such file)' },
    ]);
  });

  it('[ARC-030] a non-Error failure to read the file is still reported', () => {
    const issues = issuesOf(() =>
      loadConfig({
        env: { GM_CONFIG_FILE: '/x.yaml' },
        readFile: () => {
          throw 'disk gone';
        },
      }),
    );
    expect(issues[0]?.message).toContain('(disk gone)');
  });

  it('[ARC-030] loadConfig reads from process.env when no env is given', () => {
    const before = process.env.GM_METRICS_PORT;
    process.env.GM_METRICS_PORT = '9100';
    try {
      expect(loadConfig().metrics.port).toBe(9100);
    } finally {
      if (before === undefined) delete process.env.GM_METRICS_PORT;
      else process.env.GM_METRICS_PORT = before;
    }
  });

  it('[ARC-030] formatPath writes list indexes in brackets and joins keys with dots', () => {
    expect(formatPath(['endpoints', 0, 'options', 'appId'])).toBe('endpoints[0].options.appId');
    expect(formatPath(['routes', 1, 'defaults', 'naming', 'steps', 2, 'var'])).toBe(
      'routes[1].defaults.naming.steps[2].var',
    );
    expect(formatPath([])).toBe('');
  });
});

describe('hardened loading (ARC-030, DEP-040)', () => {
  it('[ARC-030] an alias bomb is a ConfigError at the document, not a crash', () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    let previous = 'a';
    for (const name of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      levels.push(`${name}: &${name} [${Array(9).fill(`*${previous}`).join(', ')}]`);
      previous = name;
    }
    const issues = issuesOf(() => resolveConfig({ text: levels.join('\n'), env: {} }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('');
    expect(issues[0]?.message).toMatch(/^is not valid YAML/);
  });

  it('[ARC-030] a URL setting with a username, password, query or fragment is rejected', () => {
    for (const text of [
      'publicUrl: https://user:pw@git.example.test',
      'publicUrl: https://git.example.test/?token=x',
      'publicUrl: https://git.example.test/#frag',
      'observability:\n  otlpEndpoint: http://collector:4318?key=1',
      'endpoints:\n  - id: github-main\n    provider: github\n    baseUrl: https://api.example.test?access_token=x\n    options: { org: acme, appId: 1, installationId: 2 }',
    ]) {
      expect(
        issuesOf(() => resolveConfig({ text, env: {} })),
        text,
      ).toHaveLength(1);
    }
    expect(
      resolveConfig({ text: 'publicUrl: https://git.example.test/app', env: {} }).publicUrl,
    ).toBe('https://git.example.test/app');
  });

  it('[ARC-030] a configuration with environment unset and test sign-in enabled warns that it defaults', () => {
    const warnings: string[] = [];
    resolveConfig({
      text: 'auth:\n  testSignIn: { enabled: true }\n',
      env: {},
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('defaults to "development"');
    expect(warnings[0]).toContain('auth.testSignIn.enabled is true');
    expect(warnings[0]).toContain('set GM_ENVIRONMENT=production');
  });

  it('[ARC-030] a plain http public URL with environment unset also warns', () => {
    const warnings: string[] = [];
    resolveConfig({
      text: 'publicUrl: http://git.example.test',
      env: {},
      warn: (m) => warnings.push(m),
    });
    expect(warnings[0]).toContain('publicUrl uses http');
  });

  it('[ARC-030] no warning when environment is set in the file or by GM_ENVIRONMENT, or when nothing is risky', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    resolveConfig({
      text: 'environment: test\nauth:\n  testSignIn: { enabled: true }',
      env: {},
      warn,
    });
    resolveConfig({
      text: 'auth:\n  testSignIn: { enabled: true }',
      env: { GM_ENVIRONMENT: 'test' },
      warn,
    });
    resolveConfig({ text: '', env: {}, warn });
    expect(warnings).toEqual([]);
  });

  it('[ARC-030] a numeric environment value must be a plain decimal number', () => {
    const issues = issuesOf(() =>
      resolveConfig({ text: '', env: { GM_GIT_MAX_PUSH_BYTES: '0x2000' } }),
    );
    expect(issues).toEqual([
      { path: 'git.maxPushBytes', message: 'must be a number', envVar: 'GM_GIT_MAX_PUSH_BYTES' },
    ]);
  });
});

describe('blank OTLP endpoint (DEP-050, ADR-0054)', () => {
  it('[DEP-050] a whitespace-only otlpEndpoint is unset, like an empty one', () => {
    expect(
      resolveConfig({ text: 'observability:\n  otlpEndpoint: "   "', env: {} }).observability
        .otlpEndpoint,
    ).toBe('');
    expect(
      resolveConfig({ text: '', env: { GM_OBSERVABILITY_OTLP_ENDPOINT: '  \t ' } }).observability
        .otlpEndpoint,
    ).toBe('');
  });

  it('[DEP-050] an endpoint with surrounding spaces keeps its URL', () => {
    expect(
      resolveConfig({ text: 'observability:\n  otlpEndpoint: "  http://otel:4318  "', env: {} })
        .observability.otlpEndpoint,
    ).toBe('http://otel:4318');
  });
});
