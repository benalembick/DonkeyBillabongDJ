import { createMp3Encoder } from "wasm-media-encoders";
import type { MashupRecipe } from "./types";
import { mashupDuration } from "./renderMath";

interface Source { sampleRate: number; left: Float32Array; right: Float32Array; stems: ArrayBuffer; stemRate: number; bpm: number; entry: number }
interface Request { id: number; recipe: MashupRecipe; a: Source; b: Source }
const sample = (x: Float32Array, p: number) => { const i=Math.floor(p), f=p-i; if(i<0||i>=x.length)return 0;const a=x[i]??0,b=x[i+1]??a;return a+(b-a)*f; };
function sourceFrame(s: Source, t: number, selected: boolean[], levels: number[], hp: {x:number;y:number}): [number,number] {
  const rate = s.bpm > 0 ? (currentTarget / s.bpm) : 1, sec = s.entry + t * rate;
  const op = sec * s.sampleRate, sp = Math.floor(sec * s.stemRate), pcm = new Int16Array(s.stems), at = sp * 6;
  if (op >= s.left.length || at < 0 || at + 5 >= pcm.length) return [0,0];
  const oL=sample(s.left,op), oR=sample(s.right,op), vL=pcm[at]/32768, vR=pcm[at+1]/32768, dL=pcm[at+2]/32768, dR=pcm[at+3]/32768, bL=pcm[at+4]/32768, bR=pcm[at+5]/32768;
  const iL=oL-vL-dL-bL, iR=oR-vR-dR-bR;
  // One-pole ~120 Hz vocal high-pass, matching the live vocal low-frequency management intent.
  const alpha=.983; const hvL=alpha*(hp.y+vL-hp.x); hp.x=vL; hp.y=hvL; const hvR=vR-vL+hvL;
  return [selected[0]?hvL*levels[0]:0,selected[0]?hvR*levels[0]:0].map((v,ch)=>v+(selected[1]?(ch?dR:dL)*levels[1]:0)+(selected[2]?(ch?bR:bL)*levels[2]:0)+(selected[3]?(ch?iR:iL)*levels[3]:0)) as [number,number];
}
let currentTarget=120;
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
workerScope.onmessage = async (e: MessageEvent<Request>) => {
  const {id,recipe,a,b}=e.data; currentTarget=recipe.targetBpm||a.bpm||b.bpm||120;
  try {
    const duration=mashupDuration(currentTarget,{sampleRate:a.sampleRate,sampleCount:a.left.length,bpm:a.bpm,entry:a.entry},{sampleRate:b.sampleRate,sampleCount:b.left.length,bpm:b.bpm,entry:b.entry}),total=Math.ceil(duration*44100),chunk=23040;
    const encoder=await createMp3Encoder(); encoder.configure({sampleRate:44100,channels:2,bitrate:320}); const parts:Uint8Array[]=[]; let bytes=0, hpA={x:0,y:0},hpB={x:0,y:0};
    for(let from=0;from<total;from+=chunk){const n=Math.min(chunk,total-from),L=new Float32Array(n),R=new Float32Array(n);for(let j=0;j<n;j++){const t=(from+j)/44100,bar=Math.floor(t/(240/currentTarget));const block=[...recipe.blocks].reverse().find(x=>bar>=x.startBar&&bar<x.startBar+x.bars);const as=block?.aSelected??recipe.aSelected,bs=block?.bSelected??recipe.bSelected,al=block?.aLevels??recipe.aLevels,bl=block?.bLevels??recipe.bLevels;const x=sourceFrame(a,t,as,al,hpA),y=sourceFrame(b,t,bs,bl,hpB);L[j]=Math.tanh((x[0]+y[0])*.58);R[j]=Math.tanh((x[1]+y[1])*.58);}const out=encoder.encode([L,R]).slice();if(out.length){parts.push(out);bytes+=out.length;}workerScope.postMessage({id,progress:(from+n)/total});}
    const tail=encoder.finalize().slice();parts.push(tail);bytes+=tail.length;const result=new Uint8Array(bytes);let off=0;for(const p of parts){result.set(p,off);off+=p.length;}workerScope.postMessage({id,result:result.buffer},[result.buffer]);
  } catch(error){workerScope.postMessage({id,error:String(error)});}
};
