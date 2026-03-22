// Backfill FB listings that are missing descriptions/dates
// Visits each listing page and scrapes details
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SALES_PATH = path.join(ROOT, "data", "sales.json");
const IMG_DIR = path.join(ROOT, "docs", "data", "img");
const PROFILE_DIR = path.join(ROOT, ".chrome-profile-facebook");

const monthShort = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function parseSaleDates(text) {
  if (!text) return { saleDate: "", saleDates: [], saleTime: "" };
  const year = new Date().getFullYear();
  const dates = [];
  let saleTime = "";

  const monthRegex = new RegExp(`(${monthNames.join("|")}|${monthShort.join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`, "gi");
  let match;
  while ((match = monthRegex.exec(text)) !== null) {
    const monthIdx = monthShort.indexOf(match[1].toLowerCase().slice(0, 3));
    if (monthIdx >= 0) {
      const d = new Date(year, monthIdx, parseInt(match[2]));
      if (!isNaN(d.getTime())) dates.push(d.toISOString().split("T")[0]);
    }
  }

  const slashRegex = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  while ((match = slashRegex.exec(text)) !== null) {
    const m = parseInt(match[1]) - 1;
    const d = parseInt(match[2]);
    const y = match[3] ? (match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3])) : year;
    if (m >= 0 && m < 12 && d > 0 && d <= 31) {
      const date = new Date(y, m, d);
      if (!isNaN(date.getTime())) dates.push(date.toISOString().split("T")[0]);
    }
  }

  const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–to]+\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
  if (timeMatch) saleTime = timeMatch[1].trim();

  const unique = [...new Set(dates)].sort();
  return { saleDate: unique[0] || "", saleDates: unique, saleTime };
}

async function humanPause(page, min = 1500, max = 3000) {
  await page.waitForTimeout(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function downloadImageViaPage(page, url, itemId) {
  if (!url) return "";
  try {
    if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
    const filename = `fb-${itemId}.jpg`;
    const filepath = path.join(IMG_DIR, filename);
    if (fs.existsSync(filepath)) return `data/img/${filename}`;
    const buffer = await page.evaluate(async (imgUrl) => {
      const resp = await fetch(imgUrl);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      const reader = new FileReader();
      return new Promise((resolve) => {
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(blob);
      });
    }, url);
    if (!buffer) return "";
    fs.writeFileSync(filepath, Buffer.from(buffer, "base64"));
    return `data/img/${filename}`;
  } catch { return ""; }
}

async function run() {
  const sales = JSON.parse(fs.readFileSync(SALES_PATH, "utf8"));
  const needsBackfill = sales.filter(s =>
    (s.sourceType || "").includes("facebook") &&
    (!s.description || s.description.length < 10 || s.description === "Free" || s.description.startsWith("$"))
  );

  console.log(`[backfill] ${needsBackfill.length} FB listings need details`);
  if (!needsBackfill.length) return;

  // Clear locks
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch {}
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    viewport: { width: 1440, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled", "--disable-gpu"],
  });

  const page = context.pages()[0] || await context.newPage();
  let updated = 0;
  let imgDownloaded = 0;

  try {
    for (const sale of needsBackfill) {
      try {
        await page.goto(sale.sourceUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await humanPause(page, 2000, 3500);

        // Dismiss popups
        try {
          const closeBtn = await page.locator('[aria-label="Close"]').first();
          if (await closeBtn.isVisible({ timeout: 1000 })) await closeBtn.click();
        } catch {}

        const detail = await page.evaluate(() => {
          let description = "";
          const spans = [...document.querySelectorAll("span")];
          for (const span of spans) {
            const text = span.innerText || "";
            if (text.length > 30 && text.length < 5000 &&
                !text.includes("Marketplace") && !text.includes("Buy and sell") &&
                !text.includes("Log In") && !text.includes("Create new account") &&
                !text.includes("See more on Facebook")) {
              if (text.length > description.length) description = text;
            }
          }

          const images = [];
          for (const img of document.querySelectorAll("img")) {
            const src = img.src || "";
            if (src.includes("scontent") && img.naturalWidth > 200) images.push(src);
          }

          return { description: description.slice(0, 1500), images };
        });

        if (detail.description && detail.description.length > 10) {
          sale.description = detail.description;
          const fullText = `${sale.title} ${detail.description}`;
          const dateInfo = parseSaleDates(fullText);
          if (dateInfo.saleDate) sale.saleDate = dateInfo.saleDate;
          if (dateInfo.saleDates.length) sale.saleDates = dateInfo.saleDates;
          if (dateInfo.saleTime) sale.saleTime = dateInfo.saleTime;

          // Download first image if we don't have one
          if (!sale.imageUrl && detail.images.length) {
            const itemId = sale.id.replace("fb-", "");
            const localPath = await downloadImageViaPage(page, detail.images[0], itemId);
            if (localPath) {
              sale.imageUrl = localPath;
              imgDownloaded++;
            }
          }

          updated++;
          if (updated % 10 === 0) console.log(`[backfill] ${updated}/${needsBackfill.length} done...`);
        }
      } catch (err) {
        // Skip this listing
      }
      await humanPause(page, 1000, 2500);
    }
  } finally {
    await context.close().catch(() => {});
  }

  fs.writeFileSync(SALES_PATH, JSON.stringify(sales, null, 2) + "\n");
  console.log(`[backfill] Done. Updated ${updated} descriptions, downloaded ${imgDownloaded} images.`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
