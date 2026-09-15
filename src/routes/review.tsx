import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { ProductCard } from "@/components/product-card";
import { Lightbox } from "@/components/lightbox";
import { useCatalog } from "@/hooks/use-catalog";
import { useDesk } from "@/store/desk-store";
import type { Product } from "@/lib/catalog";
import type { Mark } from "@/lib/persist";

export const Route = createFileRoute("/review")({ component: ReviewPage });

function ReviewPage() {
  const { products, loading } = useCatalog();
  const decisions = useDesk((s) => s.decisions);
  const setMark = useDesk((s) => s.setMark);
  const exportCsv = useDesk((s) => s.exportCsv);
  const exportDecisions = useDesk((s) => s.exportDecisions);
  const finalizeAndExport = useDesk((s) => s.finalizeAndExport);
  const checkpointing = useDesk((s) => s.checkpointing);
  const [which, setWhich] = useState<Mark>("import");
  const [lightbox, setLightbox] = useState<{ product: Product; index: number } | null>(
    null,
  );

  const list = useMemo(() => {
    if (!products) return [];
    return products.filter((p) => decisions[p.id] === which);
  }, [products, decisions, which]);
  const unmarked = products?.filter((product) => !decisions[product.id]).length ?? 0;

  async function downloadFinal() {
    if (!products) return;
    const result = await finalizeAndExport(products);
    if (result.ok) {
      toast.success(`Final JSON validated and cloud revision ${result.revision} confirmed. Send that file back.`);
    } else {
      toast.error(result.error);
    }
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="font-display text-4xl">Chosen products</h1>
        <p className="mt-2 max-w-2xl text-muted">
          This is the list that will be imported to the website. You can still flip any mark.
          Once all 3,367 products are marked, create the validated FINAL JSON and send it back.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant={which === "import" ? "import" : "secondary"}
            onClick={() => setWhich("import")}
          >
            Import ({products ? products.filter((p) => decisions[p.id] === "import").length : 0})
          </Button>
          <Button
            variant={which === "reject" ? "reject" : "secondary"}
            onClick={() => setWhich("reject")}
          >
            Skip ({products ? products.filter((p) => decisions[p.id] === "reject").length : 0})
          </Button>
          <Button
            variant="secondary"
            onClick={() => products && exportCsv(products, which)}
            disabled={!products}
          >
            Download this list as CSV
          </Button>
          <Button
            onClick={() => void downloadFinal()}
            disabled={!products || unmarked > 0 || checkpointing}
          >
            {checkpointing ? "Confirming cloud save…" : "Finalize & download JSON"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => products && exportDecisions(products)}
            disabled={!products}
          >
            Download progress backup
          </Button>
        </div>
        {unmarked > 0 ? (
          <p className="mt-3 text-sm text-warn">
            Final export is locked until the remaining {unmarked} products are marked.
          </p>
        ) : (
          <p className="mt-3 text-sm text-import">
            All products are marked. Final export will checkpoint the cloud copy and validate every GTIN first.
          </p>
        )}

        {loading ? <p className="mt-8 text-muted">Loading…</p> : null}
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              mark={decisions[p.id]}
              onMark={(m) => setMark(p.id, m, products)}
              onOpenPhoto={(idx) => setLightbox({ product: p, index: idx })}
            />
          ))}
        </div>
        {list.length === 0 && !loading ? (
          <p className="mt-8 text-muted">Nothing in this list yet.</p>
        ) : null}
      </main>
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
