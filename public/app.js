const saleForm = document.getElementById("sale-form");
const formMessage = document.getElementById("form-message");
const searchInput = document.getElementById("search-input");
const sourceFilter = document.getElementById("source-filter");
const dateFilter = document.getElementById("date-filter");
const saleList = document.getElementById("sale-list");
const savedList = document.getElementById("saved-list");
const alertList = document.getElementById("alert-list");
const priorityList = document.getElementById("priority-list");
const emailLog = document.getElementById("email-log");
const emailMessage = document.getElementById("email-message");
const pollEmailButton = document.getElementById("poll-email-button");
const scrapeButton = document.getElementById("scrape-button");
const scrapeMessage = document.getElementById("scrape-message");
const rssButton = document.getElementById("rss-button");
const rssMessage = document.getElementById("rss-message");
const enrichButton = document.getElementById("enrich-button");
const enrichMessage = document.getElementById("enrich-message");
const bookmarkletCode = document.getElementById("bookmarklet-code");
const countLabel = document.getElementById("count-label");

const map = L.map("map").setView([27.93, -82.18], 10);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let markers = [];
let salesCache = [];

const today = new Date().toISOString().split("T")[0];

// ─── Pin colors Ryan can pick ───────────────────────────────────────────────

const PIN_COLORS = [
  { name: "red", hex: "#e74c3c", label: "New" },
  { name: "green", hex: "#2ecc71", label: "Going" },
  { name: "blue", hex: "#3498db", label: "Maybe" },
  { name: "yellow", hex: "#f1c40f", label: "Checked" },
  { name: "purple", hex: "#9b59b6", label: "Hot" },
  { name: "orange", hex: "#e67e22", label: "Meh" },
];

// ─── Pin shapes by sale type (SVG) ──────────────────────────────────────────

