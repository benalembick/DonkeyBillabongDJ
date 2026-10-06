import { Emitter } from "../core/events";
import type { CommandBus } from "../core/commands";
import type { DJEngine } from "../core/engine/DJEngine";
import type { AudioEngine } from "../core/engine/types";
import type { LibraryStore } from "../library/LibraryStore";
import { moveItem, type PlaylistStore } from "../library/PlaylistStore";
import type { AnalysisService } from "../analysis/AnalysisService";
import { compatibleKeys, DEFAULT_AUTO_DJ, planTransition, type AutoDJSettings, type TransitionPlan } from "./transition";

export interface AutoDJState {
  status: "OFF" | "ACTIVE" | "PAUSED" | "TRANSITIONING";
  playlistId: string | null;
  current: string | null;
  deck: number;
  upcoming: string[];
  played: string[];
  preparing: boolean;
  queueLocked: boolean;
  plan: TransitionPlan | null;
  nextSeconds: number | null;
  message: string;
  settings: AutoDJSettings;
}
interface Options { engine: DJEngine; bus: CommandBus; audio: AudioEngine; library: LibraryStore; playlists: PlaylistStore; analysis: Pick<AnalysisService, "get">; stemAvailable?: (ref: string) => boolean; settings?: Partial<AutoDJSettings>; saveSettings?: (s: AutoDJSettings) => void }

