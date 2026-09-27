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
  rating: number;
  artwork: string | null;
}

export interface PlaylistRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  /** Ordered track refs. */
  refs: string[];
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
    -- (rating column is added by migrate() for databases created before it existed)
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
  migrate(db);
  return db;
}

/** Additive schema migrations for existing databases. */
function migrate(d: DatabaseSync): void {
  const cols = (d.prepare("PRAGMA table_info(tracks)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("rating")) d.exec("ALTER TABLE tracks ADD COLUMN rating INTEGER NOT NULL DEFAULT 0");
  d.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      ref TEXT NOT NULL,
      PRIMARY KEY (playlist_id, position)
    );
  `);
  if (!cols.includes("artwork")) {
    d.exec("ALTER TABLE tracks ADD COLUMN artwork TEXT");
    // Re-read tags once so existing tracks pick up their embedded cover art.
    d.exec("UPDATE tracks SET tags_read = 0");
  }
}

export function loadTracks(): TrackRow[] {
  return open().prepare("SELECT * FROM tracks ORDER BY added_at, ref").all() as unknown as TrackRow[];
}

export function upsertTracks(rows: TrackRow[]): void {
  const d = open();
  const stmt = d.prepare(`
    INSERT INTO tracks (ref, title, artist, album, genre, year, duration_ms, isrc, bpm, key, tags_read, added_at, rating, artwork)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ref) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
      genre=excluded.genre, year=excluded.year, duration_ms=excluded.duration_ms, isrc=excluded.isrc,
      bpm=excluded.bpm, key=excluded.key, tags_read=excluded.tags_read, rating=excluded.rating, artwork=excluded.artwork`);
  d.exec("BEGIN");
  try {
    for (const r of rows) {
      stmt.run(r.ref, r.title, r.artist, r.album, r.genre, r.year, r.duration_ms, r.isrc, r.bpm, r.key, r.tags_read, r.added_at, r.rating ?? 0, r.artwork ?? null);
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

export function loadPlaylists(): PlaylistRow[] {
  const d = open();
  const lists = d.prepare("SELECT * FROM playlists ORDER BY created_at, id").all() as unknown as Omit<PlaylistRow, "refs">[];
  const tracks = d.prepare("SELECT ref FROM playlist_tracks WHERE playlist_id = ? ORDER BY position");
  return lists.map((p) => ({ ...p, refs: (tracks.all(p.id) as { ref: string }[]).map((r) => r.ref) }));
}

/** Replace one playlist (name + full ordered track list) atomically. */
export function savePlaylist(p: PlaylistRow): void {
  const d = open();
  d.exec("BEGIN");
  try {
    d.prepare(
      `INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(p.id, p.name, p.created_at, p.updated_at);
    d.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").run(p.id);
    const ins = d.prepare("INSERT INTO playlist_tracks (playlist_id, position, ref) VALUES (?, ?, ?)");
    p.refs.forEach((ref, i) => ins.run(p.id, i, ref));
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export function removePlaylist(id: string): void {
  const d = open();
  d.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").run(id);
  d.prepare("DELETE FROM playlists WHERE id = ?").run(id);
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
