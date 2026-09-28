import { Emitter } from "../core/events";
import type { CommandBus } from "../core/commands";
import type { DJEngine } from "../core/engine/DJEngine";
import type { TrackInfo } from "../core/engine/types";
import type { PreparationStore } from "../preparation/PreparationStore";
import { camelotKey, compatibility } from "../analysis/discovery";
import type { MashupPersistence, MashupRecipe, MashupBlock } from "./types";
import type { StemEnvelopes } from "../stems/StemService";

export const MASHUP_STEMS = ["Vocals", "Drums", "Bass", "Melody"] as const;
export interface MashupSource { track: TrackInfo; deck: number; selected: boolean[]; levels: number[]; entry: number }
export interface LiveMashupState {
  status: "idle" | "preparing" | "ready" | "playing" | "paused" | "error";
  a: MashupSource | null; b: MashupSource | null;
  targetBpm: number | null; targetKey: string | null; score: number; phraseBars: 8 | 16 | 32;
  warning: string | null; message: string;
  recipeId: string | null; recipes: MashupRecipe[]; blocks: MashupBlock[];
  vocalRegions: { a: [number, number][]; b: [number, number][] }; vocalSemitones: number;
  renderProgress: number | null;
}
interface Options { engine: DJEngine; bus: CommandBus; preparation: PreparationStore; persistence: MashupPersistence; lookup: (ref: string) => TrackInfo | undefined; envelopes: (deck: number) => StemEnvelopes | null; renderData: (ref: string) => Promise<{rate:number;total:number;pcm:ArrayBuffer}>; sourcePcm: (deck:number)=>{sampleRate:number;channels:Float32Array[]}|null; saveFile:(name:string,data:ArrayBuffer)=>Promise<{ref:string;name:string}|null>; importRendered:(file:{ref:string;name:string},track:TrackInfo)=>Promise<void> }

