import { useEffect } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Lightbox({
  images,
  index,
  name,
  onClose,
  onIndex,
}: {
  images: string[];
  index: number;
  name: string;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex((index + 1) % images.length);
      if (e.key === "ArrowLeft") onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose, onIndex]);

  const src = images[index];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-fg/90 p-3 md:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={onClose}
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-bg">
        <p className="truncate font-display text-lg">{name}</p>
        <p className="shrink-0 text-sm text-bg/70">
          {index + 1} / {images.length}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="text-bg hover:bg-fg"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="size-5" />
        </Button>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {images.length > 1 ? (
          <Button
            variant="secondary"
            size="icon"
            className="absolute left-0 z-10"
            onClick={() => onIndex((index - 1 + images.length) % images.length)}
            aria-label="Previous photo"
          >
            <ChevronLeft />
          </Button>
        ) : null}
        {src ? (
          <img
            src={src}
            alt={name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
        ) : null}
        {images.length > 1 ? (
          <Button
            variant="secondary"
            size="icon"
            className="absolute right-0 z-10"
            onClick={() => onIndex((index + 1) % images.length)}
            aria-label="Next photo"
          >
            <ChevronRight />
          </Button>
        ) : null}
      </div>
      {images.length > 1 ? (
        <div className="mt-3 flex justify-center gap-2 overflow-x-auto" onClick={(e) => e.stopPropagation()}>
          {images.map((img, i) => (
            <button
              key={img}
              type="button"
              onClick={() => onIndex(i)}
              className={`size-16 shrink-0 overflow-hidden rounded-sm border-2 ${
                i === index ? "border-primary-fg" : "border-transparent opacity-70"
              }`}
            >
              <img src={img} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
