import pw from "/Users/dotta/paperclip/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
import path from "node:path";
import fs from "node:fs";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const targets = [
  { html: "01-sidebar-desktop.html",          png: "01-sidebar-desktop.png",          width: 1440, height: 900,  dpr: 2 },
  { html: "02-sidebar-mobile.html",           png: "02-sidebar-mobile.png",           width: 390,  height: 844,  dpr: 3 },
  { html: "03-three-dot-menu.html",           png: "03-three-dot-menu.png",           width: 1080,  height: 460,  dpr: 2 },
  { html: "04-create-space-modal-desktop.html", png: "04-create-space-modal-desktop.png", width: 1440, height: 900, dpr: 2 },
  { html: "05-create-space-modal-mobile.html",  png: "05-create-space-modal-mobile.png",  width: 390,  height: 844, dpr: 3 },
  { html: "06-edit-space-desktop.html",       png: "06-edit-space-desktop.png",       width: 1440, height: 900, dpr: 2 },
  { html: "07-edit-space-mobile.html",        png: "07-edit-space-mobile.png",        width: 390,  height: 1320, dpr: 3 },
  { html: "08-add-content-ingest-desktop.html", png: "08-add-content-ingest-desktop.png", width: 1440, height: 900, dpr: 2 },
  { html: "09-add-content-ingest-mobile.html", png: "09-add-content-ingest-mobile.png", width: 390,  height: 1024, dpr: 3 },
];

const browser = await chromium.launch();
for (const t of targets) {
  const ctx = await browser.newContext({
    viewport: { width: t.width, height: t.height },
    deviceScaleFactor: t.dpr,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  const fileUrl = url.pathToFileURL(path.join(here, t.html)).toString();
  await page.goto(fileUrl, { waitUntil: "networkidle" });
  // pad mobile screenshots to fit content
  const out = path.join(here, t.png);
  await page.screenshot({ path: out, fullPage: t.png.includes("mobile") || t.png.startsWith("06-") || t.png.startsWith("07-") });
  console.log("rendered", t.png);
  await ctx.close();
}
await browser.close();
console.log("done");
