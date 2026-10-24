#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = "127.0.0.1";
const PORT = 4173;
const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m3u", "audio/x-mpegurl; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
]);

function sendText(response, status, text) {
  const body = Buffer.from(text);
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function parseRange(value, size) {
  if (typeof value !== "string" || !value.startsWith("bytes=") || value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed");
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${HOST}:${PORT}`).pathname);
  } catch {
    sendText(response, 400, "Bad Request");
    return;
  }
  const sitePath = pathname === "/libvetv"
    ? "/"
    : pathname.startsWith("/libvetv/")
    ? pathname.slice("/libvetv".length)
    : pathname;
  const requestPath = sitePath === "/" ? "/index.html" : sitePath;
  const candidate = resolve(ROOT, `.${requestPath}`);
  const fromRoot = relative(ROOT, candidate);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === "..") {
    sendText(response, 403, "Forbidden");
    return;
  }
  let fileStat;
  try {
    fileStat = await stat(candidate);
  } catch {
    sendText(response, 404, "Not Found");
    return;
  }
  if (!fileStat.isFile()) {
    sendText(response, 404, "Not Found");
    return;
  }

  const headers = {
    "Content-Type": MIME.get(extname(candidate).toLowerCase()) || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const range = parseRange(request.headers.range, fileStat.size);
  if (request.headers.range && !range) {
    response.writeHead(416, { ...headers, "Content-Range": `bytes */${fileStat.size}` });
    response.end();
    return;
  }
  if (range) {
    const length = range.end - range.start + 1;
    response.writeHead(206, {
      ...headers,
      "Content-Length": length,
      "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(candidate, { start: range.start, end: range.end }).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": fileStat.size });
  if (request.method === "HEAD") response.end();
  else createReadStream(candidate).pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`Synthetic static server listening at http://${HOST}:${PORT}/`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