function pinSvg(color, shape) {
  const c = color || "#e74c3c";
  if (shape === "diamond") {
    return `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="2" transform="rotate(45 9 9)" fill="${c}" stroke="#fff" stroke-width="2"/></svg>`;
  }
  if (shape === "square") {
    return `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="${c}" stroke="#fff" stroke-width="2"/></svg>`;
  }
  if (shape === "star") {
    return `<svg width="18" height="18" viewBox="0 0 18 18"><polygon points="9,1 11.5,6.5 17,7 13,11 14,17 9,14 4,17 5,11 1,7 6.5,6.5" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`;
  }
  // Default: circle (yard sale / generic)
  return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="${c}" stroke="#fff" stroke-width="2"/></svg>`;
}

function saleShape(sale) {
  // All sales (yard, garage, estate, community) = circle
  // Different shapes reserved for items (future feature)
  if (sale.itemType === "item") return "star";
  return "circle";
}

function salePinColor(sale) {
  if (sale.pinColor) {
    const found = PIN_COLORS.find((p) => p.name === sale.pinColor);
    if (found) return found.hex;
    return sale.pinColor;
  }
  // Unseen = red
  return "#e74c3c";
}

function makePinIcon(sale) {
  const color = salePinColor(sale);
  const shape = saleShape(sale);
  return L.divIcon({
    className: "",
    html: pinSvg(color, shape),
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setMessage(el, text, isError = false) {
  el.textContent = text;
  el.style.color = isError ? "#ffb3b3" : "";
}

function isExpired(sale) {
  if (!sale.saleDate) return false;
  return sale.saleDate < today;
}

function friendlyDate(dateStr) {
  if (!dateStr) return "Date TBD";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function sourceBadge(sale) {
  const st = sale.sourceType || sale.source || "";
  if (st.includes("estatesales")) return `<span class="source-badge">EstateSales</span>`;
  if (st.includes("yardsalesearch")) return `<span class="source-badge">YardSaleSearch</span>`;
  if (st.includes("craigslist")) return `<span class="source-badge">Craigslist</span>`;
  if (st.includes("facebook")) return `<span class="source-badge">Facebook</span>`;
  return `<span class="source-badge">${st}</span>`;
}

function escapeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ─── Color picker popup ────────────────────────────────────────────────────

function colorPickerHtml(saleId) {
  const dots = PIN_COLORS.map(
    (c) => `<button class="color-dot" data-sale-id="${escapeId(saleId)}" data-color="${c.name}" style="background:${c.hex}" title="${c.label}"></button>`
  ).join("");
  return `<div class="color-picker">${dots}</div>`;
}

// ─── Sale card ──────────────────────────────────────────────────────────────

function saleCard(sale, opts = {}) {
  const expired = isExpired(sale);
  const priorityClass = sale.highPriority ? " priority" : "";
  const expiredClass = expired ? " expired-card" : "";
  const savedClass = sale.saved ? " saved-card" : "";
  const seenClass = sale.seen ? " seen" : " unseen";
  const priorityBadge = sale.highPriority
    ? `<span class="priority-badge">${(sale.highPriorityMatches || []).join(", ")}</span>`
    : "";
  const allDates = sale.saleDates && sale.saleDates.length > 1
    ? sale.saleDates.map(friendlyDate).join(", ")
    : "";
  const pinDot = `<span class="pin-dot" style="background:${salePinColor(sale)}">&nbsp;</span>`;
  const shape = saleShape(sale);
  const t = `${sale.title} ${(sale.tags || []).join(" ")}`.toLowerCase();
  const shapeLabel = t.includes("estate") ? "Estate" : t.includes("community") || t.includes("neighborhood") ? "Community" : t.includes("garage") ? "Garage" : t.includes("moving") ? "Moving" : "Yard";

  const actions = opts.minimal ? "" : `
    <div class="card-actions">
      <button class="btn-save${sale.saved ? " active" : ""}" onclick="toggleSave('${escapeId(sale.id)}')" title="Save">&#9733;</button>
      <button class="btn-dismiss" onclick="dismissSale('${escapeId(sale.id)}')" title="Not interested">&times;</button>
      <button class="btn-color" onclick="toggleColorPicker('${escapeId(sale.id)}')" title="Change color">&#9679;</button>
    </div>
    <div class="color-picker-wrap" id="cp-${escapeId(sale.id)}" style="display:none">${colorPickerHtml(sale.id)}</div>
  `;

  return `
    <article class="sale-card${priorityClass}${expiredClass}${savedClass}${seenClass}" data-sale-id="${escapeId(sale.id)}">
      <h3>${pinDot} ${sale.title}${sourceBadge(sale)} <span class="shape-label">${shapeLabel}</span></h3>
      <div class="sale-meta">
        ${friendlyDate(sale.saleDate)}${sale.saleTime ? ` &bull; ${sale.saleTime}` : ""}${allDates ? `<br />All dates: ${allDates}` : ""}<br />
        ${sale.locationName}${sale.distanceMiles != null ? ` &bull; ${sale.distanceMiles} mi` : ""}<br />
        ${sale.description || ""}
      </div>
      ${priorityBadge}
      ${sale.sourceUrl ? `<p><a href="${sale.sourceUrl}" target="_blank" rel="noreferrer">View listing</a></p>` : ""}
      ${actions}
    </article>
  `;
}

// ─── Actions ────────────────────────────────────────────────────────────────

window.toggleSave = async function (id) {
  try {
    await fetch(`/api/sales/${id}/save`, { method: "POST" });
    await loadSales();
    await loadSaved();
  } catch (e) { console.error(e); }
};

window.dismissSale = async function (id) {
  try {
    await fetch(`/api/sales/${id}/dismiss`, { method: "POST" });
    await loadSales();
    await loadSaved();
  } catch (e) { console.error(e); }
};

window.toggleColorPicker = function (id) {
  const el = document.getElementById(`cp-${id}`);
  if (el) el.style.display = el.style.display === "none" ? "flex" : "none";
};

document.addEventListener("click", async (e) => {
  if (!e.target.classList.contains("color-dot")) return;
  const id = e.target.dataset.saleId;
  const color = e.target.dataset.color;
  try {
    await fetch(`/api/sales/${id}/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
    await loadSales();
    await loadSaved();
  } catch (e) { console.error(e); }
});

// ─── Popup on map ───────────────────────────────────────────────────────────

