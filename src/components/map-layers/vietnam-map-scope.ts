export const VIETNAM_MAP_BOUNDS = {
  minLng: 101.0,
  maxLng: 110.8,
  minLat: 7.4,
  maxLat: 23.6,
};

export function isInsideVietnamMapBounds(lat?: number | null, lng?: number | null): boolean {
  if (lat == null || lng == null) return false;
  return (
    lng >= VIETNAM_MAP_BOUNDS.minLng &&
    lng <= VIETNAM_MAP_BOUNDS.maxLng &&
    lat >= VIETNAM_MAP_BOUNDS.minLat &&
    lat <= VIETNAM_MAP_BOUNDS.maxLat
  );
}
