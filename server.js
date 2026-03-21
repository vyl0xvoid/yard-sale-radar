const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const app = express();
const PORT = Number(process.env.PORT) || 3027;
const DATA_DIR = path.join(__dirname, "data");
const SALES_PATH = path.join(DATA_DIR, "sales.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const EMAIL_LOG_PATH = path.join(DATA_DIR, "email-log.json");

const BLOCKED_TERMS = [
  "anal",
  "anus",
  "asshole",
  "bitch",
  "blowjob",
  "boner",
  "cock",
  "cum",
  "cunt",
  "dick",
  "dildo",
  "fuck",
  "fucking",
  "jizz",
  "nude",
  "nudes",
  "penis",
  "porn",
  "pussy",
  "rape",
  "sex",
  "sexual",
  "shit",
  "slut",
  "tit",
  "vagina",
  "whore"
];

const HIGH_PRIORITY_KEYWORDS = [
  "comic",
  "comics",
  "game",
  "games",
  "video game",
  "video games",
  "retro game",
  "retro games",
  "trading card",
  "trading cards",
  "card",
  "cards",
  "pokemon",
  "pokemon cards",
  "mtg",
  "magic the gathering",
  "yugioh",
  "lego",
  "legos",
  "duplo"
];

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2) + "\n");
  }
}

function loadJson(filePath, fallback) {
  ensureFile(filePath, fallback);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function createDefaultSettings() {
  return {
    alertRules: {
      keywords: ["yard sale", "garage sale", "estate sale", "moving sale"],
      radiusMiles: 25,
      weekendOnly: true
    },
    highPriorityRules: {
      keywords: HIGH_PRIORITY_KEYWORDS
    },
    emailIngestion: {
      enabled: false,
      host: "",
      port: 993,
      secure: true,
      user: "",
      password: "",
      mailbox: "INBOX",
      sourceLabelHints: {
        facebook: ["facebook", "marketplace"],
        craigslist: ["craigslist"]
      }
    }
  };
}

function createSeedSales() {
  return [];
}

function createEmailLog() {
  return {
    lastPollAt: null,
    messages: []
  };
}

ensureDir(DATA_DIR);
ensureFile(SALES_PATH, createSeedSales());
ensureFile(SETTINGS_PATH, createDefaultSettings());
ensureFile(EMAIL_LOG_PATH, createEmailLog());

function normalizeText(value) {
  return String(value || "").trim();
}

function slugId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 50);
}

function milesBetween(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocodeAddress(address) {
  const encoded = encodeURIComponent(address);
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encoded}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "yard-sale-radar-localhost"
    }
  });

  if (!response.ok) {
    throw new Error(`Geocoding failed: ${response.status}`);
  }

  const results = await response.json();
  if (!results.length) {
    return null;
  }

  return {
    lat: Number(results[0].lat),
    lng: Number(results[0].lon),
    displayName: results[0].display_name
  };
}

function inferSourceType(sourceText) {
  const normalized = sourceText.toLowerCase();
  if (normalized.includes("facebook")) return "facebook-email";
  if (normalized.includes("craigslist")) return "craigslist-email";
  return "manual";
}

function inferTags(text) {
  const haystack = text.toLowerCase();
  const tags = [];
  for (const keyword of ["yard sale", "garage sale", "estate sale", "moving sale", "vintage", "tools", "records", "furniture"]) {
    if (haystack.includes(keyword)) {
      tags.push(keyword);
    }
  }
  return [...new Set(tags)];
}

function containsBlockedTerms(text) {
  const normalized = text.toLowerCase();
  return BLOCKED_TERMS.some((term) => normalized.includes(term));
}

function getHighPriorityMatches(text, settings) {
  const keywords = settings.highPriorityRules?.keywords || HIGH_PRIORITY_KEYWORDS;
  const normalized = text.toLowerCase();
  return keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
}

function dedupeSales(existingSales, candidate) {
  return existingSales.find((sale) => {
    if (candidate.sourceUrl && sale.sourceUrl && sale.sourceUrl === candidate.sourceUrl) {
      return true;
    }
    return slugId(sale.title) === slugId(candidate.title) && sale.saleDate === candidate.saleDate;
  });
}

