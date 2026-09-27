import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signDeveloperToken } from "../src/providers/apple/AppleMusicClient";
import { CommandBus } from "../src/core/commands";
import { DJEngine } from "../src/core/engine/DJEngine";
import type { TrackInfo } from "../src/core/engine/types";
import { EventLog } from "../src/core/log";
import { buildLocalIndex, normalizeTitle } from "../src/library/matching";
import { trackInfoFromFileName } from "../src/library/LibraryStore";
import { PROVIDER_CAPABILITIES } from "../src/providers/MusicProvider";
import { toTrackInfo } from "../src/providers/StreamingStore";
import { FakeAudioEngine } from "./fakes";

describe("local matching", () => {
  const lib = [
    trackInfoFromFileName("/m/1.mp3", "Daft Punk - One More Time.mp3"),
    trackInfoFromFileName("/m/2.mp3", "Fred again.. - Delilah (pull me out of this).mp3"),
    trackInfoFromFileName("/m/3.mp3", "Other Artist - One More Time.mp3"),
    trackInfoFromFileName("/m/4.flac", "Strings of Life.flac"),
  ];
  const idx = buildLocalIndex(lib);

  it("normalises remaster/feat/punctuation noise", () => {
    expect(normalizeTitle("One More Time - Remastered 2021")).toBe("one more time");
    expect(normalizeTitle("Song (feat. Someone)")).toBe("song");
    expect(normalizeTitle("Beyoncé & Co")).toBe("beyonce and co");
  });

  it("matches title + artist and prefers the right artist", () => {
    expect(idx.find("One More Time", "Daft Punk")?.ref).toBe("/m/1.mp3");
    expect(idx.find("One More Time - Radio Edit", "Daft Punk")).toBeNull(); // different title text stays unmatched
    expect(idx.find("One More Time", "Nobody")).toBeNull();
  });

  it("matches files without an artist by title", () => {
    expect(idx.find("Strings Of Life", "Derrick May")?.ref).toBe("/m/4.flac");
  });
});

describe("source policy", () => {
  it("engine refuses streaming tracks with the provider's reason", async () => {
    const log = new EventLog();
    const audio = new FakeAudioEngine();
    const engine = new DJEngine({
      bus: new CommandBus(),
      audio,
      log,
      browser: { moveSelection: () => {}, getSelected: () => null },
      loadBytes: async () => new ArrayBuffer(10),
      canLoad: (t) => (PROVIDER_CAPABILITIES[t.source].canLoadIntoDeck ? { ok: true } : { ok: false, reason: "nope" }),
    });
    const spotify: TrackInfo = toTrackInfo({ provider: "spotify", id: "abc", title: "X", artist: "Y", album: "", durationMs: 1000 });
    await engine.loadTrack(0, spotify);
    expect(engine.getState().decks[0].status).toBe("empty");
    expect(audio.calls.some((c) => c.fn === "loadDeck")).toBe(false);
    expect(log.all().at(-1)?.message).toMatch(/Can't load "X".*nope/);
  });

  it("only local sources are loadable or recordable", () => {
    expect(PROVIDER_CAPABILITIES.local.canLoadIntoDeck).toBe(true);
    for (const id of ["spotify", "apple-music"] as const) {
      expect(PROVIDER_CAPABILITIES[id].canLoadIntoDeck).toBe(false);
      expect(PROVIDER_CAPABILITIES[id].canRecord).toBe(false);
    }
  });
});

describe("Apple Music developer token", () => {
  it("is a valid ES256 JWT with the MusicKit claims", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = await signDeveloperToken("TEAM123456", "KEY1234567", pem, 1_700_000_000);
    const [h, p, s] = jwt.split(".");
    const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
    expect(dec(h)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(dec(p).iss).toBe("TEAM123456");
    expect(dec(p).exp - dec(p).iat).toBeLessThanOrEqual(15_777_000);
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
});
