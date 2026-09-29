import type { TrackInfo } from "../core/engine/types";
import type { TrackPreparation } from "../preparation/types";
import { compatibility } from "../analysis/discovery";
import type { PracticeEvent, PracticeResult, PracticeSample } from "./types";

const clampScore=(n:number)=>Math.round(Math.max(0,Math.min(100,n)));
const mean=(xs:number[],fallback=50)=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:fallback;
export function scorePractice(a:TrackInfo,b:TrackInfo,pa:TrackPreparation|undefined,pb:TrackPreparation|undefined,samples:PracticeSample[],events:PracticeEvent[]):PracticeResult {
  const overlap=samples.filter(s=>s.volumeA>.08&&s.volumeB>.08), phases=overlap.map(s=>Math.abs(s.phaseMs??250));
  const bpmErrors=overlap.filter(s=>s.bpmA&&s.bpmB).map(s=>Math.abs(s.bpmA!-s.bpmB!));
  const beatMatching=clampScore(100-mean(phases,180)/2.3-mean(bpmErrors,2)*10);
  const grid=pa?.beatGrid, start=overlap[0]?.posA??0, beat=grid?60/grid.bpm:null, phrase=beat?beat*64:null;
  const phraseError=phrase?Math.min(start%phrase,phrase-start%phrase):phrase??8;
  const phraseAlignment=clampScore(100-(phrase?phraseError/phrase*180:35));
  const timing=clampScore(phraseAlignment*.7+(overlap.length>4?30:10));
  const jumps=overlap.slice(1).map((s,i)=>Math.abs((s.volumeA+s.volumeB)-(overlap[i].volumeA+overlap[i].volumeB)));
  const duration=overlap.length?overlap.at(-1)!.at-overlap[0].at:0;
  const deliberateCut=duration<4&&jumps.some(x=>x>.5);
  const transition=clampScore(100-mean(jumps,0)*110-(duration<2&&!deliberateCut?20:0));
  const lowOverlap=mean(overlap.map(s=>Math.max(0,s.eqLowA+s.eqLowB-1.25)),.15), clipping=overlap.filter(s=>s.clipping).length/Math.max(1,overlap.length);
  const eqBalance=clampScore(100-lowOverlap*90-clipping*70);
  const harmonicCompatibility=compatibility(a,b,pa,pb).score;
  const gainControl=clampScore(100-clipping*100-mean(jumps,0)*60);
  const trackSelection=clampScore(harmonicCompatibility*.55+(100-Math.min(100,mean(bpmErrors,4)*18))*.45);
  const overall=clampScore(beatMatching*.3+timing*.2+transition*.2+eqBalance*.15+trackSelection*.1+gainControl*.05);
  const strengths:string[]=[],improvements:string[]=[];
  if(phraseAlignment>=80)strengths.push(`Great phrase timing: Track B entered close to a musical phrase boundary.`);else improvements.push(`Move Track B's entry closer to a 16-bar phrase boundary.`);
  if(beatMatching>=80)strengths.push(`The beats stayed closely aligned through most of the blend.`);else improvements.push(`Beat alignment averaged about ${Math.round(mean(phases,180))} ms apart; use smaller jog corrections to reduce drift.`);
  if(eqBalance>=80)strengths.push(`Low-end and gain balance stayed controlled during the overlap.`);else improvements.push(clipping>0?`Clipping was detected during the transition; lower channel gain before the blend.`:`Reduce one track's bass while both kick and bass parts overlap.`);
  if(transition<70)improvements.push(`Smooth the fader curve and avoid sudden combined-level changes during the transition.`);
  return {id:crypto.randomUUID(),date:Date.now(),trackARef:a.ref,trackATitle:`${a.artist} — ${a.title}`,trackBRef:b.ref,trackBTitle:`${b.artist} — ${b.title}`,scores:{overall,beatMatching,timing,transition,eqBalance,phraseAlignment,harmonicCompatibility,gainControl,trackSelection},events,strengths,improvements};
}