function buildSaleRecord(payload, geocoded, settings, confidence = 0.9) {
  const title = normalizeText(payload.title);
  const description = normalizeText(payload.description);
  const sourceUrl = normalizeText(payload.sourceUrl);
  const address = normalizeText(payload.address || payload.locationName);
  const highPriorityMatches = getHighPriorityMatches(`${title} ${description}`, settings);

  return {
    id: payload.id || `${Date.now()}-${slugId(title)}`,
    title,
    source: normalizeText(payload.source || "manual"),
    sourceUrl,
    description,
    locationName: normalizeText(payload.locationName || geocoded?.displayName || address),
    address,
    lat: geocoded?.lat ?? Number(payload.lat),
    lng: geocoded?.lng ?? Number(payload.lng),
    saleDate: normalizeText(payload.saleDate),
    saleTime: normalizeText(payload.saleTime || ""),
    createdAt: new Date().toISOString(),
    tags: inferTags(`${title} ${description}`),
    highPriority: highPriorityMatches.length > 0,
    highPriorityMatches,
    status: "active",
    sourceType: inferSourceType(payload.source || "manual"),
    confidence
  };
}

app.get("/api/sales", (req, res) => {
  const sales = loadJson(SALES_PATH, createSeedSales());
  const settings = loadJson(SETTINGS_PATH, createDefaultSettings());
  const search = normalizeText(req.query.search).toLowerCase();
  const source = normalizeText(req.query.source).toLowerCase();
  const date = normalizeText(req.query.date);

  let filtered = sales.filter((sale) => sale.status === "active");

  if (search) {
    filtered = filtered.filter((sale) =>
      [sale.title, sale.description, sale.tags.join(" "), sale.locationName]
        .join(" ")
        .toLowerCase()
        .includes(search)
    );
  }

  if (source) {
    filtered = filtered.filter((sale) => sale.sourceType.toLowerCase().includes(source));
  }

  if (date) {
    filtered = filtered.filter((sale) => sale.saleDate === date);
  }

  res.json({
    sales: filtered,
    highPriority: filtered.filter((sale) => sale.highPriority),
    settings
  });
});

app.post("/api/sales", async (req, res) => {
  try {
    const sales = loadJson(SALES_PATH, createSeedSales());
    const payload = req.body || {};
    const title = normalizeText(payload.title);
    const description = normalizeText(payload.description);
    const sourceUrl = normalizeText(payload.sourceUrl);
    const address = normalizeText(payload.address);
    const saleDate = normalizeText(payload.saleDate);
    const combinedText = [title, description, sourceUrl, address].join(" ");

    if (!title || !address || !saleDate) {
      res.status(400).json({ error: "Title, address, and sale date are required." });
      return;
    }

    if (containsBlockedTerms(combinedText)) {
      res.status(400).json({ error: "Explicit content is blocked from this radar." });
      return;
    }

    const geocoded = await geocodeAddress(address);
    if (!geocoded) {
      res.status(400).json({ error: "Could not geocode that address." });
      return;
    }

    const settings = loadJson(SETTINGS_PATH, createDefaultSettings());
    const candidate = buildSaleRecord(payload, geocoded, settings, 0.95);

    const duplicate = dedupeSales(sales, candidate);
    if (duplicate) {
      res.status(409).json({ error: "Looks like this sale is already saved.", sale: duplicate });
      return;
    }

    sales.unshift(candidate);
    saveJson(SALES_PATH, sales);
    res.status(201).json({ sale: candidate });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not save sale." });
  }
});

