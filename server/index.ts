import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BANK_COUNT,
  GLOBAL_SCENE_COUNT,
  emptyBanksFile,
  type AtemCcuRelayStored,
  type Bank,
  type BanksFile,
} from "../src/banks/bank.js";
import { BANKS_DEV_PORT } from "../src/banks/devServerPort.js";
import { RelayCoordinator } from "./relay/coordinator.js";

/**
 * @file index.ts (`server`)
 *
 * bm-bluetooth — Banks HTTP API backed by **`data/cameras.json`**, relay session listing (`RelayCoordinator` + Redis),
 * and optional **`STATIC_DIR`** hosting of the built Vite bundle.
 *
 * **Private** repo.
 */

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

// ─────────────────────────────────────────────────────────────────────────────
// Banks JSON persistence (`data/cameras.json`)
// ─────────────────────────────────────────────────────────────────────────────

interface Database {
  cameras: Record<string, BanksFile>;
  globalScenes: Array<Bank | null>;
}

function normalizeDatabase(db: Database): void {
  if (!db.cameras) db.cameras = {};
  if (!Array.isArray(db.globalScenes)) {
    db.globalScenes = Array.from({ length: GLOBAL_SCENE_COUNT }, () => null);
  }
  while (db.globalScenes.length < GLOBAL_SCENE_COUNT) {
    db.globalScenes.push(null);
  }
  if (db.globalScenes.length > GLOBAL_SCENE_COUNT) {
    db.globalScenes = db.globalScenes.slice(0, GLOBAL_SCENE_COUNT);
  }
  for (const file of Object.values(db.cameras)) {
    if (file.globalLoadedSlot === undefined) file.globalLoadedSlot = null;
  }
}

let cache: Database | undefined;
let writeQueue: Promise<void> = Promise.resolve();

async function readDb(): Promise<Database> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    cache = JSON.parse(raw) as Database;
  } catch {
    cache = { cameras: {}, globalScenes: Array.from({ length: GLOBAL_SCENE_COUNT }, () => null) };
  }
  normalizeDatabase(cache);
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
  file.globalLoadedSlot = null;
  file.updatedAt = Date.now();
  db.cameras[deviceId] = file;
  await persist();
  return file;
}

async function applyLoadedUpdate(deviceId: string, body: Record<string, unknown>): Promise<BanksFile> {
  const db = await readDb();
  const file = db.cameras[deviceId] ?? emptyBanksFile();

  if ("slot" in body) {
    const slot = body.slot as number | null | undefined;
    if (slot !== null && slot !== undefined && (typeof slot !== "number" || slot < 0 || slot >= BANK_COUNT)) {
      throw new HttpError(400, `slot must be 0..${BANK_COUNT - 1} or null`);
    }
    file.loadedSlot = slot ?? null;
    if (file.loadedSlot !== null) file.globalLoadedSlot = null;
  }
  if ("globalLoadedSlot" in body) {
    const g = body.globalLoadedSlot as number | null | undefined;
    if (g !== null && g !== undefined && (typeof g !== "number" || g < 0 || g >= GLOBAL_SCENE_COUNT)) {
      throw new HttpError(400, `globalLoadedSlot must be 0..${GLOBAL_SCENE_COUNT - 1} or null`);
    }
    file.globalLoadedSlot = g ?? null;
    if (file.globalLoadedSlot !== null) file.loadedSlot = null;
  }

  file.updatedAt = Date.now();
  db.cameras[deviceId] = file;
  await persist();
  return file;
}

async function saveGlobalScene(deviceId: string, slot: number, bank: Bank): Promise<{ camera: BanksFile; globalBanks: Array<Bank | null> }> {
  if (slot < 0 || slot >= GLOBAL_SCENE_COUNT) {
    throw new HttpError(400, `global slot must be 0..${GLOBAL_SCENE_COUNT - 1}`);
  }
  const db = await readDb();
  db.globalScenes[slot] = bank;
  const file = db.cameras[deviceId] ?? emptyBanksFile();
  file.globalLoadedSlot = slot;
  file.loadedSlot = null;
  file.updatedAt = Date.now();
  db.cameras[deviceId] = file;
  await persist();
  return { camera: file, globalBanks: [...db.globalScenes] };
}

async function getGlobalScenes(): Promise<Array<Bank | null>> {
  const db = await readDb();
  return [...db.globalScenes];
}

