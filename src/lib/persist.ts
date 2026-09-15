export type Mark = "import" | "reject";

export type DeskSnapshot = {
  version: 1;
  app: "halmar-import-desk";
  updatedAt: number;
  clientName: string;
  note: string;
  decisions: Record<string, Mark>;
};

export const STORAGE_KEY = "halmar-import-desk-v1";
const IDB_NAME = "halmar-import-desk";
const IDB_STORE = "kv";
const SESSION_KEY = "halmar-import-desk-session";

export function emptySnapshot(): DeskSnapshot {
  return {
    version: 1,
    app: "halmar-import-desk",
    updatedAt: 0,
    clientName: "",
    note: "",
    decisions: {},
  };
}

export function isMark(v: unknown): v is Mark {
  return v === "import" || v === "reject";
}

export function parseSnapshot(raw: unknown): DeskSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.app !== "halmar-import-desk") return null;
  const decisions: Record<string, Mark> = {};
  if (o.decisions && typeof o.decisions === "object") {
    for (const [k, v] of Object.entries(o.decisions as Record<string, unknown>)) {
      if (isMark(v) && k) decisions[k] = v;
    }
  }
  if (Object.keys(decisions).length === 0 && Array.isArray(o.products)) {
    for (const row of o.products as Array<Record<string, unknown>>) {
      if (row && typeof row.id === "string" && isMark(row.decision)) {
        decisions[row.id] = row.decision;
      }
    }
  }
  if (Object.keys(decisions).length === 0 && o.decisionsByEanGtin && typeof o.decisionsByEanGtin === "object") {
    for (const [k, v] of Object.entries(o.decisionsByEanGtin as Record<string, unknown>)) {
      if (isMark(v) && k) decisions[k] = v;
    }
  }
  return {
    version: 1,
    app: "halmar-import-desk",
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
    clientName: typeof o.clientName === "string" ? o.clientName : "",
    note: typeof o.note === "string" ? o.note : "",
    decisions,
  };
}

