/**
 * change-requests facet (FAC-CRQ). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * Blocking only: Change Requests are never migrated, so `desired` is empty, and `compareMode` is
 * `none` (no ParityResult). Target Change Requests opened by the framework are never seen here.
 * Decisions: docs/adr/0155-change-requests-facet.md.
 */
import { type ChangeRequests, changeRequestsFacet } from '@git-migrator/canonical';
import type { FacetDefinition, Finding, TranslationResult } from '@git-migrator/core';

export const OPEN_CHANGE_REQUEST = 'change-requests.open';

/** The guidance list parameter holds at most 500 items (guidance params: `list`). */
export const MAX_LISTED = 500;
const MAX_ID_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_URL_LENGTH = 300;

/**
 * Exactly the characters the guidance validator refuses (`hasForbiddenCharacter` in
 * packages/guidance/src/template.ts): C0, DEL, C1, U+2028/2029, U+202A-202E and U+2066-2069. Any
 * run of them, and of whitespace, becomes one space. Other format characters (for example ZWJ in
 * emoji sequences) are kept. ADR-0155; testing/integration keeps the two in sync.
 */
const GUIDANCE_FORBIDDEN_OR_SPACE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the guidance set is C0 and C1 by definition
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\s]+/gu;

/** Lone surrogates are not well-formed text; each becomes U+FFFD. */
const LONE_SURROGATE = /\p{Cs}/gu;

/** Cleans and cuts at `max` code points, so a surrogate pair is never split. */
function clean(text: string, max: number): string {
  return Array.from(
    text.replace(LONE_SURROGATE, '\uFFFD').replace(GUIDANCE_FORBIDDEN_OR_SPACE, ' ').trim(),
  )
    .slice(0, max)
    .join('')
    .trimEnd();
}

/**
 * One listed entry: `<id>: <title>`. The URL stands in for a blank id, and a title is omitted when
 * it is blank. An entry that is blank after cleaning is dropped from the list.
 */
export function changeRequestLabel(cr: ChangeRequests['open'][number]): string {
  const id = clean(cr.id, MAX_ID_LENGTH);
  const name = id === '' ? clean(cr.url, MAX_URL_LENGTH) : id;
  const title = clean(cr.title, MAX_TITLE_LENGTH);
  if (name === '') return '';
  return title === '' ? name : `${name}: ${title}`;
}

export function translateChangeRequests(source: ChangeRequests): TranslationResult<ChangeRequests> {
  const blockers: Finding[] = [];
  if (source.open.length > 0) {
    const ids = source.open
      .map(changeRequestLabel)
      .filter((label) => label !== '')
      .slice(0, MAX_LISTED);
    blockers.push({
      code: OPEN_CHANGE_REQUEST,
      paths: ['/open'],
      // `count` is the real total even when the list is cut at MAX_LISTED.
      params: { count: source.open.length, ids },
    });
  }
  return {
    // Nothing is migrated, so nothing is desired on the target.
    desired: { open: [] },
    decisions: [],
    blockers,
    preTasks: [],
    postTasks: [],
    warnings: [],
  };
}

export const changeRequestsDefinition: FacetDefinition<ChangeRequests> = {
  key: changeRequestsFacet.key,
  scope: changeRequestsFacet.scope,
  schemaVersion: changeRequestsFacet.schemaVersion,
  schema: changeRequestsFacet.schema,
  compareMode: 'none',
  collections: changeRequestsFacet.collections,
  sets: changeRequestsFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: (data) => data,
  translate: translateChangeRequests,
  // Never called: `compareMode` is `none`. The engine still requires the member.
  compare: () => [],
  findingCodes: {
    [OPEN_CHANGE_REQUEST]: { kind: 'blocker' },
  },
  policyKeys: [],
};
