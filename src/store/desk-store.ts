import { create } from "zustand";
import { CATALOG_FINGERPRINT } from "@/lib/catalog-integrity";
import {
  loadDeskProgress,
  saveDeskProgress,
  type CloudDeskSnapshot,
} from "@/lib/cloud-progress";
import {
  type DeskSnapshot,
  type Mark,
  bindBackupFile,
  boundBackupName,
  broadcastSnapshot,
  buildExportPayload,
  canBindBackupFile,
  csvEscape,
  deskShareUrl,
  downloadJson,
  downloadText,
  emptySnapshot,
  flushPendingLocalWrites,
  mergeSnapshots,
  parseSnapshot,
  readIdb,
  readLegacyLocal,
  readLocal,
  readSession,
  requestPersistentStorage,
  resolveDeskToken,
  restoreBoundBackup,
  subscribeToDesk,
  writeLocal,
} from "@/lib/persist";
import type { Product } from "@/lib/catalog";
import { compareDecisionMeta } from "@/lib/progress-model";

type SaveStatus = "loading" | "saving" | "saved" | "error";
type CloudStatus = "loading" | "ready" | "syncing" | "synced" | "error";
type ActionResult = { ok: true; revision: number } | { ok: false; error: string };

type DeskState = DeskSnapshot & {
  hydrated: boolean;
  backupFile: string | null;
  localStatus: SaveStatus;
  localError: string | null;
  cloudStatus: CloudStatus;
  cloudError: string | null;
  cloudDirty: boolean;
  checkpointing: boolean;
  persistentStorage: boolean;
  hydrate: () => Promise<void>;
  setMark: (id: string, mark: Mark, products?: Product[] | null) => void;
  setClientName: (name: string) => void;
  setNote: (note: string) => void;
  connectBackupFile: () => Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  importSnapshot: (raw: unknown) => { ok: true; count: number } | { ok: false; error: string };
  exportDecisions: (products: Product[], kind?: "manual" | "auto" | "page") => void;
  finalizeAndExport: (products: Product[]) => Promise<ActionResult>;
  checkpointPage: () => Promise<ActionResult>;
  exportCsv: (products: Product[], which: "import" | "reject" | "all") => void;
  shareUrl: () => string;
};

let writerId = "";
let unsubscribeDesk: (() => void) | null = null;

