import { CATALOG_FINGERPRINT, CATALOG_MANIFEST } from "./catalog-integrity";
import {
  isMark,
  mergeDecisionState,
  type DecisionMeta,
  type Mark,
} from "./progress-model";

export type { DecisionMeta, Mark } from "./progress-model";

export type DeskSnapshot = {
  version: 2;
  app: "halmar-import-desk";
  deskToken: string;
  updatedAt: number;
  detailsUpdatedAt: number;
  detailsWriter: string;
  clientName: string;
  note: string;
  decisions: Record<string, Mark>;
  decisionMeta: Record<string, DecisionMeta>;
  serverRevision: number;
  serverUpdatedAt: number;
  serverDeskId: string;
};

export type PersistenceReport = {
  durable: boolean;
  localStorage: boolean;
  sessionStorage: boolean;
  indexedDb: boolean;
  backupFile: boolean;
  errors: string[];
};

const LEGACY_STORAGE_KEY = "halmar-import-desk-v1";
const CURRENT_DESK_KEY = "halmar-import-desk-current-v2";
const STORAGE_PREFIX = "halmar-import-desk-v2:";
const JOURNAL_PREFIX = "halmar-import-desk-mark-v2:";
const IDB_NAME = "halmar-import-desk";
const IDB_STORE = "kv";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function snapshotKey(token: string) {
  return `${STORAGE_PREFIX}${token}`;
}

function sessionKey(token: string) {
  return `${STORAGE_PREFIX}session:${token}`;
}

function journalPrefix(token: string) {
  return `${JOURNAL_PREFIX}${token}:`;
}

function idbBackupKey(token: string) {
  return `${snapshotKey(token)}:previous`;
}

function idbHandleKey(token: string) {
  return `${snapshotKey(token)}:file-handle`;
}

export function emptySnapshot(deskToken = ""): DeskSnapshot {
  return {
    version: 2,
    app: "halmar-import-desk",
    deskToken,
    updatedAt: 0,
    detailsUpdatedAt: 0,
    detailsWriter: "",
    clientName: "",
    note: "",
    decisions: {},
    decisionMeta: {},
    serverRevision: 0,
    serverUpdatedAt: 0,
    serverDeskId: "",
  };
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

function normalizeDecisionMeta(
  raw: unknown,
  decisions: Record<string, Mark>,
  fallbackTime: number,
): Record<string, DecisionMeta> {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const result: Record<string, DecisionMeta> = {};
  for (const id of Object.keys(decisions)) {
    const item = source[id];
    const meta = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const stamp = Number(meta.updatedAt);
    result[id] = {
      updatedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : Math.max(1, fallbackTime),
      writer: typeof meta.writer === "string" && meta.writer ? meta.writer : "legacy-import",
    };
  }
  return result;
}

export function parseSnapshot(raw: unknown, fallbackToken = ""): DeskSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.app !== "halmar-import-desk" && o.format !== "halmar-import-desk") return null;
  const decisions: Record<string, Mark> = {};
  if (o.decisions && typeof o.decisions === "object") {
    for (const [key, value] of Object.entries(o.decisions as Record<string, unknown>)) {
      if (key && isMark(value)) decisions[key] = value;
    }
  }
  if (Object.keys(decisions).length === 0 && Array.isArray(o.products)) {
    for (const row of o.products as Array<Record<string, unknown>>) {
      if (row && typeof row.id === "string" && isMark(row.decision)) decisions[row.id] = row.decision;
    }
  }
  if (Object.keys(decisions).length === 0 && o.decisionsByEanGtin && typeof o.decisionsByEanGtin === "object") {
    for (const [key, value] of Object.entries(o.decisionsByEanGtin as Record<string, unknown>)) {
      if (key && isMark(value)) decisions[key] = value;
    }
  }
  const updatedAt = Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : Date.now();
  const cloud = o.cloud && typeof o.cloud === "object" ? (o.cloud as Record<string, unknown>) : {};
  return {
    version: 2,
    app: "halmar-import-desk",
    deskToken: validToken(o.deskToken) ? o.deskToken : fallbackToken,
    updatedAt,
    detailsUpdatedAt: Number.isFinite(Number(o.detailsUpdatedAt)) ? Number(o.detailsUpdatedAt) : updatedAt,
    detailsWriter: typeof o.detailsWriter === "string" ? o.detailsWriter : "legacy-import",
    clientName: typeof o.clientName === "string" ? o.clientName : "",
    note: typeof o.note === "string" ? o.note : "",
    decisions,
    decisionMeta: normalizeDecisionMeta(o.decisionMeta, decisions, updatedAt),
    serverRevision: Math.max(0, Number(o.serverRevision ?? cloud.revision) || 0),
    serverUpdatedAt: Math.max(0, Number(o.serverUpdatedAt ?? cloud.updatedAt) || 0),
    serverDeskId:
      typeof o.serverDeskId === "string"
        ? o.serverDeskId
        : typeof cloud.deskId === "string"
          ? cloud.deskId
          : "",
  };
}

