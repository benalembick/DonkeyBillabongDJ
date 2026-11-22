/**
 * Library track preview in the headphones only. It feeds the headphone level stage of the 4-channel routing
 * (DDJ-SB phones on outputs 3/4) directly, so it never reaches the master output, the decks, the cue bus or
 * the master meter. Without 4-channel routing there is no headphone-only output, so preview is unavailable
 * rather than falling back to the speakers.
 */
import { Emitter } from "../core/events";
import type { TrackInfo } from "../core/engine/types";
import type { WebAudioEngine } from "./WebAudioEngine";

export interface HeadphonePreviewState {
  /** The ref being previewed (loading or playing), or null. */
  ref: string | null;
  status: "idle" | "loading" | "playing";
  /** A headphone-only output exists (4-channel routing active on a device that exposes it). */
  available: boolean;
}

const FADE_S = 0.02;

export class HeadphonePreview extends Emitter<{ change: HeadphonePreviewState }> {
  private st: HeadphonePreviewState;
  private source: AudioBufferSourceNode | null = null;
  private out: GainNode | null = null;
  /** Bumped on every start/stop so a slow decode can't start a preview that was already replaced. */
  private token = 0;

  constructor(private audio: WebAudioEngine, private readAudio: (ref: string) => Promise<ArrayBuffer>) {
    super();
    this.st = { ref: null, status: "idle", available: this.headphonesAvailable() };
    audio.on((e) => {
      // A rebuilt graph means a new AudioContext: our nodes are dead, and the routing may now be stereo.
      if (e.type === "rebuilt") this.stop();
      if ((e.type === "status" || e.type === "rebuilt") && this.headphonesAvailable() !== this.st.available) this.patch({ available: !this.st.available });
    });
  }

  get state(): HeadphonePreviewState {
    return this.st;
  }

  static unavailableReason = "Headphone preview needs a DJ controller sound card with 4 outputs (e.g. DDJ-SB): Settings → Audio → Routing → 4 channels";

  private headphonesAvailable(): boolean {
    return this.audio.getStatus().routing === "quad";
  }

  /**
   * Starts previewing `track` in the headphones; the same track again (or while it loads) stops it.
   * `offset` (s): start part-way in (AI Set Studio cue preview) — given, it always (re)starts there.
   */
  async toggle(track: TrackInfo, offset?: number): Promise<void> {
    if (this.st.ref === track.ref && offset === undefined) return this.stop();
    if (track.source !== "local") throw new Error("Only local files can be previewed in the headphones");
    if (!this.headphonesAvailable()) throw new Error(HeadphonePreview.unavailableReason);
    this.stop();
    const token = ++this.token;
    this.patch({ ref: track.ref, status: "loading" });
    try {
      const decoded = await this.audio.decode(await this.readAudio(track.ref));
      if (token !== this.token) return;
      const { context, input, headphones } = await this.audio.createMonitorOutput();
      if (token !== this.token || !headphones) {
        input.disconnect();
        if (token === this.token) throw new Error(HeadphonePreview.unavailableReason);
        return;
      }
      const source = context.createBufferSource();
      source.buffer = decoded.handle as AudioBuffer;
      const now = context.currentTime;
      input.gain.setValueAtTime(0, now);
      input.gain.linearRampToValueAtTime(1, now + FADE_S);
      source.connect(input);
      source.onended = () => { if (this.source === source) this.finish(); };
      const startAt = Math.max(0, Math.min(offset ?? 0, Math.max(0, (source.buffer?.duration ?? 0) - 0.05)));
      source.start(now, startAt);
      this.clock = { context, startedAt: now, offset: startAt };
      this.source = source;
      this.out = input;
      this.patch({ status: "playing" });
    } catch (err) {
      if (token === this.token) this.finish();
      throw err;
    }
  }

  /** Seconds into the previewed track right now (null when nothing is previewing). */
  position(): number | null {
    const c = this.clock;
    return c && this.source ? c.offset + Math.max(0, c.context.currentTime - c.startedAt) : null;
  }
  private clock: { context: BaseAudioContext; startedAt: number; offset: number } | null = null;

  stop(): void {
    this.token++;
    this.clock = null;
    const source = this.source, out = this.out;
    this.source = this.out = null;
    if (source && out) {
      try {
        const t = out.context.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(out.gain.value, t);
        out.gain.linearRampToValueAtTime(0, t + FADE_S);
        source.stop(t + FADE_S);
        source.onended = () => out.disconnect();
      } catch {
        /* context already closed */
      }
    }
    if (this.st.ref !== null) this.patch({ ref: null, status: "idle" });
  }

  private finish(): void {
    this.source = null;
    this.clock = null;
    this.out?.disconnect();
    this.out = null;
    this.patch({ ref: null, status: "idle" });
  }

  private patch(p: Partial<HeadphonePreviewState>): void {
    this.st = { ...this.st, ...p };
    this.emit("change", this.st);
  }
}
