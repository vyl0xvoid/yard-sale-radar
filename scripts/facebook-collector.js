const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SALES_PATH = path.join(DATA_DIR, "sales.json");
const PROFILE_DIR = path.join(ROOT, ".chrome-profile-facebook");

// Ryan's areas — 33547 (Lithia) + surrounding cities
// Facebook Marketplace uses lat/lng + radius for location filtering
const SEARCHES = [
  // Marketplace search: yard sale, garage sale, estate sale, moving sale
  // within 40 miles of 33547 (Lithia/FishHawk area: 27.87, -82.21)
  // daysSinceListed=1 to only get recent posts
  "https://www.facebook.com/marketplace/tampa/search?query=yard%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/tampa/search?query=garage%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/tampa/search?query=estate%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/tampa/search?query=moving%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/lakeland/search?query=yard%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/lakeland/search?query=garage%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/lakeland/search?query=estate%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/plant-city/search?query=yard%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/brandon/search?query=yard%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/riverview-fl/search?query=yard%20sale&daysSinceListed=1&sortBy=creation_date_descend",
  "https://www.facebook.com/marketplace/mulberry-fl/search?query=yard%20sale&daysSinceListed=1&sortBy=creation_date_descend",
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
  for (const kw of ["yard sale","garage sale","estate sale","moving sale","tools","records",
    "games","comics","cards","furniture","vintage","lego","pokemon"]) {
    if (normalized.includes(kw)) tags.push(kw);
  }
  return [...new Set(tags)];
}

function getHighPriorityMatches(text) {
  const normalized = String(text || "").toLowerCase();
  return HIGH_PRIORITY_KEYWORDS.filter((kw) => normalized.includes(kw));
}

// Target cities for location matching
const TARGET_AREAS = [
  "lithia", "fishhawk", "mulberry", "lakeland", "brandon",
  "riverview", "plant city", "valrico", "seffner", "dover",
  "tampa", "lutz", "wesley chapel", "zephyrhills", "bartow",
  "winter haven", "auburndale", "haines city"
];

async function humanPause(page, min = 1500, max = 3500) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await page.waitForTimeout(duration);
}

async function scrollToLoadMore(page, scrolls = 3) {
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, 800 + Math.random() * 400);
    await humanPause(page, 1800, 3200);
  }
}

async function collectSearchResults(page, searchUrl) {
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await humanPause(page, 2500, 4000);

    // Dismiss cookie popup if it appears again
    try {
      const cb = await page.locator('button:has-text("Allow"), button:has-text("Accept"), [data-cookiebanner="accept_button"], [data-testid="cookie-policy-manage-dialog-accept-button"]').first();
      if (await cb.isVisible({ timeout: 1500 })) {
        await cb.click();
        await humanPause(page, 1500, 2500);
      }
    } catch {}

    // Check for login wall
    const loginCheck = await page.evaluate(() => {
      return document.querySelector('[data-testid="royal_login_form"]') !== null ||
             document.title.includes("Log in") ||
             document.title.includes("log in");
    });
    if (loginCheck) {
      console.log("[FB] Login required — need to log in first. Run with --login flag.");
      return [];
    }

    // Scroll to load more results
    await scrollToLoadMore(page, 3);

    // Extract listing cards from Marketplace search results
    const listings = await page.evaluate(() => {
      const results = [];
      // FB Marketplace renders listings as links with item IDs
      const links = document.querySelectorAll('a[href*="/marketplace/item/"]');
      const seen = new Set();

      for (const link of links) {
        const href = link.href || "";
        const match = href.match(/\/marketplace\/item\/(\d+)/);
        if (!match) continue;
        const itemId = match[1];
        if (seen.has(itemId)) continue;
        seen.add(itemId);

        // Walk up to find the card container — typically 3-5 levels up
        let card = link;
        for (let i = 0; i < 6; i++) {
          if (card.parentElement) card = card.parentElement;
        }

        const allText = (link.innerText || card.innerText || "").trim();
        const lines = allText.split("\n").map(l => l.trim()).filter(l => l.length > 0 && l.length < 200);

        // FB card text is usually: price line, title line, location line, distance line
        let price = "";
        let title = "";
        let location = "";

        for (const line of lines) {
          // Price line: starts with $, or "Free", or contains currency
          if (!price && (/^\$[\d,]+/.test(line) || /^free$/i.test(line))) {
            price = line;
            continue;
          }
          // Distance line: "12 mi away", "5 miles away"
          if (/^\d+\s*(mi|miles?|km)\b/i.test(line)) continue;
          // Skip very short lines (like "·" separators)
          if (line.length < 3) continue;
          // First substantial text after price = title
          if (!title) {
            title = line;
            continue;
          }
          // Next line = location
          if (!location && line !== title) {
            location = line;
            continue;
          }
        }

        // Fallback: if no title found, use the link's accessible name or first text
        if (!title) {
          title = link.getAttribute("aria-label") || link.textContent?.trim()?.slice(0, 100) || "";
        }
        if (!title || title.length < 3) continue;

        // Get image if available
        const img = link.querySelector("img");
        const imageUrl = img?.src || "";

        results.push({
          itemId,
          title,
          location,
          price,
          imageUrl,
          sourceUrl: `https://www.facebook.com/marketplace/item/${itemId}/`,
        });
      }

      return results;
    });

    return listings;
  } catch (err) {
    const shortUrl = searchUrl.replace("https://www.facebook.com/marketplace/", "");
    console.log(`[FB] ${shortUrl} — ${err.message}`);
    return [];
  }
}