export function mergeSnapshots(a: DeskSnapshot | null, b: DeskSnapshot | null): DeskSnapshot | null {
  if (!a) return b;
  if (!b) return a;
  if (a.deskToken && b.deskToken && a.deskToken !== b.deskToken) return a;
  const merged = mergeDecisionState(a, b);
  const bDetailsAreNewer =
    b.detailsUpdatedAt > a.detailsUpdatedAt ||
    (b.detailsUpdatedAt === a.detailsUpdatedAt && b.detailsWriter.localeCompare(a.detailsWriter) > 0);
  const server = b.serverRevision > a.serverRevision ? b : a;
  return {
    version: 2,
    app: "halmar-import-desk",
    deskToken: a.deskToken || b.deskToken,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    detailsUpdatedAt: bDetailsAreNewer ? b.detailsUpdatedAt : a.detailsUpdatedAt,
    detailsWriter: bDetailsAreNewer ? b.detailsWriter : a.detailsWriter,
    clientName: bDetailsAreNewer ? b.clientName : a.clientName,
    note: bDetailsAreNewer ? b.note : a.note,
    decisions: merged.decisions,
    decisionMeta: merged.decisionMeta,
    serverRevision: server.serverRevision,
    serverUpdatedAt: server.serverUpdatedAt,
    serverDeskId: server.serverDeskId,
  };
}

export const pickRicher = mergeSnapshots;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function resolveDeskToken() {
  let fromLink = false;
  let token = "";
  try {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("desk");
    if (validToken(fromHash)) {
      token = fromHash;
      fromLink = true;
    }
  } catch {
    // The browser URL is optional during tests and server rendering.
  }
  if (!token) {
    try {
      const stored = localStorage.getItem(CURRENT_DESK_KEY);
      if (validToken(stored)) token = stored;
    } catch {
      // A generated token is still usable through the share link.
    }
  }
  if (!token) token = randomToken();
  try {
    localStorage.setItem(CURRENT_DESK_KEY, token);
    sessionStorage.setItem(CURRENT_DESK_KEY, token);
  } catch {
    // Persistence diagnostics will surface blocked storage separately.
  }
  return { token, fromLink };
}

function addJournal(snapshot: DeskSnapshot, source: Storage) {
  try {
    const prefix = journalPrefix(snapshot.deskToken);
    for (let index = 0; index < source.length; index += 1) {
      const key = source.key(index);
      if (!key?.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const raw = JSON.parse(source.getItem(key) ?? "null") as Record<string, unknown> | null;
      if (!raw || !isMark(raw.mark)) continue;
      const stamp = Number(raw.updatedAt);
      const incoming = {
        decisions: { [id]: raw.mark },
        decisionMeta: {
          [id]: {
            updatedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : 1,
            writer: typeof raw.writer === "string" && raw.writer ? raw.writer : "journal",
          },
        },
      };
      const merged = mergeDecisionState(snapshot, incoming);
      snapshot.decisions = merged.decisions;
      snapshot.decisionMeta = merged.decisionMeta;
    }
  } catch {
    // The full snapshot can still recover even when journal iteration is blocked.
  }
  return snapshot;
}

export function readLocal(token: string): DeskSnapshot | null {
  try {
    const raw = localStorage.getItem(snapshotKey(token));
    const parsed = raw ? parseSnapshot(JSON.parse(raw), token) : emptySnapshot(token);
    const withJournal = addJournal(parsed ?? emptySnapshot(token), localStorage);
    return raw || Object.keys(withJournal.decisions).length > 0 ? withJournal : null;
  } catch {
    return null;
  }
}

export function readLegacyLocal(token: string): DeskSnapshot | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? parseSnapshot(JSON.parse(raw), token) : null;
  } catch {
    return null;
  }
}

