import { createServerFn } from "@tanstack/react-start";
import {
  isMark,
  mergeDecisionState,
  type DecisionMeta,
  type Mark,
} from "./progress-model";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const MAX_PRODUCTS = 4_000;
const MAX_CHECKPOINT_IDS = 500;

export type CloudDeskSnapshot = {
  format: "halmar-import-desk-progress";
  version: 1;
  deskId: string;
  revision: number;
  updatedAt: number;
  detailsUpdatedAt: number;
  detailsWriter: string;
  clientName: string;
  note: string;
  catalogFingerprint: string;
  decisions: Record<string, Mark>;
  decisionMeta: Record<string, DecisionMeta>;
  appliedCheckpointIds: string[];
};

export type SaveDeskInput = {
  deskToken: string;
  checkpointId: string;
  updatedAt: number;
  detailsUpdatedAt: number;
  detailsWriter: string;
  clientName: string;
  note: string;
  catalogFingerprint: string;
  decisions: Record<string, Mark>;
  decisionMeta: Record<string, DecisionMeta>;
};

function cleanTokenInput(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid desk request.");
  const deskToken = (raw as Record<string, unknown>).deskToken;
  if (typeof deskToken !== "string" || !TOKEN_RE.test(deskToken)) {
    throw new Error("Invalid private desk link.");
  }
  return { deskToken };
}

function cleanSaveInput(raw: unknown): SaveDeskInput {
  const o = raw as Record<string, unknown>;
  const { deskToken } = cleanTokenInput(raw);
  if (typeof o.checkpointId !== "string" || !/^[A-Za-z0-9-]{16,80}$/.test(o.checkpointId)) {
    throw new Error("Invalid checkpoint identifier.");
  }
  if (typeof o.catalogFingerprint !== "string" || !FINGERPRINT_RE.test(o.catalogFingerprint)) {
    throw new Error("Invalid catalog fingerprint.");
  }
  const updatedAt = Number(o.updatedAt);
  const detailsUpdatedAt = Number(o.detailsUpdatedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(detailsUpdatedAt)) {
    throw new Error("Invalid checkpoint time.");
  }
  const detailsWriter = typeof o.detailsWriter === "string" ? o.detailsWriter.slice(0, 100) : "";
  const clientName = typeof o.clientName === "string" ? o.clientName.slice(0, 200) : "";
  const note = typeof o.note === "string" ? o.note.slice(0, 5_000) : "";
  const rawDecisions = o.decisions;
  const rawMeta = o.decisionMeta;
  if (!rawDecisions || typeof rawDecisions !== "object" || Array.isArray(rawDecisions)) {
    throw new Error("Invalid decisions.");
  }
  if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
    throw new Error("Invalid decision metadata.");
  }
  const entries = Object.entries(rawDecisions as Record<string, unknown>);
  if (entries.length > MAX_PRODUCTS) throw new Error("Too many product decisions.");
  const decisions: Record<string, Mark> = {};
  const decisionMeta: Record<string, DecisionMeta> = {};
  for (const [id, value] of entries) {
    if (!/^[0-9]{8,20}$/.test(id) || !isMark(value)) throw new Error("Invalid product decision.");
    const meta = (rawMeta as Record<string, unknown>)[id];
    if (!meta || typeof meta !== "object") throw new Error("Missing decision metadata.");
    const m = meta as Record<string, unknown>;
    const stamp = Number(m.updatedAt);
    const writer = typeof m.writer === "string" ? m.writer.slice(0, 100) : "";
    if (!Number.isFinite(stamp) || stamp < 1 || !writer) throw new Error("Invalid decision metadata.");
    decisions[id] = value;
    decisionMeta[id] = { updatedAt: stamp, writer };
  }
  return {
    deskToken,
    checkpointId: o.checkpointId,
    updatedAt,
    detailsUpdatedAt,
    detailsWriter,
    clientName,
    note,
    catalogFingerprint: o.catalogFingerprint,
    decisions,
    decisionMeta,
  };
}

async function deskLocation(token: string) {
  const { createHash } = await import("node:crypto");
  const deskId = createHash("sha256").update(token).digest("hex");
  return {
    deskId,
    pathname: `desks/${deskId}.json`,
    backupPathname: `desks/${deskId}.previous.json`,
  };
}

function validCloudSnapshot(raw: unknown, deskId: string): CloudDeskSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.format !== "halmar-import-desk-progress" || o.version !== 1 || o.deskId !== deskId) {
    return null;
  }
  const decisions: Record<string, Mark> = {};
  const decisionMeta: Record<string, DecisionMeta> = {};
  if (!o.decisions || typeof o.decisions !== "object" || Array.isArray(o.decisions)) return null;
  if (!o.decisionMeta || typeof o.decisionMeta !== "object" || Array.isArray(o.decisionMeta)) return null;
  const entries = Object.entries(o.decisions as Record<string, unknown>);
  if (entries.length > MAX_PRODUCTS) return null;
  const meta = o.decisionMeta as Record<string, unknown>;
  for (const [id, value] of entries) {
    if (!/^[0-9]{8,20}$/.test(id) || !isMark(value)) return null;
    const item = meta[id] as Record<string, unknown> | undefined;
    const stamp = Number(item?.updatedAt);
    const writer = typeof item?.writer === "string" ? item.writer : "";
    if (!Number.isFinite(stamp) || stamp < 1 || !writer) return null;
    decisions[id] = value;
    decisionMeta[id] = {
      updatedAt: stamp,
      writer,
    };
  }
  return {
    format: "halmar-import-desk-progress",
    version: 1,
    deskId,
    revision: Math.max(0, Number(o.revision) || 0),
    updatedAt: Math.max(0, Number(o.updatedAt) || 0),
    detailsUpdatedAt: Math.max(0, Number(o.detailsUpdatedAt) || 0),
    detailsWriter: typeof o.detailsWriter === "string" ? o.detailsWriter : "cloud-legacy",
    clientName: typeof o.clientName === "string" ? o.clientName : "",
    note: typeof o.note === "string" ? o.note : "",
    catalogFingerprint: typeof o.catalogFingerprint === "string" ? o.catalogFingerprint : "",
    decisions,
    decisionMeta,
    appliedCheckpointIds: Array.isArray(o.appliedCheckpointIds)
      ? o.appliedCheckpointIds.filter((v): v is string => typeof v === "string").slice(-MAX_CHECKPOINT_IDS)
      : [],
  };
}

