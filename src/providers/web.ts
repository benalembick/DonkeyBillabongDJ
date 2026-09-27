/**
 * Small helpers that work identically in the browser and in Node/Electron
 * (both provide fetch, WebCrypto and TextEncoder).
 */

export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown | null): Promise<void>;
}

/** JSON fetch with a timeout; network problems never hang the app. */
export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

export function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

export async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** localStorage-backed store for browser mode. */
export class LocalStorageStore implements KeyValueStore {
  private readonly prefix: string;
  constructor(prefix = "dbdj.streaming.") {
    this.prefix = prefix;
  }
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = localStorage.getItem(this.prefix + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }
  async set(key: string, value: unknown | null): Promise<void> {
    try {
      if (value === null) localStorage.removeItem(this.prefix + key);
      else localStorage.setItem(this.prefix + key, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode): the session just won't persist */
    }
  }
}
