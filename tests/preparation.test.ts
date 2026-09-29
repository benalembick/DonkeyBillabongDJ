import { describe, expect, it } from "vitest";
import { PreparationStore } from "../src/preparation/PreparationStore";
import { EMPTY_CONTENT_ID, type PreparationPersistence, type TrackPreparation, type WaveformRecord } from "../src/preparation/types";

const record = (trackId: string, refs: string[]): TrackPreparation => ({ schemaVersion:1,trackId,refs,fileSize:0,title:"old",artist:"",album:"",isrc:null,duration:10,bpm:null,key:null,keyConfidence:0,energy:null,energyConfidence:0,sections:[],recommendedCues:[],gain:null,analysisVersion:null,analysedAt:null,updatedAt:1,beatGrid:null,cuePoint:0,cues:[],savedLoops:[],lastLoop:null });

describe("preparation content identity", () => {
  it("does not restore the legacy empty-buffer identity and repairs its ref on identification", async () => {
    const saved: TrackPreparation[]=[];
    const persistence: PreparationPersistence={list:async()=>[record(EMPTY_CONTENT_ID,["song.mp3"])],save:async(r)=>{saved.push(r);},loadWaveform:async()=>null,saveWaveform:async(_r:WaveformRecord)=>{}};
    const store=new PreparationStore(persistence);await store.ready;
    expect(store.forRef("song.mp3")).toBeUndefined();
    const identified=await store.identify({ref:"song.mp3",title:"Song",artist:"",album:"",source:"local",bpm:null,key:null},new Uint8Array([1,2,3]).buffer,10);
    expect(identified.trackId).not.toBe(EMPTY_CONTENT_ID);
    expect(store.forRef("song.mp3")?.trackId).toBe(identified.trackId);
    expect(saved.some((r)=>r.trackId===EMPTY_CONTENT_ID&&r.refs.length===0)).toBe(true);
  });

  it("rejects detached or empty audio bytes", async () => {
    const persistence: PreparationPersistence={list:async()=>[],save:async()=>{},loadWaveform:async()=>null,saveWaveform:async()=>{}};
    const store=new PreparationStore(persistence);await store.ready;
    await expect(store.identify({ref:"empty.mp3",title:"Empty",artist:"",album:"",source:"local",bpm:null,key:null},new ArrayBuffer(0),0)).rejects.toThrow("empty audio data");
  });
});
