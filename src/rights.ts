import type { Rights, UseAction } from './types.js';
/** Fail closed. Unknown is never treated as permission. */
export function mayUse(rights: Rights | undefined, action: UseAction, now = new Date().toISOString()): boolean {
  if (!rights || rights[action] !== 'ALLOWED') return false;
  if (rights.expiresAt && rights.expiresAt <= now) return false;
  return true;
}
export function assertPermitted(rights: Rights | undefined, action: UseAction): void {
  if (!mayUse(rights, action)) throw new Error(`RIGHTS_BLOCKED:${action}`);
}
export function validateRights(rights: Rights): void {
  for (const action of ['evaluation','retain','subscriber_display','media_mirror','export'] as const) {
    if (!['ALLOWED','DENIED','UNKNOWN'].includes(rights[action])) throw new Error(`Invalid right: ${action}`);
  }
  if (!rights.sourceId.trim() || !rights.basis.trim()) throw new Error('Missing source or rights basis');
}
