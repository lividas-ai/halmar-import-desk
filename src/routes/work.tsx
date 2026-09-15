import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { ProductCard } from "@/components/product-card";
import { Lightbox } from "@/components/lightbox";
import { useCatalog } from "@/hooks/use-catalog";
import { useDesk } from "@/store/desk-store";
import { filterProducts, firstUnmarkedLocation, pageSlice } from "@/lib/catalog";
import type { Product } from "@/lib/catalog";

type WorkSearch = { category: string; page: number; q: string };

export const Route = createFileRoute("/work")({
  validateSearch: (search: Record<string, unknown>): WorkSearch => ({
    category:
      typeof search.category === "string" && search.category.length > 0
        ? search.category
        : "all",
    page: Math.max(1, Number(search.page) || 1),
    q:
      typeof search.q === "string"
        ? search.q
        : typeof search.q === "number" && Number.isFinite(search.q)
          ? String(search.q)
          : "",
  }),
  component: WorkPage,
});

function WorkPage() {
  const { category, page, q } = Route.useSearch();
  const navigate = useNavigate({ from: "/work" });
  const { products, categories, loading, error } = useCatalog();
  const decisions = useDesk((s) => s.decisions);
  const deskToken = useDesk((s) => s.deskToken);
  const setMark = useDesk((s) => s.setMark);
  const checkpointPage = useDesk((s) => s.checkpointPage);
  const checkpointing = useDesk((s) => s.checkpointing);
  const [focus, setFocus] = useState(0);
  const [query, setQuery] = useState(q);
  const [lightbox, setLightbox] = useState<{ product: Product; index: number } | null>(
    null,
  );

  const filtered = useMemo(() => {
    if (!products) return [];
    return filterProducts(products, { category, q });
  }, [products, category, q]);

  const slice = pageSlice(filtered, page);
  const deskHash = deskToken ? `desk=${deskToken}` : undefined;

  useEffect(() => {
    if (slice.page !== page) {
      void navigate({
        search: (prev) => ({ ...prev, page: slice.page }),
        hash: deskHash,
        replace: true,
      });
    }
  }, [slice.page, page, navigate, deskHash]);

  useEffect(() => {
    setFocus(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [page, category, q]);

  const unmarkedOnPage = slice.items.filter((p) => !decisions[p.id]);
  const pageReady = slice.items.length > 0 && unmarkedOnPage.length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const current = slice.items[focus] ?? unmarkedOnPage[0] ?? slice.items[0];
      if (!current) return;
      if (e.key === "1") {
        e.preventDefault();
        setMark(current.id, "import", products);
        setFocus((i) => Math.min(i + 1, Math.max(0, slice.items.length - 1)));
      }
      if (e.key === "2") {
        e.preventDefault();
        setMark(current.id, "reject", products);
        setFocus((i) => Math.min(i + 1, Math.max(0, slice.items.length - 1)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slice.items, focus, unmarkedOnPage, setMark, products]);

  async function go(nextPage: number) {
    if (nextPage > page && !pageReady) {
      toast.error("Mark every product on this page with 1 (import) or 2 (skip) first.");
      return;
    }
    if (nextPage > page && products) {
      const result = await checkpointPage();
      if (!result.ok) {
        toast.error(`Could not confirm the cloud save. You are still on this page. ${result.error}`);
        return;
      }
      toast.success(`Cloud checkpoint confirmed · revision ${result.revision}.`);
    }
    if (nextPage > slice.totalPages) {
      if (!products) return;
      const loc = firstUnmarkedLocation(products, decisions, categories);
      if (!loc) {
        toast.success("Every product is marked.");
        void navigate({ to: "/review", hash: deskHash });
        return;
      }
      void navigate({
        search: { category: loc.category, page: loc.page, q: "" },
        hash: deskHash,
      });
      return;
    }
    void navigate({ search: (prev) => ({ ...prev, page: nextPage }), hash: deskHash });
  }

  function jumpCategory(name: string) {
    void navigate({ search: { category: name, page: 1, q }, hash: deskHash });
  }

  function resumeUnmarked() {
    if (!products) return;
    const loc = firstUnmarkedLocation(products, decisions, categories);
    if (!loc) {
      toast.success("Every product is marked.");
      return;
    }
    void navigate({
      search: { category: loc.category, page: loc.page, q: "" },
      hash: deskHash,
    });
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row">
        <aside className="lg:w-56 lg:shrink-0">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
            Categories
          </p>
          <div className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
            <CatBtn
              active={category === "all"}
              label="All products"
              count={products?.length ?? 3367}
              done={products ? products.filter((p) => decisions[p.id]).length : 0}
              onClick={() => jumpCategory("all")}
            />
            {categories.map((c) => {
              const done = products
                ? products.filter((p) => p.category === c.name && decisions[p.id]).length
                : 0;
              return (
                <CatBtn
                  key={c.name}
                  active={category === c.name}
                  label={c.name}
                  count={c.count}
                  done={done}
                  onClick={() => jumpCategory(c.name)}
                />
              );
            })}
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <form
            className="mb-4 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void navigate({
                search: (prev) => ({ ...prev, q: query, page: 1 }),
                hash: deskHash,
              });
            }}
          >
            <label className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, EAN, code, collection"
                className="h-11 w-full rounded-md border border-border bg-surface pl-9 pr-3"
              />
            </label>
            <Button type="submit" variant="secondary">
              Search
            </Button>
            <Button type="button" variant="ghost" onClick={resumeUnmarked}>
              Jump to unmarked
            </Button>
          </form>

          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-display text-3xl">
                {category === "all" ? "All products" : category}
              </h1>
              <p className="text-sm text-muted">
                Showing {slice.start}–{slice.end} of {slice.total}
                {q ? ` matching “${q}”` : ""}. In stock first, then low stock, then out of stock.
                Keys 1 and 2 mark the highlighted card.
              </p>
            </div>
            <p
              className={`rounded-md px-3 py-2 text-sm font-medium ${
                pageReady ? "bg-import-soft text-import" : "bg-warn-soft text-warn"
              }`}
            >
              {pageReady
                ? "Page complete — Next saves progress"
                : `${unmarkedOnPage.length} on this page still need 1 or 2`}
            </p>
          </div>

          {loading ? <p className="text-muted">Loading catalog…</p> : null}
          {error ? <p className="text-reject">{error}</p> : null}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {slice.items.map((p, i) => (
              <div key={p.id} onMouseEnter={() => setFocus(i)}>
                <ProductCard
                  product={p}
                  mark={decisions[p.id]}
                  focused={focus === i}
                  onMark={(m) => setMark(p.id, m, products)}
                  onOpenPhoto={(idx) => setLightbox({ product: p, index: idx })}
                />
              </div>
            ))}
          </div>

          {slice.items.length === 0 && !loading ? (
            <p className="mt-8 text-muted">No products match this filter.</p>
          ) : null}

          <div className="sticky bottom-0 mt-8 flex items-center justify-between gap-3 border-t border-border bg-bg/95 py-3 backdrop-blur">
            <Button
              variant="secondary"
              disabled={slice.page <= 1}
              onClick={() => void go(slice.page - 1)}
            >
              <ChevronLeft className="size-4" />
              Previous
            </Button>
            <p className="text-sm tabular-nums text-muted">
              Page {slice.page} / {slice.totalPages}
            </p>
            <Button
              disabled={!pageReady || checkpointing}
              onClick={() => void go(slice.page + 1)}
              title={!pageReady ? "Mark all products on this page first" : "Saves progress, then continues"}
            >
              {checkpointing
                ? "Confirming save…"
                : slice.page >= slice.totalPages
                  ? "Save & continue"
                  : "Next"}
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </section>
      </div>

      {lightbox ? (
        <Lightbox
          images={lightbox.product.images}
          index={lightbox.index}
          name={lightbox.product.name}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox({ ...lightbox, index: i })}
        />
      ) : null}
    </AppShell>
  );
}

function CatBtn({
  active,
  label,
  count,
  done,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  done: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-w-40 flex-col rounded-md border px-3 py-2 text-left text-sm lg:min-w-0 ${
        active ? "border-primary bg-surface" : "border-transparent bg-transparent hover:bg-surface"
      }`}
    >
      <span className="font-medium">{label}</span>
      <span className="text-xs tabular-nums text-muted">
        {done}/{count}
      </span>
    </button>
  );
}
