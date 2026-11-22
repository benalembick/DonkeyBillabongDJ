/**
 * DBDJ_SMOKE_DRUMS=/path/loop.wav (+ DBDJ_SMOKE_DRUMS_SHOTS=/dir): opens Production Studio → Drum Transcriber by
 * clicking the real navigation, imports the file (the OS file dialog can't be scripted), presses ANALYSE in the UI,
 * waits for the worker, selects the first hit, and screenshots the empty state, the analysed grid and the selection.
 * Reports the hits per lane, grid, worker use and what the DOM rendered.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";

export async function runDrumsSmoke(win: BrowserWindow, file: string, shotsDir: string): Promise<unknown> {
  const shot = async (name: string) => {
    if (!shotsDir) return null;
    const p = path.join(shotsDir, name);
    await fs.writeFile(p, (await win.webContents.capturePage()).toPNG());
    return p;
  };
  const js = <T>(code: string) => win.webContents.executeJavaScript(`(async () => { const a = window.dbdj; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${code} })()`) as Promise<T>;
  const opened = await js<unknown>(`
    const nav = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Production Studio"); nav?.click(); await sleep(400);
    const tab = document.querySelector(".ps-drums-tab"); tab?.click(); await sleep(400);
    a.drums.close(); await sleep(200);
    return { nav: !!nav, tab: !!tab, active: tab?.classList.contains("active"), empty: !!document.querySelector(".dt-empty-card") };`);
  const s0 = await shot("drums-1-empty.png");
  const imported = await js<unknown>(`
    await a.drums.importRef(${JSON.stringify(file)}, ${JSON.stringify(path.basename(file))}, "file"); await sleep(500);
    const btn = [...document.querySelectorAll(".dt-top button")].find((b) => /ANALYSE/.test(b.textContent || ""));
    const stages = []; const off = a.drums.subscribe((s) => { if (s.analysis && stages[stages.length - 1] !== s.analysis.stage) stages.push(s.analysis.stage); });
    btn?.click();
    for (let i = 0; i < 300 && (a.drums.analysing || !a.drums.getState().project?.analysis); i++) await sleep(100);
    off(); await sleep(400);
    const p = a.drums.getState().project;
    const lanes = {}; for (const h of p?.hits ?? []) lanes[h.lane] = (lanes[h.lane] ?? 0) + 1;
    return { button: !!btn, stages, error: a.drums.getState().error, source: a.drums.getState().source, hits: p?.hits.length, lanes, grid: p?.grid, analysis: p && { onsets: p.analysis?.onsets.length, classifier: p.analysis?.classifier, ms: p.analysis?.elapsedMs },
      dom: { notes: document.querySelectorAll(".dt-note").length, wave: !!document.querySelector(".dt-wave path"), laneHeads: document.querySelectorAll(".dt-lane-head").length, velBars: document.querySelectorAll(".dt-vel i").length } };`);
  const s1 = await shot("drums-2-analysed.png");
  const selected = await js<unknown>(`
    const note = document.querySelector(".dt-note"); const r = note.getBoundingClientRect();
    note.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.x + 3, clientY: r.y + 3, pointerId: 1, button: 0 }));
    note.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: r.x + 3, clientY: r.y + 3, pointerId: 1, button: 0 }));
    a.drums.setSettings({ quantize: { grid: "1/16", strength: 1 } }); await sleep(300);
    return { selected: document.querySelectorAll(".dt-note.selected").length, panel: document.querySelector(".dt-panel h4 small")?.textContent };`);
  const s2 = await shot("drums-3-selected.png");
  const sent = await js<unknown>(`
    const click = (sel, text) => { const b = [...document.querySelectorAll(sel)].find((x) => !text || (x.textContent || "").includes(text)); b?.click(); return !!b; };
    const before = a.production.getState().project.tracks.length;
    const opened = click(".dt-send"); await sleep(300); const dialog = document.querySelector(".dt-dialog")?.textContent;
    const sentClick = click(".dt-dialog-buttons button.primary"); await sleep(400); const banner = document.querySelector(".dt-sent")?.textContent;
    const shotWait = await sleep(100);
    return { opened, dialog: dialog?.slice(0, 220), sentClick, banner, tracksAdded: a.production.getState().project.tracks.length - before, bpm: a.production.getState().project.bpm };`);
  const s3 = await shot("drums-4-sent.png");
  const arrangement = await js<unknown>(`
    [...document.querySelectorAll(".dt-sent button")].find((b) => /ARRANGEMENT/.test(b.textContent || ""))?.click(); await sleep(700);
    const ps = a.production.getState(); const clip = ps.project.tracks.flatMap((t) => t.clips).find((c) => c.id === ps.selectedClipId);
    return { arrangementTab: document.querySelector(".ps-arrangement-tab")?.classList.contains("active"), clip: clip && { type: clip.type, name: clip.name, start: clip.start, notes: clip.notes?.length, bars: clip.patternBars },
      editor: document.querySelector(".ps-midi-editor .ps-editor-tools b")?.textContent, rows: [...document.querySelectorAll(".ps-midi-editor .ps-keys button")].map((b) => b.textContent).slice(0, 8), editorNotes: document.querySelectorAll(".ps-midi-editor .ps-note").length };`);
  const s4 = await shot("drums-5-arrangement.png");
  return { opened, imported, selected, sent, arrangement, shots: [s0, s1, s2, s3, s4] };
}
