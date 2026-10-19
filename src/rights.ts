import type { Rights, UseAction } from './types.js';
import { parseInstant } from './time.js';

export const USE_ACTIONS: readonly UseAction[] = ['evaluation', 'retain', 'subscriber_display', 'media_mirror', 'export'];
const PERMISSIONS = new Set(['ALLOWED', 'DENIED', 'UNKNOWN']);

/**
 * Fail closed. Unknown is never treated as permission.
 * Expiry is compared as instants, not strings; an unparseable expiry or clock
 * value denies.
 */
export function mayUse(rights: Rights | undefined, action: UseAction, now: string = new Date().toISOString()): boolean {
  if (!rights || rights[action] !== 'ALLOWED') return false;
  if (rights.expiresAt !== undefined) {
    const expires = parseInstant(rights.expiresAt);
    const current = parseInstant(now);
    if (!expires || !current || expires.getTime() <= current.getTime()) return false;
  }
  return true;
}

export function assertPermitted(rights: Rights | undefined, action: UseAction, now?: string): void {
  if (!mayUse(rights, action, now)) throw new Error(`RIGHTS_BLOCKED:${action}`);
}

export function validateRights(rights: Rights): void {
  for (const action of USE_ACTIONS) {
    if (!PERMISSIONS.has(rights[action])) throw new Error(`Invalid right: ${action}`);
  }
  if (typeof rights.sourceId !== 'string' || !rights.sourceId.trim() || typeof rights.basis !== 'string' || !rights.basis.trim()) {
    throw new Error('Missing source or rights basis');
  }
  if (rights.expiresAt !== undefined && (typeof rights.expiresAt !== 'string' || !parseInstant(rights.expiresAt))) {
    throw new Error('Invalid rights expiresAt');
  }
}
