// Sunrise/sunset from the standard sunrise equation (accurate to ~1-2 minutes at mid latitudes).
// Computing it locally means sun times never depend on a weather API being available.

const RAD = Math.PI / 180;
const J2000 = 2451545.0;
const UNIX_EPOCH_JD = 2440587.5;

const sin = (deg) => Math.sin(deg * RAD);
const cos = (deg) => Math.cos(deg * RAD);

/**
 * @param {string} date local date 'YYYY-MM-DD'
 * @returns {{sunrise: number|null, sunset: number|null, polar: 'day'|'night'|null}}
 */
export function sunTimes(date, lat, lon) {
  const [y, m, d] = date.split('-').map(Number);
  const jdNoon = Date.UTC(y, m - 1, d, 12) / 86_400_000 + UNIX_EPOCH_JD;
  const n = Math.round(jdNoon - J2000);
  const jStar = n + 0.0009 - lon / 360;
  const M = (((357.5291 + 0.98560028 * jStar) % 360) + 360) % 360;
  const C = 1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = J2000 + jStar + 0.0053 * sin(M) - 0.0069 * sin(2 * lambda);
  const sinDec = sin(lambda) * sin(23.44);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (sin(-0.833) - sin(lat) * sinDec) / (cos(lat) * cosDec);
  if (cosH > 1) return { sunrise: null, sunset: null, polar: 'night' };
  if (cosH < -1) return { sunrise: null, sunset: null, polar: 'day' };
  const H = Math.acos(cosH) / RAD;
  const toMs = (j) => Math.round((j - UNIX_EPOCH_JD) * 86_400_000);
  return { sunrise: toMs(jTransit - H / 360), sunset: toMs(jTransit + H / 360), polar: null };
}