/** Only references and transient playback state; the library owns all track metadata. */
export class AutoDJ extends Emitter<{ change: AutoDJState }> {
  private state: AutoDJState;
  private generation = 0;
  private loadingDeck: number | null = null;
  private prepared: string | null = null;
  private fade: { from: number; elapsed: number; duration: number; incoming: string; lastPosition: number; mashup: boolean } | null = null;
  private unsub: (() => void)[];
  constructor(private o: Options) {
    super();
    this.state = { status: "OFF", playlistId: null, current: null, deck: 0, upcoming: [], played: [], preparing: false, queueLocked: false, plan: null, nextSeconds: null, message: "", settings: { ...DEFAULT_AUTO_DJ, ...o.settings } };
    // Manual deck/mixer actions intentionally leave automation active. Once
    // started, Auto DJ owns the transition schedule until STOP AUTO DJ is used.
    this.unsub = [o.audio.on((e) => { if (e.type === "error") this.pause(`Audio error: ${e.message}`); })];
  }
  getState(): AutoDJState { return this.state; }
  private set(patch: Partial<AutoDJState>) { this.state = { ...this.state, ...patch }; this.emit("change", this.state); }
  configure(patch: Partial<AutoDJSettings>) {
    const settings = { ...this.state.settings, ...patch };
    this.o.saveSettings?.(settings);
    this.set({ settings, plan: this.state.status === "TRANSITIONING" ? this.state.plan : null });
  }
  private send(action: string, value = 1) { this.o.bus.send(action, value, "system"); }
  private play(deck: number, playing: boolean) { if (this.o.engine.getState().decks[deck].playing !== playing) this.send(`deck${deck + 1}.play`); }
  private cancelLoad() {
    ++this.generation;
    if (this.loadingDeck !== null) this.o.engine.cancelPendingLoad(this.loadingDeck);
    this.loadingDeck = null;
  }
  pause(message = "Automatic transitions paused; decks remain under your control") {
    if (this.state.status === "OFF") return;
    this.cancelLoad();
    this.set({ status: "PAUSED", preparing: false, message });
  }
  stop() {
    this.cancelLoad(); this.fade = null; this.prepared = null;
    this.set({ status: "OFF", preparing: false, queueLocked: false, plan: null, nextSeconds: null, message: "Auto DJ stopped; decks remain under manual control" });
  }
  /** Restart the preserved session after STOP without rebuilding or losing queue edits. */
  async restart(): Promise<void> {
    if (this.state.status !== "OFF" || !this.state.current) return;
    const deck = this.state.deck, other = 1 - deck;
    this.fade = null; this.prepared = null;
    // STOP deliberately leaves audio alone. Restart establishes one clear
    // outgoing deck even if STOP was pressed halfway through a transition.
    this.play(other, false);
    let current = this.o.engine.getState().decks[deck];
    if (current.status !== "ready" || current.track?.ref !== this.state.current) {
      if (!await this.load(deck, this.state.current)) return;
      current = this.o.engine.getState().decks[deck];
    }
    this.send("mixer.crossfader", deck);
    this.play(deck, true);
    this.set({ status: "ACTIVE", queueLocked: false, plan: null, nextSeconds: null, message: "Auto DJ restarted — preparing next track" });
    await this.prepare();
  }
  dispose() { this.stop(); this.unsub.forEach((f) => f()); }
  private arrange(refs: string[], first?: string): string[] {
    // Only the starting entry is pinned; intentional repeats of that track stay in the list.
    const at = first === undefined ? -1 : refs.indexOf(first);
    let rest = at < 0 ? refs.slice() : [...refs.slice(0, at), ...refs.slice(at + 1)];
    if (this.state.settings.shuffle) for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    if (this.state.settings.keyAware) {
      const ordered: string[] = first ? [first] : rest.splice(0, 1);
      while (rest.length) {
        const key = this.o.library.getByRef(ordered[ordered.length - 1])?.key;
        const at = rest.findIndex((r) => compatibleKeys(key, this.o.library.getByRef(r)?.key) === true);
        ordered.push(...rest.splice(Math.max(0, at), 1));
      }
      return ordered;
    }
    return first ? [first, ...rest] : rest;
  }
  async start(playlistId: string, selectedRef?: string) {
    if (this.o.engine.getState().decks.some((d) => d.playing)) {
      this.set({ message: "Pause the decks before starting a new Auto DJ set." }); return;
    }
    const p = this.o.playlists.get(playlistId);
    if (!p?.refs.length) return;
    this.stop();
    const index = selectedRef ? p.refs.indexOf(selectedRef) : 0;
    const refs = this.arrange(this.state.settings.shuffle || this.state.settings.keyAware ? p.refs : p.refs.slice(Math.max(0, index)), index >= 0 ? selectedRef : undefined);
    const [current, ...upcoming] = refs;
    this.set({ status: "ACTIVE", playlistId, current, deck: 0, upcoming, played: [], message: "Loading first track…" });
    if (!await this.load(0, current)) return;
    this.resetDeck(0);
    this.send("mixer.crossfader", 0);
    this.play(0, true);
    this.set({ message: "Preparing next track" });
    await this.prepare();
  }
  private resetDeck(deck: number) {
    if (this.o.engine.getState().decks[deck].sync) this.send(`deck${deck + 1}.sync`);
    this.send(`deck${deck + 1}.tempo.reset`);
    this.send(`mixer.channel${deck + 1}.volume`, 1);
    if (this.o.engine.getState().mixer.channels[deck].mute) this.send(`mixer.channel${deck + 1}.mute`);
  }
  private async load(deck: number, ref: string): Promise<boolean> {
    const t = this.o.library.getByRef(ref);
    if (!t || t.unavailableReason) { this.pause(t?.unavailableReason ?? "Track missing from library. Reconnect its original file to continue."); return false; }
    const token = ++this.generation;
    this.loadingDeck = deck;
    this.set({ preparing: true });
    await this.o.engine.loadTrack(deck, t, "auto-dj");
    if (token !== this.generation) return false;
    this.loadingDeck = null;
    this.set({ preparing: false });
    const d = this.o.engine.getState().decks[deck];
    if (d.status !== "ready" || d.track?.ref !== ref) { this.pause(d.error ?? "Could not load track. Reconnect the file and resume."); return false; }
    return true;
  }
  private async prepare() {
    if (this.state.status !== "ACTIVE" || this.state.preparing) return;
    if (!this.state.upcoming.length && this.state.settings.repeat && this.state.playlistId) {
      const p = this.o.playlists.get(this.state.playlistId);
      if (p?.refs.length) this.set({ upcoming: this.arrange(p.refs) });
    }
    const next = this.state.upcoming[0];
    if (!next || this.prepared === next) return;
    const deck = 1 - this.state.deck;
    if (this.o.engine.getState().decks[deck].playing) { this.pause("Pause the other deck before resuming Auto DJ."); return; }
    if (!await this.load(deck, next)) return;
    this.resetDeck(deck);
    this.prepared = next;
    this.set({ plan: null, message: "Next track ready — analysing transition" });
  }
  resume() {
    if (this.state.status !== "PAUSED" || !this.state.current) return;
    const e = this.o.engine.getState();
    const active = e.decks.map((d, i) => ({ d, i })).filter(({ d }) => d.playing && d.status === "ready");
    if (!active.length && !this.state.played.length && ["empty", "error"].includes(e.decks[this.state.deck].status)) {
      this.set({ status: "ACTIVE", message: "Retrying first track…" });
      void this.retryFirst(); return;
    }
    if (active.length === 2 && this.fade && e.decks[this.state.deck].track?.ref === this.state.current && e.decks[1 - this.state.deck].track?.ref === this.fade.incoming) {
      this.fade.from = e.mixer.crossfader; this.fade.duration = Math.max(1, this.fade.duration - this.fade.elapsed); this.fade.elapsed = 0;
      this.fade.lastPosition = this.o.audio.getPosition(1 - this.state.deck);
      this.set({ status: "TRANSITIONING", message: "Resuming from the current crossfader position" }); return;
    }
    if (active.length !== 1) { this.set({ message: "Leave one deck playing, then resume Auto DJ." }); return; }
    const { d, i } = active[0];
    this.fade = null; this.prepared = null;
    const at = this.state.upcoming.indexOf(d.track!.ref);
    this.set({ status: "ACTIVE", queueLocked: false, deck: i, current: d.track!.ref, upcoming: at >= 0 ? this.state.upcoming.slice(at + 1) : this.state.upcoming, plan: null, message: "Continuing from the playing deck" });
    void this.prepare();
  }
  private async retryFirst() {
    const deck = this.state.deck;
    if (!this.state.current || !await this.load(deck, this.state.current)) return;
    this.resetDeck(deck); this.send("mixer.crossfader", deck); this.play(deck, true);
    await this.prepare();
  }
  add(refs: string[]) { this.set({ upcoming: [...this.state.upcoming, ...refs.filter((r) => !!this.o.library.getByRef(r))] }); if (this.state.status === "ACTIVE") void this.prepare(); }
  /** Add tracks to the front of the editable queue, preserving their selected order. */
  playNextRefs(refs: string[]) {
    const playable = refs.filter((r) => !!this.o.library.getByRef(r));
    if (!playable.length || this.state.status === "TRANSITIONING" || this.fade) return;
    this.editUpcoming([...playable, ...this.state.upcoming]);
  }
  private editUpcoming(refs: string[]) {
    if (this.state.status === "TRANSITIONING" || this.fade) return;
    if (refs[0] !== this.state.upcoming[0]) { this.cancelLoad(); this.prepared = null; }
    this.set({ upcoming: refs, preparing: this.loadingDeck !== null, plan: null });
    void this.prepare();
  }
  remove(index: number) { this.editUpcoming(this.state.upcoming.filter((_, i) => i !== index)); }
  move(from: number, to: number) { this.editUpcoming(moveItem(this.state.upcoming, from, to)); }
  playNext(index: number) { this.move(index, 0); }
  saveToPlaylist() {
    if (this.state.playlistId) this.o.playlists.replaceTracks(this.state.playlistId, [...this.state.played, ...(this.state.current ? [this.state.current] : []), ...this.state.upcoming]);
    this.set({ message: "Queue saved back to playlist" });
  }
  skip() {
    if (this.state.status !== "ACTIVE" || this.state.preparing || !this.prepared) return;
    this.begin(true);
  }
  private begin(quick = false) {
    const { engine } = this.o;
    const out = this.state.deck, incoming = 1 - out;
    const decks = engine.getState().decks;
    if (!this.prepared || decks[incoming].track?.ref !== this.prepared || decks[incoming].status !== "ready") return;
    let plan = planTransition(decks[out], decks[incoming], this.state.settings, this.o.analysis.get(out), this.o.analysis.get(incoming));
    const lateness = Math.max(0, (this.o.audio.getPosition(out) - plan.mixOut) / decks[out].rate);
    // A delayed preload or a stalled renderer may miss the chosen phrase. Never force a late beat mix.
    if (plan.sync && lateness > 0.25) plan = planTransition(decks[out], decks[incoming], { ...this.state.settings, style: "crossfade" }, this.o.analysis.get(out), this.o.analysis.get(incoming));
    if (quick) { plan.seconds = Math.min(2, plan.seconds); plan.sync = false; plan.kind = "quick-fade"; }
    if (plan.sync) {
      engine.setMaster(out);
    }
    const outBpm = engine.baseBpm(out), inBpm = engine.baseBpm(incoming);
    const matchedIncomingRate = plan.sync && outBpm && inBpm ? outBpm * engine.getState().decks[out].rate / inBpm : engine.getState().decks[incoming].rate;
    const phaseOffset = plan.sync ? lateness * matchedIncomingRate : 0;
    engine.seekTo(incoming, plan.mixIn + phaseOffset);
    this.play(incoming, true);
    // Engage Sync only after both decks are running. toggleSync then performs its
    // immediate phase snap, removing decoder/command scheduling latency before
    // the crossfade becomes audible; tick() keeps the phases locked afterwards.
    if (plan.sync && !engine.getState().decks[incoming].sync) this.send(`deck${incoming + 1}.sync`);
    const currentRef = decks[out].track?.ref;
    const mashup = !!(plan.sync && this.state.settings.intelligentMashups && currentRef && this.o.stemAvailable?.(currentRef) && this.o.stemAvailable?.(this.prepared));
    if (mashup) {
      engine.setStemMix(out, [true, true, true, true], [.72, .82, .82, .72]);
      engine.setStemMix(incoming, [true, false, false, false], [.78, 0, 0, 0]);
      this.send("mixer.crossfader", .5);
    }
    this.fade = { from: engine.getState().mixer.crossfader, elapsed: 0, duration: plan.seconds, incoming: this.prepared, lastPosition: this.o.audio.getPosition(incoming), mashup };
    this.set({ status: "TRANSITIONING", queueLocked: true, plan, nextSeconds: 0, message: mashup ? "Intelligent Mashup: vocal overlay, then instrumental handover" : plan.reason });
  }
  tick() {
    if (this.state.status === "OFF" || this.state.status === "PAUSED" || this.o.audio.getStatus().state !== "running") return;
    const deck = this.state.deck, incoming = 1 - deck;
    const decks = this.o.engine.getState().decks;
    if (this.fade && this.state.status === "TRANSITIONING") {
      if (!decks[incoming].playing || decks[incoming].track?.ref !== this.fade.incoming) { this.pause("Incoming deck changed; check playback before resuming."); return; }
      const position = this.o.audio.getPosition(incoming);
      this.fade.elapsed += Math.max(0, position - this.fade.lastPosition) / decks[incoming].rate;
      this.fade.lastPosition = position;
      const progress = Math.min(1, this.fade.elapsed / this.fade.duration);
      if (this.fade.mashup) {
        this.o.engine.setStemMix(deck, [true, true, true, true], [.72 * (1 - progress), .82 * (1 - progress), .82 * (1 - progress), .72 * (1 - progress)]);
        this.o.engine.setStemMix(incoming, [true, true, true, true], [.78, .82 * progress, .82 * progress, .72 * progress]);
      } else this.send("mixer.crossfader", this.fade.from + (incoming - this.fade.from) * progress);
      if (progress >= 1) {
        if (this.fade.mashup) { this.o.engine.setStemMix(incoming, [true, true, true, true], [1, 1, 1, 1]); this.send("mixer.crossfader", incoming); }
        this.play(deck, false);
        if (decks[deck].sync) this.send(`deck${deck + 1}.sync`);
        this.o.engine.setMaster(incoming);
        this.fade = null; this.prepared = null;
        this.set({ status: "ACTIVE", queueLocked: false, deck: incoming, played: [...this.state.played, this.state.current!], current: this.state.upcoming[0], upcoming: this.state.upcoming.slice(1), plan: null, message: "Transition complete" });
        void this.prepare();
      }
      return;
    }
    if (this.state.preparing) return;
    if (!this.state.upcoming.length) {
      if (this.state.settings.repeat) { void this.prepare(); return; }
      if (!decks[deck].playing) { this.stop(); this.set({ message: "Playlist complete" }); }
      return;
    }
    if (!this.prepared) { void this.prepare(); return; }
    const plan = planTransition(decks[deck], decks[incoming], this.state.settings, this.o.analysis.get(deck), this.o.analysis.get(incoming));
    const position = this.o.audio.getPosition(deck);
    if (!decks[deck].playing) {
      if (this.state.nextSeconds !== null || this.state.message !== "Deck paused; Auto DJ remains armed") this.set({ nextSeconds: null, message: "Deck paused; Auto DJ remains armed" });
      return;
    }
    const nextSeconds = Math.max(0, (plan.mixOut - position) / decks[deck].rate);
    this.set({ plan, nextSeconds });
    if (position >= plan.mixOut) this.begin();
  }
}
