import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { must, world } from './harness.ts';
import { fakeAppJwt } from './jwt.ts';
import { b64url } from './util.ts';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function jwtFrom(parts: { header?: object; claims?: object; sig?: string }): string {
  const header = parts.header ?? { alg: 'RS256', typ: 'JWT' };
  const claims = parts.claims ?? {};
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.${parts.sig ?? b64url('sig')}`;
}

describe('App authentication (JWT to installation token)', () => {
  it('[TST-011] exchanges a JWT for an installation token valid for one hour', async () => {
    const w = world({ clock: () => NOW });
    const jwt = fakeAppJwt({ appId: 12345, nowMs: NOW });
    const res = await w.spec(
      '/app/installations/{installation_id}/access_tokens',
      'post',
      `/app/installations/${[...w.fake.state.installations.keys()][0]}/access_tokens`,
      { token: jwt },
      201,
    );
    expect(res.body.token).toMatch(/^ghs_[0-9a-f]{36}$/);
    expect(Date.parse(res.body.expires_at)).toBe(NOW + 3600_000);
    expect(res.body.permissions.administration).toBe('write');
    const me = await w.call('GET', '/orgs/acme', { token: res.body.token });
    expect(me.status).toBe(200);
  });

  it('[TST-011] accepts the client id as issuer and any signature, but not a malformed token', async () => {
    const w = world({ clock: () => NOW });
    const id = [...w.fake.state.installations.keys()][0];
    const iat = Math.floor(NOW / 1000);
    const byClient = jwtFrom({
      claims: { iss: w.fake.state.appClientId, iat: iat - 60, exp: iat + 540 },
    });
    expect(
      (await w.call('POST', `/app/installations/${id}/access_tokens`, { token: byClient })).status,
    ).toBe(201);
    const garbage = await w.spec(
      '/app/installations/{installation_id}/access_tokens',
      'post',
      `/app/installations/${id}/access_tokens`,
      { token: 'a.b' },
      401,
    );
    expect(garbage.body.message).toBe('Bad credentials');
    const notJson = await w.call('POST', `/app/installations/${id}/access_tokens`, {
      token: 'x.y.z',
    });
    expect(notJson.body.message).toBe('A JSON web token could not be decoded');
  });

  it.each([
    [
      'unsupported algorithm',
      { header: { alg: 'HS256' }, claims: { iss: '12345', iat: 0, exp: 0 } },
      /not a supported signing algorithm/,
    ],
    [
      'missing iat',
      { claims: { iss: '12345', exp: Math.floor(NOW / 1000) + 60 } },
      /'Issued at' claim/,
    ],
    [
      'iat in the future',
      {
        claims: {
          iss: '12345',
          iat: Math.floor(NOW / 1000) + 30,
          exp: Math.floor(NOW / 1000) + 60,
        },
      },
      /'Issued at' claim/,
    ],
    [
      'exp in the past',
      {
        claims: {
          iss: '12345',
          iat: Math.floor(NOW / 1000) - 600,
          exp: Math.floor(NOW / 1000) - 1,
        },
      },
      /'Expiration time' claim \('exp'\) must be a numeric value/,
    ],
    [
      'exp more than 10 minutes ahead',
      { claims: { iss: '12345', iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 601 } },
      /less than 10 minutes/,
    ],
    [
      'unknown issuer',
      {
        claims: { iss: '999', iat: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 60 },
      },
      /'Issuer' claim/,
    ],
    [
      'missing issuer',
      { claims: { iat: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 60 } },
      /'Issuer' claim/,
    ],
  ])('[TST-011] rejects a JWT with %s', async (_name, parts, message) => {
    const w = world({ clock: () => NOW });
    const res = await w.call('GET', '/app', { token: jwtFrom(parts) });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(message);
  });

  it('[TST-011] exp exactly 10 minutes ahead is accepted; the 60 s backdated iat the docs suggest too', async () => {
    const w = world({ clock: () => NOW });
    const iat = Math.floor(NOW / 1000);
    expect(
      (
        await w.call('GET', '/app', {
          token: jwtFrom({ claims: { iss: '12345', iat: iat - 60, exp: iat + 600 } }),
        })
      ).status,
    ).toBe(200);
  });

  it('[TST-011] verifies the signature only when the fake knows the App public key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const w = world({ clock: () => NOW, appPublicKeyPem: pem });
    const iat = Math.floor(NOW / 1000);
    const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: '12345', iat: iat - 60, exp: iat + 540 }))}`;
    const good = `${signingInput}.${b64url(sign('RSA-SHA256', Buffer.from(signingInput), privateKey))}`;
    expect((await w.call('GET', '/app', { token: good })).status).toBe(200);
    expect(
      (await w.call('GET', '/app', { token: `${signingInput}.${b64url('forged')}` })).status,
    ).toBe(401);
  });

  it('[TST-011] installation ids: unknown is 404, an installation token cannot mint tokens', async () => {
    const w = world({ clock: () => NOW });
    const jwt = fakeAppJwt({ appId: 12345, nowMs: NOW });
    await w.spec(
      '/app/installations/{installation_id}/access_tokens',
      'post',
      '/app/installations/1/access_tokens',
      { token: jwt },
      404,
    );
    const id = [...w.fake.state.installations.keys()][0];
    expect((await w.call('POST', `/app/installations/${id}/access_tokens`)).status).toBe(401);
    expect(
      (await w.call('POST', `/app/installations/${id}/access_tokens`, { token: w.token })).status,
    ).toBe(401);
  });

  it('[TST-011] requested permissions must be a subset of the installation grant', async () => {
    const w = world({ clock: () => NOW });
    const jwt = fakeAppJwt({ appId: 12345, nowMs: NOW });
    const id = [...w.fake.state.installations.keys()][0];
    const narrow = await w.call('POST', `/app/installations/${id}/access_tokens`, {
      token: jwt,
      body: { permissions: { contents: 'read' } },
    });
    expect(narrow.status).toBe(201);
    expect(narrow.body.permissions).toEqual({ contents: 'read', metadata: 'read' });
    const tooMuch = await w.call('POST', `/app/installations/${id}/access_tokens`, {
      token: jwt,
      body: { permissions: { contents: 'admin' } },
    });
    expect(tooMuch.status).toBe(422);
    const unknown = await w.call('POST', `/app/installations/${id}/access_tokens`, {
      token: jwt,
      body: { permissions: { deployments: 'read' } },
    });
    expect(unknown.status).toBe(422);
  });

  it('[TST-011] a token limited to repositories cannot see the others', async () => {
    const w = world({ clock: () => NOW });
    const jwt = fakeAppJwt({ appId: 12345, nowMs: NOW });
    const id = [...w.fake.state.installations.keys()][0];
    const res = await w.call('POST', `/app/installations/${id}/access_tokens`, {
      token: jwt,
      body: { repositories: ['auto-ok'] },
    });
    expect(res.body.repository_selection).toBe('selected');
    expect(res.body.repositories.map((r: { name: string }) => r.name)).toEqual(['auto-ok']);
    expect((await w.call('GET', '/repos/acme/auto-ok', { token: res.body.token })).status).toBe(
      200,
    );
    expect((await w.call('GET', '/repos/acme/empty', { token: res.body.token })).status).toBe(404);
    expect(
      (
        await w.call('POST', `/app/installations/${id}/access_tokens`, {
          token: jwt,
          body: { repositories: ['nope'] },
        })
      ).status,
    ).toBe(422);
  });

  it('[TST-011] tokens expire after 1 hour (Bad credentials)', async () => {
    let now = NOW;
    const w = world({ clock: () => now });
    const token = w.fake.token();
    expect((await w.call('GET', '/orgs/acme', { token })).status).toBe(200);
    now += 3600_000 - 1;
    expect((await w.call('GET', '/orgs/acme', { token })).status).toBe(200);
    now += 1;
    const expired = await w
      .spec('/orgs/{org}', 'get', '/orgs/acme', { token }, 404)
      .catch(() => null);
    expect(expired).toBeNull(); // 401 is not documented for this operation
    const res = await w.call('GET', '/orgs/acme', { token });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Bad credentials');
  });

  it('[TST-011] suspended installations are refused', async () => {
    const w = world({ clock: () => NOW });
    const jwt = fakeAppJwt({ appId: 12345, nowMs: NOW });
    const id = [...w.fake.state.installations.keys()][0] as number;
    must(w.fake.state.installations.get(id)).suspended = true;
    expect(
      (await w.call('POST', `/app/installations/${id}/access_tokens`, { token: jwt })).status,
    ).toBe(403);
    expect((await w.call('GET', '/orgs/acme')).status).toBe(403);
  });
});

