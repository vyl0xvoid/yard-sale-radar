const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SALES_PATH = path.join(DATA_DIR, "sales.json");

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

const SEARCHES = [
  { region: "tampa", query: "yard sale", url: "https://tampa.craigslist.org/search/gms?query=yard+sale&sort=date" },
  { region: "tampa", query: "garage sale", url: "https://tampa.craigslist.org/search/gms?query=garage+sale&sort=date" },
  { region: "tampa", query: "estate sale", url: "https://tampa.craigslist.org/search/gms?query=estate+sale&sort=date" },
  { region: "lakeland", query: "yard sale", url: "https://lakeland.craigslist.org/search/gms?query=yard+sale&sort=date" },
  { region: "lakeland", query: "estate sale", url: "https://lakeland.craigslist.org/search/gms?query=estate+sale&sort=date" }
];

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
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
    .slice(0, 50);
}

function containsBlockedTerms(text) {
  const normalized = String(text || "").toLowerCase();
  return BLOCKED_TERMS.some((term) => normalized.includes(term));
}

function highPriorityMatches(text) {
  const normalized = String(text || "").toLowerCase();
  return HIGH_PRIORITY_KEYWORDS.filter((keyword) => normalized.includes(keyword));
}

function inferTags(text) {
  const haystack = text.toLowerCase();
  const tags = [];
  for (const keyword of ["yard sale", "garage sale", "estate sale", "moving sale", "vintage", "tools", "records", "furniture", "games", "comics", "trading cards"]) {
    if (haystack.includes(keyword)) tags.push(keyword);
  }
  return [...new Set(tags)];
}

function parseSaleDate(text) {
  const isoMatch = String(text || "").match(/\d{4}-\d{2}-\d{2}/);
  return isoMatch ? isoMatch[0] : "";
}

async function scrapeListingPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(700);

  return page.evaluate(() => {
    const title = document.querySelector("#titletextonly")?.textContent?.trim() || "";
    const description = document.querySelector("#postingbody")?.textContent?.replace("QR Code Link to This Post", "").trim() || "";
    const time = document.querySelector("time")?.getAttribute("datetime") || "";
    const mapNode = document.querySelector("#map");
    const lat = mapNode ? Number(mapNode.getAttribute("data-latitude")) : null;
    const lng = mapNode ? Number(mapNode.getAttribute("data-longitude")) : null;
    const area = document.querySelector(".postingtitletext small")?.textContent?.replace(/[()]/g, "").trim() || "";
    const attrText = Array.from(document.querySelectorAll(".attrgroup span"))
      .map((el) => el.textContent.trim())
      .join(" | ");

    return {
      title,
      description,
      postedAt: time,
      lat,
      lng,
      area,
      attrText
    };
  });
}

async function scrapeSearch(page, detailPage, search) {
  await page.goto(search.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);

  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".cl-search-result")).slice(0, 20).map((row) => {
      const link = row.querySelector(".posting-title")?.href || "";
      const title = row.querySelector(".posting-title")?.textContent?.trim() || "";
      const meta = row.querySelector(".meta")?.textContent?.trim() || "";
      const location = row.querySelector(".supertitle + .meta .locations")?.textContent?.trim() || "";
      return { link, title, meta, location };
    });
  });

  const results = [];
  for (const row of rows) {
    if (!row.link || !row.title) continue;
    const detail = await scrapeListingPage(detailPage, row.link);
    const combined = `${row.title} ${detail.description} ${detail.attrText}`;
    if (containsBlockedTerms(combined)) continue;

    const matches = highPriorityMatches(combined);
    results.push({
      id: `cl-${slugId(row.title)}-${slugId(row.link.split("/").pop())}`,
      title: row.title,
      source: `craigslist ${search.region}`,
      sourceUrl: row.link,
      description: detail.description.slice(0, 800),
      locationName: detail.area || row.location || search.region,
      address: detail.area || row.location || search.region,
      lat: detail.lat,
      lng: detail.lng,
      saleDate: parseSaleDate(detail.postedAt),
      saleTime: "",
      createdAt: new Date().toISOString(),
      tags: inferTags(combined),
      highPriority: matches.length > 0,
      highPriorityMatches: matches,
      status: "active",
      sourceType: "craigslist-scrape",
      confidence: detail.lat && detail.lng ? 0.93 : 0.72
    });
    await detailPage.waitForTimeout(400);
  }

  return results;
}

async function run() {
  const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    headless: true,
    executablePath
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  const detailPage = await context.newPage();
  let scraped = [];

  try {
    for (const search of SEARCHES) {
      const chunk = await scrapeSearch(page, detailPage, search);
      scraped = scraped.concat(chunk);
    }
  } finally {
    await browser.close();
  }

  const existing = loadJson(SALES_PATH, []);
  const nonScraped = existing.filter((sale) => sale.sourceType !== "craigslist-scrape");
  const deduped = new Map();
  for (const sale of scraped) {
    if (!sale.lat || !sale.lng) continue;
    deduped.set(sale.sourceUrl, sale);
  }

  const next = [...nonScraped, ...Array.from(deduped.values())];
  saveJson(SALES_PATH, next);
  console.log(`Saved ${deduped.size} Craigslist sale(s).`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
