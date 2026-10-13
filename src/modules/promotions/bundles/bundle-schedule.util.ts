import {
  resolveScheduleWindow,
  ScheduleWindowInput,
  ScheduleWindowWrite,
} from '../../../common/schedule/schedule-window.util';

export type BundleScheduleInput = ScheduleWindowInput;
export type BundleScheduleWrite = ScheduleWindowWrite;

/** Bundle schedule resolution - see common/schedule/schedule-window.util.ts. */
export const resolveBundleSchedule = resolveScheduleWindow;

export type BundleStatus = 'DISABLED' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED';

/**
 * Admin-facing lifecycle state, using the exact same window the pricing
 * query applies (startsAt <= now <= expiresAt) so the list can never claim
 * "Active" for a bundle that checkout is not applying.
 */
export function computeBundleStatus(
  bundle: { isEnabled: boolean; startsAt: Date | null; expiresAt: Date | null },
  now: Date = new Date(),
): BundleStatus {
  if (!bundle.isEnabled) return 'DISABLED';
  if (bundle.startsAt && bundle.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  if (bundle.expiresAt && bundle.expiresAt.getTime() < now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}
