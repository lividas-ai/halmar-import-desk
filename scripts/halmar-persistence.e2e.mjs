import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.HALMAR_TEST_URL ?? "http://127.0.0.1:8080";
const products = JSON.parse(readFileSync(new URL("../public/data/products.json", import.meta.url), "utf8"));

function deskUrl(token, query = "") {
  const url = new URL("/work", baseUrl);
  url.searchParams.set("category", "all");
  url.searchParams.set("page", "1");
  url.searchParams.set("q", query);
  if (token) url.hash = `desk=${token}`;
  return url.toString();
}

async function waitForDesk(page) {
  await page.locator("header").waitFor();
  await page.waitForFunction(() => {
    const text = document.querySelector("header")?.textContent ?? "";
    return !text.includes("Loading save") && /cloud (ready|r\d+|problem)/.test(text);
  }, null, { timeout: 30_000 });
}

async function openDesk(context, token, query = "") {
  const page = await context.newPage();
  await page.goto(deskUrl(token, query));
  await waitForDesk(page);
  if (query) {
    await page.locator("article").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => /of 1 matching/.test(document.body.innerText), null, { timeout: 30_000 });
  }
  return page;
}

async function markOnlyProduct(page, mark) {
  const cards = page.locator("article");
  assert.equal(await cards.count(), 1);
  await cards.first().getByRole("button", { name: mark === "import" ? "1 Import" : "2 Skip" }).click();
  await page.waitForFunction(() => !(document.querySelector("header")?.textContent ?? "").includes("saving locally"));
}

async function checkpointSingleResult(page) {
  const beforeText = await page.locator("header").innerText();
  const beforeRevision = Number(beforeText.match(/cloud r(\d+)/)?.[1] ?? 0);
  const button = page.getByRole("button", { name: "Save & continue" });
  await button.click();
  try {
    await page.waitForFunction((previous) => {
      const text = document.querySelector("header")?.textContent ?? "";
      const revision = Number(text.match(/cloud r(\d+)/)?.[1] ?? 0);
      return revision > previous && !text.includes("cloud saving");
    }, beforeRevision, { timeout: 30_000 });
  } catch (error) {
    console.error(JSON.stringify({ checkpointTimeout: true, beforeRevision, url: page.url(), header: await page.locator("header").innerText(), body: (await page.locator("body").innerText()).slice(-1_500) }, null, 2));
    throw error;
  }
}

async function markedCount(page) {
  const text = await page.locator("header").innerText();
  return Number(text.match(/(\d+)\/3367 marked/)?.[1] ?? -1);
}

const browser = await chromium.launch({ headless: true });
const consoleErrors = [];
const listenForErrors = (page) => {
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
};

