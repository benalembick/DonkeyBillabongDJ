import { describe, expect, it } from "vitest";
import { RecordingSourceAdapter, SpotifyPlaybackAdapter, SpotifySessionCoordinator, type SpotifySession, type SpotifySessionStore } from "../src/acquire/SpotifySessionCoordinator";
import type { StreamingTrack } from "../src/providers/streamingTypes";

const track = (id: string, title = id): StreamingTrack => ({ provider: "spotify", id, title, artist: "Artist", album: "Album", durationMs: 180_000, externalUrl: `https://open.spotify.com/track/${id}` });
const memoryStore = (): SpotifySessionStore & { value: SpotifySession[] } => ({ value: [], load() { return this.value; }, save(value) { this.value = structuredClone(value); } });

describe("Spotify session coordinator", () => {
  it("uses official external playback without exposing an audio buffer", async () => {
    const opened: string[] = [], playback = new SpotifyPlaybackAdapter(async (url) => { opened.push(url); });
    await playback.openTrack(track("1234567890123456789012"));
    expect(opened).toEqual(["https://open.spotify.com/track/1234567890123456789012"]);
    expect(playback.getState().mode).toBe("external");
  });
  it("refuses recording without a provider agreement even when playback is connected", () => {
    const recording = new RecordingSourceAdapter({ providerAuthorized: false, processCaptureAvailable: true, silentRouting: false });
    expect(() => recording.assertReady({ id: "local", name: "This computer", local: true, active: true })).toThrow(/provider agreement/i);
  });
  it("refuses a remote playback device", () => {
    const recording = new RecordingSourceAdapter({ providerAuthorized: true, processCaptureAvailable: true, silentRouting: false });
    expect(() => recording.assertReady({ id: "remote", name: "Living room", local: false, active: true })).toThrow(/remote Spotify device/i);
  });
  it("persists source order and never replaces an already completed asset on retry", () => {
    const store = memoryStore(), playback = new SpotifyPlaybackAdapter(async () => undefined);
    const recording = new RecordingSourceAdapter({ providerAuthorized: true, processCaptureAvailable: true, silentRouting: true });
    const coordinator = new SpotifySessionCoordinator(playback, recording, store);
    playback.selectDevice({ id: "local", name: "This computer", local: true, active: true });
    const ids = ["1234567890123456789012", "abcdefghijklmnopqrstuv"];
    const session = coordinator.create("Set", "playlist-1", ids.map((id) => track(id)), (_t) => "authorized-recording");
    expect(session.entries.map((e) => e.position)).toEqual([0, 1]);
    coordinator.prepareRecording(session.id, session.entries[0].id);
    coordinator.complete(session.id, session.entries[0].id, "C:\\Music\\one.flac");
    expect(coordinator.retry(session.id, session.entries[0].id).resultRef).toBe("C:\\Music\\one.flac");
    expect(store.value[0].entries.map((e) => e.spotifyTrackId)).toEqual(ids);
  });
});
