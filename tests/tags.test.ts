import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTags } from "../electron/library/tags";
import { trackInfoFromFileName } from "../src/library/LibraryStore";
import { applyTags } from "../src/library/tags";
import { SmartTrackResolver } from "../src/matching/SmartTrackResolver";
import { buildIdentity } from "../src/matching/identity";
import { LocalLibrarySource } from "../src/matching/sources";
import { taggedWav } from "./fixtures/taggedWav";

describe("local tag reading → ISRC matching", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dbdj-tags-"));
  const file = path.join(dir, "track01.wav"); // filename deliberately says nothing useful
  writeFileSync(file, taggedWav({ title: "Get Lucky", artist: "Daft Punk", isrc: "USQX91300809", seconds: 2 }));

  it("reads title, artist, ISRC and duration from embedded tags (file untouched)", async () => {
    const [t] = await readTags([file]);
    expect(t).toMatchObject({ ok: true, title: "Get Lucky", artist: "Daft Punk", isrc: "USQX91300809" });
    expect(t.durationMs).toBeGreaterThan(1900);
    expect(t.durationMs).toBeLessThan(2100);
  });

  it("an ISRC read from tags resolves a Spotify track exactly", async () => {
    const [tags] = await readTags([file]);
    const local = applyTags(trackInfoFromFileName(file, "track01.wav"), tags);
    expect(local.isrc).toBe("USQX91300809");
    const resolver = new SmartTrackResolver({ sources: [new LocalLibrarySource([local])] });
    const res = await resolver.resolve(
      buildIdentity({ source: "spotify", sourceTrackId: "abc", title: "Get Lucky (feat. Pharrell Williams)", artists: ["Daft Punk"], durationMs: 2000, isrc: "USQX91300809" }),
    );
    expect(res.status).toBe("resolved");
    expect(res.best?.method).toBe("isrc");
    expect(res.confidence).toBeGreaterThanOrEqual(95);
  });

  it("unreadable files are reported, not thrown", async () => {
    const bad = path.join(dir, "bad.mp3");
    writeFileSync(bad, "not audio");
    const [t] = await readTags([bad]);
    expect(t.ok === false || t.title === undefined).toBe(true);
  });
});
