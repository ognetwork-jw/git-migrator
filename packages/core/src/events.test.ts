import { describe, expect, it } from 'vitest';
import {
  type DomainEvent,
  decodeEvent,
  EVENT_TYPES,
  EventEncodingError,
  encodeEvent,
  isValidTopic,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_TOPICS,
  parseEvent,
  parseTopicList,
  topicsForEvent,
} from './events.ts';

const at = '2026-01-01T00:00:00.000Z';
const ev = (type: DomainEvent['type'], ids: DomainEvent['ids'] = {}): DomainEvent => ({
  type,
  ids,
  at,
});

describe('domain events (JOB-060)', () => {
  it('[JOB-060] round-trips an event through the NOTIFY payload', () => {
    const event = ev('run.updated', { run: 'r1', migration: 'm1' });
    expect(decodeEvent(encodeEvent(event))).toEqual(event);
  });

  it('[JOB-060] refuses a payload above 7,000 bytes and an invalid event', () => {
    const many = ev('run.updated', { run: 'r'.repeat(64) });
    expect(encodeEvent(many).length).toBeLessThan(MAX_EVENT_PAYLOAD_BYTES);
    expect(() => encodeEvent({ ...many, type: 'nope' as never })).toThrow(EventEncodingError);
    const huge = JSON.stringify({ type: 'quota.updated', ids: {}, at, pad: 'x'.repeat(7000) });
    expect(decodeEvent(huge)).toBeUndefined();
    // A multi-byte payload is measured in bytes, not characters.
    const wide = JSON.stringify({ type: 'quota.updated', ids: {}, at, pad: 'é'.repeat(3600) });
    expect(wide.length).toBeLessThan(MAX_EVENT_PAYLOAD_BYTES);
    expect(decodeEvent(wide)).toBeUndefined();
    const spread = { ...many, ids: Object.fromEntries([['run', 'r'.repeat(70)]]) };
    expect(() => encodeEvent(spread)).toThrow(EventEncodingError);
    const tooBig = {
      type: 'quota.updated',
      get ids() {
        return {};
      },
      at: `2026-01-01T00:00:00.000Z${'0'.repeat(7000)}`,
    };
    expect(() => encodeEvent(tooBig as never)).toThrow(EventEncodingError);
  });

  it('[JOB-060] rejects malformed payloads', () => {
    for (const bad of [
      'not json',
      'null',
      '[]',
      '{"type":"run.updated"}',
      JSON.stringify({ type: 'x', ids: {}, at }),
      JSON.stringify({ type: 'quota.updated', ids: {}, at: 'yesterday' }),
      JSON.stringify({ type: 'quota.updated', ids: {}, at: '2026-01-01' }),
      JSON.stringify({ type: 'quota.updated', ids: {}, at: 'Jan 1 2026' }),
      JSON.stringify({ type: 'quota.updated', ids: {}, at: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'quota.updated', ids: {}, at: '2026-02-30T00:00:00.000Z' }),
      JSON.stringify({ type: 'quota.updated', ids: [], at }),
      JSON.stringify({ type: 'quota.updated', ids: { other: 'a' }, at }),
      JSON.stringify({ type: 'quota.updated', ids: { run: 5 }, at }),
      JSON.stringify({ type: 'quota.updated', ids: { run: 'a b' }, at }),
    ]) {
      expect(decodeEvent(bad)).toBeUndefined();
    }
    expect(parseEvent(undefined)).toBeUndefined();
  });

  it('[JOB-060] maps every event type to its topics', () => {
    expect(topicsForEvent(ev('migration.updated', { migration: 'm' }))).toEqual([
      'migration:m',
      'list:migrations',
    ]);
    expect(topicsForEvent(ev('run.updated', { run: 'r', migration: 'm' }))).toEqual([
      'run:r',
      'migration:m',
      'list:runs',
      'list:migrations',
    ]);
    expect(topicsForEvent(ev('run.updated', { run: 'r' }))).toEqual([
      'run:r',
      'list:runs',
      'list:migrations',
    ]);
    expect(topicsForEvent(ev('run.log', { run: 'r' }))).toEqual(['run:r']);
    expect(topicsForEvent(ev('task.updated', { task: 't', migration: 'm' }))).toEqual([
      'task:t',
      'migration:m',
      'list:tasks',
    ]);
    expect(topicsForEvent(ev('inventory.progress', { endpoint: 'e' }))).toEqual([
      'endpoint:e',
      'list:repositories',
    ]);
    expect(topicsForEvent(ev('quota.updated'))).toEqual(['quota']);
    expect(topicsForEvent(ev('invitation.updated', { invitation: 'i' }))).toEqual([
      'invitation:i',
      'list:invitations',
    ]);
    expect(EVENT_TYPES).toHaveLength(7);
    expect(topicsForEvent(ev('run.log'))).toEqual([]);
  });

  it('[JOB-060] validates topics', () => {
    for (const ok of ['quota', 'list:migrations', 'migration:abc_1-2', 'run:x', 'endpoint:e']) {
      expect(isValidTopic(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'list:other',
      'migration',
      'migration:',
      'bogus:1',
      'run:a b',
      'Quota',
    ]) {
      expect(isValidTopic(bad)).toBe(false);
    }
  });

  it('[JOB-060] parses the topics parameter', () => {
    expect(parseTopicList('migration:m1, run:r1,list:migrations,quota,quota')).toEqual({
      ok: true,
      topics: ['migration:m1', 'run:r1', 'list:migrations', 'quota'],
    });
    expect(parseTopicList(undefined).ok).toBe(false);
    expect(parseTopicList(' , ').ok).toBe(false);
    expect(parseTopicList('quota,nope').ok).toBe(false);
    const tooMany = Array.from({ length: MAX_TOPICS + 1 }, (_, i) => `run:r${i}`).join(',');
    expect(parseTopicList(tooMany).ok).toBe(false);
  });
});
