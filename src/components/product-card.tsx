import { useMemo, useState } from "react";
import { Check, Expand, X } from "lucide-react";
import type { Product } from "@/lib/catalog";
import type { Mark } from "@/lib/persist";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ProductCard({
  product,
  mark,
  focused,
  onMark,
  onOpenPhoto,
}: {
  product: Product;
  mark: Mark | undefined;
  focused?: boolean;
  onMark: (m: Mark) => void;
  onOpenPhoto: (index: number) => void;
}) {
  const [failed, setFailed] = useState<Record<string, true>>({});
  const live = useMemo(
    () => product.images.filter((u) => !failed[u]),
    [product.images, failed],
  );
  const [pick, setPick] = useState(0);
  const src = live[Math.min(pick, Math.max(0, live.length - 1))];
  const srcIndex = src ? product.images.indexOf(src) : 0;

  const stockClass =
    product.stockStatus === "in_stock"
      ? "bg-import-soft text-import"
      : product.stockStatus === "low_stock"
        ? "bg-warn-soft text-warn"
        : product.stockStatus === "out_of_stock"
          ? "bg-reject-soft text-reject"
          : "bg-bg text-muted";

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-surface",
        mark === "import" && "border-import ring-2 ring-import/30",
        mark === "reject" && "border-reject ring-2 ring-reject/30",
        !mark && "border-border",
        focused && "outline outline-2 outline-offset-2 outline-primary",
      )}
    >
      <div className="relative bg-bg">
        {src ? (
          <button
            type="button"
            className="block w-full"
            onClick={() => onOpenPhoto(Math.max(0, srcIndex))}
            aria-label={`Enlarge photo of ${product.name}`}
          >
            <img
              src={src}
              alt={product.name}
              className="h-44 w-full object-contain bg-bg"
              loading="lazy"
              onError={() => {
                if (src) setFailed((f) => ({ ...f, [src]: true }));
              }}
            />
          </button>
        ) : (
          <div className="flex h-44 items-center justify-center px-3 text-center text-xs text-muted">
            {product.hasCatalogPhoto
              ? "Photo listed in catalog, missing on Halmar server"
              : "No photo in catalog"}
          </div>
        )}
        {src ? (
          <button
            type="button"
            onClick={() => onOpenPhoto(Math.max(0, srcIndex))}
            className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-md bg-surface/90 text-fg shadow"
            aria-label="Expand photo"
          >
            <Expand className="size-4" />
          </button>
        ) : null}
        <span
          className={cn(
            "absolute left-2 top-2 rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            mark === "import"
              ? "bg-import text-primary-fg"
              : mark === "reject"
                ? "bg-reject text-primary-fg"
                : "bg-warn-soft text-warn",
          )}
        >
          {mark === "import" ? "1 Import" : mark === "reject" ? "2 Skip" : "Unmarked"}
        </span>
      </div>

      {live.length > 1 ? (
        <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {live.map((img, i) => (
            <button
              key={img}
              type="button"
              onClick={() => setPick(i)}
              className={cn(
                "size-10 shrink-0 overflow-hidden rounded-sm border",
                i === pick ? "border-primary" : "border-border opacity-80",
              )}
            >
              <img
                src={img}
                alt=""
                className="size-full object-cover"
                onError={() => setFailed((f) => ({ ...f, [img]: true }))}
              />
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
            {product.collection} · {product.category}
          </p>
          <h2 className="font-display text-base leading-snug text-fg">{product.name}</h2>
        </div>
        <p className={cn("w-fit rounded-sm px-2 py-0.5 text-[11px] font-semibold", stockClass)}>
          {product.stockStatus === "out_of_stock" && product.deliveryDate
            ? `Out of stock · expected back ${product.deliveryDate}`
            : product.stockLabel}
        </p>
        <dl className="grid grid-cols-2 gap-x-2 text-[11px] text-muted">
          <div>
            <dt className="uppercase tracking-wide">EAN</dt>
            <dd className="truncate font-mono text-fg">{product.ean || "—"}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide">Code</dt>
            <dd className="truncate font-mono text-fg">{product.code || "—"}</dd>
          </div>
        </dl>
        {product.description ? (
          <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-fg/90">
            {product.description}
          </p>
        ) : null}

        <div className="mt-auto grid grid-cols-2 gap-2 pt-1">
          <Button
            type="button"
            variant={mark === "import" ? "import" : "secondary"}
            size="sm"
            onClick={() => onMark("import")}
            aria-pressed={mark === "import"}
          >
            <Check className="size-4" />
            1 Import
          </Button>
          <Button
            type="button"
            variant={mark === "reject" ? "reject" : "secondary"}
            size="sm"
            onClick={() => onMark("reject")}
            aria-pressed={mark === "reject"}
          >
            <X className="size-4" />
            2 Skip
          </Button>
        </div>
      </div>
    </article>
  );
}