async function saveLastState(deviceId: string, state: Bank): Promise<void> {
  const db = await readDb();
  const file = db.cameras[deviceId] ?? emptyBanksFile();
  file.lastState = state;
  file.updatedAt = Date.now();
  db.cameras[deviceId] = file;
  await persist();
}

async function saveAtemCcuRelay(deviceId: string, body: unknown): Promise<BanksFile> {
  if (!body || typeof body !== "object") throw new HttpError(400, "Expected JSON object");
  const o = body as Record<string, unknown>;
  const address = String(o.address ?? "").trim();
  const cam = Math.round(Number(o.cameraId));
  if (!address) throw new HttpError(400, "address required");
  if (!Number.isFinite(cam) || cam < 1 || cam > 24) throw new HttpError(400, "cameraId must be 1..24");
  const sessionName =
    o.sessionName !== undefined && o.sessionName !== null ? String(o.sessionName).trim().slice(0, 120) : undefined;
  let port: number | undefined;
  if (o.port !== undefined && o.port !== null) {
    port = Math.round(Number(o.port));
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new HttpError(400, "port must be 1..65535");
  }
  const relay: AtemCcuRelayStored = { address, cameraId: cam, sessionName, port };
  const db = await readDb();
  const file = db.cameras[deviceId] ?? emptyBanksFile();
  file.atemCcuRelay = relay;
  file.updatedAt = Date.now();
  db.cameras[deviceId] = file;
  await persist();
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP façade helpers (`readJson`, `send`, routing table)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Route table / relay coordinator singleton
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES = {
  banks: /^\/api\/cameras\/([^/]+)\/banks$/,
  bankSlot: /^\/api\/cameras\/([^/]+)\/banks\/(\d+)$/,
  loaded: /^\/api\/cameras\/([^/]+)\/loaded$/,
  globalScenes: /^\/api\/global\/scenes\/?$/,
  cameraGlobalSceneSlot: /^\/api\/cameras\/([^/]+)\/global-scenes\/(\d+)$/,
  state: /^\/api\/cameras\/([^/]+)\/state$/,
  atemCcuRelay: /^\/api\/cameras\/([^/]+)\/atem-ccu-relay$/,
  relaySessions: /^\/api\/relay\/sessions\/?$/,
  relayAtemConnectors: /^\/api\/relay\/atem-connectors\/?$/,
};

const relayCoordinator = new RelayCoordinator(process.env.REDIS_URL);

// ─────────────────────────────────────────────────────────────────────────────
// `handle()` + optional static SPA (`STATIC_DIR`)
// ─────────────────────────────────────────────────────────────────────────────

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
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    const file = await applyLoadedUpdate(decodeURIComponent(match[1]!), body);
    send(res, 200, file);
    return;
  }

  if (url.match(ROUTES.globalScenes) && method === "GET") {
    const banks = await getGlobalScenes();
    send(res, 200, { banks }, { "cache-control": "no-store" });
    return;
  }

  if ((match = url.match(ROUTES.cameraGlobalSceneSlot)) && method === "PUT") {
    const bank = (await readJson(req)) as Bank;
    const payload = await saveGlobalScene(decodeURIComponent(match[1]!), Number(match[2]), bank);
    send(res, 200, payload);
    return;
  }

  if ((match = url.match(ROUTES.state)) && method === "PUT") {
    const state = (await readJson(req)) as Bank;
    await saveLastState(decodeURIComponent(match[1]!), state);
    send(res, 204, undefined);
    return;
  }

  if ((match = url.match(ROUTES.atemCcuRelay)) && method === "PUT") {
    const body = await readJson(req);
    const file = await saveAtemCcuRelay(decodeURIComponent(match[1]!), body);
    send(res, 200, file);
    return;
  }

  if (url.match(ROUTES.relayAtemConnectors) && method === "GET") {
    try {
      const connectors = await relayCoordinator.listAtemConnectors();
      send(res, 200, { connectors });
      return;
    } catch (error) {
      send(res, 500, { error: (error as Error).message });
      return;
    }
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
  console.log(
    `  redis: ${
      process.env.REDIS_URL?.trim()
        ? "enabled (relay coordinates across instances)"
        : "not configured — single-node relay only; set REDIS_URL if you run more than one replica"
    }`,
  );
});