/** State model and controller for a two-deck, STEM-routed live arrangement. */
export class LiveMashupService extends Emitter<{ change: LiveMashupState }> {
  private state: LiveMashupState = { status: "idle", a: null, b: null, targetBpm: null, targetKey: null, score: 0, phraseBars: 16, warning: null, message: "Select a recommendation", recipeId: null, recipes: [], blocks: [], vocalRegions: { a: [], b: [] }, vocalSemitones: 0, renderProgress: null };
  private activeBlock = "";
  readonly ready: Promise<void>;
  constructor(private o: Options) { super(); this.ready = this.loadRecipes(); }
  getState() { return this.state; }
  private set(p: Partial<LiveMashupState>) { this.state = { ...this.state, ...p }; this.emit("change", this.state); }
  private prep(t: TrackInfo) { return this.o.preparation.forRef(t.ref); }
  private entry(t: TrackInfo, bars: number): number {
    const p = this.prep(t), grid = p?.beatGrid;
    const suggested = p?.recommendedCues.find((c) => c.kind === "mix-in")?.timestamp ?? grid?.firstBeat ?? 0;
    if (!grid) return suggested;
    const phrase = bars * 4 * 60 / grid.bpm;
    return grid.firstBeat + Math.ceil(Math.max(0, suggested - grid.firstBeat) / phrase) * phrase;
  }
  private async loadRecipes() {
    const recipes = (await this.o.persistence.list()).filter((r) => r.version === 2);
    // One-time migration from the Phase 1 local recipe list.
    try {
      const old = JSON.parse(localStorage.getItem("dbdj.mashup.recipes.v1") || "[]") as any[];
      for (const row of old) if (row.a?.track?.ref && row.b?.track?.ref) {
        const recipe = this.recipeFrom(row.a, row.b, row.targetBpm ?? null, row.targetKey ?? null, row.phraseBars ?? 16, row.blocks ?? []);
        await this.o.persistence.save(recipe); recipes.push(recipe);
      }
      if (old.length) localStorage.removeItem("dbdj.mashup.recipes.v1");
    } catch { /* malformed legacy recipes stay untouched */ }
    this.set({ recipes });
  }
  async create(a: TrackInfo, b: TrackInfo): Promise<void> {
    const support = this.o.engine.getStemsSupport();
    if (!support.ok) { this.set({ status: "error", a: null, b: null, warning: support.reason ?? "STEMS unavailable", message: "Live Mashup requires the local STEM separation engine." }); return; }
    const ba = this.prep(a)?.bpm ?? a.bpm, bb = this.prep(b)?.bpm ?? b.bpm;
    const target = ba && bb ? Math.round((ba + bb) * 50) / 100 : ba ?? bb ?? null;
    const gap = ba && bb ? Math.abs(ba - bb) / Math.max(ba, bb) : 1;
    const m = compatibility(a, b, this.prep(a), this.prep(b));
    const ka = camelotKey(this.prep(a)?.key ?? a.key), kb = camelotKey(this.prep(b)?.key ?? b.key);
    const warning = gap > .1 ? "BPM difference exceeds 10%; choose a closer match to avoid extreme stretching." : m.score < 45 ? "Low musical compatibility; review the result before saving." : !ka || !kb ? "Key is unknown for one or both tracks; no pitch correction will be applied." : null;
    this.set({ status: "preparing", targetBpm: target, targetKey: kb ?? ka, score: m.score, warning, message: "Loading tracks and preparing STEMS…" });
    try {
      for (let d = 0; d < 2; d++) if (this.o.engine.getState().decks[d].playing) this.o.bus.send(`deck${d + 1}.play`, 1, "system");
      await this.o.engine.loadTrack(0, a, "manual"); await this.o.engine.loadTrack(1, b, "manual");
      const phraseBars = this.state.phraseBars;
      const sa: MashupSource = { track: a, deck: 0, selected: [true, false, false, false], levels: [.8, .8, .8, .8], entry: this.entry(a, phraseBars) };
      const sb: MashupSource = { track: b, deck: 1, selected: [false, true, true, true], levels: [.75, .85, .85, .72], entry: this.entry(b, phraseBars) };
      if (target && ba) this.o.engine.setRateDirect(0, target / ba);
      if (target && bb) this.o.engine.setRateDirect(1, target / bb);
      this.o.engine.seekTo(0, sa.entry); this.o.engine.seekTo(1, sb.entry);
      this.o.engine.setStemMix(0, sa.selected, sa.levels); this.o.engine.setStemMix(1, sb.selected, sb.levels);
      // Vocal low-cut approximation plus conservative channel headroom.
      this.o.bus.send("mixer.channel1.eq.low", .22, "system"); this.o.bus.send("mixer.channel1.volume", .78, "system"); this.o.bus.send("mixer.channel2.volume", .78, "system"); this.o.bus.send("mixer.crossfader", .5, "system");
      const blocks: MashupBlock[] = [{ id: crypto.randomUUID(), startBar: 0, bars: phraseBars, aSelected: sa.selected.slice(), bSelected: sb.selected.slice(), aLevels: sa.levels.slice(), bLevels: sb.levels.slice() }];
      this.set({ status: "ready", a: sa, b: sb, blocks, recipeId: null, vocalSemitones: 0, message: "Ready. STEMS continue preparing in the background if they were not cached." });
    } catch (e) { this.set({ status: "error", message: String(e) }); }
  }
  playPause(): void {
    if (!this.state.a || !this.state.b || !["ready", "playing", "paused"].includes(this.state.status)) return;
    const playing = this.state.status === "playing";
    if (!playing && this.o.engine.getState().decks.some((d) => d.stems.status !== "ready")) {
      this.set({ message: "Waiting for both STEM separations to finish before playback" }); return;
    }
    for (let d = 0; d < 2; d++) if (this.o.engine.getState().decks[d].playing === playing) this.o.bus.send(`deck${d + 1}.play`, 1, "system");
    if (!playing) {
      this.o.engine.setMaster(0);
      if (!this.o.engine.getState().decks[1].sync) this.o.bus.send("deck2.sync", 1, "system");
    }
    this.set({ status: playing ? "paused" : "playing", message: playing ? "Live mashup paused" : "Live mashup playing — decks are phase locked" });
  }
  setStem(source: "a" | "b", stem: number, selected: boolean, level?: number): void {
    const s = this.state[source]; if (!s) return;
    const next = { ...s, selected: s.selected.slice(), levels: s.levels.slice() };
    next.selected[stem] = selected; if (level !== undefined) next.levels[stem] = level;
    const blocks = this.state.blocks.map((block) => {
      const selection = (source === "a" ? block.aSelected : block.bSelected).slice();
      const levels = (source === "a" ? block.aLevels : block.bLevels).slice();
      selection[stem] = selected; if (level !== undefined) levels[stem] = level;
      return source === "a" ? { ...block, aSelected: selection, aLevels: levels } : { ...block, bSelected: selection, bLevels: levels };
    });
    this.o.engine.setStemMix(next.deck, next.selected, next.levels); this.set({ [source]: next, blocks });
  }
  setLevel(source: "a" | "b", stem: number, level: number): void { const s = this.state[source]; if (s) this.setStem(source, stem, s.selected[stem], level); }
  swap(): void {
    const a = this.state.a, b = this.state.b; if (!a || !b) return;
    const av = [false, true, true, true], bv = [true, false, false, false];
    const na = { ...a, selected: av }, nb = { ...b, selected: bv };
    const blocks = this.state.blocks.map((block) => ({ ...block, aSelected: av.slice(), bSelected: bv.slice() }));
    this.o.engine.setStemMix(0, av, na.levels); this.o.engine.setStemMix(1, bv, nb.levels); this.set({ a: na, b: nb, blocks, message: "Vocal and instrumental sources swapped" });
  }
  setPhraseBars(bars: 8 | 16 | 32): void {
    const a = this.state.a, b = this.state.b; this.set({ phraseBars: bars });
    if (!a || !b) return;
    const na = { ...a, entry: this.entry(a.track, bars) }, nb = { ...b, entry: this.entry(b.track, bars) };
    this.o.engine.seekTo(na.deck, na.entry); this.o.engine.seekTo(nb.deck, nb.entry); this.set({ a: na, b: nb, message: `Aligned to ${bars}-bar phrase boundaries` });
  }
  resync(): void {
    if (!this.state.a || !this.state.b) return;
    this.o.engine.setMaster(0);
    if (this.o.engine.getState().decks[1].sync) this.o.bus.send("deck2.sync", 1, "system");
    this.o.bus.send("deck2.sync", 1, "system");
    this.set({ message: "Beat and phase Sync reapplied" });
  }
  private recipeFrom(a: MashupSource, b: MashupSource, targetBpm = this.state.targetBpm, targetKey = this.state.targetKey, phraseBars = this.state.phraseBars, blocks = this.state.blocks): MashupRecipe {
    const now = Date.now(), old = this.state.recipes.find((r) => r.id === this.state.recipeId);
    return { version: 2, id: old?.id ?? crypto.randomUUID(), name: `${a.track.title} × ${b.track.title}`, createdAt: old?.createdAt ?? now, updatedAt: now,
      aRef: a.track.ref, bRef: b.track.ref, aEntry: a.entry, bEntry: b.entry, aSelected: a.selected, bSelected: b.selected, aLevels: a.levels, bLevels: b.levels,
      targetBpm, targetKey, phraseBars, vocalSemitones: this.state.vocalSemitones, blocks };
  }
  async saveRecipe(): Promise<void> {
    if (!this.state.a || !this.state.b) return;
    try { const recipe = this.recipeFrom(this.state.a, this.state.b); await this.o.persistence.save(recipe); const recipes = [...this.state.recipes.filter((r) => r.id !== recipe.id), recipe]; this.set({ recipeId: recipe.id, recipes, message: "Editable mashup project saved" }); }
    catch (e) { this.set({ message: `Could not save recipe: ${String(e)}` }); }
  }
  async openRecipe(id: string): Promise<void> {
    const r = this.state.recipes.find((x) => x.id === id); if (!r) return;
    const a = this.o.lookup(r.aRef), b = this.o.lookup(r.bRef); if (!a || !b) { this.set({ message: "A source track is missing from the library" }); return; }
    await this.create(a, b); const sa = this.state.a, sb = this.state.b; if (!sa || !sb) return;
    const na = { ...sa, entry: r.aEntry, selected: r.aSelected, levels: r.aLevels }, nb = { ...sb, entry: r.bEntry, selected: r.bSelected, levels: r.bLevels };
    this.o.engine.seekTo(0, na.entry); this.o.engine.seekTo(1, nb.entry); this.o.engine.setStemMix(0, na.selected, na.levels); this.o.engine.setStemMix(1, nb.selected, nb.levels);
    this.set({ a: na, b: nb, recipeId: r.id, targetBpm: r.targetBpm, targetKey: r.targetKey, phraseBars: r.phraseBars, vocalSemitones: r.vocalSemitones, blocks: r.blocks, message: `Opened ${r.name}` });
  }
  async deleteRecipe(id: string): Promise<void> { await this.o.persistence.remove(id); this.set({ recipes: this.state.recipes.filter((r) => r.id !== id), recipeId: this.state.recipeId === id ? null : this.state.recipeId }); }
  async renderMashup(): Promise<void> {
    const a=this.state.a,b=this.state.b;if(!a||!b)return;
    try {
      await this.saveRecipe(); const recipe=this.recipeFrom(a,b), pa=this.o.sourcePcm(0),pb=this.o.sourcePcm(1); if(!pa||!pb)throw new Error("Source audio is not loaded");
      this.set({renderProgress:0,message:"Rendering mashup from cached STEMS…"}); const [sa,sb]=await Promise.all([this.o.renderData(a.track.ref),this.o.renderData(b.track.ref)]);
      const worker=new Worker(new URL("./render.worker.ts",import.meta.url),{type:"module"}),id=Date.now();
      const mp3=await new Promise<ArrayBuffer>((resolve,reject)=>{worker.onmessage=(e)=>{if(e.data.id!==id)return;if(e.data.error){worker.terminate();reject(new Error(e.data.error));}else if(e.data.result){worker.terminate();resolve(e.data.result);}else this.set({renderProgress:e.data.progress});};worker.onerror=(e)=>{worker.terminate();reject(new Error(e.message));};const msg={id,recipe,a:{sampleRate:pa.sampleRate,left:pa.channels[0],right:pa.channels[1]??pa.channels[0].slice(),stems:sa.pcm,stemRate:sa.rate,bpm:this.prep(a.track)?.bpm??a.track.bpm??this.state.targetBpm??120,entry:a.entry},b:{sampleRate:pb.sampleRate,left:pb.channels[0],right:pb.channels[1]??pb.channels[0].slice(),stems:sb.pcm,stemRate:sb.rate,bpm:this.prep(b.track)?.bpm??b.track.bpm??this.state.targetBpm??120,entry:b.entry}};worker.postMessage(msg,[msg.a.left.buffer,msg.a.right.buffer,msg.a.stems,msg.b.left.buffer,msg.b.right.buffer,msg.b.stems]);});
      const title=`${a.track.title} x ${b.track.title} (Mashup)`,artist=[a.track.artist,b.track.artist].filter(Boolean).join(" x "),tagged=prependId3(mp3,title,artist,"Created with DonkeyBillabongDJ"),file=await this.o.saveFile(`${safe(title)}.mp3`,tagged);
      if(file)await this.o.importRendered(file,{ref:file.ref,title,artist,album:"DonkeyBillabongDJ Mashups",source:"local",bpm:this.state.targetBpm,key:this.state.targetKey,genre:"Mashup",addedAt:Date.now()});
      this.set({renderProgress:null,message:file?"Mashup rendered, saved and added to the Mashups playlist":"Save cancelled"});
    }catch(e){this.set({renderProgress:null,message:`Mashup render failed: ${String(e)}`});}
  }
  addBlock(): void { const last = this.state.blocks.at(-1), bars = this.state.phraseBars; this.set({ blocks: [...this.state.blocks, { id: crypto.randomUUID(), startBar: (last?.startBar ?? -bars) + (last?.bars ?? bars), bars, aSelected: this.state.a?.selected.slice() ?? [true,false,false,false], bSelected: this.state.b?.selected.slice() ?? [false,true,true,true], aLevels: this.state.a?.levels.slice() ?? [1,1,1,1], bLevels: this.state.b?.levels.slice() ?? [1,1,1,1] }] }); }
  updateBlock(id: string, patch: Partial<MashupBlock>): void { this.set({ blocks: this.state.blocks.map((b) => b.id === id ? { ...b, ...patch } : b).sort((a,b) => a.startBar-b.startBar) }); }
  removeBlock(id: string): void { this.set({ blocks: this.state.blocks.filter((b) => b.id !== id) }); }
  tick(): void {
    if (this.state.status !== "playing" || !this.state.a || !this.state.b || !this.state.targetBpm) return;
    const bar = Math.max(0, Math.floor((this.o.engine.getPosition(0) - this.state.a.entry) / (240 / this.state.targetBpm)));
    const block = [...this.state.blocks].reverse().find((b) => bar >= b.startBar && bar < b.startBar + b.bars);
    if (block && block.id !== this.activeBlock) { this.activeBlock = block.id; this.o.engine.setStemMix(0, block.aSelected, block.aLevels); this.o.engine.setStemMix(1, block.bSelected, block.bLevels); }
    const detect = (deck: number): [number,number][] => { const e = this.o.envelopes(deck); if (!e) return []; const v=e.vocals, max=v.reduce((m,x)=>Math.max(m,x),0), out:[number,number][]=[]; let start=-1; for(let i=0;i<v.length;i++){const on=v[i]>max*.18;if(on&&start<0)start=i;if((!on||i===v.length-1)&&start>=0){if(i-start>8)out.push([start*e.hop,i*e.hop]);start=-1;}} return out.slice(0,64); };
    if (!this.state.vocalRegions.a.length || !this.state.vocalRegions.b.length) this.set({ vocalRegions: { a: detect(0), b: detect(1) } });
  }
}
const safe=(s:string)=>s.replace(/[<>:"/\\|?*]/g,"_").slice(0,140);
function prependId3(audio:ArrayBuffer,title:string,artist:string,comment:string):ArrayBuffer{const enc=new TextEncoder(),frame=(id:string,payload:Uint8Array)=>{const out=new Uint8Array(10+payload.length);out.set(enc.encode(id),0);new DataView(out.buffer).setUint32(4,payload.length);out.set(payload,10);return out;},text=(id:string,value:string)=>{const body=enc.encode(value),payload=new Uint8Array(1+body.length);payload[0]=3;payload.set(body,1);return frame(id,payload);},commentBody=enc.encode(comment),commentPayload=new Uint8Array(5+commentBody.length);commentPayload[0]=3;commentPayload.set(enc.encode("eng"),1);commentPayload[4]=0;commentPayload.set(commentBody,5);const frames=[text("TIT2",title),text("TPE1",artist),frame("COMM",commentPayload)],size=frames.reduce((n,x)=>n+x.length,0),tag=new Uint8Array(10+size+audio.byteLength);tag.set(enc.encode("ID3"));tag[3]=3;tag[6]=(size>>21)&127;tag[7]=(size>>14)&127;tag[8]=(size>>7)&127;tag[9]=size&127;let at=10;for(const f of frames){tag.set(f,at);at+=f.length;}tag.set(new Uint8Array(audio),at);return tag.buffer;}
