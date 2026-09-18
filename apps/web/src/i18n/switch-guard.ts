'use client';
import { useEffect, useRef, useSyncExternalStore } from 'react';
type Guard = { busy?: boolean; dirty?: boolean };
const guards = new Map<symbol, Guard>();
const listeners = new Set<() => void>();
function snapshot() {
  let state = 0;
  for (const value of guards.values()) state |= (value.busy ? 1 : 0) | (value.dirty ? 2 : 0);
  return state;
}
function emit() {
  for (const listener of listeners) listener();
}
export function useLocaleGuard({ busy = false, dirty = false }: Guard) {
  const id = useRef(Symbol());
  useEffect(() => {
    const token = id.current;
    guards.set(token, { busy, dirty });
    emit();
    return () => {
      guards.delete(token);
      emit();
    };
  }, [busy, dirty]);
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useLocaleSwitchGuard() {
  const state = useSyncExternalStore(subscribe, snapshot, () => 0);
  return { busy: Boolean(state & 1), dirty: Boolean(state & 2) };
}

let localeUnloadAllowed = false;
export function allowLocaleUnload() {
  localeUnloadAllowed = true;
}
export function isLocaleUnloadAllowed() {
  return localeUnloadAllowed;
}
