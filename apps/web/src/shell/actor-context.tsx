'use client';

import { createContext, useContext } from 'react';
import type { Actor } from '../api/actor.ts';

const ActorContext = createContext<Actor | undefined>(undefined);

export const ActorProvider = ActorContext.Provider;

/** The signed-in Actor. Only valid below the shell, which renders children once it is known. */
export function useActor(): Actor {
  const actor = useContext(ActorContext);
  if (actor === undefined) throw new Error('useActor must be used inside the app shell');
  return actor;
}
