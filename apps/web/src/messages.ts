import { GUIDANCE_MESSAGES_EN, nestCatalog } from '@git-migrator/guidance';
import ui from '../messages/en.json' with { type: 'json' };

/** The namespace the guidance catalog is mounted under (UI-040, ADR-0093). */
export const GUIDANCE_NAMESPACE = 'guidance';

/**
 * The English catalog of the app: the interface strings of `messages/en.json` and the guidance
 * strings of `@git-migrator/guidance`, mounted under {@link GUIDANCE_NAMESPACE} (ADR-0093).
 */
export const messages = {
  ...ui,
  [GUIDANCE_NAMESPACE]: nestCatalog(GUIDANCE_MESSAGES_EN),
};