app.post("/api/import/craigslist", async (req, res) => {
  try {
    const sales = loadJson(SALES_PATH, createSeedSales());
    const settings = loadJson(SETTINGS_PATH, createDefaultSettings());
    const listings = Array.isArray(req.body?.listings) ? req.body.listings : [];

    if (!listings.length) {
      res.status(400).json({ error: "No listings supplied." });
      return;
    }

    let imported = 0;
    let skipped = 0;
    for (const listing of listings) {
      const combinedText = [listing.title, listing.description, listing.sourceUrl, listing.locationName].join(" ");
      if (!listing.title || !listing.sourceUrl || containsBlockedTerms(combinedText)) {
        skipped += 1;
        continue;
      }

      const candidate = buildSaleRecord(
        {
          ...listing,
          source: listing.source || "craigslist live import",
          saleDate: listing.saleDate || ""
        },
        listing.lat && listing.lng ? { lat: Number(listing.lat), lng: Number(listing.lng), displayName: listing.locationName } : null,
        settings,
        listing.lat && listing.lng ? 0.9 : 0.7
      );

      const duplicate = dedupeSales(sales, candidate);
      if (duplicate) {
        skipped += 1;
        continue;
      }

      sales.unshift(candidate);
      imported += 1;
    }

    saveJson(SALES_PATH, sales);
    res.json({ ok: true, imported, skipped });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not import Craigslist page." });
  }
});

app.get("/api/settings", (req, res) => {
  res.json(loadJson(SETTINGS_PATH, createDefaultSettings()));
});

app.post("/api/settings", (req, res) => {
  const current = loadJson(SETTINGS_PATH, createDefaultSettings());
  const next = {
    ...current,
    ...req.body,
    alertRules: {
      ...current.alertRules,
      ...(req.body.alertRules || {})
    },
    emailIngestion: {
      ...current.emailIngestion,
      ...(req.body.emailIngestion || {})
    }
  };
  saveJson(SETTINGS_PATH, next);
  res.json(next);
});

// ─── Sale actions: save, dismiss, color-tag ─────────────────────────────────

app.post("/api/sales/:id/tag", (req, res) => {
  const sales = loadJson(SALES_PATH, []);
  const sale = sales.find((s) => s.id === req.params.id);
  if (!sale) {
    res.status(404).json({ error: "Sale not found." });
    return;
  }
  const { color, saved, dismissed } = req.body || {};
  if (color !== undefined) sale.pinColor = color;
  if (saved !== undefined) sale.saved = !!saved;
  if (dismissed !== undefined) {
    sale.dismissed = !!dismissed;
    if (dismissed) sale.status = "dismissed";
  }
  sale.seen = true;
  saveJson(SALES_PATH, sales);
  res.json({ ok: true, sale });
});

app.post("/api/sales/:id/save", (req, res) => {
  const sales = loadJson(SALES_PATH, []);
  const sale = sales.find((s) => s.id === req.params.id);
  if (!sale) {
    res.status(404).json({ error: "Sale not found." });
    return;
  }
  sale.saved = !sale.saved;
  sale.seen = true;
  saveJson(SALES_PATH, sales);
  res.json({ ok: true, sale });
});

app.post("/api/sales/:id/dismiss", (req, res) => {
  const sales = loadJson(SALES_PATH, []);
  const sale = sales.find((s) => s.id === req.params.id);
  if (!sale) {
    res.status(404).json({ error: "Sale not found." });
    return;
  }
  sale.dismissed = true;
  sale.status = "dismissed";
  saveJson(SALES_PATH, sales);
  res.json({ ok: true, sale });
});

app.get("/api/sales/saved", (req, res) => {
  const sales = loadJson(SALES_PATH, []);
  res.json({ sales: sales.filter((s) => s.saved) });
});

app.get("/api/alerts/preview", (req, res) => {
  const sales = loadJson(SALES_PATH, createSeedSales());
  const settings = loadJson(SETTINGS_PATH, createDefaultSettings());
  const origin = {
    lat: 27.9378,
    lng: -82.2859
  };

  const upcoming = sales
    .filter((sale) => sale.status === "active")
    .map((sale) => ({
      ...sale,
      distanceMiles: Number(milesBetween(origin.lat, origin.lng, sale.lat, sale.lng).toFixed(1))
    }))
    .filter((sale) => sale.distanceMiles <= settings.alertRules.radiusMiles)
    .filter((sale) =>
      settings.alertRules.keywords.some((keyword) =>
        `${sale.title} ${sale.description} ${sale.tags.join(" ")}`.toLowerCase().includes(keyword.toLowerCase())
      )
    );

  res.json({
    alerts: upcoming,
    highPriorityAlerts: upcoming.filter((sale) => sale.highPriority)
  });
});

