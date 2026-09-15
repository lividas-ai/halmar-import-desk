import rawManifest from "../data/catalog-meta.json";

export type CatalogSource = {
  role: "catalog" | "stock" | "prices";
  url: string;
  contentSha256: string;
  rawSha256: string;
  contentHashAlgorithm: string;
  itemRows: number;
  uniqueGtin: number;
  feedDate: string;
};

export type CatalogManifest = {
  schemaVersion: number;
  verifiedAt: string;
  bundleSha256: string;
  fingerprintAlgorithm: string;
  uniqueProducts: number;
  duplicateCatalogRowsMerged: number;
  duplicateRows: Record<"catalog" | "stock" | "prices", {
    gtins: number;
    extraRows: number;
    conflicts: number;
    resolution: string;
  }>;
  allHaveImageUrls: boolean;
  sources: CatalogSource[];
  coverage: {
    stockMatched: number;
    stockNotListed: number;
    pricesMatched: number;
    pricesNotListed: number;
  };
};

export const CATALOG_MANIFEST = rawManifest as CatalogManifest;
export const CATALOG_FINGERPRINT = CATALOG_MANIFEST.bundleSha256;