describe('installation token permissions', () => {
  it('[TST-011] endpoints check the permission and level; the needed permission is advertised', async () => {
    const w = world();
    const readOnly = w.fake.token({
      permissions: { metadata: 'read', administration: 'read', contents: 'read' },
    });
    const created = await w.call('POST', '/orgs/acme/repos', {
      token: readOnly,
      body: { name: 'x' },
    });
    expect(created.status).toBe(403);
    expect(created.body.message).toBe('Resource not accessible by integration');
    expect(created.headers.get('x-accepted-github-permissions')).toBe('administration=write');
    expect((await w.call('GET', '/repos/acme/auto-ok/keys', { token: readOnly })).status).toBe(200);
    expect(
      (await w.call('POST', '/repos/acme/auto-ok/keys', { token: readOnly, body: { key: 'x' } }))
        .status,
    ).toBe(403);
    expect((await w.call('GET', '/repos/acme/auto-ok/hooks', { token: readOnly })).status).toBe(
      403,
    );
    expect((await w.call('GET', '/orgs/acme/members', { token: readOnly })).status).toBe(403);
    expect(
      (
        await w.call('POST', '/graphql', {
          token: readOnly,
          body: {
            query: `mutation { deleteBranchProtectionRule(input:{branchProtectionRuleId:"x"}) { clientMutationId } }`,
          },
        })
      ).body.errors[0].type,
    ).toBe('FORBIDDEN');
  });

  it('[TST-011] environment writes need Administration, reads need Actions (provider doc)', async () => {
    const w = world();
    const envOnly = w.fake.token({ permissions: { metadata: 'read', environments: 'write' } });
    expect(
      (await w.call('PUT', '/repos/acme/auto-ok/environments/e', { token: envOnly, body: {} }))
        .status,
    ).toBe(403);
    expect(
      (await w.call('GET', '/repos/acme/auto-ok/environments', { token: envOnly })).status,
    ).toBe(403);
    const actions = w.fake.token({
      permissions: { metadata: 'read', actions: 'read', environments: 'write' },
    });
    expect(
      (await w.call('GET', '/repos/acme/auto-ok/environments', { token: actions })).status,
    ).toBe(200);
    w.fake.state.addEnvironment(w.repo, 'e');
    expect(
      (
        await w.call('POST', '/repos/acme/auto-ok/environments/e/variables', {
          token: actions,
          body: { name: 'A', value: '1' },
        })
      ).status,
    ).toBe(201);
  });

  it('[TST-011] anonymous requests are 401, JWT on installation endpoints 403, installation token on JWT endpoints 401', async () => {
    const w = world({ clock: () => NOW });
    expect((await w.call('GET', '/orgs/acme', { token: null })).status).toBe(401);
    expect((await w.call('GET', '/users/dave', { token: null })).status).toBe(200);
    expect(
      (await w.call('GET', '/orgs/acme', { token: fakeAppJwt({ appId: 12345, nowMs: NOW }) }))
        .status,
    ).toBe(403);
    expect((await w.call('GET', '/app', { token: w.token })).status).toBe(401);
    expect((await w.call('GET', '/orgs/acme', { token: 'ghs_unknown' })).body.message).toBe(
      'Bad credentials',
    );
    expect(
      (await w.call('GET', '/orgs/acme', { headers: { authorization: 'Weird xyz' }, token: null }))
        .status,
    ).toBe(401);
  });

  it('[TST-011] an installation on one organization cannot read another', async () => {
    const w = world();
    w.fake.state.addOrg({ login: 'other' });
    w.fake.state.addRepository('other', { name: 'secret' });
    expect((await w.call('GET', '/orgs/other')).status).toBe(404);
    expect((await w.call('GET', '/repos/other/secret')).status).toBe(404);
    expect((await w.call('GET', '/orgs/other/members')).status).toBe(404);
  });
});
