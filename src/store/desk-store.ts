import { create } from "zustand";
import {
  type DeskSnapshot,
  type Mark,
  bindBackupFile,
  boundBackupName,
  buildExportPayload,
  canBindBackupFile,
  csvEscape,
  downloadJson,
  downloadText,
  emptySnapshot,
  parseSnapshot,
  pickRicher,
  readIdb,
  readLocal,
  readSession,
  requestPersistentStorage,
  writeLocal,
} from "@/lib/persist";
import type { Product } from "@/lib/catalog";

type DeskState = DeskSnapshot & {
  hydrated: boolean;
  backupFile: string | null;
  lastAutoDownloadAt: number;
  hydrate: () => Promise<void>;
  setMark: (id: string, mark: Mark, products?: Product[] | null) => void;
  setClientName: (name: string) => void;
  setNote: (note: string) => void;
  connectBackupFile: () => Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  importSnapshot: (raw: unknown) => { ok: true; count: number } | { ok: false; error: string };
  exportDecisions: (products: Product[], kind?: "manual" | "auto") => void;
  exportCsv: (products: Product[], which: "import" | "reject" | "all") => void;
};

function persistNow(partial: Partial<DeskSnapshot>, current: DeskSnapshot): DeskSnapshot {
  const next: DeskSnapshot = {
    version: 1,
    app: "halmar-import-desk",
    updatedAt: Date.now(),
    clientName: partial.clientName ?? current.clientName,
    note: partial.note ?? current.note,
    decisions: partial.decisions ?? current.decisions,
  };
  writeLocal(next);
  return next;
}

function maybeAutoDownload(get: () => DeskState, products?: Product[]) {
  if (!products?.length) return;
  const state = get();
  const marked = Object.keys(state.decisions).length;
  if (marked === 0) return;
  const every = 50;
  const justHit = marked % every === 0;
  const finished = marked >= products.length;
  const cooled = Date.now() - state.lastAutoDownloadAt > 20_000;
  if ((justHit || finished) && cooled) {
    state.exportDecisions(products, "auto");
  }
}

export const useDesk = create<DeskState>((set, get) => ({
  ...emptySnapshot(),
  hydrated: false,
  backupFile: boundBackupName(),
  lastAutoDownloadAt: 0,
  hydrate: async () => {
    if (get().hydrated) return;
    await requestPersistentStorage();
    const local = readLocal();
    const session = readSession();
    const idb = await readIdb();
    const chosen = pickRicher(pickRicher(local, session), idb);
    if (chosen) {
      writeLocal(chosen);
      set({ ...chosen, hydrated: true, backupFile: boundBackupName() });
    } else {
      set({ hydrated: true });
    }
  },
  setMark: (id, mark, products) => {
    const cur = get();
    const decisions = { ...cur.decisions, [id]: mark };
    const next = persistNow({ decisions }, cur);
    set({ ...next, hydrated: true });
    maybeAutoDownload(get, products ?? undefined);
  },
  setClientName: (clientName) => {
    const next = persistNow({ clientName }, get());
    set({ ...next, hydrated: true });
  },
  setNote: (note) => {
    const next = persistNow({ note }, get());
    set({ ...next, hydrated: true });
  },
  connectBackupFile: async () => {
    if (!canBindBackupFile()) {
      return { ok: false, error: "This browser cannot lock a disk file. Use Download save instead." };
    }
    try {
      const name = await bindBackupFile();
      set({ backupFile: name });
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Could not lock a file." };
    }
  },
  importSnapshot: (raw) => {
    const parsed = parseSnapshot(raw);
    if (!parsed) return { ok: false, error: "This file is not a Halmar Import Desk backup." };
    writeLocal(parsed);
    set({ ...parsed, hydrated: true });
    return { ok: true, count: Object.keys(parsed.decisions).length };
  },
  exportDecisions: (products, kind = "manual") => {
    const snap = get();
    const payload = buildExportPayload(snap, products);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name =
      kind === "auto"
        ? `halmar-autosave-${stamp}.json`
        : `halmar-decisions-${stamp}.json`;
    downloadJson(name, payload);
    set({ lastAutoDownloadAt: Date.now() });
  },
  exportCsv: (products, which) => {
    const snap = get();
    const rows =
      which === "all"
        ? products
        : products.filter((p) => snap.decisions[p.id] === which);
    const header = [
      "decision",
      "ean",
      "eanGtin",
      "eanInternal",
      "code",
      "name",
      "category",
      "collection",
      "stock",
      "deliveryDate",
      "image",
      "description",
    ];
    const lines = [
      header.join(","),
      ...rows.map((p) =>
        [
          snap.decisions[p.id] ?? "unmarked",
          p.ean,
          p.eanGtin ?? p.ean,
          p.eanInternal ?? "",
          p.code,
          p.name,
          p.category,
          p.collection,
          p.stockLabel,
          p.deliveryDate,
          p.images[0] ?? "",
          p.description.replace(/\s+/g, " "),
        ]
          .map(csvEscape)
          .join(","),
      ),
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(
      `halmar-${which}-${stamp}.csv`,
      "\uFEFF" + lines.join("\n"),
      "text/csv;charset=utf-8",
    );
  },
}));
