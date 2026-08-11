/**
 * The TimeTracking API's own vocabulary, and the two rules derived from it.
 *
 * Deliberately local to the desktop workspace rather than imported from
 * `@pixel/shared`: this package is self-contained (`rootDir: src`, no workspace
 * dependency) and — more to the point — the main process is now the ONLY part
 * of the system that knows this vendor exists. The server and the browser
 * bundle carry nothing but the coarse `WorkStatus`. That is the same boundary
 * `ipc.ts` and `client/src/desktop/bridge.ts` already keep between the desktop
 * and the renderer, for the same reason.
 *
 * The model that shapes everything here: a working time is a *pair* of
 * bookings. An entry is opened by a beginning booking (COMING, HOMEOFFICE, …)
 * and closed by an ending one. "Pause" is therefore not a state anyone holds —
 * it is the booking that closes the current entry, and resuming opens a fresh
 * one. Which bookings are legal right now is configured per install as a DFA
 * and reported by the API itself as `allowedBookings`, so nothing here
 * hard-codes what may follow what.
 */
import type { WorkAction, WorkStatus } from '../ipc.js';

export type BookingType =
  | 'COMING'
  | 'LEAVING'
  | 'BREAK'
  | 'HOMEOFFICE'
  | 'BUSINESS_TRIP'
  | 'BUSINESS_DRIVE'
  | 'ON_COMPANY_GROUND'
  | 'CUSTOM_TYPE_1'
  | 'CUSTOM_TYPE_2'
  | 'CUSTOM_TYPE_3';

export type BookingDirection = 'BEGINNING' | 'ENDING';

/** One booking the API says this user may make right now. */
export interface AllowedBooking {
  bookingType: BookingType;
  bookingDirection: BookingDirection;
}

/** Only these open an entry that counts as "at work" in the world. */
const BEGINNING_STATUS: Partial<Record<BookingType, WorkStatus>> = {
  COMING: 'working',
  ON_COMPANY_GROUND: 'working',
  HOMEOFFICE: 'homeoffice',
  BUSINESS_TRIP: 'trip',
  BUSINESS_DRIVE: 'trip',
};

/**
 * Derive the world status from the current entry.
 *
 * An entry with no ending booking yet is *running*, and its opening booking
 * says what kind of work it is. Once closed, the closing booking says why:
 * BREAK reads as a pause, anything else as off the clock. A booking type nobody
 * mapped falls back to 'working' while running — better to show someone as at
 * work than to blank their status because their employer renamed a button.
 */
export function statusFromEntry(
  firstBookingType: BookingType | null,
  lastBookingType: BookingType | null,
  running: boolean,
): WorkStatus {
  if (running) return (firstBookingType && BEGINNING_STATUS[firstBookingType]) || 'working';
  return lastBookingType === 'BREAK' ? 'break' : 'away';
}

/**
 * Translate a button into a booking the API says is legal right now, or null
 * when it isn't — which is what greys the button out on the clock's face.
 *
 * Starting and resuming after a break are the same move (both open an entry),
 * so 'start' takes COMING when offered and otherwise whatever beginning booking
 * the install does offer — one that only allows HOMEOFFICE still works. 'end'
 * avoids BREAK for the same reason 'pause' insists on it: a break closes the
 * entry without ending the day.
 */
export function bookingForAction(action: WorkAction, allowed: readonly AllowedBooking[]): AllowedBooking | null {
  const inDirection = (d: BookingDirection): AllowedBooking[] => allowed.filter((a) => a.bookingDirection === d);
  const preferring = (list: AllowedBooking[], type: BookingType): AllowedBooking | undefined =>
    list.find((a) => a.bookingType === type);

  switch (action) {
    case 'start': {
      const beginnings = inDirection('BEGINNING');
      return preferring(beginnings, 'COMING') ?? beginnings[0] ?? null;
    }
    case 'pause':
      return preferring(inDirection('ENDING'), 'BREAK') ?? null;
    case 'end': {
      const endings = inDirection('ENDING');
      return preferring(endings, 'LEAVING') ?? endings.find((a) => a.bookingType !== 'BREAK') ?? null;
    }
  }
}
