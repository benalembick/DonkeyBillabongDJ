import { describe, expect, it } from "vitest";
import { scorePractice } from "../src/practice/scoring";
import type { TrackInfo } from "../src/core/engine/types";
const track=(ref:string,bpm:number,key:string):TrackInfo=>({ref,title:ref,artist:"Artist",album:"",source:"local",bpm,key});
const samples=(phase:number,clip=false)=>Array.from({length:30},(_,i)=>({at:i*.2,posA:60+i*.2,posB:10+i*.2,bpmA:128,bpmB:128,phaseMs:phase,volumeA:1-i/30,volumeB:i/30,crossfader:i/30,eqLowA:1-i/30,eqLowB:i/30,filterA:.5,filterB:.5,clipping:clip}));
describe("practice scoring",()=>{
  it("rewards aligned, controlled transitions",()=>{const a=track("A",128,"Am"),b=track("B",128,"Am"),good=scorePractice(a,b,undefined,undefined,samples(12),[]),poor=scorePractice(a,b,undefined,undefined,samples(190,true),[]);expect(good.scores.beatMatching).toBeGreaterThan(poor.scores.beatMatching);expect(good.scores.eqBalance).toBeGreaterThan(poor.scores.eqBalance);expect(good.scores.overall).toBeGreaterThan(poor.scores.overall)});
  it("is deterministic for measured score components",()=>{const a=track("A",126,"C"),b=track("B",127,"G"),x=scorePractice(a,b,undefined,undefined,samples(35),[]),y=scorePractice(a,b,undefined,undefined,samples(35),[]);expect(x.scores).toEqual(y.scores);expect(x.improvements).toEqual(y.improvements)});
});