export function readLocal(): DeskSnapshot | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parseSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readSession(): DeskSnapshot | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return parseSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeLocal(snap: DeskSnapshot) {
  if (typeof localStorage === "undefined") return;
  const payload = JSON.stringify(snap);
  try {
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    /* quota */
  }
  try {
    sessionStorage.setItem(SESSION_KEY, payload);
  } catch {
    /* quota */
  }
  void writeIdb(payload);
  void writeBoundFile(payload);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeIdb(payload: string) {
  try {
    if (typeof indexedDB === "undefined") return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(payload, STORAGE_KEY);
      tx.objectStore(IDB_STORE).put(payload, `${STORAGE_KEY}-bak`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* localStorage is the primary copy */
  }
}

export async function readIdb(): Promise<DeskSnapshot | null> {
  try {
    if (typeof indexedDB === "undefined") return null;
    const db = await openDb();
    const load = (key: string) =>
      new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const raw = (await load(STORAGE_KEY)) ?? (await load(`${STORAGE_KEY}-bak`));
    db.close();
    if (typeof raw === "string") return parseSnapshot(JSON.parse(raw));
    return parseSnapshot(raw);
  } catch {
    return null;
  }
}

export function pickRicher(a: DeskSnapshot | null, b: DeskSnapshot | null): DeskSnapshot | null {
  if (!a) return b;
  if (!b) return a;
  const ac = Object.keys(a.decisions).length;
  const bc = Object.keys(b.decisions).length;
  if (bc !== ac) return bc > ac ? b : a;
  return b.updatedAt > a.updatedAt ? b : a;
}

export async function requestPersistentStorage() {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* optional */
  }
}

type FileHandle = {
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
};

let boundHandle: FileHandle | null = null;
let boundName: string | null = null;
let lastBoundWrite = "";

export function boundBackupName() {
  return boundName;
}

export function canBindBackupFile() {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

export async function bindBackupFile(): Promise<string> {
  const picker = (window as unknown as {
    showSaveFilePicker: (opts: unknown) => Promise<FileHandle & { name?: string }>;
  }).showSaveFilePicker;
  const handle = await picker({
    suggestedName: "halmar-import-desk-SAVE.json",
    types: [
      {
        description: "Halmar decisions",
        accept: { "application/json": [".json"] },
      },
    ],
  });
  boundHandle = handle;
  boundName = handle.name ?? "halmar-import-desk-SAVE.json";
  const existing = readLocal();
  if (existing) await writeBoundFile(JSON.stringify(existing));
  return boundName;
}

async function writeBoundFile(payload: string) {
  if (!boundHandle || payload === lastBoundWrite) return;
  lastBoundWrite = payload;
  try {
    const writable = await boundHandle.createWritable();
    await writable.write(payload);
    await writable.close();
  } catch {
    /* user may have revoked; download still works */
  }
}

export function buildExportPayload(
  snap: DeskSnapshot,
  products: Array<{
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
  }>,
) {
  const toImport: Array<Record<string, string>> = [];
  const toSkip: Array<Record<string, string>> = [];
  const unmarked: Array<Record<string, string>> = [];
  const decisionsByEanGtin: Record<string, string> = {};
  const decisionsByEanInternal: Record<string, string> = {};
  const decisionsByCode: Record<string, string> = {};
  const rows = products.map((p) => {
    const decision = snap.decisions[p.id] ?? "unmarked";
    const eanGtin = p.eanGtin || p.ean || p.id;
    const eanInternal = p.eanInternal || "";
    const row = {
      id: p.id,
      eanGtin,
      eanInternal,
      ean: eanGtin,
      code: p.code,
      name: p.name,
      category: p.category,
      collection: p.collection,
      stock: p.stockLabel,
      stockStatus: p.stockStatus,
      deliveryDate: p.deliveryDate,
      decision,
      image: p.images[0] ?? "",
    };
    const key = {
      eanGtin,
      eanInternal,
      code: p.code,
      name: p.name,
      decision,
    };
    if (decision === "import") toImport.push(key);
    else if (decision === "reject") toSkip.push(key);
    else unmarked.push(key);
    if (eanGtin) decisionsByEanGtin[eanGtin] = decision;
    if (eanInternal) decisionsByEanInternal[eanInternal] = decision;
    if (p.code) decisionsByCode[p.code] = decision;
    return row;
  });
  return {
    format: "halmar-import-desk",
    formatVersion: 2,
    encoding: "utf-8",
    app: "halmar-import-desk",
    version: 1,
    exportedAt: new Date().toISOString(),
    clientName: snap.clientName,
    note: snap.note,
    updatedAt: snap.updatedAt,
    catalogFingerprint: "9ce230cf2d17841376c1f106c49da72cc6013ad04a4176fcd3fc379c50b788a6",
    catalogUniqueProducts: 3367,
    xmlSources: {
      catalogEnglish: "https://integration.halmar.pl/halmar_catalog_en.xml",
      catalogPolish: "https://integration.halmar.pl/halmar_catalog_pl.xml",
      stock: "https://integration.halmar.pl/halmar_stock.xml",
    },
    howToUseWithXml: [
      "This JSON is the client's YES/NO list. The Halmar XML is the product catalog (photos, descriptions, prices).",
      "Do not guess. Join records in this exact order of keys:",
      "1) JSON eanGtin === XML <ean_GTIN>",
      "2) else JSON eanInternal === XML <ean>",
      "3) else JSON code === XML <code> (exact, case-sensitive)",
      "Put on the website ONLY items whose decision is the exact string \"import\". Also listed in toImport.",
      "Do NOT put on the website items whose decision is the exact string \"reject\". Also listed in toSkip.",
      "\"unmarked\" means the client has not decided — do not import those unless told otherwise.",
      "Use XML for all product content. Use this file only to filter which SKUs to keep.",
      "All 3367 unique catalog products are listed in products[]. counts.totalProducts must equal that list length.",
    ],
    decisionValues: {
      import: "YES — include this product on the website",
      reject: "NO — do not import this product",
      unmarked: "Client has not decided yet — do not import",
    },
    counts: {
      totalProducts: products.length,
      marked: Object.keys(snap.decisions).length,
      import: toImport.length,
      reject: toSkip.length,
      unmarked: unmarked.length,
    },
    totalProducts: products.length,
    marked: Object.keys(snap.decisions).length,
    importCount: toImport.length,
    rejectCount: toSkip.length,
    unmarkedCount: unmarked.length,
    toImport,
    toSkip,
    unmarked,
    decisions: snap.decisions,
    decisionsByEanGtin,
    decisionsByEanInternal,
    decisionsByCode,
    products: rows,
  };
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  triggerDownload(blob, filename);
}

export function downloadText(filename: string, text: string, mime: string) {
  triggerDownload(new Blob([text], { type: mime }), filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function csvEscape(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
