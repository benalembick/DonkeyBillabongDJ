/**
 * Local library database (SQLite via Node's built-in node:sqlite — no native
 * module to rebuild). Lives in the user's app-data folder and never leaves the
 * machine. Audio files are referenced by path and never modified.
 */
import { app } from "electron";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface TrackRow {
  ref: string;
  title: string;
  artist: string;
  album: string;
  genre: string | null;
  year: number | null;
  duration_ms: number | null;
  isrc: string | null;
  bpm: number | null;
  key: string | null;
  tags_read: number;
  added_at: number;
}

export interface MappingRow {
  key: string;
  metadata_source: string;
  metadata_track_id: string;
  audio_source: string;
  audio_track_id: string;
  isrc: string | null;
  confidence: number;
  method: string;
  user_confirmed: number;
  resolved_at: number;
}

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(path.join(app.getPath("userData"), "library.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tracks (
      ref TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      genre TEXT,
      year INTEGER,
      duration_ms INTEGER,
      isrc TEXT,
      bpm REAL,
      key TEXT,
      tags_read INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc);
    CREATE TABLE IF NOT EXISTS track_resolutions (
      key TEXT PRIMARY KEY,
      metadata_source TEXT NOT NULL,
      metadata_track_id TEXT NOT NULL,
      audio_source TEXT NOT NULL,
      audio_track_id TEXT NOT NULL,
      isrc TEXT,
      confidence INTEGER NOT NULL,
      method TEXT NOT NULL,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function loadTracks(): TrackRow[] {
  return open().prepare("SELECT * FROM tracks ORDER BY added_at, ref").all() as unknown as TrackRow[];
}

export function upsertTracks(rows: TrackRow[]): void {
  const d = open();
  const stmt = d.prepare(`
    INSERT INTO tracks (ref, title, artist, album, genre, year, duration_ms, isrc, bpm, key, tags_read, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ref) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
      genre=excluded.genre, year=excluded.year, duration_ms=excluded.duration_ms, isrc=excluded.isrc,
      bpm=excluded.bpm, key=excluded.key, tags_read=excluded.tags_read`);
  d.exec("BEGIN");
  try {
    for (const r of rows) {
      stmt.run(r.ref, r.title, r.artist, r.album, r.genre, r.year, r.duration_ms, r.isrc, r.bpm, r.key, r.tags_read, r.added_at);
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export function removeTracks(refs: string[]): void {
  const stmt = open().prepare("DELETE FROM tracks WHERE ref = ?");
  for (const r of refs) stmt.run(r);
}

export function loadMappings(): MappingRow[] {
  return open().prepare("SELECT * FROM track_resolutions").all() as unknown as MappingRow[];
}

export function putMapping(m: MappingRow): void {
  open()
    .prepare(
      `INSERT OR REPLACE INTO track_resolutions (key, metadata_source, metadata_track_id, audio_source, audio_track_id, isrc, confidence, method, user_confirmed, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(m.key, m.metadata_source, m.metadata_track_id, m.audio_source, m.audio_track_id, m.isrc, m.confidence, m.method, m.user_confirmed, m.resolved_at);
}

export function removeMapping(key: string): void {
  open().prepare("DELETE FROM track_resolutions WHERE key = ?").run(key);
}
