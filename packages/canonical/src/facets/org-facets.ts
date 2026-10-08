/**
 * org-variables, org-secrets, org-webhooks (endpoint-level). 05-facets gives no schema for them;
 * ADR-0087 records the decision: the repository-level shapes, plus `visibility: 'all'` on variables.
 */
import { z } from 'zod';
import { cleanText, declareFacet } from '../common.ts';
import { type Webhook, webhookSchema } from './webhooks.ts';

export type OrgVariables = { variables: { name: string; value: string; visibility: 'all' }[] }; // key: name
export type OrgSecrets = { secrets: { name: string }[] }; // key: name
export type OrgWebhooks = { hooks: Webhook[] }; // key: key (webhookKey)

export const orgVariablesSchema: z.ZodType<OrgVariables> = z.strictObject({
  variables: z.array(
    z.strictObject({ name: cleanText, value: z.string(), visibility: z.literal('all') }),
  ),
});

export const orgSecretsSchema: z.ZodType<OrgSecrets> = z.strictObject({
  secrets: z.array(z.strictObject({ name: cleanText })),
});

export const orgWebhooksSchema: z.ZodType<OrgWebhooks> = z.strictObject({
  hooks: z.array(webhookSchema),
});

export const orgVariablesFacet = declareFacet({
  key: 'org-variables',
  scope: 'endpoint',
  schema: orgVariablesSchema,
  collections: [{ path: '/variables', key: 'name' }],
});
export const orgSecretsFacet = declareFacet({
  key: 'org-secrets',
  scope: 'endpoint',
  schema: orgSecretsSchema,
  collections: [{ path: '/secrets', key: 'name' }],
});
export const orgWebhooksFacet = declareFacet({
  key: 'org-webhooks',
  scope: 'endpoint',
  schema: orgWebhooksSchema,
  collections: [{ path: '/hooks', key: 'key' }],
  sets: ['/hooks/events'],
});