export function readSession(token: string): DeskSnapshot | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(token));
    return raw ? parseSnapshot(JSON.parse(raw), token) : null;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) request.result.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeIdb(snapshot: DeskSnapshot, changedIds: string[]) {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable");
  const db = await openDb();
  const payload = JSON.stringify(snapshot);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const previous = store.get(snapshotKey(snapshot.deskToken));
      previous.onsuccess = () => {
        if (previous.result !== undefined) store.put(previous.result, idbBackupKey(snapshot.deskToken));
        store.put(payload, snapshotKey(snapshot.deskToken));
        for (const id of changedIds) {
          const meta = snapshot.decisionMeta[id];
          const mark = snapshot.decisions[id];
          if (meta && mark) store.put({ mark, ...meta }, `${journalPrefix(snapshot.deskToken)}${id}`);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
  } finally {
    db.close();
  }
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readIdb(token: string, includeLegacy = false): Promise<DeskSnapshot | null> {
  try {
    if (typeof indexedDB === "undefined") return null;
    const db = await openDb();
    try {
      const store = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE);
      const [primary, backup, legacy, keys, values] = await Promise.all([
        requestValue(store.get(snapshotKey(token))),
        requestValue(store.get(idbBackupKey(token))),
        includeLegacy ? requestValue(store.get(LEGACY_STORAGE_KEY)) : Promise.resolve(undefined),
        requestValue(store.getAllKeys()),
        requestValue(store.getAll()),
      ]);
      let parsed: DeskSnapshot | null = null;
      for (const raw of [primary, backup, legacy]) {
        if (raw === undefined) continue;
        try {
          parsed = parseSnapshot(typeof raw === "string" ? JSON.parse(raw) : raw, token);
        } catch {
          parsed = null;
        }
        if (parsed) break;
      }
      const snapshot = parsed ?? emptySnapshot(token);
      const prefix = journalPrefix(token);
      for (let index = 0; index < keys.length; index += 1) {
        const key = String(keys[index]);
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        const value = values[index] as Record<string, unknown> | undefined;
        if (!value || !isMark(value.mark)) continue;
        const stamp = Number(value.updatedAt);
        const incoming = {
          decisions: { [id]: value.mark },
          decisionMeta: {
            [id]: {
              updatedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : 1,
              writer: typeof value.writer === "string" && value.writer ? value.writer : "idb-journal",
            },
          },
        };
        const merged = mergeDecisionState(snapshot, incoming);
        snapshot.decisions = merged.decisions;
        snapshot.decisionMeta = merged.decisionMeta;
      }
      return parsed || Object.keys(snapshot.decisions).length > 0 ? snapshot : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

type WritableFile = { write: (data: string) => Promise<void>; close: () => Promise<void> };
type FileHandle = {
  name?: string;
  createWritable: () => Promise<WritableFile>;
  queryPermission?: (opts?: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (opts?: { mode: "readwrite" }) => Promise<PermissionState>;
};

let boundHandle: FileHandle | null = null;
let boundToken = "";
let boundName: string | null = null;
let boundWritable = false;
let lastBoundWrite = "";

export function boundBackupName(token?: string) {
  return boundWritable && (!token || token === boundToken) ? boundName : null;
}

export function canBindBackupFile() {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

async function saveHandle(token: string, handle: FileHandle) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(handle, idbHandleKey(token));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function restoreBoundBackup(token: string): Promise<string | null> {
  try {
    if (typeof indexedDB === "undefined") return null;
    const db = await openDb();
    const handle = await requestValue(
      db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(idbHandleKey(token)),
    );
    db.close();
    if (!handle || typeof handle !== "object") return null;
    const candidate = handle as FileHandle;
    const permission = candidate.queryPermission
      ? await candidate.queryPermission({ mode: "readwrite" })
      : "prompt";
    boundHandle = candidate;
    boundToken = token;
    boundName = candidate.name ?? "halmar-import-desk-live-backup.json";
    boundWritable = permission === "granted";
    return boundWritable ? boundName : null;
  } catch {
    boundWritable = false;
    return null;
  }
}

export async function bindBackupFile(snapshot: DeskSnapshot): Promise<string> {
  const picker = (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileHandle> })
    .showSaveFilePicker;
  let handle = boundToken === snapshot.deskToken ? boundHandle : null;
  if (handle?.requestPermission) {
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") handle = null;
  }
  if (!handle) {
    handle = await picker({
      suggestedName: "halmar-import-desk-live-backup.json",
      types: [{ description: "Halmar decisions", accept: { "application/json": [".json"] } }],
    });
  }
  boundHandle = handle;
  boundToken = snapshot.deskToken;
  boundName = handle.name ?? "halmar-import-desk-live-backup.json";
  boundWritable = false;
  await saveHandle(snapshot.deskToken, handle);
  await writeBoundFile(snapshot.deskToken, JSON.stringify(snapshot));
  return boundName;
}

async function writeBoundFile(token: string, payload: string) {
  if (!boundHandle || token !== boundToken || payload === lastBoundWrite) return false;
  try {
    const writable = await boundHandle.createWritable();
    await writable.write(payload);
    await writable.close();
    lastBoundWrite = payload;
    boundWritable = true;
    return true;
  } catch (error) {
    boundWritable = false;
    throw error;
  }
}

function browserCopies(snapshot: DeskSnapshot, changedIds: string[]) {
  const payload = JSON.stringify(snapshot);
  const errors: string[] = [];
  let localOk = false;
  let sessionOk = false;
  try {
    localStorage.setItem(CURRENT_DESK_KEY, snapshot.deskToken);
  } catch (error) {
    errors.push(`Browser desk key: ${error instanceof Error ? error.message : "write failed"}`);
  }
  for (const id of changedIds) {
    try {
      const mark = snapshot.decisions[id];
      const meta = snapshot.decisionMeta[id];
      if (!mark || !meta) continue;
      const key = `${journalPrefix(snapshot.deskToken)}${id}`;
      const value = JSON.stringify({ mark, ...meta });
      localStorage.setItem(key, value);
      if (localStorage.getItem(key) !== value) throw new Error(`mark ${id} verification failed`);
    } catch (error) {
      errors.push(`Browser journal: ${error instanceof Error ? error.message : "write failed"}`);
    }
  }
  try {
    // The per-product journal is committed first so a crash while replacing the
    // larger snapshot still leaves the user's newest explicit decision behind.
    localStorage.setItem(snapshotKey(snapshot.deskToken), payload);
    if (localStorage.getItem(snapshotKey(snapshot.deskToken)) !== payload) {
      throw new Error("localStorage verification failed");
    }
    localOk = true;
  } catch (error) {
    errors.push(`Browser storage: ${error instanceof Error ? error.message : "write failed"}`);
  }
  try {
    sessionStorage.setItem(CURRENT_DESK_KEY, snapshot.deskToken);
    sessionStorage.setItem(sessionKey(snapshot.deskToken), payload);
    if (sessionStorage.getItem(sessionKey(snapshot.deskToken)) !== payload) {
      throw new Error("sessionStorage verification failed");
    }
    sessionOk = true;
  } catch (error) {
    errors.push(`Session storage: ${error instanceof Error ? error.message : "write failed"}`);
  }
  return { payload, errors, localOk, sessionOk };
}

let writeQueue: Promise<unknown> = Promise.resolve();
let latestWrite: Promise<PersistenceReport> = Promise.resolve({
  durable: false,
  localStorage: false,
  sessionStorage: false,
  indexedDb: false,
  backupFile: false,
  errors: [],
});

export function writeLocal(snapshot: DeskSnapshot, changedIds = Object.keys(snapshot.decisions)) {
  const browser = browserCopies(snapshot, changedIds);
  const run = writeQueue.then(async (): Promise<PersistenceReport> => {
    let indexedDb = false;
    let backupFile = false;
    const errors = [...browser.errors];
    try {
      await writeIdb(snapshot, changedIds);
      indexedDb = true;
    } catch (error) {
      errors.push(`IndexedDB: ${error instanceof Error ? error.message : "write failed"}`);
    }
    try {
      backupFile = await writeBoundFile(snapshot.deskToken, browser.payload);
    } catch (error) {
      errors.push(`Backup file: ${error instanceof Error ? error.message : "write failed"}`);
    }
    return {
      durable: browser.localOk || indexedDb || backupFile,
      localStorage: browser.localOk,
      sessionStorage: browser.sessionOk,
      indexedDb,
      backupFile,
      errors,
    };
  });
  writeQueue = run.catch(() => undefined);
  latestWrite = run;
  return run;
}

export function flushPendingLocalWrites() {
  return latestWrite;
}

export async function requestPersistentStorage() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

const channels = new Map<string, BroadcastChannel>();

function channelFor(token: string) {
  if (typeof BroadcastChannel === "undefined") return null;
  let channel = channels.get(token);
  if (!channel) {
    channel = new BroadcastChannel(`halmar-import-desk:${token}`);
    channels.set(token, channel);
  }
  return channel;
}

export function broadcastSnapshot(snapshot: DeskSnapshot) {
  channelFor(snapshot.deskToken)?.postMessage(snapshot);
}

export function subscribeToDesk(token: string, callback: (snapshot: DeskSnapshot) => void) {
  const channel = channelFor(token);
  const onMessage = (event: MessageEvent<unknown>) => {
    const parsed = parseSnapshot(event.data, token);
    if (parsed) callback(parsed);
  };
  channel?.addEventListener("message", onMessage);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== snapshotKey(token) && !event.key?.startsWith(journalPrefix(token))) return;
    const snapshot = readLocal(token);
    if (snapshot) callback(snapshot);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    channel?.removeEventListener("message", onMessage);
    window.removeEventListener("storage", onStorage);
  };
}

type ExportProduct = {
  id: string;
  ean: string;
  eanGtin?: string;
  eanInternal?: string;
  code: string;
  name: string;
  category: string;
  collection: string;
  stockStatus: string;
  stockLabel: string;
  deliveryDate: string;
  images: string[];
  description: string;
  pricePln?: string;
  priceEur?: string;
  priceListed?: boolean;
};

export function buildExportPayload(
  snapshot: DeskSnapshot,
  products: ExportProduct[],
  options: { requireComplete?: boolean } = {},
) {
  const knownIds = new Set(products.map((product) => product.id));
  const orphanedDecisionIds = Object.keys(snapshot.decisions).filter((id) => !knownIds.has(id));
  const duplicateIds = products
    .map((product) => product.eanGtin || product.ean || product.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  const toImport: Array<Record<string, string>> = [];
  const toSkip: Array<Record<string, string>> = [];
  const unmarked: Array<Record<string, string>> = [];
  const decisionsByEanGtin: Record<string, string> = {};
  const decisionsByEanInternal: Record<string, string> = {};
  const decisionsByCode: Record<string, string> = {};
  const rows = products.map((product) => {
    const decision = snapshot.decisions[product.id] ?? "unmarked";
    const eanGtin = product.eanGtin || product.ean || product.id;
    const eanInternal = product.eanInternal || "";
    const key = { eanGtin, eanInternal, code: product.code, name: product.name, decision };
    if (decision === "import") toImport.push(key);
    else if (decision === "reject") toSkip.push(key);
    else unmarked.push(key);
    decisionsByEanGtin[eanGtin] = decision;
    if (eanInternal) decisionsByEanInternal[eanInternal] = decision;
    if (product.code) decisionsByCode[product.code] = decision;
    return {
      id: product.id,
      eanGtin,
      eanInternal,
      ean: eanGtin,
      code: product.code,
      name: product.name,
      category: product.category,
      collection: product.collection,
      stock: product.stockLabel,
      stockStatus: product.stockStatus,
      deliveryDate: product.deliveryDate,
      pricePln: product.pricePln || "",
      priceEur: product.priceEur || "",
      priceListed: product.priceListed ? "yes" : "no",
      decision,
      images: product.images,
      description: product.description,
    };
  });
  const validationErrors = [
    ...(products.length === CATALOG_MANIFEST.uniqueProducts
      ? []
      : [`Expected ${CATALOG_MANIFEST.uniqueProducts} products, found ${products.length}.`]),
    ...(duplicateIds.length ? [`Duplicate primary GTIN identifiers: ${duplicateIds.join(", ")}`] : []),
    ...(orphanedDecisionIds.length
      ? [`Saved decisions no longer present in this catalog: ${orphanedDecisionIds.join(", ")}`]
      : []),
    ...(unmarked.length ? [`${unmarked.length} products are still unmarked.`] : []),
  ];
  if (options.requireComplete && validationErrors.length) {
    throw new Error(`Final export blocked: ${validationErrors.join(" ")}`);
  }
  const markedKnown = toImport.length + toSkip.length;
  return {
    format: "halmar-import-desk",
    formatVersion: 3,
    encoding: "utf-8",
    app: "halmar-import-desk",
    version: 2,
    finalized: validationErrors.length === 0,
    exportedAt: new Date().toISOString(),
    clientName: snapshot.clientName,
    note: snapshot.note,
    updatedAt: snapshot.updatedAt,
    cloud: {
      deskId: snapshot.serverDeskId,
      revision: snapshot.serverRevision,
      updatedAt: snapshot.serverUpdatedAt,
    },
    catalogFingerprint: CATALOG_FINGERPRINT,
    catalogFingerprintAlgorithm: CATALOG_MANIFEST.fingerprintAlgorithm,
    catalogUniqueProducts: CATALOG_MANIFEST.uniqueProducts,
    sourceManifest: CATALOG_MANIFEST,
    xmlSources: Object.fromEntries(CATALOG_MANIFEST.sources.map((source) => [source.role, source.url])),
    joinContract: {
      normalization: "No normalization. Compare exact strings.",
      orderedKeys: [
        { json: "eanGtin", xml: "ean_GTIN", priority: 1 },
        { json: "eanInternal", xml: "ean", priority: 2 },
        { json: "code", xml: "code", priority: 3 },
      ],
      catalogDuplicateResolution: {
        groupBy: "ean_GTIN",
        verifyEqualFields: ["ean", "code", "description", "nett_weight", "origin_country", "withdrawn"],
        selectProductRowWhere: "XML <name> exactly equals JSON product.name",
        explanation: "Halmar may repeat one GTIN in category-heading rows. They are one product, not separate products.",
      },
      stockDuplicateResolution: "Require one row per ean_GTIN and stop if duplicates disagree.",
      priceDuplicateResolution: "If rows repeat, require identical ean, code, price1, price2, and currencies before using one.",
      includeOnlyWhen: { field: "decision", equals: "import" },
      rejectWhen: { field: "decision", equals: "reject" },
      unmarkedPolicy: "Never import without explicit human review.",
      failClosed: true,
    },
    howToUseWithXml: [
      "This JSON is the client's final YES/NO list; the three source URLs and their canonical content hashes are in sourceManifest.",
      "Verify each contentSha256 using contentHashAlgorithm. The raw hash may change when Halmar only updates the root feed timestamp.",
      "If a canonical content hash changed, re-run the identity join and report the change instead of guessing.",
      "Every JSON product has a unique eanGtin. XML can repeat category-heading rows; apply catalogDuplicateResolution exactly.",
      "Include only decision=import. Never include reject or unmarked products.",
      "Use catalog XML for canonical content, stock XML for availability/delivery_date, and export XML for price1 PLN and price2 EUR.",
      "Stop with an error on an unmatched or ambiguous selected product.",
    ],
    validation: {
      readyForImport: validationErrors.length === 0,
      errors: validationErrors,
      duplicatePrimaryIds: duplicateIds,
      orphanedDecisionIds,
    },
    decisionValues: {
      import: "YES — include this product on the website",
      reject: "NO — do not import this product",
      unmarked: "Client has not decided yet — do not import",
    },
    counts: {
      totalProducts: products.length,
      marked: markedKnown,
      import: toImport.length,
      reject: toSkip.length,
      unmarked: unmarked.length,
      orphanedDecisions: orphanedDecisionIds.length,
    },
    totalProducts: products.length,
    marked: markedKnown,
    importCount: toImport.length,
    rejectCount: toSkip.length,
    unmarkedCount: unmarked.length,
    toImport,
    toSkip,
    unmarked,
    decisions: snapshot.decisions,
    decisionMeta: snapshot.decisionMeta,
    decisionsByEanGtin,
    decisionsByEanInternal,
    decisionsByCode,
    products: rows,
  };
}

export function deskShareUrl(token: string) {
  return `${window.location.origin}/work?category=all&page=1&q=#desk=${token}`;
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  triggerDownload(blob, filename);
}

export function downloadText(filename: string, text: string, mime: string) {
  triggerDownload(new Blob([text], { type: mime }), filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4_000);
}

export function csvEscape(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
