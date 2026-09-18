/**
 * Geofenced pass activation (round 5). The seam between PorchPass's
 * geofence constraint and a real source of a visitor's location — the same
 * pattern `ringClient.ts` uses for Ring itself: a small interface a real
 * deployment implements against actual hardware/SDKs, with a simulator
 * standing in here since there's no real geolocation hardware available in
 * this sandboxed environment.
 *
 * What's actually missing isn't the distance math (that's a few lines of
 * trigonometry, and it's honest either way) — it's that a raw
 * `{ lat, lng }` in a POST body is trivially spoofable: anyone who knows a
 * pass's ID can claim to be standing at the front door. A real deployment
 * would source the coordinates from a signal a client can't just type in —
 * a companion mobile app reading the OS's native geolocation API (which
 * layers in GPS/Wi-Fi/cell fusion and, on iOS/Android, real anti-spoofing),
 * or a network-level coarse-location cross-check — rather than trusting
 * whatever numbers arrive on the wire. `SimulatedGeoVerifier` does the
 * honest haversine-distance comparison on exactly the coordinates it's
 * given, with no attestation of where they actually came from, which is
 * precisely the gap `RingClient`'s doc comment calls out for Ring itself.
 */

export interface HomeLocation {
  lat: number;
  lng: number;
}

export interface ProximityResult {
  withinRadius: boolean;
  distanceMeters: number;
}

export interface GeoVerifier {
  /** Compares a claimed `{lat, lng}` against the household's configured home location and radius. */
  verifyProximity(lat: number, lng: number, home: HomeLocation, radiusMeters: number): ProximityResult;
}

export const DEFAULT_GEOFENCE_RADIUS_METERS = 200;

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in meters (haversine formula). */
export function haversineDistanceMeters(a: HomeLocation, b: HomeLocation): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** In-memory geolocation simulator — see the module doc comment above. */
export class SimulatedGeoVerifier implements GeoVerifier {
  verifyProximity(lat: number, lng: number, home: HomeLocation, radiusMeters: number): ProximityResult {
    const distanceMeters = haversineDistanceMeters(home, { lat, lng });
    return { withinRadius: distanceMeters <= radiusMeters, distanceMeters };
  }
}
