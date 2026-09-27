import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export function htmlPage(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;background:#0d0f12;color:#e6e9ef;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px;text-align:center"><h2>${title}</h2><p>${message}</p></div></body>`;
}

type Handler = (req: IncomingMessage, url: URL, res: ServerResponse) => void | Promise<void>;

/**
 * A short-lived HTTP server on the loopback interface, used for OAuth-style
 * callbacks (RFC 8252). Closes itself when `close()` is called or on timeout.
 */
export function startLoopback(port: number, handler: Handler, timeoutMs = 5 * 60_000): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      Promise.resolve(handler(req, url, res)).catch((err) => {
        res.writeHead(500, { "content-type": "text/html" }).end(htmlPage("Error", String(err)));
      });
    });
    const timer = setTimeout(() => server.close(), timeoutMs);
    const close = () => {
      clearTimeout(timer);
      server.close();
    };
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${port} is in use — close other apps using it and retry.`) : err),
    );
    server.listen(port, "127.0.0.1", () => resolve({ close }));
  });
}

export function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString("utf8");
      if (data.length > limit) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
