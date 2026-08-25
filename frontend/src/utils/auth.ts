const DEVICE_KEY = "matrixspooll_auth_device";
const CSRF_COOKIE_KEY = "matrixspooll_csrf_token";
const LEGACY_TOKEN_KEY = "matrixspooll_auth_token";

function getCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  const value = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

export function getDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_KEY, value);
  return value;
}

/**
 * Consume the bearer token stored by releases predating HttpOnly sessions.
 * The value is removed before it is returned so a failed exchange cannot
 * leave a long-lived credential in browser storage.
 */
export function consumeLegacyToken(): string | null {
  try {
    const token = localStorage.getItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    return token;
  } catch {
    return null;
  }
}

export function discardLegacyToken(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function withSession(options: RequestInit = {}): RequestInit {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const csrfToken = getCookie(CSRF_COOKIE_KEY);
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }
  return { ...options, credentials: "same-origin", headers };
}

export function sessionFetch(input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> {
  return fetch(input, withSession(options));
}
