import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const authorizePage = vi.fn(async (path: string) => {
  order.push(`authorize ${path}`);
});

vi.mock('./authorize.ts', () => ({ authorizePage: (path: string) => authorizePage(path) }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => {
    order.push('translate');
    return key;
  },
}));
vi.mock('../waves/waves-view.tsx', () => ({ WavesView: () => null }));
vi.mock('../waves/wave-detail-view.tsx', () => ({ WaveDetailView: () => null }));
vi.mock('../ui/page-heading.tsx', () => ({ PageHeading: () => null }));

const list = await import('../../app/(shell)/waves/page.tsx');
const detail = await import('../../app/(shell)/waves/[id]/page.tsx');

beforeEach(() => {
  order.length = 0;
  authorizePage.mockClear();
});

describe('[AUTH-021] [UI-024] the Wave pages are gated on the server', () => {
  it('[AUTH-021] [UI-024] the list authorizes "/waves" before anything else renders', async () => {
    const page = await list.default();
    expect(order[0]).toBe('authorize /waves');
    expect(page).toBeTruthy();
    expect(list.dynamic).toBe('force-dynamic');
  });

  it('[AUTH-021] [UI-024] the detail page authorizes "/waves" and renders the Wave of the address', async () => {
    const page = (await detail.default({ params: Promise.resolve({ id: 'w1' }) })) as {
      props: { children: { props: { id: string } }[] };
    };
    expect(order[0]).toBe('authorize /waves');
    expect(page.props.children[1]?.props.id).toBe('w1');
    expect(detail.dynamic).toBe('force-dynamic');
  });

  it('[AUTH-021] [UI-024] a redirect from the gate stops the pages from rendering', async () => {
    authorizePage.mockRejectedValue(new Error('NEXT_REDIRECT /signin'));
    await expect(list.default()).rejects.toThrow('NEXT_REDIRECT');
    await expect(detail.default({ params: Promise.resolve({ id: 'w1' }) })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(order).not.toContain('translate');
  });
});