function getWriterId() {
  if (!writerId) {
    writerId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return writerId;
}

function snapshotOf(state: DeskState): DeskSnapshot {
  return {
    version: 2,
    app: "halmar-import-desk",
    deskToken: state.deskToken,
    updatedAt: state.updatedAt,
    detailsUpdatedAt: state.detailsUpdatedAt,
    detailsWriter: state.detailsWriter,
    clientName: state.clientName,
    note: state.note,
    decisions: state.decisions,
    decisionMeta: state.decisionMeta,
    serverRevision: state.serverRevision,
    serverUpdatedAt: state.serverUpdatedAt,
    serverDeskId: state.serverDeskId,
  };
}

function fromCloud(cloud: CloudDeskSnapshot, deskToken: string): DeskSnapshot {
  return {
    version: 2,
    app: "halmar-import-desk",
    deskToken,
    updatedAt: cloud.updatedAt,
    detailsUpdatedAt: cloud.detailsUpdatedAt,
    detailsWriter: cloud.detailsWriter,
    clientName: cloud.clientName,
    note: cloud.note,
    decisions: cloud.decisions,
    decisionMeta: cloud.decisionMeta,
    serverRevision: cloud.revision,
    serverUpdatedAt: cloud.updatedAt,
    serverDeskId: cloud.deskId,
  };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function safeFilePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function hasUserData(snapshot: DeskSnapshot) {
  return Boolean(
    Object.keys(snapshot.decisions).length || snapshot.clientName.trim() || snapshot.note.trim(),
  );
}

function cloudCovers(snapshot: DeskSnapshot, cloud: CloudDeskSnapshot) {
  if (cloud.catalogFingerprint !== CATALOG_FINGERPRINT) return false;
  for (const [id, mark] of Object.entries(snapshot.decisions)) {
    const localMeta = snapshot.decisionMeta[id];
    const cloudMeta = cloud.decisionMeta[id];
    if (!localMeta || !cloudMeta || !cloud.decisions[id]) return false;
    const comparison = compareDecisionMeta(cloudMeta, localMeta);
    if (comparison < 0 || (comparison === 0 && cloud.decisions[id] !== mark)) return false;
  }
  return (
    cloud.detailsUpdatedAt > snapshot.detailsUpdatedAt ||
    (cloud.detailsUpdatedAt === snapshot.detailsUpdatedAt &&
      cloud.detailsWriter.localeCompare(snapshot.detailsWriter) >= 0)
  );
}

function sameUserData(a: DeskSnapshot, b: DeskSnapshot) {
  if (
    a.detailsUpdatedAt !== b.detailsUpdatedAt ||
    a.detailsWriter !== b.detailsWriter ||
    a.clientName !== b.clientName ||
    a.note !== b.note
  ) return false;
  const ids = Object.keys(a.decisions);
  if (ids.length !== Object.keys(b.decisions).length) return false;
  return ids.every((id) =>
    a.decisions[id] === b.decisions[id] &&
    a.decisionMeta[id]?.updatedAt === b.decisionMeta[id]?.updatedAt &&
    a.decisionMeta[id]?.writer === b.decisionMeta[id]?.writer
  );
}

export const useDesk = create<DeskState>((set, get) => {
  const observeWrite = (snapshot: DeskSnapshot, changedIds?: string[]) => {
    set({ localStatus: "saving", localError: null });
    void writeLocal(snapshot, changedIds).then((report) => {
      const stillCurrent =
        get().deskToken === snapshot.deskToken && get().updatedAt === snapshot.updatedAt;
      if (!stillCurrent) return;
      if (report.durable) {
        set({
          localStatus: "saved",
          localError: report.errors.length ? report.errors.join(" · ") : null,
          backupFile: boundBackupName(snapshot.deskToken),
        });
      } else {
        const message = report.errors.join(" · ") || "No durable browser storage accepted the save.";
        set({ localStatus: "error", localError: message });
        if (get().cloudStatus !== "syncing") void get().checkpointPage();
      }
    });
  };

  const commit = (
    snapshot: DeskSnapshot,
    changedIds?: string[],
    broadcast = true,
    cloudDirty = true,
  ) => {
    set({ ...snapshot, hydrated: true, cloudDirty });
    observeWrite(snapshot, changedIds);
    if (broadcast) broadcastSnapshot(snapshot);
  };

  let activeCheckpoint: Promise<ActionResult> | null = null;

  const runCheckpoint = async (): Promise<ActionResult> => {
    set({ checkpointing: true, cloudStatus: "syncing", cloudError: null });
    try {
      let lastRevision = get().serverRevision;
      for (let catchup = 0; catchup < 5; catchup += 1) {
        await flushPendingLocalWrites();
        const snapshot = snapshotOf(get());
        const checkpointId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const cloud = await saveDeskProgress({
          data: {
            deskToken: snapshot.deskToken,
            checkpointId,
            updatedAt: snapshot.updatedAt,
            detailsUpdatedAt: snapshot.detailsUpdatedAt,
            detailsWriter: snapshot.detailsWriter || getWriterId(),
            clientName: snapshot.clientName,
            note: snapshot.note,
            catalogFingerprint: CATALOG_FINGERPRINT,
            decisions: snapshot.decisions,
            decisionMeta: snapshot.decisionMeta,
          },
        });
        lastRevision = cloud.revision;
        const cloudSnapshot = fromCloud(cloud, snapshot.deskToken);
        const returnedMerge = mergeSnapshots(snapshotOf(get()), cloudSnapshot);
        if (!returnedMerge) throw new Error("Cloud returned an invalid checkpoint.");
        const localReport = await writeLocal(returnedMerge, []);

        // A mark can be made while a network request or IndexedDB transaction
        // is finishing. Merge once more before touching store state so an older
        // checkpoint response can never roll that mark back.
        const latest = snapshotOf(get());
        const merged = mergeSnapshots(latest, returnedMerge);
        if (!merged) throw new Error("Could not merge the confirmed checkpoint.");
        const dirty = !cloudCovers(merged, cloud);
        const reportCoversLatest = sameUserData(merged, returnedMerge);
        const currentStatus = get();
        set({
          ...merged,
          cloudDirty: dirty,
          cloudStatus: "synced",
          cloudError: null,
          ...(reportCoversLatest
            ? {
                localStatus: localReport.durable ? "saved" : "error",
                localError: localReport.errors.length ? localReport.errors.join(" · ") : null,
                backupFile: boundBackupName(merged.deskToken),
              }
            : {
                localStatus: currentStatus.localStatus,
                localError: currentStatus.localError,
                backupFile: currentStatus.backupFile,
              }),
        });
        broadcastSnapshot(merged);
        if (!dirty) {
          set({ checkpointing: false });
          return { ok: true, revision: cloud.revision };
        }
      }
      throw new Error(
        `New changes kept arriving while cloud revision ${lastRevision} was saving. Please press Next again.`,
      );
    } catch (error) {
      const message = errorMessage(error, "Cloud checkpoint failed.");
      set({ checkpointing: false, cloudStatus: "error", cloudError: message, cloudDirty: true });
      return { ok: false, error: message };
    }
  };

  const checkpoint = () => {
    if (activeCheckpoint) return activeCheckpoint;
    activeCheckpoint = runCheckpoint().finally(() => {
      activeCheckpoint = null;
    });
    return activeCheckpoint;
  };

  const initial: DeskState = {
    ...emptySnapshot(),
    hydrated: false,
    backupFile: null,
    localStatus: "loading",
    localError: null,
    cloudStatus: "loading",
    cloudError: null,
    cloudDirty: false,
    checkpointing: false,
    persistentStorage: false,

    hydrate: async () => {
      if (get().hydrated || get().deskToken) return;
      const { token, fromLink } = resolveDeskToken();
      set({ deskToken: token, cloudStatus: "loading", localStatus: "loading" });
      const persistentStorage = await requestPersistentStorage();
      const [idb, backupFile] = await Promise.all([
        readIdb(token, !fromLink),
        restoreBoundBackup(token),
      ]);
      const sources = [
        readLocal(token),
        readSession(token),
        idb,
        ...(!fromLink ? [readLegacyLocal(token)] : []),
      ];
      let chosen: DeskSnapshot | null = emptySnapshot(token);
      for (const source of sources) chosen = mergeSnapshots(chosen, source);
      chosen = chosen ?? emptySnapshot(token);
      set({
        ...chosen,
        hydrated: true,
        backupFile,
        persistentStorage,
        localStatus: "saving",
        cloudStatus: "syncing",
        cloudError: null,
        cloudDirty: hasUserData(chosen),
      });
      observeWrite(chosen);

      unsubscribeDesk?.();
      unsubscribeDesk = subscribeToDesk(token, (incoming) => {
        const current = snapshotOf(get());
        const merged = mergeSnapshots(current, incoming);
        if (!merged) return;
        const changed =
          merged.updatedAt !== current.updatedAt ||
          Object.keys(merged.decisions).length !== Object.keys(current.decisions).length ||
          Object.entries(merged.decisions).some(([id, mark]) => current.decisions[id] !== mark);
        if (changed) commit(merged, undefined, false, true);
      });

      try {
        const cloud = await loadDeskProgress({ data: { deskToken: token } });
        if (cloud) {
          const merged = mergeSnapshots(snapshotOf(get()), fromCloud(cloud, token));
          if (merged) {
            set({
              ...merged,
              cloudStatus: "synced",
              cloudError: null,
              cloudDirty: !cloudCovers(merged, cloud),
            });
            observeWrite(merged);
          }
        } else {
          set({
            cloudStatus: "ready",
            cloudError: null,
            cloudDirty: hasUserData(snapshotOf(get())),
          });
        }
      } catch (error) {
        set({
          cloudStatus: "error",
          cloudError: errorMessage(error, "Could not load cloud checkpoint."),
          cloudDirty: hasUserData(snapshotOf(get())),
        });
      }
    },

    setMark: (id, mark) => {
      const current = snapshotOf(get());
      const disk = current.deskToken ? readLocal(current.deskToken) : null;
      const base = mergeSnapshots(current, disk) ?? current;
      const stamp = Math.max(Date.now(), base.updatedAt + 1);
      const next: DeskSnapshot = {
        ...base,
        updatedAt: stamp,
        decisions: { ...base.decisions, [id]: mark },
        decisionMeta: {
          ...base.decisionMeta,
          [id]: { updatedAt: stamp, writer: getWriterId() },
        },
      };
      commit(next, [id]);
    },

    setClientName: (clientName) => {
      const current = snapshotOf(get());
      const stamp = Math.max(Date.now(), current.updatedAt + 1);
      commit({
        ...current,
        updatedAt: stamp,
        detailsUpdatedAt: stamp,
        detailsWriter: getWriterId(),
        clientName,
      }, []);
    },

    setNote: (note) => {
      const current = snapshotOf(get());
      const stamp = Math.max(Date.now(), current.updatedAt + 1);
      commit({
        ...current,
        updatedAt: stamp,
        detailsUpdatedAt: stamp,
        detailsWriter: getWriterId(),
        note,
      }, []);
    },

    connectBackupFile: async () => {
      if (!canBindBackupFile()) {
        return { ok: false, error: "This browser cannot keep a live disk file. Use Download backup instead." };
      }
      try {
        const name = await bindBackupFile(snapshotOf(get()));
        set({ backupFile: name, localError: null });
        return { ok: true, name };
      } catch (error) {
        const message = errorMessage(error, "Could not connect the backup file.");
        set({ backupFile: null, localError: `Backup file: ${message}` });
        return { ok: false, error: message };
      }
    },

    importSnapshot: (raw) => {
      const current = snapshotOf(get());
      const parsed = parseSnapshot(raw, current.deskToken);
      if (!parsed) return { ok: false, error: "This file is not a Halmar Import Desk backup." };
      const stamp = Math.max(Date.now(), current.updatedAt + 1);
      const writer = getWriterId();
      const decisions = { ...current.decisions };
      const decisionMeta = { ...current.decisionMeta };
      for (const [id, mark] of Object.entries(parsed.decisions)) {
        decisions[id] = mark;
        decisionMeta[id] = { updatedAt: stamp, writer };
      }
      const next: DeskSnapshot = {
        ...current,
        updatedAt: stamp,
        detailsUpdatedAt: stamp,
        detailsWriter: writer,
        clientName: parsed.clientName,
        note: parsed.note,
        decisions,
        decisionMeta,
      };
      commit(next);
      return { ok: true, count: Object.keys(parsed.decisions).length };
    },

    exportDecisions: (products) => {
      const snapshot = snapshotOf(get());
      observeWrite(snapshot, []);
      const payload = buildExportPayload(snapshot, products);
      const day = new Date().toISOString().slice(0, 10);
      const client = safeFilePart(snapshot.clientName) || "client";
      downloadJson(
        `halmar-progress-${client}-${day}-r${snapshot.serverRevision}-${Object.keys(snapshot.decisions).length}.json`,
        payload,
      );
    },

    checkpointPage: checkpoint,

    finalizeAndExport: async (products) => {
      const unmarked = products.filter((product) => !get().decisions[product.id]).length;
      if (unmarked) return { ok: false, error: `${unmarked} products are still unmarked.` };
      const checkpoint = await get().checkpointPage();
      if (!checkpoint.ok) return checkpoint;
      try {
        const snapshot = snapshotOf(get());
        const payload = buildExportPayload(snapshot, products, { requireComplete: true });
        const day = new Date().toISOString().slice(0, 10);
        const client = safeFilePart(snapshot.clientName) || "client";
        downloadJson(`halmar-FINAL-${client}-${day}-r${snapshot.serverRevision}.json`, payload);
        return { ok: true, revision: snapshot.serverRevision };
      } catch (error) {
        return { ok: false, error: errorMessage(error, "Final export validation failed.") };
      }
    },

    exportCsv: (products, which) => {
      const snapshot = snapshotOf(get());
      const rows = which === "all" ? products : products.filter((product) => snapshot.decisions[product.id] === which);
      const header = [
        "decision", "ean", "eanGtin", "eanInternal", "code", "name", "category", "collection",
        "stock", "deliveryDate", "pricePln", "priceEur", "image", "description",
      ];
      const lines = [
        header.join(","),
        ...rows.map((product) =>
          [
            snapshot.decisions[product.id] ?? "unmarked",
            product.ean,
            product.eanGtin ?? product.ean,
            product.eanInternal ?? "",
            product.code,
            product.name,
            product.category,
            product.collection,
            product.stockLabel,
            product.deliveryDate,
            product.pricePln ?? "",
            product.priceEur ?? "",
            product.images[0] ?? "",
            product.description.replace(/\s+/g, " "),
          ].map(csvEscape).join(","),
        ),
      ];
      downloadText(`halmar-${which}-${new Date().toISOString().slice(0, 10)}.csv`, `\uFEFF${lines.join("\n")}`, "text/csv;charset=utf-8");
    },

    shareUrl: () => deskShareUrl(get().deskToken),
  };

  return initial;
});
