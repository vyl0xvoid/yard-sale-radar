// ─── Static Yard Sale Radar (GitHub Pages) ──────────────────────────────────
// Loads sales.json directly, uses localStorage for save/dismiss/color state.

const searchInput = document.getElementById("search-input");
const sourceFilter = document.getElementById("source-filter");
const dateFilter = document.getElementById("date-filter");
const saleList = document.getElementById("sale-list");
const savedList = document.getElementById("saved-list");
const priorityList = document.getElementById("priority-list");
const countLabel = document.getElementById("count-label");
const lastUpdated = document.getElementById("last-updated");

const map = L.map("map").setView([27.93, -82.18], 10);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let markers = [];
let allSales = [];

const today = new Date().toISOString().split("T")[0];

// High-priority keywords (same as server)
const HP_KEYWORDS = [
  "comic", "comics", "game", "games", "video game", "video games",
  "retro game", "retro games", "trading card", "trading cards",
  "card", "cards", "pokemon", "pokemon cards", "mtg",
  "magic the gathering", "yugioh", "lego", "legos", "duplo"
];

// ─── localStorage helpers ────────────────────────────────────────────────────

function getLocalState() {
  try {
    return JSON.parse(localStorage.getItem("ysr-state") || "{}");
  } catch { return {}; }
}

function saveLocalState(state) {
  localStorage.setItem("ysr-state", JSON.stringify(state));
}

function getSaleState(id) {
  const state = getLocalState();
  return state[id] || {};
}

function setSaleState(id, updates) {
  const state = getLocalState();
  state[id] = { ...(state[id] || {}), ...updates };
  saveLocalState(state);
}

// ─── Pin colors ──────────────────────────────────────────────────────────────

const PIN_COLORS = [
  { name: "red", hex: "#e74c3c", label: "New" },
  { name: "green", hex: "#2ecc71", label: "Going" },
  { name: "blue", hex: "#3498db", label: "Maybe" },
  { name: "yellow", hex: "#f1c40f", label: "Checked" },
  { name: "purple", hex: "#9b59b6", label: "Hot" },
  { name: "orange", hex: "#e67e22", label: "Meh" },
];

