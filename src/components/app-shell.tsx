import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Download, HardDrive, Link2, Upload, LayoutGrid, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDesk } from "@/store/desk-store";
import { useCatalog } from "@/hooks/use-catalog";
import { TOTAL_PRODUCTS } from "@/lib/catalog";
import { formatClock } from "@/lib/utils";
import { parseSnapshot } from "@/lib/persist";

export function AppShell({ children }: { children: ReactNode }) {
  const { products } = useCatalog();
  const hydrate = useDesk((s) => s.hydrate);
  const hydrated = useDesk((s) => s.hydrated);
  const deskToken = useDesk((s) => s.deskToken);
  const decisions = useDesk((s) => s.decisions);
  const updatedAt = useDesk((s) => s.updatedAt);
  const backupFile = useDesk((s) => s.backupFile);
  const localStatus = useDesk((s) => s.localStatus);
  const localError = useDesk((s) => s.localError);
  const cloudStatus = useDesk((s) => s.cloudStatus);
  const cloudError = useDesk((s) => s.cloudError);
  const cloudDirty = useDesk((s) => s.cloudDirty);
  const serverRevision = useDesk((s) => s.serverRevision);
  const exportDecisions = useDesk((s) => s.exportDecisions);
  const importSnapshot = useDesk((s) => s.importSnapshot);
  const connectBackupFile = useDesk((s) => s.connectBackupFile);
  const shareUrl = useDesk((s) => s.shareUrl);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated || !deskToken) return;
    const expected = `desk=${deskToken}`;
    if (window.location.hash.slice(1) === expected) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#${expected}`,
    );
  }, [deskToken, hydrated]);

  useEffect(() => {
    const warnIfUnsaved = (event: BeforeUnloadEvent) => {
      if (!cloudDirty && localStatus !== "saving" && localStatus !== "error") return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnIfUnsaved);
    return () => window.removeEventListener("beforeunload", warnIfUnsaved);
  }, [cloudDirty, localStatus]);

  const total = products?.length ?? TOTAL_PRODUCTS;
  const marked = Object.keys(decisions).length;
  const imported = Object.values(decisions).filter((d) => d === "import").length;
  const skipped = Object.values(decisions).filter((d) => d === "reject").length;
  const deskHash = deskToken ? `desk=${deskToken}` : undefined;

  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result));
        const parsed = parseSnapshot(raw);
        if (!parsed) {
          toast.error("Not a valid Halmar decisions file.");
          return;
        }
        const res = importSnapshot(raw);
        if (res.ok) toast.success(`Restored ${res.count} markings.`);
        else toast.error(res.error);
      } catch {
        toast.error("Could not read that file.");
      }
    };
    reader.readAsText(file);
  }

  function downloadNow() {
    if (!products) {
      toast.error("Catalog still loading.");
      return;
    }
    exportDecisions(products, "manual");
    toast.success("Verified progress backup downloaded. The final file is created on the Chosen page.");
  }

  async function lockFile() {
    const res = await connectBackupFile();
    if (res.ok) toast.success(`Live backup connected: ${res.name}. Every mark writes to this file.`);
    else toast.error(res.error);
  }

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <Link
            to="/work"
            search={{ category: "all", page: 1, q: "" }}
            hash={deskHash}
            className="font-display text-lg tracking-tight"
          >
            Halmar Import Desk
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              to="/work"
              search={{ category: "all", page: 1, q: "" }}
              hash={deskHash}
              className="rounded-md px-3 py-2 text-muted hover:bg-bg hover:text-fg"
            >
              <span className="inline-flex items-center gap-1">
                <LayoutGrid className="size-4" /> Categories
              </span>
            </Link>
            <Link
              to="/work"
              search={{ category: "all", page: 1, q: "" }}
              hash={deskHash}
              className="rounded-md px-3 py-2 text-muted hover:bg-bg hover:text-fg"
            >
              Review pages
            </Link>
            <Link
              to="/review"
              hash={deskHash}
              className="rounded-md px-3 py-2 text-muted hover:bg-bg hover:text-fg"
            >
              <span className="inline-flex items-center gap-1">
                <ListChecks className="size-4" /> Chosen
              </span>
            </Link>
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted">
              {hydrated ? (
                <>
                  <span className="font-semibold tabular-nums text-fg">
                    {marked}/{total}
                  </span>{" "}
                  marked · {imported} import · {skipped} skip
                  <span className="hidden sm:inline">
                    {localStatus === "saving"
                      ? " · saving locally…"
                      : localStatus === "error"
                        ? " · local save problem"
                        : ` · local ${formatClock(updatedAt)}`}
                  </span>
                  <span
                    className={
                      cloudStatus === "error" ? "text-reject" : cloudDirty ? "text-warn" : ""
                    }
                  >
                    {cloudStatus === "syncing"
                      ? " · cloud saving…"
                      : serverRevision > 0
                        ? ` · cloud r${serverRevision}${cloudDirty ? " · changes pending" : ""}`
                        : cloudStatus === "error"
                          ? " · cloud problem"
                          : ` · cloud ready${cloudDirty ? " · changes pending" : ""}`}
                  </span>
                  {backupFile ? (
                    <span className="hidden md:inline"> · disk {backupFile}</span>
                  ) : null}
                </>
              ) : (
                "Loading save…"
              )}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!hydrated}
              onClick={async () => {
                const url = shareUrl();
                try {
                  await navigator.clipboard.writeText(url);
                  toast.success("Desk link copied. Send this URL to your client.");
                } catch {
                  toast.message(url);
                }
              }}
            >
              <Link2 className="size-4" />
              Copy desk link
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="size-4" />
              Restore
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void lockFile()}>
              <HardDrive className="size-4" />
              {backupFile ? "Backup file on" : "Lock backup file"}
            </Button>
            <Button size="sm" onClick={downloadNow}>
              <Download className="size-4" />
              Download backup
            </Button>
          </div>
        </div>
        <div className="h-1 bg-border">
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${Math.min(100, (marked / total) * 100)}%` }}
          />
        </div>
        {localError || cloudError ? (
          <div className="border-t border-reject/30 bg-reject-soft px-4 py-2 text-center text-sm text-reject">
            <strong>
              {localStatus === "error" || cloudStatus === "error"
                ? "Save protection needs attention."
                : "One backup layer needs attention."}
            </strong>{" "}
            {[localError, cloudError].filter(Boolean).join(" · ")}
          </div>
        ) : null}
      </header>
      {children}
    </div>
  );
}
