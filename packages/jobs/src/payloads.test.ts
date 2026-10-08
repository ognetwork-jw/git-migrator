import { describe, expect, it } from 'vitest';
import { InvalidPayloadError, isJobName, JOB_PAYLOADS, parsePayload } from './payloads.ts';
import { QUEUE_DEFINITIONS, QUEUE_NAMES } from './queues.ts';

describe('job payloads', () => {
  it('[JOB-011] has a payload schema for every job on every queue', () => {
    for (const queue of QUEUE_NAMES) {
      for (const job of QUEUE_DEFINITIONS[queue].jobs) expect(JOB_PAYLOADS).toHaveProperty(job);
    }
    expect(isJobName('run.execute')).toBe(true);
    expect(isJobName('run.other')).toBe(false);
    expect(isJobName('toString')).toBe(false);
  });

  it('[JOB-011] accepts IDs and nothing else', () => {
    expect(parsePayload('run.execute', { runId: 'r1' })).toEqual({ runId: 'r1' });
    expect(parsePayload('maintenance.prune', {})).toEqual({});
    expect(parsePayload('inventory.namespace', { endpointId: 'e', namespaceId: 'n' })).toEqual({
      endpointId: 'e',
      namespaceId: 'n',
    });
  });

  it('[JOB-011] refuses a missing ID, an empty ID and a wrong type', () => {
    expect(() => parsePayload('run.execute', {})).toThrow(InvalidPayloadError);
    expect(() => parsePayload('run.execute', { runId: '' })).toThrow(InvalidPayloadError);
    expect(() => parsePayload('run.execute', { runId: 5 })).toThrow(InvalidPayloadError);
    expect(() => parsePayload('analysis.migration', null)).toThrow(InvalidPayloadError);
  });

  it('[JOB-011] refuses extra fields, so a secret cannot ride along, and never echoes values', () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    let message = '';
    try {
      parsePayload('run.execute', { runId: 'r1', token: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('run.execute');
    expect(message).not.toContain(secret);
    expect(() => parsePayload('maintenance.prune', { x: 1 })).toThrow(InvalidPayloadError);
  });
});
