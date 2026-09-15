import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SOURCES = {
  catalog: "https://integration.halmar.pl/halmar_catalog_en.xml",
  stock: "https://integration.halmar.pl/halmar_stock.xml",
  prices: "https://integration.halmar.pl/halmar_catalog_export.xml",
};

function argument(name) {
  const exact = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (exact) return exact.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const shouldWrite = process.argv.includes("--write");
const productPath = resolve(argument("products") ?? "public/data/products.json");
const metaPath = resolve(argument("meta") ?? "public/data/catalog-meta.json");
const appMetaPath = resolve(argument("app-meta") ?? "src/data/catalog-meta.json");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonicalXmlHash(buffer) {
  const canonical = decodeXml(buffer).replace(/(<Items\b[^>]*?)\s+Date="[^"]*"/, "$1");
  return sha256(Buffer.from(canonical, "utf8"));
}

function decodeXml(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  return new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeEntities(match[1]).trim() : "";
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function price(value) {
  return value ? Number.parseFloat(value).toFixed(2) : "";
}

function parseFeed(buffer) {
  const xml = decodeXml(buffer);
  const date = xml.match(/<Items\b[^>]*\bDate="([^"]+)"/)?.[1] ?? "";
  const items = [...xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((match) => match[1]);
  return { xml, date, items };
}

function row(item) {
  return {
    ean: tag(item, "ean"),
    eanGtin: tag(item, "ean_GTIN"),
    code: tag(item, "code"),
    name: normalizeText(tag(item, "name")),
    description: normalizeText(tag(item, "description")),
    pictures: [...item.matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((match) => decodeEntities(match[1]).trim()),
    weight: tag(item, "nett_weight"),
    origin: tag(item, "origin_country"),
    withdrawn: tag(item, "withdrawn"),
    stock: tag(item, "stock"),
    deliveryDate: tag(item, "delivery_date"),
    pricePln: price(tag(item, "price1")),
    priceEur: price(tag(item, "price2")),
    pricePlnCurrency: tag(item, "price1_currency"),
    priceEurCurrency: tag(item, "price2_currency"),
  };
}

async function sourceBuffer(role) {
  const path = argument(role);
  if (path) return readFile(resolve(path));
  const response = await fetch(SOURCES[role], { redirect: "follow" });
  if (!response.ok) throw new Error(`${role} feed returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function groupByGtin(rows) {
  const map = new Map();
  for (const item of rows) {
    if (!item.eanGtin) continue;
    const values = map.get(item.eanGtin) ?? [];
    values.push(item);
    map.set(item.eanGtin, values);
  }
  return map;
}

function duplicateIntegrity(groups, fields) {
  let gtins = 0;
  let extraRows = 0;
  const conflicts = [];
  for (const [eanGtin, rows] of groups) {
    if (rows.length < 2) continue;
    gtins += 1;
    extraRows += rows.length - 1;
    for (const field of fields) {
      const values = new Set(rows.map((item) => JSON.stringify(item[field] ?? "")));
      if (values.size > 1) conflicts.push(`${eanGtin}:${field}`);
    }
  }
  return { gtins, extraRows, conflicts };
}

const [catalogBuffer, stockBuffer, pricesBuffer, productBuffer] = await Promise.all([
  sourceBuffer("catalog"),
  sourceBuffer("stock"),
  sourceBuffer("prices"),
  readFile(productPath),
]);
const catalogFeed = parseFeed(catalogBuffer);
const stockFeed = parseFeed(stockBuffer);
const pricesFeed = parseFeed(pricesBuffer);
const catalogRows = catalogFeed.items.map(row);
const stockRows = stockFeed.items.map(row);
const pricesRows = pricesFeed.items.map(row);
const catalogByGtin = groupByGtin(catalogRows);
const stockByGtin = groupByGtin(stockRows);
const pricesByGtin = groupByGtin(pricesRows);
const products = JSON.parse(productBuffer.toString("utf8"));
const duplicateChecks = {
  catalog: duplicateIntegrity(catalogByGtin, [
    "ean", "code", "description", "weight", "origin", "withdrawn",
  ]),
  stock: duplicateIntegrity(stockByGtin, ["ean", "code", "stock", "deliveryDate"]),
  prices: duplicateIntegrity(pricesByGtin, [
    "ean", "code", "pricePln", "priceEur", "pricePlnCurrency", "priceEurCurrency",
  ]),
};

if (process.argv.includes("--report-duplicates")) {
  const compact = (groups) => [...groups]
    .filter(([, rows]) => rows.length > 1)
    .map(([eanGtin, rows]) => ({ eanGtin, rows }));
  console.log(JSON.stringify({
    catalog: compact(catalogByGtin),
    stock: compact(stockByGtin),
    prices: compact(pricesByGtin),
  }, null, 2));
}

const structuralErrors = [];
for (const [role, check] of Object.entries(duplicateChecks)) {
  for (const conflict of check.conflicts) {
    structuralErrors.push(`${role} duplicate GTIN has conflicting ${conflict}`);
  }
}
if (!Array.isArray(products)) structuralErrors.push("products.json is not an array");
const productIds = new Set();
for (const product of products) {
  if (!product.id || product.id !== product.eanGtin) structuralErrors.push(`invalid primary ID ${product.id}`);
  if (productIds.has(product.id)) structuralErrors.push(`duplicate app product ${product.id}`);
  productIds.add(product.id);
  const candidates = catalogByGtin.get(product.id) ?? [];
  if (!candidates.some((candidate) => candidate.ean === product.eanInternal && candidate.code === product.code)) {
    structuralErrors.push(`catalog identity missing for ${product.id} (${product.code})`);
  }
}
for (const id of catalogByGtin.keys()) {
  if (!productIds.has(id)) structuralErrors.push(`catalog GTIN absent from app ${id}`);
}
if (structuralErrors.length) {
  console.error(structuralErrors.slice(0, 30).join("\n"));
  console.error(`Feed verification aborted with ${structuralErrors.length} structural error(s).`);
  process.exit(1);
}

const stockStatus = {
  available: "in_stock",
  "low stock": "low_stock",
  "out of stock": "out_of_stock",
};
const stockLabel = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  not_listed: "Not listed",
};

if (shouldWrite) {
  for (const product of products) {
    const stock = stockByGtin.get(product.id)?.[0];
    const prices = pricesByGtin.get(product.id)?.[0];
    const status = stock ? (stockStatus[stock.stock] ?? "not_listed") : "not_listed";
    product.stockStatus = status;
    product.stockLabel = stockLabel[status];
    product.deliveryDate = stock?.deliveryDate ?? "";
    product.pricePln = prices?.pricePln ?? "";
    product.priceEur = prices?.priceEur ?? "";
    product.pricePlnCurrency = prices?.pricePlnCurrency ?? "PLN";
    product.priceEurCurrency = prices?.priceEurCurrency ?? "EUR";
    product.priceListed = Boolean(prices);
    product.price = product.pricePln;
    product.currency = product.pricePlnCurrency;
  }
}

const mismatches = [];
for (const product of products) {
  const catalogCandidates = (catalogByGtin.get(product.id) ?? []).filter(
    (candidate) => candidate.ean === product.eanInternal && candidate.code === product.code,
  );
  const catalog = [...catalogCandidates].sort((left, right) => {
    const score = (candidate) =>
      (candidate.name === product.name || (!candidate.name && candidate.code === product.name) ? 100 : 0) +
      (candidate.description && candidate.description !== "-" ? 10 : 0) +
      candidate.pictures.length;
    return score(right) - score(left);
  })[0];
  const expectedPictures = [...new Set(catalogCandidates.flatMap((candidate) => candidate.pictures))]
    .slice(0, 10);
  const stock = stockByGtin.get(product.id)?.[0];
  const prices = pricesByGtin.get(product.id)?.[0];
  const expectedStatus = stock ? (stockStatus[stock.stock] ?? "not_listed") : "not_listed";
  const checks = [
    ["catalog name", product.name, catalog ? (catalog.name || catalog.code) : ""],
    ["catalog description", normalizeText(product.description), catalog?.description === "-" ? "" : (catalog?.description ?? "")],
    ["catalog images", JSON.stringify(product.images), JSON.stringify(expectedPictures)],
    ["catalog weight", product.weight, catalog?.weight ?? ""],
    ["catalog origin", product.origin, catalog?.origin ?? ""],
    ["catalog withdrawn", product.withdrawn, catalog?.withdrawn ?? ""],
    ["stock status", product.stockStatus, expectedStatus],
    ["stock label", product.stockLabel, stockLabel[expectedStatus]],
    ["delivery date", product.deliveryDate, stock?.deliveryDate ?? ""],
    ["price PLN", product.pricePln, prices?.pricePln ?? ""],
    ["price EUR", product.priceEur, prices?.priceEur ?? ""],
    ["PLN currency", product.pricePlnCurrency, prices?.pricePlnCurrency ?? "PLN"],
    ["EUR currency", product.priceEurCurrency, prices?.priceEurCurrency ?? "EUR"],
    ["price listing", product.priceListed, Boolean(prices)],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) mismatches.push(`${product.id} ${field}: app=${JSON.stringify(actual)} feed=${JSON.stringify(expected)}`);
  }
}

if (mismatches.length) {
  console.error(mismatches.slice(0, 30).join("\n"));
  console.error(`${mismatches.length} feed mismatch(es). Run with --write to refresh stock and prices.`);
  process.exit(1);
}

let finalProductBuffer = Buffer.from(JSON.stringify(products));
if (shouldWrite) await writeFile(productPath, finalProductBuffer);
else finalProductBuffer = productBuffer;

const manifest = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  bundleSha256: sha256(finalProductBuffer),
  fingerprintAlgorithm: "SHA-256 of the exact UTF-8 public/data/products.json bytes",
  uniqueProducts: products.length,
  duplicateCatalogRowsMerged: catalogRows.length - catalogByGtin.size,
  duplicateRows: {
    catalog: {
      gtins: duplicateChecks.catalog.gtins,
      extraRows: duplicateChecks.catalog.extraRows,
      conflicts: duplicateChecks.catalog.conflicts.length,
      resolution: "Group by ean_GTIN and select the row whose name exactly matches the JSON product; category-name rows have verified-identical identity and content fields.",
    },
    stock: {
      gtins: duplicateChecks.stock.gtins,
      extraRows: duplicateChecks.stock.extraRows,
      conflicts: duplicateChecks.stock.conflicts.length,
      resolution: "Require one row per ean_GTIN; stop if future duplicates disagree on stock or delivery date.",
    },
    prices: {
      gtins: duplicateChecks.prices.gtins,
      extraRows: duplicateChecks.prices.extraRows,
      conflicts: duplicateChecks.prices.conflicts.length,
      resolution: "Group by ean_GTIN only after verifying all duplicate rows have identical codes, currencies, and prices.",
    },
  },
  allHaveImageUrls: products.every((product) => Array.isArray(product.images) && product.images.length > 0),
  sources: [
    {
      role: "catalog",
      url: SOURCES.catalog,
      contentSha256: canonicalXmlHash(catalogBuffer),
      rawSha256: sha256(catalogBuffer),
      contentHashAlgorithm: "SHA-256 of UTF-8 decoded XML after removing the root <Items> Date attribute",
      itemRows: catalogRows.length,
      uniqueGtin: catalogByGtin.size,
      feedDate: catalogFeed.date,
    },
    {
      role: "stock",
      url: SOURCES.stock,
      contentSha256: canonicalXmlHash(stockBuffer),
      rawSha256: sha256(stockBuffer),
      contentHashAlgorithm: "SHA-256 of UTF-8 decoded XML after removing the root <Items> Date attribute",
      itemRows: stockRows.length,
      uniqueGtin: stockByGtin.size,
      feedDate: stockFeed.date,
    },
    {
      role: "prices",
      url: SOURCES.prices,
      contentSha256: canonicalXmlHash(pricesBuffer),
      rawSha256: sha256(pricesBuffer),
      contentHashAlgorithm: "SHA-256 of UTF-8 decoded XML after removing the root <Items> Date attribute",
      itemRows: pricesRows.length,
      uniqueGtin: pricesByGtin.size,
      feedDate: pricesFeed.date,
    },
  ],
  coverage: {
    stockMatched: products.filter((product) => stockByGtin.has(product.id)).length,
    stockNotListed: products.filter((product) => !stockByGtin.has(product.id)).length,
    pricesMatched: products.filter((product) => pricesByGtin.has(product.id)).length,
    pricesNotListed: products.filter((product) => !pricesByGtin.has(product.id)).length,
  },
};

if (shouldWrite) {
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([writeFile(metaPath, manifestText), writeFile(appMetaPath, manifestText)]);
} else {
  const [saved, appSaved] = await Promise.all([
    readFile(metaPath, "utf8").then(JSON.parse),
    readFile(appMetaPath, "utf8").then(JSON.parse),
  ]);
  const manifestErrors = [];
  if (JSON.stringify(saved) !== JSON.stringify(appSaved)) manifestErrors.push("public and bundled manifests differ");
  if (saved.bundleSha256 !== manifest.bundleSha256) manifestErrors.push("saved bundle fingerprint is stale");
  for (const source of manifest.sources) {
    const prior = saved.sources?.find((item) => item.role === source.role);
    if (prior?.contentSha256 !== source.contentSha256) {
      manifestErrors.push(`${source.role} canonical content hash changed`);
    }
  }
  if (manifestErrors.length) {
    console.error(`${manifestErrors.join("\n")}\nRun npm run sync:feeds, review the changes, and verify again.`);
    process.exit(1);
  }
}
console.log(JSON.stringify({ ok: true, wrote: shouldWrite, ...manifest }, null, 2));