async function runCollector() {
  // Use real Chrome profile so we're logged into Facebook
  const userDataDir = path.join(
    process.env.HOME,
    "Library/Application Support/Google/Chrome"
  );

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    viewport: { width: 1440, height: 1000 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
    ],
  });

  const page = context.pages()[0] || await context.newPage();

  // First check if we're logged into Facebook
  await page.goto("https://www.facebook.com/marketplace/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await humanPause(page, 2000, 3000);

  // Handle cookie consent popup (Meta shows this before anything else)
  try {
    // Look for common cookie consent buttons
    const cookieBtn = await page.locator('button:has-text("Allow"), button:has-text("Accept"), button:has-text("Allow all cookies"), button:has-text("Only allow essential cookies"), [data-cookiebanner="accept_button"], [data-testid="cookie-policy-manage-dialog-accept-button"]').first();
    if (await cookieBtn.isVisible({ timeout: 3000 })) {
      await cookieBtn.click();
      console.log("[FB] Accepted cookie consent");
      await humanPause(page, 2000, 3000);
    }
  } catch {
    // No cookie popup or already accepted — that's fine
  }

  // Sometimes there's a second cookie dialog
  try {
    const cookieBtn2 = await page.locator('[aria-label="Allow all cookies"], [aria-label="Accept all"]').first();
    if (await cookieBtn2.isVisible({ timeout: 2000 })) {
      await cookieBtn2.click();
      console.log("[FB] Accepted second cookie dialog");
      await humanPause(page, 2000, 3000);
    }
  } catch {}

  // Check for login — FB shows either a full login page or a modal overlay
  const isLoggedIn = await page.evaluate(() => {
    const hasLoginForm = document.querySelector('[data-testid="royal_login_form"]');
    const hasLoginModal = document.querySelector('[role="dialog"] input[name="email"], [role="dialog"] input[type="email"]');
    const titleLogin = document.title.toLowerCase().includes("log in");
    return !hasLoginForm && !hasLoginModal && !titleLogin;
  });

  if (!isLoggedIn) {
    console.log("[FB] Not logged in. Please log in in the browser window...");
    console.log("[FB] Waiting up to 2 minutes for you to log in...");
    // Try to close any modal first so user can see the login form
    try {
      const closeBtn = await page.locator('[aria-label="Close"], [role="dialog"] [aria-label="Close"]').first();
      if (await closeBtn.isVisible({ timeout: 1000 })) {
        await closeBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    // Navigate to login page and wait — no polling/refreshing, just watch the URL
    await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded", timeout: 15000 });
    console.log("[FB] Waiting for you to log in... (5 min timeout, page will NOT refresh)");

    // Wait for navigation away from login page (user logs in -> FB redirects)
    try {
      await page.waitForURL(url => !url.includes("/login") && !url.includes("checkpoint"), { timeout: 300000 });
    } catch {
      console.log("[FB] Timed out waiting for login. Run again after logging in.");
      await context.close();
      return 0;
    }
    console.log("[FB] Login successful! Session saved.");
    await page.waitForTimeout(3000);
  }

  console.log("[FB] Logged in. Starting collection...");

  const existing = loadJson(SALES_PATH, []);
  const existingUrls = new Set(existing.map(s => s.sourceUrl).filter(Boolean));
  const allNew = [];
  let imported = 0;

  try {
    for (const searchUrl of SEARCHES) {
      const listings = await collectSearchResults(page, searchUrl);
      const shortUrl = searchUrl.split("query=")[1]?.split("&")[0] || searchUrl;
      console.log(`[FB] ${decodeURIComponent(shortUrl)}: ${listings.length} results`);

      for (const listing of listings) {
        // Update existing listings that are missing images
        if (existingUrls.has(listing.sourceUrl) && listing.imageUrl) {
          const existingSale = existing.find(s => s.sourceUrl === listing.sourceUrl);
          if (existingSale && !existingSale.imageUrl) {
            existingSale.imageUrl = listing.imageUrl;
          }
        }
        if (existingUrls.has(listing.sourceUrl)) continue;
        if (containsBlockedTerms(`${listing.title} ${listing.location}`)) continue;

        const combined = `${listing.title} ${listing.location}`;
        const matches = getHighPriorityMatches(combined);

        const sale = {
          id: `fb-${listing.itemId}`,
          title: listing.title,
          source: "facebook marketplace",
          sourceUrl: listing.sourceUrl,
          description: listing.price ? `${listing.price}` : "",
          locationName: listing.location || "Facebook Marketplace",
          address: listing.location || "",
          lat: null,
          lng: null,
          saleDate: "",
          saleTime: "",
          createdAt: new Date().toISOString(),
          tags: inferTags(combined),
          highPriority: matches.length > 0,
          highPriorityMatches: matches,
          status: "active",
          sourceType: "facebook",
          imageUrl: listing.imageUrl || "",
          confidence: 0.6,
        };

        existingUrls.add(listing.sourceUrl);
        allNew.push(sale);
        imported++;
      }

      // Be polite — long pause between different searches
      await humanPause(page, 3000, 6000);
    }
  } finally {
    await context.close().catch(() => {});
  }

  // Always save — might have updated images on existing listings
  const merged = [...allNew, ...existing];
  saveJson(SALES_PATH, merged);

  console.log(`[FB] Done. ${imported} new listing(s) imported.`);
  return imported;
}

runCollector()
  .then((count) => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[FB] Error:", err.message);
    process.exit(1);
  });