app.post("/api/email-ingestion/test", async (req, res) => {
  const settings = loadJson(SETTINGS_PATH, createDefaultSettings());
  if (!settings.emailIngestion.enabled) {
    res.status(400).json({ error: "Email ingestion is disabled in settings." });
    return;
  }

  if (!settings.emailIngestion.host || !settings.emailIngestion.user || !settings.emailIngestion.password) {
    res.status(400).json({ error: "Email credentials are incomplete." });
    return;
  }

  const client = new ImapFlow({
    host: settings.emailIngestion.host,
    port: settings.emailIngestion.port,
    secure: settings.emailIngestion.secure,
    auth: {
      user: settings.emailIngestion.user,
      pass: settings.emailIngestion.password
    }
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(settings.emailIngestion.mailbox);
    const emailLog = loadJson(EMAIL_LOG_PATH, createEmailLog());

    try {
      const messages = [];
      for await (const message of client.fetch("1:*", { envelope: true, source: true })) {
        const parsed = await simpleParser(message.source);
        const subject = parsed.subject || "";
        const from = parsed.from?.text || "";
        const text = parsed.text || parsed.html || "";
        const sourceUrlMatch = text.match(/https?:\/\/\S+/);

        messages.push({
          id: String(message.uid),
          subject,
          from,
          sourceUrl: sourceUrlMatch ? sourceUrlMatch[0] : "",
          preview: text.slice(0, 280),
          receivedAt: message.envelope?.date || new Date().toISOString()
        });
      }

      emailLog.lastPollAt = new Date().toISOString();
      emailLog.messages = messages.slice(-30).reverse();
      saveJson(EMAIL_LOG_PATH, emailLog);
      res.json(emailLog);
    } finally {
      lock.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not read inbox." });
  } finally {
    await client.logout().catch(() => {});
  }
});

app.get("/api/email-log", (req, res) => {
  res.json(loadJson(EMAIL_LOG_PATH, createEmailLog()));
});

app.post("/api/scrape/craigslist", (req, res) => {
  const scriptPath = path.join(__dirname, "scripts", "craigslist-collector.js");
  execFile(process.execPath, [scriptPath], { cwd: __dirname }, (error, stdout, stderr) => {
    if (error) {
      res.status(500).json({
        error: stderr || error.message || "Craigslist scrape failed."
      });
      return;
    }

    res.json({
      ok: true,
      output: stdout.trim()
    });
  });
});

app.post("/api/collect/rss", (req, res) => {
  const scriptPath = path.join(__dirname, "scripts", "rss-collector.js");
  execFile(process.execPath, [scriptPath], { cwd: __dirname, timeout: 60000 }, (error, stdout, stderr) => {
    if (error) {
      res.status(500).json({
        error: stderr || error.message || "RSS collection failed."
      });
      return;
    }

    res.json({
      ok: true,
      output: stdout.trim()
    });
  });
});

app.post("/api/enrich-geocode", async (req, res) => {
  try {
    const sales = loadJson(SALES_PATH, []);
    let enriched = 0;

    for (const sale of sales) {
      if (sale.lat && sale.lng) continue;
      if (!sale.address && !sale.locationName) continue;

      const geocoded = await geocodeAddress(sale.address || sale.locationName);
      if (geocoded) {
        sale.lat = geocoded.lat;
        sale.lng = geocoded.lng;
        sale.locationName = sale.locationName || geocoded.displayName;
        sale.confidence = Math.max(sale.confidence || 0, 0.85);
        enriched += 1;
      }

      // Respect Nominatim rate limit (1 req/sec)
      await new Promise((r) => setTimeout(r, 1100));
    }

    saveJson(SALES_PATH, sales);
    res.json({ ok: true, enriched });
  } catch (error) {
    res.status(500).json({ error: error.message || "Geocode enrichment failed." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Yard Sale Radar is running at http://localhost:${PORT}`);
  console.log(`Network access: http://192.168.12.160:${PORT}`);
});