function pinSvg(color) {
  const c = color || "#e74c3c";
  return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="${c}" stroke="#fff" stroke-width="2"/></svg>`;
}

function salePinColor(sale) {
  const local = getSaleState(sale.id);
  if (local.pinColor) {
    const found = PIN_COLORS.find(p => p.name === local.pinColor);
    if (found) return found.hex;
  }
  if (sale.pinColor) {
    const found = PIN_COLORS.find(p => p.name === sale.pinColor);
    if (found) return found.hex;
  }
  return "#e74c3c";
}

function makePinIcon(sale) {
  return L.divIcon({
    className: "",
    html: pinSvg(salePinColor(sale)),
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function isSaved(sale) {
  const local = getSaleState(sale.id);
  return local.saved || sale.saved || false;
}

function isDismissed(sale) {
  const local = getSaleState(sale.id);
  return local.dismissed || sale.status === "dismissed" || false;
}

function isHighPriority(sale) {
  if (sale.highPriority) return true;
  const text = `${sale.title} ${sale.description || ""} ${(sale.tags || []).join(" ")}`.toLowerCase();
  return HP_KEYWORDS.some(kw => text.includes(kw));
}

function getHPMatches(sale) {
  if (sale.highPriorityMatches && sale.highPriorityMatches.length) return sale.highPriorityMatches;
  const text = `${sale.title} ${sale.description || ""} ${(sale.tags || []).join(" ")}`.toLowerCase();
  return HP_KEYWORDS.filter(kw => text.includes(kw));
}

// ─── Color picker ────────────────────────────────────────────────────────────

function colorPickerHtml(saleId) {
  const dots = PIN_COLORS.map(
    c => `<button class="color-dot" data-sale-id="${escapeId(saleId)}" data-color="${c.name}" style="background:${c.hex}" title="${c.label}"></button>`
  ).join("");
  return `<div class="color-picker">${dots}</div>`;
}

// ─── Sale card ───────────────────────────────────────────────────────────────

function saleCard(sale, opts = {}) {
  const expired = isExpired(sale);
  const saved = isSaved(sale);
  const hp = isHighPriority(sale);
  const hpMatches = getHPMatches(sale);
  const priorityClass = hp ? " priority" : "";
  const expiredClass = expired ? " expired-card" : "";
  const savedClass = saved ? " saved-card" : "";
  const pinDot = `<span class="pin-dot" style="background:${salePinColor(sale)}">&nbsp;</span>`;
  const t = `${sale.title} ${(sale.tags || []).join(" ")}`.toLowerCase();
  const shapeLabel = t.includes("estate") ? "Estate" : t.includes("community") || t.includes("neighborhood") ? "Community" : t.includes("garage") ? "Garage" : t.includes("moving") ? "Moving" : "Yard";

  const priorityBadge = hp
    ? `<span class="priority-badge">${hpMatches.join(", ")}</span>`
    : "";

  const allDates = sale.saleDates && sale.saleDates.length > 1
    ? sale.saleDates.map(friendlyDate).join(", ")
    : "";

  const actions = opts.minimal ? "" : `
    <div class="card-actions">
      <button class="btn-save${saved ? " active" : ""}" onclick="toggleSave('${escapeId(sale.id)}')" title="Save">&#9733;</button>
      <button class="btn-dismiss" onclick="dismissSale('${escapeId(sale.id)}')" title="Not interested">&times;</button>
      <button class="btn-color" onclick="toggleColorPicker('${escapeId(sale.id)}')" title="Change color">&#9679;</button>
    </div>
    <div class="color-picker-wrap" id="cp-${escapeId(sale.id)}" style="display:none">${colorPickerHtml(sale.id)}</div>
  `;

  return `
    <article class="sale-card${priorityClass}${expiredClass}${savedClass}" data-sale-id="${escapeId(sale.id)}">
      <h3>${pinDot} ${sale.title}${sourceBadge(sale)} <span class="shape-label">${shapeLabel}</span></h3>
      <div class="sale-meta">
        ${friendlyDate(sale.saleDate)}${sale.saleTime ? ` &bull; ${sale.saleTime}` : ""}${allDates ? `<br />All dates: ${allDates}` : ""}<br />
        ${sale.locationName || sale.address || ""}${sale.distanceMiles != null ? ` &bull; ${sale.distanceMiles} mi` : ""}<br />
        ${sale.description || ""}
      </div>
      ${priorityBadge}
      ${sale.sourceUrl ? `<p><a href="${sale.sourceUrl}" target="_blank" rel="noreferrer">View listing</a></p>` : ""}
      ${actions}
    </article>
  `;
}

// ─── Actions (localStorage-backed) ──────────────────────────────────────────

window.toggleSave = function (id) {
  const current = getSaleState(id);
  setSaleState(id, { saved: !current.saved });
  renderAll();
};

window.dismissSale = function (id) {
  setSaleState(id, { dismissed: true });
  renderAll();
};

window.toggleColorPicker = function (id) {
  const el = document.getElementById(`cp-${id}`);
  if (el) el.style.display = el.style.display === "none" ? "flex" : "none";
};

document.addEventListener("click", function (e) {
  if (e.target.classList.contains("color-dot")) {
    const id = e.target.dataset.saleId;
    const color = e.target.dataset.color;
    setSaleState(id, { pinColor: color });
    renderAll();
    return;
  }
  if (e.target.dataset.popupSale) {
    const id = e.target.dataset.popupSale;
    const color = e.target.dataset.popupColor;
    setSaleState(id, { pinColor: color });
    renderAll();
  }
});

// ─── Filtering ───────────────────────────────────────────────────────────────

function getFilteredSales() {
  const search = searchInput.value.trim().toLowerCase();
  const source = sourceFilter.value;
  const date = dateFilter.value;

  return allSales.filter(sale => {
    if (isDismissed(sale)) return false;
    // Hide expired dated sales
    if (sale.saleDate && sale.saleDate < today) return false;
    // Hide undated sales older than 5 days
    if (!sale.saleDate && sale.createdAt) {
      const age = (Date.now() - new Date(sale.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (age > 5) return false;
    }

    if (search) {
      const haystack = `${sale.title} ${sale.description || ""} ${sale.locationName || ""} ${sale.address || ""} ${(sale.tags || []).join(" ")}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    if (source) {
      const st = sale.sourceType || sale.source || "";
      if (!st.includes(source)) return false;
    }

    if (date) {
      if (sale.saleDate !== date) {
        const hasDate = sale.saleDates && sale.saleDates.includes(date);
        if (!hasDate) return false;
      }
    }

    return true;
  });
}

