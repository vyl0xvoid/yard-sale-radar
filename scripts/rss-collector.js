const fs = require("fs");
const path = require("path");

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

function getHighPriorityMatches(text) {
  const normalized = String(text || "").toLowerCase();
  return HIGH_PRIORITY_KEYWORDS.filter((kw) => normalized.includes(kw));
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

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const response = await fetch(url, {
    redirect: "follow",
    ...opts,
    headers: { "User-Agent": UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(ms),
  });
  return response;
}

// ─── CRAIGSLIST (search API) ────────────────────────────────────────────────

const CL_SEARCHES = [
  { query: "yard sale", lat: 27.94, lon: -82.29, radius: 40 },
  { query: "garage sale", lat: 27.94, lon: -82.29, radius: 40 },
  { query: "estate sale", lat: 27.94, lon: -82.29, radius: 40 },
  { query: "moving sale", lat: 27.94, lon: -82.29, radius: 40 },
];

function parseItemCoords(locString) {
  const match = String(locString || "").match(/~([-\d.]+)~([-\d.]+)/);
  if (!match) return { lat: null, lng: null };
  return { lat: Number(match[1]), lng: Number(match[2]) };
}

function parseItemDates(dateArray) {
  if (!Array.isArray(dateArray) || dateArray.length < 2) return [];
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return dateArray.slice(1).map((day) => {
    const m = String(month).padStart(2, "0");
    const d = String(Math.floor(day)).padStart(2, "0");
    return `${year}-${m}-${d}`;
  });
}

function extractField(item, tag) {
  for (const el of item) {
    if (Array.isArray(el) && el[0] === tag) return el;
  }
  return null;
}

function buildCLUrl(item, locations, minPostingId) {
  const realId = minPostingId + item[0];
  const locString = String(item[4] || "");
  const locIdx = parseInt(locString.split(":")[0], 10) || 0;
  const locInfo = locations[locIdx];
  const subdomain = Array.isArray(locInfo) ? locInfo[1] : "tampa";
  const subarea = Array.isArray(locInfo) && locInfo.length > 2 ? locInfo[2] : "";
  const slugField = extractField(item, 6);
  const slug = slugField ? slugField[1] : "";
  const sub = subarea ? `${subarea}/` : "";
  const url = slug
    ? `https://${subdomain}.craigslist.org/${sub}gms/d/${slug}/${realId}.html`
    : `https://${subdomain}.craigslist.org/${sub}gms/${realId}.html`;
  return { realId, url };
}

async function collectCraigslist() {
  const results = [];
  for (const search of CL_SEARCHES) {
    try {
      const url = new URL("https://sapi.craigslist.org/web/v8/postings/search/full");
      url.searchParams.set("batch", "50-0-360-0-0");
      url.searchParams.set("cc", "US");
      url.searchParams.set("lang", "en");
      url.searchParams.set("query", search.query);
      url.searchParams.set("searchPath", "gms");
      url.searchParams.set("lat", String(search.lat));
      url.searchParams.set("lon", String(search.lon));
      url.searchParams.set("search_distance", String(search.radius));
      url.searchParams.set("sort", "date");

      const resp = await fetchWithTimeout(url.toString(), { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const json = await resp.json();

      const data = json.data || {};
      const items = data.items || [];
      const locationDescs = data.decode?.locationDescriptions || [];
      const locations = data.decode?.locations || [];
      const minPostingId = data.decode?.minPostingId || 0;

      for (const item of items) {
        const title = item[item.length - 1];
        if (containsBlockedTerms(title)) continue;

        const locString = item[4];
        const coords = parseItemCoords(locString);
        const descMatch = String(locString).match(/^\d+:(\d+)/);
        const descIdx = descMatch ? Number(descMatch[1]) : 0;
        const locationName = locationDescs[descIdx] || "";
        const dateField = extractField(item, 3);
        const saleDates = dateField ? parseItemDates(dateField.slice(1)) : [];
        const { realId, url: sourceUrl } = buildCLUrl(item, locations, minPostingId);
        const matches = getHighPriorityMatches(title);

        results.push({
          id: `cl-api-${realId}`,
          title,
          source: `craigslist (${search.query})`,
          sourceUrl,
          description: "",
          locationName: locationName || "Tampa Bay, FL",
          address: locationName || "Tampa Bay, FL",
          lat: coords.lat,
          lng: coords.lng,
          saleDate: saleDates[0] || "",
          saleDates,
          saleTime: "",
          tags: inferTags(title),
          highPriority: matches.length > 0,
          highPriorityMatches: matches,
          sourceType: "craigslist",
          confidence: coords.lat && coords.lng ? 0.92 : 0.65,
        });
      }
      await new Promise((r) => setTimeout(r, 600));
    } catch (err) {
      console.error(`[craigslist/${search.query}] ${err.message}`);
    }
  }
  return results;
}

// EstateSales.org: fully Angular-rendered, no SSR listings. Skipped.
async function collectEstateSalesOrg() {
  return [];
}

async function _collectEstateSalesOrg_DISABLED() {
  const results = [];
  const ESTATESALES_ORG_PAGES = [];
  for (const pageUrl of ESTATESALES_ORG_PAGES) {
    try {
      const resp = await fetchWithTimeout(pageUrl);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const html = await resp.text();

      // pageData is on one line: window.pageData = {...};dataLayer = [pageData];
      const match = html.match(/window\.pageData\s*=\s*(\{[^;]*\})\s*;/);
      if (!match) {
        console.error(`[estatesales.org] Could not find pageData in ${pageUrl}`);
        continue;
      }

      let pageData;
      try {
        pageData = JSON.parse(match[1]);
      } catch {
        console.error(`[estatesales.org] JSON parse failed for ${pageUrl}`);
        continue;
      }

      // pageData is config only (no listings) — listings load via Angular
      // But the HTML itself has schema.org Event microdata we can parse
      // Fall through to HTML parsing below
      const listings = [];

      // Parse schema.org Event blocks from the HTML instead
      const eventRegex = /<div[^>]*itemtype="http:\/\/schema\.org\/Event"[^>]*class="event[^"]*"[^>]*id="(\d+)"[^>]*>([\s\S]*?)(?=<div[^>]*itemtype="http:\/\/schema\.org\/Event"|<\/section|<footer)/gi;
      let eventMatch;
      while ((eventMatch = eventRegex.exec(html)) !== null) {
        const id = eventMatch[1];
        const block = eventMatch[2];
        const nameM = block.match(/itemprop="name"[^>]*>([\s\S]*?)<\/h2>/i);
        const rawTitle = nameM ? nameM[1].replace(/<[^>]+>/g, "").replace(/\(\d+ photos\)/g, "").trim() : "";
        if (!rawTitle) continue;

        const urlM = block.match(/itemprop="url"\s+href="([^"]+)"/i);
        const latM = block.match(/itemprop="latitude"\s+content="([^"]+)"/i);
        const lngM = block.match(/itemprop="longitude"\s+content="([^"]+)"/i);
        const locM = block.match(/itemprop="addressLocality"[^>]*>([\s\S]*?)<\//i);
        const regM = block.match(/itemprop="addressRegion"[^>]*>([\s\S]*?)<\//i);
        const startM = block.match(/itemprop="startDate"\s+content="([^"]+)"/i);
        const endM = block.match(/itemprop="endDate"\s+content="([^"]+)"/i);
        const descM = block.match(/class="eventdesc"[^>]*>([\s\S]*?)<\/div>/i);

        listings.push({
          id,
          title: rawTitle.replace(/&amp;/g, "&").replace(/&#039;/g, "'"),
          url: urlM ? urlM[1] : "",
          lat: latM ? latM[1] : null,
          lon: lngM ? lngM[1] : null,
          city: locM ? locM[1].replace(/<[^>]+>/g, "").trim() : "",
          state: regM ? regM[1].replace(/<[^>]+>/g, "").trim() : "FL",
          date_from: startM ? startM[1] : "",
          date_to: endM ? endM[1] : "",
          description: descM ? descM[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "",
        });
      }
      for (const listing of listings) {
        const title = listing.title || listing.name || "";
        const description = listing.description || "";
        const combined = `${title} ${description}`;
        if (containsBlockedTerms(combined)) continue;

        const lat = listing.lat || listing.latitude || null;
        const lng = listing.lon || listing.lng || listing.longitude || null;
        const address = [listing.address, listing.city, listing.state, listing.zip]
          .filter(Boolean).join(", ");
        const saleUrl = listing.url
          ? (listing.url.startsWith("http") ? listing.url : `https://www.estatesales.org${listing.url}`)
          : pageUrl;

        const dateFrom = listing.date_from || listing.start_date_time || "";
        const saleDate = dateFrom ? dateFrom.split("T")[0].split(" ")[0] : "";
        const dateTo = listing.date_to || "";
        const saleDates = [];
        if (saleDate) {
          saleDates.push(saleDate);
          if (dateTo) {
            const end = dateTo.split("T")[0].split(" ")[0];
            if (end !== saleDate) saleDates.push(end);
          }
        }

        const matches = getHighPriorityMatches(combined);

        results.push({
          id: `eso-${listing.id || slugId(title)}`,
          title,
          source: "estatesales.org",
          sourceUrl: saleUrl,
          description: description.slice(0, 900),
          locationName: listing.city ? `${listing.city}, ${listing.state || "FL"}` : "Tampa Bay, FL",
          address: address || "Tampa Bay, FL",
          lat: lat ? Number(lat) : null,
          lng: lng ? Number(lng) : null,
          saleDate,
          saleDates,
          saleTime: "",
          tags: inferTags(combined),
          highPriority: matches.length > 0,
          highPriorityMatches: matches,
          sourceType: "estatesales-org",
          confidence: lat && lng ? 0.95 : 0.7,
        });
      }
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      console.error(`[estatesales.org] ${err.message}`);
    }
  }
  return results;
}

// ─── ESTATESALES.NET ────────────────────────────────────────────────────────

const ESTATESALES_NET_ZIPS = ["33601", "33511", "33810", "33569", "33572"];

async function collectEstateSalesNet() {
  const results = [];
  for (const zip of ESTATESALES_NET_ZIPS) {
    try {
      const pageUrl = `https://www.estatesales.net/FL/Tampa/${zip}`;
      const resp = await fetchWithTimeout(pageUrl);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const html = await resp.text();

      // Extract JSON-LD structured data
      const ldMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of ldMatches) {
        try {
          const ld = JSON.parse(m[1]);
          if (ld["@type"] !== "Event" && ld["@type"] !== "SaleEvent") continue;

          const title = ld.name || "";
          const description = ld.description || "";
          const combined = `${title} ${description}`;
          if (containsBlockedTerms(combined)) continue;

          const location = ld.location || {};
          const geo = location.geo || {};
          const lat = geo.latitude || null;
          const lng = geo.longitude || null;
          const address = location.address
            ? [location.address.streetAddress, location.address.addressLocality,
               location.address.addressRegion, location.address.postalCode].filter(Boolean).join(", ")
            : "";
          const saleDate = ld.startDate ? ld.startDate.split("T")[0] : "";
          const endDate = ld.endDate ? ld.endDate.split("T")[0] : "";
          const saleDates = saleDate ? [saleDate] : [];
          if (endDate && endDate !== saleDate) saleDates.push(endDate);

          const matches = getHighPriorityMatches(combined);

          results.push({
            id: `esn-${slugId(ld.url || title)}`,
            title,
            source: "estatesales.net",
            sourceUrl: ld.url || pageUrl,
            description: description.slice(0, 900),
            locationName: location.address?.addressLocality
              ? `${location.address.addressLocality}, ${location.address.addressRegion || "FL"}`
              : "Tampa Bay, FL",
            address: address || "Tampa Bay, FL",
            lat: lat ? Number(lat) : null,
            lng: lng ? Number(lng) : null,
            saleDate,
            saleDates,
            saleTime: "",
            tags: inferTags(combined),
            highPriority: matches.length > 0,
            highPriorityMatches: matches,
            sourceType: "estatesales-net",
            confidence: lat && lng ? 0.95 : 0.7,
          });
        } catch {
          // skip malformed JSON-LD
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      console.error(`[estatesales.net/${zip}] ${err.message}`);
    }
  }
  return results;
}

// ─── YARDSALESEARCH.COM ─────────────────────────────────────────────────────

const YSS_PAGES = [
  "https://www.yardsalesearch.com/garage-sales-in-tampa-fl.html",
  "https://www.yardsalesearch.com/garage-sales-in-brandon-fl.html",
  "https://www.yardsalesearch.com/garage-sales-in-lakeland-fl.html",
  "https://www.yardsalesearch.com/garage-sales-in-riverview-fl.html",
];

async function collectYardSaleSearch() {
  const results = [];
  for (const pageUrl of YSS_PAGES) {
    try {
      const resp = await fetchWithTimeout(pageUrl);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const html = await resp.text();

      // Each listing is a <div class="event row" id="..."> with schema.org microdata
      const eventRegex = /<div[^>]*class="event row"[^>]*id="(\d+)"[^>]*>([\s\S]*?)(?=<div[^>]*class="event row"|<\/section|<footer)/gi;

      let match;
      while ((match = eventRegex.exec(html)) !== null) {
        const listingId = match[1];
        const block = match[2];

        // Title from itemprop="name"
        const nameMatch = block.match(/itemprop="name"[^>]*>([\s\S]*?)<\/h2>/i);
        const rawTitle = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, "").replace(/\(\d+ photos\)/g, "").trim() : "";
        if (!rawTitle) continue;
        const title = rawTitle.replace(/&amp;/g, "&").replace(/&#039;/g, "'").replace(/&quot;/g, '"');

        // URL from itemprop="url"
        const urlMatch = block.match(/itemprop="url"\s+href="([^"]+)"/i);
        const sourceUrl = urlMatch ? urlMatch[1] : `https://www.yardsalesearch.com/yss-garage-sale.jsp?id=${listingId}`;

        // Lat/lng from schema.org GeoCoordinates
        const latMatch = block.match(/itemprop="latitude"\s+content="([^"]+)"/i);
        const lngMatch = block.match(/itemprop="longitude"\s+content="([^"]+)"/i);
        const lat = latMatch ? Number(latMatch[1]) : null;
        const lng = lngMatch ? Number(lngMatch[1]) : null;

        // Location from address microdata
        const localityMatch = block.match(/itemprop="addressLocality"[^>]*>([\s\S]*?)<\//i);
        const regionMatch = block.match(/itemprop="addressRegion"[^>]*>([\s\S]*?)<\//i);
        const locality = localityMatch ? localityMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        const region = regionMatch ? regionMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        const locationName = [locality, region].filter(Boolean).join(", ") || "Tampa Bay, FL";

        // Sale type
        const typeMatch = block.match(/class="sale-header"[^>]*>\s*<div>([\s\S]*?)<\/div>/i);
        const saleType = typeMatch ? typeMatch[1].trim() : "";

        // Dates from itemprop="startDate"
        const startMatch = block.match(/itemprop="startDate"\s+content="([^"]+)"/i);
        const endMatch = block.match(/itemprop="endDate"\s+content="([^"]+)"/i);
        const saleDate = startMatch ? startMatch[1].split("T")[0] : "";
        const endDate = endMatch ? endMatch[1].split("T")[0] : "";
        const saleDates = saleDate ? [saleDate] : [];
        if (endDate && endDate !== saleDate) saleDates.push(endDate);

        // When text
        const whenMatch = block.match(/class="whenLocation[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const saleTime = whenMatch ? whenMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";

        // Description from eventdesc
        const descMatch = block.match(/class="eventdesc"[^>]*>([\s\S]*?)<\/div>/i);
        const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";

        const combined = `${title} ${description} ${saleType}`;
        if (containsBlockedTerms(combined)) continue;

        const matches = getHighPriorityMatches(combined);

        results.push({
          id: `yss-${listingId}`,
          title: saleType ? `[${saleType}] ${title}` : title,
          source: "yardsalesearch.com",
          sourceUrl,
          description: description.slice(0, 900),
          locationName,
          address: locationName,
          lat,
          lng,
          saleDate,
          saleDates,
          saleTime,
          tags: inferTags(combined),
          highPriority: matches.length > 0,
          highPriorityMatches: matches,
          sourceType: "yardsalesearch",
          confidence: lat && lng ? 0.93 : 0.7,
        });
      }
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      console.error(`[yardsalesearch] ${err.message}`);
    }
  }
  return results;
}

