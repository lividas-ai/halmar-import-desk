export type StockStatus = "in_stock" | "low_stock" | "out_of_stock" | "not_listed";

export type Product = {
  id: string;
  ean: string;
  eanGtin: string;
  eanInternal: string;
  code: string;
  name: string;
  description: string;
  category: string;
  collection: string;
  images: string[];
  hasCatalogPhoto: boolean;
  price: string;
  currency: string;
  pricePln: string;
  priceEur: string;
  pricePlnCurrency: string;
  priceEurCurrency: string;
  priceListed: boolean;
  weight: string;
  origin: string;
  withdrawn: string;
  stockStatus: StockStatus;
  stockLabel: string;
  deliveryDate: string;
};

export type CategoryMeta = {
  id: string;
  name: string;
  count: number;
};

export const PAGE_SIZE = 9;
export const TOTAL_PRODUCTS = 3367;
export const CATALOG_VERSION = "en-stock-price-1";

const STOCK_RANK: Record<StockStatus, number> = {
  in_stock: 0,
  low_stock: 1,
  out_of_stock: 2,
  not_listed: 3,
};

export function stockRank(status: StockStatus | undefined) {
  return STOCK_RANK[status ?? "not_listed"] ?? 9;
}

export function sortByStock<T extends { stockStatus: StockStatus; name: string }>(items: T[]) {
  return [...items].sort(
    (a, b) => stockRank(a.stockStatus) - stockRank(b.stockStatus) || a.name.localeCompare(b.name, "en"),
  );
}

let productCache: Product[] | null = null;
let loadPromise: Promise<Product[]> | null = null;

export function loadProducts(): Promise<Product[]> {
  if (productCache) return Promise.resolve(productCache);
  if (loadPromise) return loadPromise;
  loadPromise = fetch(`/data/products.json?v=${CATALOG_VERSION}`)
    .then((r) => {
      if (!r.ok) throw new Error("Could not load catalog");
      return r.json() as Promise<Product[]>;
    })
    .then((data) => {
      productCache = sortByStock(
        data.map((p) => ({
          ...p,
          eanGtin: p.eanGtin || p.ean,
          eanInternal: p.eanInternal || "",
          pricePln: p.pricePln || p.price || "",
          priceEur: p.priceEur || "",
          pricePlnCurrency: p.pricePlnCurrency || "PLN",
          priceEurCurrency: p.priceEurCurrency || "EUR",
          priceListed: p.priceListed ?? Boolean(p.pricePln || p.price),
        })),
      );
      return productCache;
    });
  return loadPromise;
}

export function categoriesFrom(products: Product[]): CategoryMeta[] {
  const counts = new Map<string, number>();
  for (const p of products) {
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ id: name, name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en"));
}

export function filterProducts(
  products: Product[],
  opts: { category?: string; q?: string },
) {
  const q = (opts.q ?? "").trim().toLowerCase();
  const filtered = products.filter((p) => {
    if (opts.category && opts.category !== "all" && p.category !== opts.category) {
      return false;
    }
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.ean.toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      p.collection.toLowerCase().includes(q) ||
      p.stockLabel.toLowerCase().includes(q)
    );
  });
  return sortByStock(filtered);
}

export function pageSlice<T>(items: T[], page: number, size = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const safe = Math.min(Math.max(1, page), totalPages);
  const start = (safe - 1) * size;
  return {
    page: safe,
    totalPages,
    total: items.length,
    items: items.slice(start, start + size),
    start: items.length === 0 ? 0 : start + 1,
    end: Math.min(start + size, items.length),
  };
}

export function firstUnmarkedLocation(
  products: Product[],
  decisions: Record<string, string>,
  categories: CategoryMeta[],
) {
  for (const cat of categories) {
    const list = sortByStock(products.filter((p) => p.category === cat.name));
    const idx = list.findIndex((p) => !decisions[p.id]);
    if (idx >= 0) {
      return {
        category: cat.name,
        page: Math.floor(idx / PAGE_SIZE) + 1,
      };
    }
  }
  const idx = products.findIndex((p) => !decisions[p.id]);
  if (idx < 0) return null;
  return { category: "all", page: Math.floor(idx / PAGE_SIZE) + 1 };
}
