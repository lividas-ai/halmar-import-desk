import { useEffect, useState } from "react";
import {
  CATALOG_VERSION,
  categoriesFrom,
  loadProducts,
  type CategoryMeta,
  type Product,
} from "@/lib/catalog";

export function useCatalog() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<CategoryMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/data/categories.json?v=${CATALOG_VERSION}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: CategoryMeta[]) => {
        if (live && Array.isArray(data)) setCategories(data);
      })
      .catch(() => {});
    loadProducts()
      .then((data) => {
        if (!live) return;
        setProducts(data);
        setCategories(categoriesFrom(data));
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : "Load failed");
      });
    return () => {
      live = false;
    };
  }, []);

  return { products, categories, error, loading: !products && !error };
}