try {
  const original = await browser.newContext({ acceptDownloads: true });
  const page = await original.newPage();
  listenForErrors(page);
  const nextDownloads = [];
  page.on("download", (download) => nextDownloads.push(download.suggestedFilename()));
  await page.goto(deskUrl(""));
  await page.locator("article").first().waitFor({ timeout: 30_000 });
  await waitForDesk(page);

  const firstPageIds = new Set(
    await page.locator("article").evaluateAll((cards) =>
      cards.map((card) => card.querySelector("dd")?.textContent?.trim() ?? ""),
    ),
  );
  const cards = page.locator("article");
  assert.equal(await cards.count(), 9);
  for (let index = 0; index < 9; index += 1) {
    await cards.nth(index).getByRole("button", { name: "1 Import" }).click();
  }
  await page.waitForFunction(() =>
    (document.querySelector("header")?.textContent ?? "").includes("changes pending"),
  );
  await page.getByRole("button", { name: "Next" }).click();
  await page.waitForURL(/page=2/, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const text = document.querySelector("header")?.textContent ?? "";
    return text.includes("cloud r1") && !text.includes("changes pending");
  });
  assert.equal(await markedCount(page), 9);
  assert.deepEqual(nextDownloads, [], "Next must checkpoint, not download a multi-megabyte file");
  const token = await page.evaluate(() => localStorage.getItem("halmar-import-desk-current-v2"));
  assert.match(token ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    new URL(page.url()).hash,
    `#desk=${token}`,
    "internal navigation must preserve the recovery key",
  );

  const candidates = products.filter((product) => !firstPageIds.has(product.id));
  const [leftProduct, rightProduct, conflictProduct, blockedProduct, restartProduct] = [
    candidates[300], candidates[800], candidates[1300], candidates[1800], candidates[2300],
  ];

  const recovered = await browser.newContext();
  const recoveredPage = await openDesk(recovered, token);
  listenForErrors(recoveredPage);
  assert.equal(await markedCount(recoveredPage), 9, "a fresh browser must recover the confirmed checkpoint");

  const leftContext = await browser.newContext();
  const rightContext = await browser.newContext();
  const [leftPage, rightPage] = await Promise.all([
    openDesk(leftContext, token, leftProduct.id),
    openDesk(rightContext, token, rightProduct.id),
  ]);
  listenForErrors(leftPage);
  listenForErrors(rightPage);
  await Promise.all([markOnlyProduct(leftPage, "import"), markOnlyProduct(rightPage, "reject")]);
  await Promise.all([checkpointSingleResult(leftPage), checkpointSingleResult(rightPage)]);

  const unionContext = await browser.newContext();
  const unionPage = await openDesk(unionContext, token);
  listenForErrors(unionPage);
  assert.equal(await markedCount(unionPage), 11, "competing devices must merge independent marks");
  await unionPage.goto(deskUrl(token, leftProduct.id));
  await waitForDesk(unionPage);
  assert.equal(await unionPage.locator("article").getByRole("button", { name: "1 Import" }).getAttribute("aria-pressed"), "true");
  await unionPage.goto(deskUrl(token, rightProduct.id));
  await waitForDesk(unionPage);
  assert.equal(await unionPage.locator("article").getByRole("button", { name: "2 Skip" }).getAttribute("aria-pressed"), "true");

  const olderContext = await browser.newContext();
  const newerContext = await browser.newContext();
  const [olderPage, newerPage] = await Promise.all([
    openDesk(olderContext, token, conflictProduct.id),
    openDesk(newerContext, token, conflictProduct.id),
  ]);
  await markOnlyProduct(olderPage, "import");
  await new Promise((resolve) => setTimeout(resolve, 25));
  await markOnlyProduct(newerPage, "reject");
  await Promise.all([checkpointSingleResult(olderPage), checkpointSingleResult(newerPage)]);
  const conflictCheck = await openDesk(await browser.newContext(), token, conflictProduct.id);
  assert.equal(
    await conflictCheck.locator("article").getByRole("button", { name: "2 Skip" }).getAttribute("aria-pressed"),
    "true",
    "the later explicit edit must win a same-product conflict",
  );

  const blockedContext = await browser.newContext();
  await blockedContext.addInitScript(() => {
    Storage.prototype.setItem = function blockedSetItem() {
      throw new DOMException("Storage blocked for recovery test", "QuotaExceededError");
    };
    if (globalThis.IDBFactory) {
      IDBFactory.prototype.open = function blockedOpen() {
        throw new DOMException("IndexedDB blocked for recovery test", "InvalidStateError");
      };
    }
  });
  const blockedPage = await openDesk(blockedContext, token, blockedProduct.id);
  await markOnlyProduct(blockedPage, "import");
  await blockedPage.waitForFunction(() => {
    const text = document.querySelector("header")?.textContent ?? "";
    return text.includes("local save problem") && /cloud r\d+/.test(text) && !text.includes("cloud saving");
  }, null, { timeout: 30_000 });
  await checkpointSingleResult(blockedPage);
  const blockedCheck = await openDesk(await browser.newContext(), token, blockedProduct.id);
  assert.equal(
    await blockedCheck.locator("article").getByRole("button", { name: "1 Import" }).getAttribute("aria-pressed"),
    "true",
    "cloud recovery must preserve a mark even when all browser storage writes fail",
  );

  const restartContext = await browser.newContext();
  let restartPage = await openDesk(restartContext, token, restartProduct.id);
  await markOnlyProduct(restartPage, "reject");
  await restartPage.close();
  restartPage = await openDesk(restartContext, token, restartProduct.id);
  assert.equal(
    await restartPage.locator("article").getByRole("button", { name: "2 Skip" }).getAttribute("aria-pressed"),
    "true",
    "an uncheckpointed mark must survive closing and reopening the page",
  );
  await checkpointSingleResult(restartPage);

  const backupContext = await browser.newContext({ acceptDownloads: true });
  const backupPage = await openDesk(backupContext, token);
  const backupDownload = backupPage.waitForEvent("download", { timeout: 30_000 });
  await backupPage.getByRole("button", { name: "Download backup" }).click();
  const backup = await backupDownload;
  const backupPath = await backup.path();
  assert.ok(backupPath);
  const backupJson = JSON.parse(readFileSync(backupPath, "utf8"));
  assert.equal(backupJson.formatVersion, 3);
  assert.equal(backupJson.products.length, 3367);
  assert.equal(backupJson.counts.marked, 14);
  assert.equal(backupJson.validation.readyForImport, false);
  assert.equal(backupJson.sourceManifest.coverage.stockMatched, 3318);
  assert.equal(backupJson.sourceManifest.coverage.pricesMatched, 3353);
  assert.equal(JSON.stringify(backupJson).includes(token), false, "download must not expose the private desk token");

  const finalContext = await browser.newContext({ acceptDownloads: true });
  const finalPage = await openDesk(finalContext, "");
  const finalToken = await finalPage.evaluate(() => localStorage.getItem("halmar-import-desk-current-v2"));
  assert.match(finalToken ?? "", /^[A-Za-z0-9_-]{43}$/);
  const restoreDir = mkdtempSync(join(tmpdir(), "halmar-final-"));
  const restorePath = join(restoreDir, "all-marked.json");
  writeFileSync(
    restorePath,
    JSON.stringify({
      app: "halmar-import-desk",
      version: 1,
      updatedAt: Date.now(),
      clientName: "E2E validation",
      note: "Automated full-catalog finalization test",
      decisions: Object.fromEntries(products.map((product, index) => [product.id, index % 2 ? "reject" : "import"])),
    }),
  );
  await finalPage.locator('input[type="file"]').setInputFiles(restorePath);
  await finalPage.waitForFunction(() => (document.querySelector("header")?.textContent ?? "").includes("3367/3367 marked"), null, { timeout: 30_000 });
  await finalPage.getByRole("link", { name: "Chosen" }).click();
  await finalPage.waitForURL(/\/review/, { timeout: 30_000 });
  const finalDownloadPromise = finalPage.waitForEvent("download", { timeout: 60_000 });
  await finalPage.getByRole("button", { name: "Finalize & download JSON" }).click();
  const finalDownload = await finalDownloadPromise;
  const finalPath = await finalDownload.path();
  assert.ok(finalPath);
  const finalJson = JSON.parse(readFileSync(finalPath, "utf8"));
  assert.equal(finalJson.finalized, true);
  assert.equal(finalJson.validation.readyForImport, true);
  assert.deepEqual(finalJson.validation.errors, []);
  assert.deepEqual(finalJson.counts, {
    totalProducts: 3367,
    marked: 3367,
    import: 1684,
    reject: 1683,
    unmarked: 0,
    orphanedDecisions: 0,
  });
  assert.ok(finalJson.cloud.revision >= 1);
  assert.equal(finalJson.catalogFingerprint, finalJson.sourceManifest.bundleSha256);
  assert.equal(finalJson.joinContract.orderedKeys[0].xml, "ean_GTIN");
  assert.equal(JSON.stringify(finalJson).includes(finalToken), false);

  const finalRecovery = await openDesk(await browser.newContext(), finalToken);
  assert.equal(await markedCount(finalRecovery), 3367, "the full final selection must recover from cloud storage");

  assert.deepEqual(consoleErrors, []);
  console.log(JSON.stringify({
    ok: true,
    normalCheckpoint: true,
    nextDownloads: nextDownloads.length,
    competingDeviceUnion: true,
    deterministicConflict: true,
    blockedStorageRecovery: true,
    restartRecovery: true,
    backupValidated: true,
    finalExportValidated: true,
    finalCloudRecovery: true,
  }, null, 2));
} finally {
  await browser.close();
}