async function readBlob(pathname: string) {
  const { get } = await import("@vercel/blob");
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  // Private `get()` responses use a weak HTTP validator (`W/"…"`) while the
  // conditional Blob API requires the equivalent strong ETag (`"…"`). The
  // opaque value is unchanged; only the weak-response prefix is removed.
  return {
    text: await new Response(result.stream).text(),
    etag: result.blob.etag.replace(/^W\//, ""),
  };
}

function decodeCloud(text: string, deskId: string) {
  try {
    return validCloudSnapshot(JSON.parse(text), deskId);
  } catch {
    return null;
  }
}

async function readCloud(pathname: string, backupPathname: string, deskId: string) {
  const primary = await readBlob(pathname);
  if (primary) {
    const snapshot = decodeCloud(primary.text, deskId);
    if (snapshot) {
      return {
        snapshot,
        etag: primary.etag,
        primaryExists: true,
        recoveredFromBackup: false,
      };
    }
  }

  const backup = await readBlob(backupPathname);
  if (backup) {
    const snapshot = decodeCloud(backup.text, deskId);
    if (snapshot) {
      return {
        snapshot,
        etag: primary?.etag ?? null,
        primaryExists: Boolean(primary),
        recoveredFromBackup: true,
      };
    }
  }
  if (primary || backup) throw new Error("The cloud checkpoint and its rolling backup are invalid.");
  return null;
}

export const loadDeskProgress = createServerFn({ method: "POST" })
  .validator(cleanTokenInput)
  .handler(async ({ data }) => {
    const { deskId, pathname, backupPathname } = await deskLocation(data.deskToken);
    const found = await readCloud(pathname, backupPathname, deskId);
    return found?.snapshot ?? null;
  });

export const saveDeskProgress = createServerFn({ method: "POST" })
  .validator(cleanSaveInput)
  .handler(async ({ data }) => {
    const { BlobPreconditionFailedError, put } = await import("@vercel/blob");
    const { deskId, pathname, backupPathname } = await deskLocation(data.deskToken);

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const found = await readCloud(pathname, backupPathname, deskId);
      if (found?.snapshot.appliedCheckpointIds.includes(data.checkpointId)) {
        await put(backupPathname, JSON.stringify(found.snapshot), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/json;charset=utf-8",
          cacheControlMaxAge: 60,
        });
        return found.snapshot;
      }

      const current = found?.snapshot;
      const merged = mergeDecisionState(
        current ?? { decisions: {}, decisionMeta: {} },
        { decisions: data.decisions, decisionMeta: data.decisionMeta },
      );
      const incomingDetailsAreNewer =
        !current ||
        data.detailsUpdatedAt > current.detailsUpdatedAt ||
        (data.detailsUpdatedAt === current.detailsUpdatedAt &&
          data.detailsWriter.localeCompare(current.detailsWriter) > 0);
      const next: CloudDeskSnapshot = {
        format: "halmar-import-desk-progress",
        version: 1,
        deskId,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: Math.max(current?.updatedAt ?? 0, data.updatedAt, Date.now()),
        detailsUpdatedAt: incomingDetailsAreNewer
          ? data.detailsUpdatedAt
          : (current?.detailsUpdatedAt ?? 0),
        detailsWriter: incomingDetailsAreNewer
          ? data.detailsWriter
          : (current?.detailsWriter ?? ""),
        clientName: incomingDetailsAreNewer ? data.clientName : (current?.clientName ?? ""),
        note: incomingDetailsAreNewer ? data.note : (current?.note ?? ""),
        catalogFingerprint: data.catalogFingerprint,
        decisions: merged.decisions,
        decisionMeta: merged.decisionMeta,
        appliedCheckpointIds: [
          ...(current?.appliedCheckpointIds ?? []),
          data.checkpointId,
        ].slice(-MAX_CHECKPOINT_IDS),
      };

      try {
        if (found) {
          // Preserve the last known-good server revision before conditionally
          // replacing the primary Blob. A corrupt primary can recover from it.
          await put(backupPathname, JSON.stringify(found.snapshot), {
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: "application/json;charset=utf-8",
            cacheControlMaxAge: 60,
          });
        }
        await put(pathname, JSON.stringify(next), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: found?.primaryExists ?? false,
          ...(found?.etag ? { ifMatch: found.etag } : {}),
          contentType: "application/json;charset=utf-8",
          cacheControlMaxAge: 60,
        });
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) continue;
        if (!found?.primaryExists) {
          const raced = await readCloud(pathname, backupPathname, deskId);
          if (raced) continue;
        }
        throw error;
      }

      const confirmed = await readCloud(pathname, backupPathname, deskId);
      if (confirmed?.snapshot.appliedCheckpointIds.includes(data.checkpointId)) {
        if (!found) {
          await put(backupPathname, JSON.stringify(confirmed.snapshot), {
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: "application/json;charset=utf-8",
            cacheControlMaxAge: 60,
          });
        }
        return confirmed.snapshot;
      }
    }
    throw new Error("Another window kept changing this desk. Please press Next again.");
  });