// ─── MAIN COLLECTOR ─────────────────────────────────────────────────────────

async function runCollector() {
  const existing = loadJson(SALES_PATH, []);
  const existingUrls = new Set(existing.map((s) => s.sourceUrl).filter(Boolean));
  const existingIds = new Set(existing.map((s) => s.id).filter(Boolean));

  // Expire sales older than 7 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const kept = existing.filter((s) => !s.saleDate || s.saleDate >= cutoffStr);
  const expired = existing.length - kept.length;

  // Collect from all sources in parallel
  const [clResults, esoResults, esnResults, yssResults] = await Promise.all([
    collectCraigslist(),
    collectEstateSalesOrg(),
    collectEstateSalesNet(),
    collectYardSaleSearch(),
  ]);

  const allNew = [...clResults, ...esoResults, ...esnResults, ...yssResults];
  const added = [];

  for (const sale of allNew) {
    if (existingUrls.has(sale.sourceUrl)) continue;
    if (existingIds.has(sale.id)) continue;

    existingUrls.add(sale.sourceUrl);
    existingIds.add(sale.id);
    added.push({
      ...sale,
      createdAt: new Date().toISOString(),
      status: "active",
    });
  }

  if (added.length > 0 || expired > 0) {
    const merged = [...added, ...kept];
    saveJson(SALES_PATH, merged);
  }

  const summary = [
    `CL:${clResults.length}`,
    `ESorg:${esoResults.length}`,
    `ESnet:${esnResults.length}`,
    `YSS:${yssResults.length}`,
  ].join(" ");

  console.log(
    `[${new Date().toISOString()}] Collector: ${summary} | ${added.length} new, ${expired} expired`
  );
  return added.length;
}

runCollector()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
