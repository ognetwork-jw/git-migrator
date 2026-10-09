import { createRow, deleteRow, findMany, updateRow } from '../model/rpc.ts';

/** A Wave (DOM-013): the Model API lists and edits them; progress comes from `GET /dashboard`. */
export interface WaveRow {
  readonly id: string;
  readonly name: string;
  readonly targetDate: string | null;
  readonly description: string | null;
}

export interface WaveInput {
  readonly name: string;
  readonly targetDate: string | null;
  readonly description: string | null;
}

/** Waves shown on the list (the dashboard flags more than this as truncated). */
const MAX_WAVES = 200;

export const wavePageKey = ['waves', 'list'] as const;
export const waveKey = (id: string) => ['waves', 'one', id] as const;
export const waveRouteKey = (id: string) => ['waves', 'route', id] as const;

const SELECT = { id: true, name: true, targetDate: true, description: true } as const;

export const fetchWaveRows = () =>
  findMany<WaveRow>('wave', { orderBy: { name: 'asc' }, take: MAX_WAVES, select: SELECT });

export const fetchWave = async (id: string): Promise<WaveRow | null> =>
  (await findMany<WaveRow>('wave', { where: { id }, take: 1, select: SELECT }))[0] ?? null;

/** The Route of one of the Wave's repositories, so the detail table opens on a Route that has some. */
export const fetchWaveRoute = async (id: string): Promise<string | null> =>
  (
    await findMany<{ routeId: string }>('migration', {
      where: { waveId: id, scope: 'repository' },
      orderBy: { id: 'asc' },
      take: 1,
      select: { routeId: true },
    })
  )[0]?.routeId ?? null;

export const createWave = (input: WaveInput) => createRow<WaveRow>('wave', { ...input });
export const updateWave = (id: string, input: WaveInput) =>
  updateRow<WaveRow>('wave', { id }, { ...input });
export const deleteWave = (id: string) => deleteRow('wave', { id });
