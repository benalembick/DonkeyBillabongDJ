/**
 * Credential storage for streaming accounts on desktop. Values are encrypted
 * with the OS keychain (DPAPI on Windows, Keychain on macOS) via Electron
 * safeStorage and never exposed to the renderer.
 */
import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { KeyValueStore } from "../../src/providers/web";

type Stored = Record<string, { enc: boolean; data: string }>;

function filePath(): string {
  return path.join(app.getPath("userData"), "streaming-credentials.json");
}

async function readAll(): Promise<Stored> {
  try {
    return JSON.parse(await fs.readFile(filePath(), "utf8")) as Stored;
  } catch {
    return {};
  }
}

export const secureStore: KeyValueStore = {
  async get<T>(key: string): Promise<T | null> {
    const entry = (await readAll())[key];
    if (!entry) return null;
    try {
      const json = entry.enc ? safeStorage.decryptString(Buffer.from(entry.data, "base64")) : entry.data;
      return JSON.parse(json) as T;
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown | null): Promise<void> {
    const all = await readAll();
    if (value === null) delete all[key];
    else {
      const json = JSON.stringify(value);
      all[key] = safeStorage.isEncryptionAvailable()
        ? { enc: true, data: safeStorage.encryptString(json).toString("base64") }
        : { enc: false, data: json };
    }
    await fs.mkdir(path.dirname(filePath()), { recursive: true });
    await fs.writeFile(filePath(), JSON.stringify(all), { mode: 0o600 });
  },
};
