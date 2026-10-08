/** Builds the connection's `ProviderHttpClient`. All Bitbucket HTTP goes through it (ADP-060). */
import {
  type AdapterContext,
  ProviderHttpClient,
  type RequestCredentials,
} from '@git-migrator/adapter-sdk';
import type { BitbucketConfig, BitbucketCredential } from './config.ts';
import { PROVIDER } from './config.ts';
import { createClassifier, createInterpreter, type QuotaSetup } from './quota.ts';

/**
 * Atlassian token prefixes: user API tokens (`ATATT`), access tokens (`ATCTT`) and app passwords
 * (`ATBB`). Linear: one literal prefix, one bounded class (ADR-0190 item 18).
 */
export const TOKEN_SHAPES: readonly RegExp[] = [/\bAT(?:ATT|CTT|BB)[A-Za-z0-9_=+/-]{12,512}/g];

/** `authorize` result for a credential: computed once, so every attempt is cheap. */
export function basicCredentials(credential: BitbucketCredential): RequestCredentials {
  const pair = `${credential.email}:${credential.apiToken}`;
  return {
    headers: {
      authorization: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`,
      accept: 'application/json',
    },
    secrets: [credential.apiToken, pair],
  };
}

export function createClient(options: {
  endpointId: string;
  baseUrl: string;
  config: BitbucketConfig;
  credential: BitbucketCredential;
  accountKey: string;
  ctx: AdapterContext;
}): { client: ProviderHttpClient; setup: QuotaSetup } {
  const { ctx, config, credential } = options;
  const setup: QuotaSetup = {
    endpointId: options.endpointId,
    accountKey: options.accountKey,
    overrides: config.quota.overrides,
  };
  const credentials = basicCredentials(credential);
  const client = new ProviderHttpClient({
    ...ctx,
    provider: PROVIDER,
    endpointId: options.endpointId,
    baseUrl: options.baseUrl,
    classify: createClassifier(setup),
    authorize: async () => credentials,
    interpret: createInterpreter(setup),
    tokenShapes: TOKEN_SHAPES,
    pool: ctx.pool,
  });
  return { client, setup };
}
