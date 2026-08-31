export const RADAR_PROFILE_VERSION = 'radar_profile_v1';
export const RADAR_MONITOR_CREATE_VERSION = 'radar_monitor_create_v1';

export class RadarApiError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'RadarApiError';
    this.status = status;
    this.code = code;
  }
}

export function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return '';
}

export function csrfFromCookies(cookieHeader) {
  return cookieValue(cookieHeader, '__Host-radar_csrf') || cookieValue(cookieHeader, 'radar_csrf');
}

export function monitorTargetKey(target) {
  if (target?.kind === 'parcel') return `parcel:${target.parcel_id}`;
  if (target?.kind === 'parcel_set') return `parcel_set:${[...(target.parcel_ids || [])].sort().join('|')}`;
  if (target?.kind === 'radius') return `radius:${target.lat}:${target.lng}:${target.radius_m}`;
  return '';
}

export function monitorLabel(target) {
  if (target?.kind === 'parcel') return `Działka ${target.parcel_id}`;
  if (target?.kind === 'parcel_set') {
    const count = target.parcel_ids?.length || 0;
    return `${count} ${count === 2 ? 'działki' : 'działek'}`;
  }
  if (target?.kind === 'radius') {
    return `Obszar ${target.radius_m >= 1000 ? `${target.radius_m / 1000} km` : `${target.radius_m} m`}`;
  }
  return 'Monitoring miejsca';
}

export function monitorIncludesParcel(monitor, parcelId) {
  if (monitor?.target?.kind === 'parcel') return monitor.target.parcel_id === parcelId;
  return monitor?.target?.kind === 'parcel_set' && monitor.target.parcel_ids.includes(parcelId);
}

export function monitorCreateBody(target, {
  idempotencyKey,
  source = 'new',
  observedSince,
} = {}) {
  const body = {
    version: RADAR_MONITOR_CREATE_VERSION,
    idempotency_key: idempotencyKey,
    source,
    target,
  };
  if (source === 'local_storage_v1') body.observed_since = observedSince;
  return body;
}

export function reusablePendingCreate(pending, target, idempotencyKey) {
  const key = monitorTargetKey(target);
  return pending.find((body) => monitorTargetKey(body.target) === key)
    || monitorCreateBody(target, { idempotencyKey });
}

export function removeMonitorBackup(watches, monitorId) {
  return watches.filter((watch) => watch.serverMonitorId !== monitorId);
}

export function radarErrorMessage(error) {
  const code = error?.code;
  if (code === 'profile_unavailable') return 'Sesja Radaru wygasła. Utwórz monitoring ponownie.';
  if (code === 'csrf_invalid' || code === 'origin_forbidden') return 'Sesja bezpieczeństwa wygasła. Odśwież stronę i spróbuj ponownie.';
  if (code === 'monitor_limit_reached') return 'Osiągnięto limit monitorowanych miejsc.';
  if (code === 'parcel_not_found') return 'Ta działka nie jest już dostępna w aktualnych danych.';
  if (code === 'rate_limited' || code === 'capacity_limited') return 'Radar ma teraz zbyt wiele żądań. Spróbuj ponownie później.';
  if (code === 'monitor_not_found') return 'Ten monitoring nie istnieje lub został już usunięty.';
  return 'Nie udało się wykonać operacji. Spróbuj ponownie.';
}

export function isRetryableRadarError(error) {
  return !Number.isInteger(error?.status) || error.status >= 500;
}

export function createRadarClient({
  fetchFn = globalThis.fetch,
  cookieHeader = () => globalThis.document?.cookie || '',
} = {}) {
  async function request(path, { method = 'GET', body, csrf = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) {
      const token = csrfFromCookies(cookieHeader());
      if (!token) throw new RadarApiError(403, 'csrf_invalid');
      headers['X-Radar-CSRF'] = token;
    }
    const response = await fetchFn(`/api/radar${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    if (response.status !== 204) {
      try { payload = await response.json(); } catch { payload = null; }
    }
    if (!response.ok) throw new RadarApiError(response.status, payload?.error || 'request_failed');
    return payload;
  }

  return {
    async probeProfile() {
      try {
        const profile = await request('/profile');
        return { available: true, authenticated: true, profile };
      } catch (error) {
        if (error instanceof RadarApiError && error.status === 401) {
          return { available: true, authenticated: false, profile: null };
        }
        if (error instanceof RadarApiError && error.status === 404) {
          return { available: false, authenticated: false, profile: null };
        }
        throw error;
      }
    },
    createProfile: () => request('/profile', { method: 'POST', body: {} }),
    listMonitors: () => request('/monitors'),
    createMonitor: (body) => request('/monitors', { method: 'POST', body, csrf: true }),
    pauseMonitor: (id) => request(`/monitors/${id}/pause`, { method: 'POST', body: {}, csrf: true }),
    resumeMonitor: (id) => request(`/monitors/${id}/resume`, { method: 'POST', body: {}, csrf: true }),
    deleteMonitor: (id) => request(`/monitors/${id}`, { method: 'DELETE', body: {}, csrf: true }),
    readEvents: (afterMatchId = '0') => request(`/events?after_match_id=${encodeURIComponent(afterMatchId)}`),
  };
}
