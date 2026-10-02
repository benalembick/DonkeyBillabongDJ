/**
 * DBDJ_SMOKE_BIGLIB=20000: fills the library with that many synthetic tracks, opens
 * All Tracks and measures how long it takes to appear, how smooth the UI stays while
 * tracks keep updating (as background tag reading does) and while scrolling.
 */
import type { BrowserWindow } from "electron";

export async function runBigLibrarySmoke(win: BrowserWindow, count: number): Promise<unknown> {
  return win.webContents.executeJavaScript(`(async () => {
    const a = window.dbdj;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const genres = ["House", "Techno", "Disco", "Drum & Bass", "Hip Hop", "Pop"];
    const tracks = Array.from({ length: ${count} }, (_, i) => ({
      ref: "/Music/Library/Artist " + (i % 1500) + "/Album " + (i % 3000) + "/Track " + i + ".mp3",
      title: "Track " + i + " (Extended Mix)", artist: "Artist " + (i % 1500), album: "Album " + (i % 3000),
      genre: genres[i % genres.length], source: "local", bpm: 118 + (i % 12), key: null, durationMs: 180000 + (i % 240) * 1000,
      addedAt: Date.now() - i * 60000, rating: i % 6,
    }));
    // Measure the main thread: longest gap between frames and frames per second over a period.
    const watch = async (ms, during) => {
      let frames = 0, worst = 0, last = performance.now(), running = true;
      const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++; if (running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      await during?.();
      while (performance.now() - t0 < ms) await sleep(50);
      running = false;
      return { fps: Math.round(frames / ((performance.now() - t0) / 1000)), worstFrameMs: Math.round(worst) };
    };
    // Start somewhere else so opening All Tracks is a real navigation.
    document.querySelector('.main-navigation button[title="Playlists"]')?.click();
    await sleep(300);
    a.library.hydrate(tracks);
    await sleep(300);
    const out = { tracks: ${count} };
    document.querySelector('.main-navigation button[title="Collections"]')?.click();
    await sleep(200);
    const t0 = performance.now();
    const all = document.querySelector('[data-source="local-all"]') || [...document.querySelectorAll("button, .tile")].find((b) => /all tracks/i.test(b.textContent || ""));
    all?.click();
    await frame(); await frame();
    out.openAllTracksMs = Math.round(performance.now() - t0);
    out.rowsInDom = document.querySelectorAll("table.tracks tbody tr").length;
    out.idle = await watch(2000);
    // Background tag reading: batches of 200 tracks updated every 300 ms.
    out.whileTracksUpdate = await watch(3000, async () => {
      for (let b = 0; b < 10; b++) {
        const batch = a.library.getState().tracks.slice(b * 200, b * 200 + 200).map((t) => ({ ...t, album: t.album + " (tagged)" }));
        a.library.patchTracks(batch);
        await sleep(300);
      }
    });
    const wrap = document.querySelector(".library .table-wrap");
    out.whileScrolling = await watch(2000, async () => {
      for (let i = 0; i < 40; i++) { wrap.scrollTop += wrap.clientHeight * 0.75; await sleep(40); }
    });
    out.rowsInDomAfterScroll = document.querySelectorAll("table.tracks tbody tr").length;
    out.firstRowAfterScroll = document.querySelector("table.tracks tbody tr:not(.spacer) .title-cell")?.textContent;
    // Browse knob: jump the selection 5,000 tracks down; the list must scroll to show it.
    wrap.scrollTop = 0;
    await sleep(200);
    a.bus.send("browser.scroll", 5000, "midi");
    await sleep(400);
    const selRow = document.querySelector("table.tracks tbody tr.selected");
    const wr = wrap.getBoundingClientRect(), rr = selRow?.getBoundingClientRect();
    out.browseKnob = { selected: a.library.getSelected()?.title, rowRendered: !!selRow, rowTitle: selRow?.querySelector(".title-cell")?.textContent, inView: !!rr && rr.top >= wr.top && rr.bottom <= wr.bottom + 1, scrollTop: Math.round(wrap.scrollTop) };
    out.footer = [...document.querySelectorAll(".library .hint")].map((h) => h.textContent).find((t) => /of .* tracks/.test(t || ""));
    return out;
  })()`);
}
