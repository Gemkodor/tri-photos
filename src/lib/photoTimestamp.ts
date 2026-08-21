/**
 * Best-effort "when was this taken" guess, read straight out of the file
 * name - real EXIF metadata isn't reachable for SAF content:// URIs without
 * native code (which would mean leaving Expo Go behind), but most phones
 * and apps already bake a timestamp into the name (camera defaults like
 * "20260802_083757.jpg", WhatsApp's "IMG-20250322-WA0015.jpg"...), so this
 * costs nothing and needs no new permissions or libraries.
 *
 * Used only as a *safety net* for grouping "similar" photos: two photos
 * whose names both parse to a timestamp far apart are very unlikely to be
 * the same shooting session, no matter how close their visual hash lands -
 * exactly the kind of coincidence (e.g. two unrelated bathroom photos)
 * that was slipping through on hash alone.
 */

// "20260802_083757" or "20260802-083757" - the common camera default,
// date immediately followed by time. Captured with real HH:MM:SS.
const DATE_TIME_PATTERN = /(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/;

// "IMG-20250322-WA0015" - WhatsApp's naming. Only a date, no real time (the
// digits after WA are a message id, not a clock) - treated as noon that day
// so it's still useful for "different day" comparisons, just coarser.
const DATE_ONLY_PATTERN = /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})(?:[^0-9]|$)/;

function toTimestamp(y: string, mo: string, d: string, h = '12', mi = '00', s = '00'): number | null {
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, Number(h), Number(mi), Number(s));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** Parses a "when taken" guess (epoch ms) from a file name, or null if nothing recognizable was found. */
export function extractTimestampFromName(name: string): number | null {
  const dateTime = name.match(DATE_TIME_PATTERN);
  if (dateTime) {
    const [, y, mo, d, h, mi, s] = dateTime;
    const ts = toTimestamp(y, mo, d, h, mi, s);
    if (ts !== null) return ts;
  }
  const dateOnly = name.match(DATE_ONLY_PATTERN);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return toTimestamp(y, mo, d);
  }
  return null;
}
