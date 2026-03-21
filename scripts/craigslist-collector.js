const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SALES_PATH = path.join(DATA_DIR, "sales.json");
const PROFILE_DIR = path.join(ROOT, ".chrome-profile-craigslist");

const SEARCHES = [
  "https://tampa.craigslist.org/search/gms?query=yard+sale&sort=date",
  "https://tampa.craigslist.org/search/gms?query=garage+sale&sort=date",
  "https://tampa.craigslist.org/search/gms?query=estate+sale&sort=date",
  "https://tampa.craigslist.org/search/gms?query=moving+sale&sort=date",
  "https://lakeland.craigslist.org/search/gms?query=yard+sale&sort=date",
  "https://lakeland.craigslist.org/search/gms?query=garage+sale&sort=date",
  "https://lakeland.craigslist.org/search/gms?query=estate+sale&sort=date",
  "https://lakeland.craigslist.org/search/gms?query=moving+sale&sort=date"
];

const BLOCKED_TERMS = [
  "anal","anus","asshole","bitch","blowjob","boner","cock","cum","cunt","dick","dildo",
  "fuck","fucking","jizz","nude","nudes","penis","porn","pussy","rape","sex","sexual",
  "shit","slut","tit","vagina","whore"
];

const HIGH_PRIORITY_KEYWORDS = [
  "comic","comics","game","games","video game","video games","retro game","retro games",
  "trading card","trading cards","card","cards","pokemon","pokemon cards","mtg",
  "magic the gathering","yugioh","lego","legos","duplo"
];

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function slugId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function containsBlockedTerms(text) {
  const normalized = String(text || "").toLowerCase();
  return BLOCKED_TERMS.some((term) => normalized.includes(term));
}

function inferTags(text) {
  const normalized = String(text || "").toLowerCase();
  const tags = [];
  for (const keyword of ["yard sale", "garage sale", "estate sale", "moving sale", "tools", "records", "games", "comics", "cards", "furniture"]) {
    if (normalized.includes(keyword)) tags.push(keyword);
  }
  return [...new Set(tags)];
}

function getHighPriorityMatches(text) {
  const normalized = String(text || "").toLowerCase();
  return HIGH_PRIORITY_KEYWORDS.filter((keyword) => normalized.includes(keyword));
}

function dedupeSales(existingSales, candidate) {
  return existingSales.find((sale) => sale.sourceUrl && candidate.sourceUrl && sale.sourceUrl === candidate.sourceUrl);
}

async function humanPause(page, min = 400, max = 1300) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await page.waitForTimeout(duration);
}

async function collectResultsFromSearch(page, searchUrl) {
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await humanPause(page, 1200, 2200);
  await page.mouse.move(300, 200);
  await humanPause(page, 300, 900);

  const rows = await page.evaluate(() => {
    return [...document.querySelectorAll(".cl-search-result, .result-row")].slice(0, 30).map((row) => {
      const anchor = row.querySelector(".posting-title") || row.querySelector(".result-title");
      const title = anchor?.textContent?.trim() || "";
      const sourceUrl = anchor?.href || "";
      const meta = row.innerText || "";
      return { title, sourceUrl, meta };
    });
  });

  return rows.filter((row) => row.title && row.sourceUrl);
}

async function collectDetail(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await humanPause(page, 600, 1300);

  return page.evaluate(() => {
    const title = document.querySelector("#titletextonly")?.textContent?.trim() || "";
    const description = document.querySelector("#postingbody")?.textContent?.replace("QR Code Link to This Post", "").trim() || "";
    const mapNode = document.querySelector("#map");
    const lat = mapNode?.getAttribute("data-latitude") || "";
    const lng = mapNode?.getAttribute("data-longitude") || "";
    const area = document.querySelector(".postingtitletext small")?.textContent?.replace(/[()]/g, "").trim() || "";
    const postedAt = document.querySelector("time")?.getAttribute("datetime") || "";
    return { title, description, lat, lng, area, postedAt };
  });
}

async function runCollector() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    viewport: { width: 1440, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const page = context.pages()[0] || await context.newPage();
  const detailPage = await context.newPage();
  const existing = loadJson(SALES_PATH, []);
  const kept = existing.filter((sale) => sale.sourceType !== "craigslist-collector");
  let imported = 0;

  try {
    for (const searchUrl of SEARCHES) {
      const rows = await collectResultsFromSearch(page, searchUrl);
      for (const row of rows.slice(0, 12)) {
        const detail = await collectDetail(detailPage, row.sourceUrl);
        const combined = `${row.title} ${detail.description} ${row.meta}`;
        if (containsBlockedTerms(combined)) continue;
        if (!detail.lat || !detail.lng) continue;

        const matches = getHighPriorityMatches(combined);
        const candidate = {
          id: `cl-auto-${slugId(row.sourceUrl.split("/").pop())}`,
          title: detail.title || row.title,
          source: "craigslist automated collector",
          sourceUrl: row.sourceUrl,
          description: detail.description.slice(0, 900),
          locationName: detail.area || "Craigslist Tampa/Lakeland",
          address: detail.area || "Craigslist Tampa/Lakeland",
          lat: Number(detail.lat),
          lng: Number(detail.lng),
          saleDate: "",
          saleTime: "",
          createdAt: new Date().toISOString(),
          tags: inferTags(combined),
          highPriority: matches.length > 0,
          highPriorityMatches: matches,
          status: "active",
          sourceType: "craigslist-collector",
          confidence: 0.93
        };

        if (dedupeSales(kept, candidate)) continue;
        kept.unshift(candidate);
        imported += 1;
      }
    }
  } finally {
    await detailPage.close().catch(() => {});
    await context.close().catch(() => {});
  }

  saveJson(SALES_PATH, kept);
  return imported;
}

runCollector()
  .then((count) => {
    console.log(`Imported ${count} Craigslist listing(s).`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