// ─── Map popup ───────────────────────────────────────────────────────────────

function salePopup(sale) {
  const hp = isHighPriority(sale);
  const hpMatches = getHPMatches(sale);
  const localState = getSaleState(sale.id);
  const currentColor = localState.pinColor || sale.pinColor || "";

  const colorDots = PIN_COLORS.map(
    c => `<span class="popup-color-dot" data-popup-sale="${escapeId(sale.id)}" data-popup-color="${c.name}" style="background:${c.hex};width:16px;height:16px;display:inline-block;border-radius:50%;margin:2px;cursor:pointer;border:2px solid ${currentColor === c.name ? '#fff' : 'transparent'}" title="${c.label}"></span>`
  ).join("");

  return `
    <strong>${sale.title}</strong><br />
    ${friendlyDate(sale.saleDate)}${sale.saleTime ? ` &bull; ${sale.saleTime}` : ""}<br />
    ${sale.locationName || sale.address || ""}<br />
    ${hp ? `<strong style="color:#ff6b9d">${hpMatches.join(", ")}</strong><br />` : ""}
    ${sale.sourceUrl ? `<a href="${sale.sourceUrl}" target="_blank" rel="noreferrer">View listing</a><br />` : ""}
    <div style="margin-top:6px">${colorDots}</div>
  `;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderAll() {
  const sales = getFilteredSales();

  // Clear map
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  // Sort: saved first, then priority, then by date, expired last
  const sorted = [...sales].sort((a, b) => {
    const aExp = isExpired(a) ? 1 : 0;
    const bExp = isExpired(b) ? 1 : 0;
    if (aExp !== bExp) return aExp - bExp;
    const aSaved = isSaved(a) ? 1 : 0;
    const bSaved = isSaved(b) ? 1 : 0;
    if (aSaved !== bSaved) return bSaved - aSaved;
    const aHP = isHighPriority(a) ? 1 : 0;
    const bHP = isHighPriority(b) ? 1 : 0;
    if (aHP !== bHP) return bHP - aHP;
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
    html += group.map(s => saleCard(s)).join("");
  }

  saleList.innerHTML = html || `<p class="note">No sales to show.</p>`;

  // Map pins
  sales.forEach(sale => {
    if (!sale.lat || !sale.lng) return;
    const icon = makePinIcon(sale);
    const marker = L.marker([sale.lat, sale.lng], { icon }).addTo(map);
    marker.bindPopup(salePopup(sale));
    markers.push(marker);
  });

  // Counts
  const savedSales = allSales.filter(s => isSaved(s) && !isDismissed(s));
  const hp = sales.filter(s => isHighPriority(s));
  countLabel.textContent = `${sales.length} sales, ${savedSales.length} saved, ${hp.length} priority`;

  // Saved list
  savedList.innerHTML = savedSales.length
    ? savedSales.map(s => saleCard(s, { minimal: true })).join("")
    : `<p class="note">No saved leads yet. Star a sale to save it here.</p>`;

  // Priority list
  const activePriority = hp.filter(s => !isExpired(s));
  priorityList.innerHTML = activePriority.length
    ? activePriority.map(s => saleCard(s, { minimal: true })).join("")
    : `<p class="note">No collector hits yet. Looking for: lego, pokemon, comics, games, trading cards.</p>`;
}

// ─── Filter events ───────────────────────────────────────────────────────────

[searchInput, sourceFilter, dateFilter].forEach(el => {
  el.addEventListener("input", renderAll);
  el.addEventListener("change", renderAll);
});

// ─── Load data ───────────────────────────────────────────────────────────────

async function init() {
  try {
    const resp = await fetch("data/sales.json", { cache: "no-store" });
    if (!resp.ok) throw new Error("Could not load sales data");
    allSales = await resp.json();

    // Show when data was last updated
    const lastMod = resp.headers.get("last-modified");
    if (lastMod) {
      lastUpdated.textContent = `Data last updated: ${new Date(lastMod).toLocaleString()}`;
    }

    renderAll();
  } catch (err) {
    saleList.innerHTML = `<p class="note" style="color:#ffb3b3">Could not load sales data. Try refreshing.</p>`;
    console.error(err);
  }
}

init();
