import { sha256Hex } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  bitbucketCloudToGithubPipelinesDelivery,
  ORIGINAL_PIPELINES_PATH,
  PIPELINES_PURPOSE,
  renderPipelinesDelivery,
} from './delivery.ts';
import { DELIVERY_BRANCH, PIPELINES_SOURCE_TYPE, PIPELINES_TARGET_TYPE } from './index.ts';

const SIMPLE = 'pipelines:\n  default:\n    - step:\n        script:\n          - make\n';

describe('pipelines delivery', () => {
  it('[LIF-047] is the pair and the branch the translation names', () => {
    expect(bitbucketCloudToGithubPipelinesDelivery.source).toBe(PIPELINES_SOURCE_TYPE);
    expect(bitbucketCloudToGithubPipelinesDelivery.target).toBe(PIPELINES_TARGET_TYPE);
    expect(`git-migrator/${PIPELINES_PURPOSE}`).toBe(DELIVERY_BRANCH);
  });

  it('[LIF-047] delivers the generated workflows and the original file for review', () => {
    const out = renderPipelinesDelivery({ text: SIMPLE });
    expect(out.files.map((f) => f.path)).toEqual([
      '.github/workflows/ci.yml',
      ORIGINAL_PIPELINES_PATH,
    ]);
    expect(out.files.at(-1)?.content).toBe(SIMPLE);
    expect(ORIGINAL_PIPELINES_PATH).toBe('.github/git-migrator/bitbucket-pipelines.yml');
    expect(out.body).toContain(ORIGINAL_PIPELINES_PATH);
  });

  it('[FAC-PIP-003] recomputes exactly the content that translate hashed into desired', () => {
    const first = renderPipelinesDelivery({ text: SIMPLE });
    const again = renderPipelinesDelivery({ text: SIMPLE });
    expect(first).toEqual(again);
    expect(sha256Hex(first.files[0]?.content ?? '')).toBe(sha256Hex(again.files[0]?.content ?? ''));
  });
});