function salePopup(sale) {
  const colorDots = PIN_COLORS.map(
    (c) => `<span class="popup-color-dot" data-popup-sale="${escapeId(sale.id)}" data-popup-color="${c.name}" style="background:${c.hex};width:16px;height:16px;display:inline-block;border-radius:50%;margin:2px;cursor:pointer;border:2px solid ${sale.pinColor === c.name ? '#fff' : 'transparent'}" title="${c.label}"></span>`
  ).join("");

  return `
    <strong>${sale.title}</strong><br />
    ${friendlyDate(sale.saleDate)}${sale.saleTime ? ` &bull; ${sale.saleTime}` : ""}<br />
    ${sale.locationName}<br />
    ${sale.highPriority ? `<strong style="color:#ff6b9d">${(sale.highPriorityMatches || []).join(", ")}</strong><br />` : ""}
    ${sale.sourceUrl ? `<a href="${sale.sourceUrl}" target="_blank" rel="noreferrer">View listing</a><br />` : ""}
    <div style="margin-top:6px">${colorDots}</div>
  `;
}

// Handle color picks from map popups
document.addEventListener("click", async (e) => {
  if (!e.target.dataset.popupSale) return;
  const id = e.target.dataset.popupSale;
  const color = e.target.dataset.popupColor;
  try {
    await fetch(`/api/sales/${id}/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
    await loadSales();
    await loadSaved();
  } catch (e) { console.error(e); }
});

// ─── Render ─────────────────────────────────────────────────────────────────

function renderSales(sales) {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];

  // Filter out dismissed
  const visible = sales.filter((s) => !s.dismissed);

  // Sort: saved first, then priority, then unseen, then by date, expired last
  const sorted = [...visible].sort((a, b) => {
    const aExp = isExpired(a) ? 1 : 0;
    const bExp = isExpired(b) ? 1 : 0;
    if (aExp !== bExp) return aExp - bExp;
    if (a.saved !== b.saved) return b.saved ? 1 : -1;
    if (a.highPriority !== b.highPriority) return b.highPriority ? 1 : -1;
    if (a.seen !== b.seen) return a.seen ? 1 : -1;
    return (a.saleDate || "9999").localeCompare(b.saleDate || "9999");
  });

  // Group by date
  const groups = new Map();
  for (const sale of sorted) {
    const key = sale.saleDate || "undated";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sale);
  }

  let html = "";
  for (const [dateKey, group] of groups) {
    const expired = dateKey !== "undated" && dateKey < today;
    const label = dateKey === "undated" ? "Date TBD" : friendlyDate(dateKey);
    const suffix = expired ? " (past)" : "";
    html += `<div class="date-group-label">${label}${suffix} &mdash; ${group.length}</div>`;
    html += group.map((s) => saleCard(s)).join("");
  }

  saleList.innerHTML = html || `<p class="note">No sales to show.</p>`;

  // Map pins
  visible.forEach((sale) => {
    if (!sale.lat || !sale.lng) return;
    const icon = makePinIcon(sale);
    const marker = L.marker([sale.lat, sale.lng], { icon }).addTo(map);
    marker.bindPopup(salePopup(sale));
    markers.push(marker);
  });

  const unseen = visible.filter((s) => !s.seen && !isExpired(s)).length;
  const saved = visible.filter((s) => s.saved).length;
  const hp = visible.filter((s) => s.highPriority).length;
  countLabel.textContent = `${unseen} new, ${saved} saved, ${hp} priority`;
}

async function loadSales() {
  const search = encodeURIComponent(searchInput.value.trim());
  const source = encodeURIComponent(sourceFilter.value);
  const date = encodeURIComponent(dateFilter.value);
  const response = await fetch(`/api/sales?search=${search}&source=${source}&date=${date}`, { cache: "no-store" });
  const data = await response.json();
  salesCache = data.sales;
  renderSales(data.sales);
  renderPrioritySales(data.highPriority || []);
  loadAlertPreview();
}

async function loadSaved() {
  const response = await fetch("/api/sales/saved", { cache: "no-store" });
  const data = await response.json();
  savedList.innerHTML = data.sales.length
    ? data.sales.map((s) => saleCard(s, { minimal: true })).join("")
    : `<p class="note">No saved leads yet. Star a sale to save it here.</p>`;
}

function renderPrioritySales(sales) {
  priorityList.innerHTML = sales.length
    ? sales.map((s) => saleCard(s, { minimal: true })).join("")
    : `<p class="note">No collector hits yet. Looking for: lego, pokemon, comics, games, trading cards.</p>`;
}

async function loadAlertPreview() {
  const response = await fetch("/api/alerts/preview", { cache: "no-store" });
  const data = await response.json();
  alertList.innerHTML = data.alerts.length
    ? data.alerts.map((s) => saleCard(s, { minimal: true })).join("")
    : `<p class="note">No current matches for alert rules.</p>`;

  if (data.highPriorityAlerts?.length) {
    renderPrioritySales(data.highPriorityAlerts);
  }
}

async function loadEmailLog() {
  const response = await fetch("/api/email-log", { cache: "no-store" });
  const data = await response.json();
  emailLog.innerHTML = data.messages.length
    ? data.messages
        .map(
          (message) => `
            <article class="email-card">
              <h3>${message.subject || "Untitled email"}</h3>
              <div class="sale-meta">
                ${message.from}<br />
                ${new Date(message.receivedAt).toLocaleString()}<br />
                ${message.preview || ""}
              </div>
              ${message.sourceUrl ? `<p><a href="${message.sourceUrl}" target="_blank" rel="noreferrer">Open extracted link</a></p>` : ""}
            </article>
          `
        )
        .join("")
    : `<p class="note">No ingested emails yet.</p>`;
}

// ─── Form + filter events ───────────────────────────────────────────────────

saleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(saleForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const response = await fetch("/api/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save sale.");
    saleForm.reset();
    setMessage(formMessage, "Sale saved.");
    await loadSales();
  } catch (error) {
    setMessage(formMessage, error.message, true);
  }
});

[searchInput, sourceFilter, dateFilter].forEach((el) => {
  el.addEventListener("input", () => loadSales().catch(console.error));
  el.addEventListener("change", () => loadSales().catch(console.error));
});

pollEmailButton.addEventListener("click", async () => {
  setMessage(emailMessage, "Checking inbox...");
  try {
    const response = await fetch("/api/email-ingestion/test", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not pull inbox.");
    setMessage(emailMessage, `Inbox checked. ${data.messages.length} message(s) logged.`);
    await loadEmailLog();
  } catch (error) {
    setMessage(emailMessage, error.message, true);
  }
});

rssButton.addEventListener("click", async () => {
  setMessage(rssMessage, "Pulling from all sources...");
  try {
    const response = await fetch("/api/collect/rss", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Collection failed.");
    setMessage(rssMessage, data.output || "Collection completed.");
    await loadSales();
  } catch (error) {
    setMessage(rssMessage, error.message, true);
  }
});

enrichButton.addEventListener("click", async () => {
  setMessage(enrichMessage, "Geocoding sales without map pins...");
  try {
    const response = await fetch("/api/enrich-geocode", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Geocode enrichment failed.");
    setMessage(enrichMessage, `Geocoded ${data.enriched} sale(s).`);
    await loadSales();
  } catch (error) {
    setMessage(enrichMessage, error.message, true);
  }
});

scrapeButton.addEventListener("click", async () => {
  setMessage(scrapeMessage, "Running Craigslist scrape...");
  try {
    const response = await fetch("/api/scrape/craigslist", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Craigslist scrape failed.");
    setMessage(scrapeMessage, data.output || "Craigslist scrape completed.");
    await loadSales();
  } catch (error) {
    setMessage(scrapeMessage, error.message, true);
  }
});

// ─── Init ───────────────────────────────────────────────────────────────────

Promise.all([loadSales(), loadSaved(), loadEmailLog()]).catch(console.error);

bookmarkletCode.value = `javascript:(async()=>{const rows=[...document.querySelectorAll('.cl-search-result,.result-row')].slice(0,50);const listings=rows.map((row)=>{const link=row.querySelector('a[href*=\"/\"], .posting-title')?.href||row.querySelector('a')?.href||'';const title=(row.querySelector('.posting-title')?.textContent||row.querySelector('.result-title')?.textContent||'').trim();const meta=(row.innerText||'').trim();return{title,sourceUrl:link,description:meta,locationName:location.hostname.replace('.craigslist.org',''),source:'craigslist live import'};}).filter(x=>x.title&&x.sourceUrl);const r=await fetch('http://localhost:3027/api/import/craigslist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({listings})});const data=await r.json();alert(r.ok?('Imported '+data.imported+' listing(s), skipped '+data.skipped):('Import failed: '+(data.error||'unknown error')));})();`;
