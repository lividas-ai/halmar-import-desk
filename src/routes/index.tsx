import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useCatalog } from "@/hooks/use-catalog";
import { useDesk } from "@/store/desk-store";
import { TOTAL_PRODUCTS, firstUnmarkedLocation } from "@/lib/catalog";
import { formatClock } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { products, categories, error, loading } = useCatalog();
  const decisions = useDesk((s) => s.decisions);
  const clientName = useDesk((s) => s.clientName);
  const note = useDesk((s) => s.note);
  const setClientName = useDesk((s) => s.setClientName);
  const setNote = useDesk((s) => s.setNote);
  const updatedAt = useDesk((s) => s.updatedAt);
  const exportDecisions = useDesk((s) => s.exportDecisions);
  const exportCsv = useDesk((s) => s.exportCsv);
  const navigate = useNavigate();

  const marked = Object.keys(decisions).length;
  const imported = Object.values(decisions).filter((d) => d === "import").length;
  const skipped = Object.values(decisions).filter((d) => d === "reject").length;
  const total = products?.length ?? TOTAL_PRODUCTS;
  const remaining = total - marked;

  function resume() {
    if (!products) return;
    const loc = firstUnmarkedLocation(products, decisions, categories);
    if (!loc) {
      void navigate({ to: "/review" });
      return;
    }
    void navigate({
      to: "/work",
      search: { category: loc.category, page: loc.page, q: "" },
    });
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            Client catalog review
          </p>
          <h1 className="mt-2 font-display text-4xl leading-tight text-fg md:text-5xl">
            Mark every product: 1 import, 2 skip.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
            English Halmar catalog — {total} unique products. In-stock items are listed first.
            Marks save instantly in this browser (three copies). Click <strong>Lock backup file</strong>
            once so every mark is also written to a JSON file on disk. Click <strong>Download save</strong>
            anytime — that file contains all 3,367 products and every 1/2 mark. Send that file back;
            Restore loads it. A safety copy also downloads automatically every 50 marks.
          </p>
        </div>

        <section className="mt-8 grid gap-3 sm:grid-cols-4">
          <Stat label="Catalog" value={String(total)} />
          <Stat label="Marked" value={`${marked}`} hint={`${remaining} left`} />
          <Stat label="1 · Import" value={String(imported)} tone="import" />
          <Stat label="2 · Skip" value={String(skipped)} tone="reject" />
        </section>
        {products ? (
          <p className="mt-3 text-xs text-muted">
            Stock: {products.filter((p) => p.stockStatus === "in_stock").length} in stock ·{" "}
            {products.filter((p) => p.stockStatus === "low_stock").length} low stock ·{" "}
            {products.filter((p) => p.stockStatus === "out_of_stock").length} out of stock ·{" "}
            {products.filter((p) => p.stockStatus === "not_listed").length} not listed in stock file.
            Photo URLs are included for every product; if Halmar’s image server returns 404, the
            card says so and tries the next photo.
          </p>
        ) : null}

        <section className="mt-8 max-w-3xl rounded-xl border border-primary/30 bg-surface p-5">
          <h2 className="font-display text-xl">How to send this desk to your client</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
            <li>
              Click <strong>Copy desk link</strong> in the top bar and send that URL (WhatsApp, email).
            </li>
            <li>
              Tell them: open the link on a computer in Chrome, click <strong>Lock backup file</strong>{" "}
              once, then mark every product <strong>1 Import</strong> or <strong>2 Skip</strong>.
            </li>
            <li>
              When they finish (or pause), they click <strong>Download save</strong> and email you that
              JSON file.
            </li>
            <li>
              You click <strong>Restore</strong> and load their file. That JSON is also what you give
              Claude with the Halmar XML — match <code>eanGtin</code> to XML <code>ean_GTIN</code>.
            </li>
          </ol>
        </section>

        <section className="mt-8 grid gap-6 rounded-xl border border-border bg-surface p-5 md:grid-cols-2">
          <div className="space-y-3">
            <label className="block text-sm font-medium">
              Your name / company
              <input
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Saved with the export"
                className="mt-1 h-11 w-full rounded-md border border-border bg-bg px-3 text-fg"
              />
            </label>
            <label className="block text-sm font-medium">
              Note to the website builder
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Optional comments"
                className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-fg"
              />
            </label>
            <p className="text-xs text-muted">Last saved {formatClock(updatedAt)}</p>
          </div>
          <div className="flex flex-col justify-center gap-3">
            <Button size="xl" onClick={resume} disabled={loading}>
              {marked === 0
                ? "Start from first category"
                : remaining === 0
                  ? "All marked — review chosen"
                  : "Resume unmarked products"}
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => products && exportDecisions(products)}
                disabled={!products}
              >
                Download JSON save
              </Button>
              <Button
                variant="secondary"
                onClick={() => products && exportCsv(products, "import")}
                disabled={!products}
              >
                CSV of imports
              </Button>
              <Button
                variant="secondary"
                onClick={() => products && exportCsv(products, "all")}
                disabled={!products}
              >
                CSV of all marks
              </Button>
            </div>
            <p className="text-sm text-muted">
              Send the JSON save file back. Restoring it on any copy of this desk recovers every
              mark — nothing lives only in the browser tab.
            </p>
          </div>
        </section>

        {error ? <p className="mt-6 text-reject">{error}</p> : null}
        {loading ? (
          <p className="mt-8 text-muted">Loading {TOTAL_PRODUCTS} products…</p>
        ) : (
          <section className="mt-10">
            <h2 className="font-display text-2xl">Categories</h2>
            <p className="mt-1 text-sm text-muted">
              Open a category and mark every product on each page with 1 or 2.
            </p>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {categories.map((cat) => {
                const inCat = products?.filter((p) => p.category === cat.name) ?? [];
                const done = inCat.filter((p) => decisions[p.id]).length;
                const pct = cat.count ? Math.round((done / cat.count) * 100) : 0;
                return (
                  <li key={cat.name}>
                    <Link
                      to="/work"
                      search={{ category: cat.name, page: 1, q: "" }}
                      className="block rounded-lg border border-border bg-surface p-4 hover:border-primary"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <h3 className="font-display text-xl">{cat.name}</h3>
                        <span className="text-xs tabular-nums text-muted">
                          {done}/{cat.count}
                        </span>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="mt-2 text-xs text-muted">
                        {done === cat.count ? "Complete" : `${cat.count - done} still unmarked`}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "import" | "reject";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p
        className={`mt-1 font-display text-3xl tabular-nums ${
          tone === "import" ? "text-import" : tone === "reject" ? "text-reject" : "text-fg"
        }`}
      >
        {value}
      </p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
