import { describe, expect, it } from "vitest";
import { HeadphonePreview } from "../src/audio/HeadphonePreview";
import type { AudioEngineEvent, TrackInfo } from "../src/core/engine/types";
import type { WebAudioEngine } from "../src/audio/WebAudioEngine";

const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });

function fakeAudio(opts: { quad?: boolean; monitorHeadphones?: boolean } = {}) {
  let quad = opts.quad ?? true;
  const listeners = new Set<(e: AudioEngineEvent) => void>();
  const started: string[] = [], stopped: string[] = [], disconnected: string[] = [];
  let n = 0;
  const context = {
    currentTime: 0,
    createBufferSource() {
      const id = `src${++n}`;
      return { buffer: null as unknown, onended: null as null | (() => void), connect() {}, start() { started.push(id); }, stop() { stopped.push(id); } };
    },
  };
  const audio = {
    getStatus: () => ({ routing: quad ? "quad" : "stereo" }),
    on(l: (e: AudioEngineEvent) => void) { listeners.add(l); return () => listeners.delete(l); },
    decode: async () => ({ handle: { duration: 200 } }),
    createMonitorOutput: async () => ({ context, input: { gain: param(), context, connect() {}, disconnect() { disconnected.push("input"); } }, headphones: opts.monitorHeadphones ?? true }),
  };
  return {
    audio: audio as unknown as WebAudioEngine,
    started, stopped, disconnected,
    setQuad(q: boolean) { quad = q; },
    fire(e: AudioEngineEvent) { for (const l of listeners) l(e); },
  };
}

const track = (ref: string, source: TrackInfo["source"] = "local"): TrackInfo => ({ ref, title: ref, artist: "", album: "", source, bpm: null, key: null });
const read = async () => new ArrayBuffer(8);

describe("headphone preview", () => {
  it("plays a local track into the headphone output and toggles it off", async () => {
    const f = fakeAudio(); const p = new HeadphonePreview(f.audio, read);
    await p.toggle(track("a"));
    expect(p.state).toMatchObject({ ref: "a", status: "playing", available: true });
    expect(f.started).toHaveLength(1);
    await p.toggle(track("a"));
    expect(p.state).toMatchObject({ ref: null, status: "idle" });
    expect(f.stopped).toHaveLength(1);
  });

  it("refuses without a headphone-only output instead of playing through the speakers", async () => {
    const f = fakeAudio({ quad: false }); const p = new HeadphonePreview(f.audio, read);
    expect(p.state.available).toBe(false);
    await expect(p.toggle(track("a"))).rejects.toThrow(/4 outputs/);
    expect(f.started).toHaveLength(0);
  });

  it("never starts if the monitor output turns out not to be the headphones", async () => {
    const f = fakeAudio({ monitorHeadphones: false }); const p = new HeadphonePreview(f.audio, read);
    await expect(p.toggle(track("a"))).rejects.toThrow(/4 outputs/);
    expect(f.started).toHaveLength(0);
    expect(f.disconnected).toContain("input");
    expect(p.state.status).toBe("idle");
  });

  it("only previews local files", async () => {
    const p = new HeadphonePreview(fakeAudio().audio, read);
    await expect(p.toggle(track("x", "audius"))).rejects.toThrow(/local/);
  });

  it("plays one track at a time", async () => {
    const f = fakeAudio(); const p = new HeadphonePreview(f.audio, read);
    await p.toggle(track("a"));
    await p.toggle(track("b"));
    expect(p.state.ref).toBe("b");
    expect(f.started).toEqual(["src1", "src2"]);
    expect(f.stopped).toEqual(["src1"]);
  });

  it("stops when the audio graph is rebuilt and tracks whether headphones are available", async () => {
    const f = fakeAudio(); const p = new HeadphonePreview(f.audio, read);
    await p.toggle(track("a"));
    f.setQuad(false);
    f.fire({ type: "rebuilt" });
    expect(p.state).toMatchObject({ ref: null, status: "idle", available: false });
    expect(f.stopped).toHaveLength(1);
  });
});
