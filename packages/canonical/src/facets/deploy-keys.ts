/** deploy-keys (FAC-DKY). */
import { z } from 'zod';
import { declareFacet, nonEmpty } from '../common.ts';

/** Normalized `<type> <base64>`: no comment, no PEM armor (FAC-DKY key rule). */
const publicKeySchema = nonEmpty
  .regex(/^\S+ \S+$/, { message: 'publicKey must be "<type> <base64>" with the comment stripped' })
  .refine((k) => !k.startsWith('-----'), { message: 'publicKey must not be PEM armored' });

export type DeployKeys = { keys: { publicKey: string; title: string; readOnly: boolean }[] }; // key: publicKey (type + base64, comment stripped)

export const deployKeysSchema: z.ZodType<DeployKeys> = z.strictObject({
  keys: z.array(
    z.strictObject({ publicKey: publicKeySchema, title: z.string(), readOnly: z.boolean() }),
  ),
});

export const deployKeysFacet = declareFacet({
  key: 'deploy-keys',
  scope: 'repository',
  schema: deployKeysSchema,
  collections: [{ path: '/keys', key: 'publicKey' }],
});
