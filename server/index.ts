import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BANK_COUNT,
  emptyBanksFile,
  type Bank,
  type BanksFile,
} from "../src/banks/bank.js";
import { BANKS_DEV_PORT } from "../src/banks/devServerPort.js";
import { RelayCoordinator } from "./relay/coordinator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE
  ? resolve(process.env.DATA_FILE)
  : resolve(__dirname, "../data/cameras.json");
const PORT = Number(process.env.PORT ?? BANKS_DEV_PORT);
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : undefined;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

interface Database {
  cameras: Record<string, BanksFile>;
}

let cache: Database | undefined;
let writeQueue: Promise<void> = Promise.resolve();

async function readDb(): Promise<Database> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    cache = JSON.parse(raw) as Database;
  } catch {
    cache = { cameras: {} };
  }
  return cache;
}

async function persist(): Promise<void> {
  const db = cache;
  if (!db) return;
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf-8");
  });
  return writeQueue;
}

async function getBanks(deviceId: string): Promise<BanksFile> {
  const db = await readDb();
  if (!db.cameras[deviceId]) {
    db.cameras[deviceId] = emptyBanksFile();
    await persist();
  }
  return db.cameras[deviceId];
}

async function saveBank(deviceId: string, slot: number, bank: Bank): Promise<BanksFile> {
  if (slot < 0 || slot >= BANK_COUNT) {
    throw new HttpError(400, `slot must be 0..${BANK_COUNT - 1}`);
  }
  const db = await readDb();
  const file = db.cameras[deviceId] ?? emptyBanksFile();
  file.banks[slot] = bank;
  file.loadedSlot = slot;
  file.updatedAt = Date.now();
  db.cameras[deviceId] = file;
  await persist();
  return file;
}

async function setLoadedSlot(deviceId: string, slot: number | null): Promise<BanksFile> {
  if (slot !== null && (slot < 0 || slot >= BANK_COUNT)) {
    throw new HttpError(400, `slot must be 0..${BANK_COUNT - 1} or null`);
  }
  const db = await readDb();
  const file = db.cameras[deviceId] ?? emptyBanksFile();
  file.loadedSlot = slot;
  file.updatedAt = Date.now();
  db.cameras[deviceId] = file;
  await persist();
  return file;
}

async function saveLastState(deviceId: string, state: Bank): Promise<void> {
  const db = await readDb();
  const file = db.cameras[deviceId] ?? emptyBanksFile();
  file.lastState = state;
  file.updatedAt = Date.now();
  db.cameras[deviceId] = file;
  await persist();
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch (error) {
    throw new HttpError(400, `Invalid JSON: ${(error as Error).message}`);
  }
}

function send(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

const ROUTES = {
  banks: /^\/api\/cameras\/([^/]+)\/banks$/,
  bankSlot: /^\/api\/cameras\/([^/]+)\/banks\/(\d+)$/,
  loaded: /^\/api\/cameras\/([^/]+)\/loaded$/,
  state: /^\/api\/cameras\/([^/]+)\/state$/,
  relaySessions: /^\/api\/relay\/sessions\/?$/,
};

const relayCoordinator = new RelayCoordinator(process.env.REDIS_URL);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    send(res, 204, undefined);
    return;
  }

  let match: RegExpMatchArray | null;

  if ((match = url.match(ROUTES.banks)) && method === "GET") {
    const file = await getBanks(decodeURIComponent(match[1]!));
    send(res, 200, file, { "cache-control": "no-store" });
    return;
  }

  if ((match = url.match(ROUTES.bankSlot)) && method === "PUT") {
    const bank = (await readJson(req)) as Bank;
    const file = await saveBank(decodeURIComponent(match[1]!), Number(match[2]), bank);
    send(res, 200, file);
    return;
  }

  if ((match = url.match(ROUTES.loaded)) && method === "PUT") {
    const body = (await readJson(req)) as { slot: number | null };
    const file = await setLoadedSlot(decodeURIComponent(match[1]!), body?.slot ?? null);
    send(res, 200, file);
    return;
  }

  if ((match = url.match(ROUTES.state)) && method === "PUT") {
    const state = (await readJson(req)) as Bank;
    await saveLastState(decodeURIComponent(match[1]!), state);
    send(res, 204, undefined);
    return;
  }

  if (url.match(ROUTES.relaySessions) && method === "GET") {
    try {
      const sessions = await relayCoordinator.listSessions();
      send(res, 200, { sessions });
      return;
    } catch (error) {
      send(res, 500, { error: (error as Error).message });
      return;
    }
  }

  if (STATIC_DIR && (method === "GET" || method === "HEAD")) {
    if (await tryServeStatic(res, url, method === "HEAD")) return;
  }

  send(res, 404, { error: `Not found: ${method} ${url}` });
}

async function tryServeStatic(
  res: ServerResponse,
  rawUrl: string,
  headOnly: boolean,
): Promise<boolean> {
  if (!STATIC_DIR) return false;
  const pathname = decodeURIComponent(rawUrl.split("?")[0] ?? "/");
  const candidates = pathname === "/" || pathname === "" ? ["/index.html"] : [pathname];
  for (const candidate of candidates) {
    if (await sendStaticFile(res, candidate, headOnly)) return true;
  }
  return sendStaticFile(res, "/index.html", headOnly);
}

async function sendStaticFile(
  res: ServerResponse,
  pathname: string,
  headOnly: boolean,
): Promise<boolean> {
  if (!STATIC_DIR) return false;
  const safePath = normalize(pathname).replace(/^([/\\])+/, "");
  const filePath = resolve(STATIC_DIR, safePath);
  if (!filePath.startsWith(STATIC_DIR + sep) && filePath !== STATIC_DIR) return false;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const body = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": body.byteLength,
      "cache-control": pathname.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    });
    res.end(headOnly ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (error instanceof HttpError) {
      send(res, error.status, { error: error.message });
    } else {
      send(res, 500, { error: (error as Error).message });
    }
  });
});

relayCoordinator.attachToHttpServer(server);

server.listen(PORT, () => {
  console.log(`bm-bluetooth banks + relay listening on http://localhost:${PORT}`);
  console.log(`  data file: ${DATA_FILE}`);
  if (STATIC_DIR) console.log(`  static dir: ${STATIC_DIR}`);
  console.log(`  relay ws: ws://localhost:${PORT}/api/relay/socket`);
  console.log(`  redis: ${process.env.REDIS_URL ? "enabled" : "disabled (single-node fanout)"}`);
});
