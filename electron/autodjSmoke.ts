/** Opt-in integration check using disposable generated audio and the real renderer/audio/storage. */
import type { App } from "../src/app/createApp";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeImage } from "electron";
import { taggedWav } from "../tests/fixtures/taggedWav";

export async function autoDJFixtures(): Promise<{ ref: string; name: string; bytes: number[] }[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbdj-auto-dj-"));
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 30; pixels[i + 1] = 130; pixels[i + 2] = 240; pixels[i + 3] = 255; }
  const cover = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }).toPNG();
  return Promise.all(["Opening", "Main Set", "Finale"].map(async (name) => {
    const bytes = taggedWav({ title: name, artist: "Auto DJ Test", seconds: 12, sampleRate: 8000, cover });
    const ref = path.join(dir, `${name}.wav`);
    await fs.writeFile(ref, bytes);
    return { ref, name: `${name}.wav`, bytes: [...bytes] };
  }));
}

// Serialized into the renderer by the smoke harness; keep this function self-contained.
export async function runAutoDJSmoke(a: App, fixtures: { ref: string; name: string; bytes: number[] }[]) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(`Auto DJ smoke: ${message}`); };
  a.autoDJ.stop();
  a.engine.getState().decks.forEach((d, i) => { if (d.playing) a.bus.send(`deck${i + 1}.play`); });
  a.bus.send("mixer.master.level", 0); // Exercise the real graph without audible test tones.
  const files = fixtures.map((f) => new File([new Uint8Array(f.bytes)], f.name, { type: "audio/wav", lastModified: 1 }));
  const rows = a.platform.kind === "browser" ? await a.platform.refsFromDrop(files) : fixtures;
  await a.addFiles(rows);
  for (let i = 0; i < 100 && rows.some((r) => !a.library.getByRef(r.ref)?.artworkRead); i++) await sleep(50);
  assert(rows.every((r) => a.library.getByRef(r.ref)?.artworkUrl), "embedded artwork extracted on all fixtures");
  const image = new Image();
  image.src = a.library.getByRef(rows[0].ref)!.artworkUrl!;
  await image.decode();
  assert(image.naturalWidth > 0, "cached artwork is decodable under production CSP");
  if (a.platform.kind === "browser") {
    const reselected = await a.platform.refsFromDrop(files);
    assert(reselected[0].ref === rows[0].ref, "browser references survive reselection");
    const stored = await a.platform.library!.load();
    assert(stored.find((t) => t.ref === rows[0].ref)?.unavailableReason, "browser reload retains metadata and requests reconnection");
  }
  const p = a.playlists.create("Auto DJ smoke", rows.map((r) => r.ref));
  const copy = a.playlists.duplicate(p.id)!;
  a.playlists.rename(copy.id, "Duplicate renamed");
  a.playlists.move(copy.id, 2, 0);
  a.playlists.removeAt(copy.id, [1]);
  await a.playlists.flush();
  const persisted = await a.platform.playlists.load();
  assert(persisted.find((r) => r.id === copy.id)?.refs.join() === [rows[2].ref, rows[1].ref].join(), "ordered playlist persisted");
  await a.playlists.remove(copy.id);
  assert(!(await a.platform.playlists.load()).some((r) => r.id === copy.id), "playlist deletion persisted");
  a.autoDJ.configure({ style: "quick-fade", bars: "auto", repeat: false, shuffle: false });
  await a.autoDJ.start(p.id);
  assert(a.engine.getState().decks[0].playing, "first track playing");
  assert(a.engine.getState().decks[1].track?.ref === rows[1].ref, "next track prepared");
  a.autoDJ.skip();
  for (let i = 0; i < 100 && a.autoDJ.getState().current !== rows[1].ref; i++) await sleep(50);
  assert(a.autoDJ.getState().current === rows[1].ref, "real crossfade advances to next track");
  assert(a.engine.getState().mixer.crossfader === 1, "crossfader finishes on incoming deck");
  a.bus.send("mixer.crossfader", 0.62, "midi");
  await sleep(150);
  assert(a.autoDJ.getState().status === "PAUSED" && a.engine.getState().mixer.crossfader === 0.62, "manual MIDI takeover is respected");
  assert(a.playlists.get(p.id)?.refs.join() === rows.map((r) => r.ref).join(), "runtime leaves playlist unchanged");
  const result = { mode: a.platform.kind, artworkDecoded: image.naturalWidth, playlistPersisted: true, transitionCompleted: true, manualOverride: true, state: a.autoDJ.getState().status };
  return result;
}
