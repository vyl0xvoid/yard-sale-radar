// Batch geocode sales missing lat/lng using known city coordinates + Nominatim fallback
const fs = require("fs");
const path = require("path");

const SALES_PATH = path.join(__dirname, "..", "data", "sales.json");

// Pre-cached coordinates for Ryan's area cities
const CITY_COORDS = {
  "tampa": [27.9506, -82.4572],
  "lakeland": [28.0395, -81.9498],
  "bartow": [27.8964, -81.8432],
  "plant city": [28.0186, -82.1193],
  "riverview": [27.8764, -82.3265],
  "winter haven": [28.0222, -81.7329],
  "mulberry": [27.8953, -81.9737],
  "brandon": [27.9378, -82.2859],
  "valrico": [27.9323, -82.2365],
  "seffner": [27.9836, -82.2812],
  "dover": [27.9942, -82.2237],
  "clearwater": [27.9659, -82.8001],
  "st petersburg": [27.7676, -82.6403],
  "wesley chapel": [28.2397, -82.3279],
  "lutz": [28.1511, -82.4615],
  "zephyrhills": [28.2336, -82.1812],
  "auburndale": [28.0656, -81.7887],
  "haines city": [28.1142, -81.6179],
  "temple terrace": [28.0353, -82.3893],
  "tarpon springs": [28.1461, -82.7568],
  "spring hill": [28.4767, -82.5476],
  "lithia": [27.8667, -82.2167],
  "fishhawk": [27.8511, -82.2139],
  "land o' lakes": [28.2189, -82.4571],
  "land o lakes": [28.2189, -82.4571],
  "ruskin": [27.7209, -82.4332],
  "palmetto": [27.5214, -82.5723],
  "bradenton": [27.4989, -82.5748],
  "sarasota": [27.3364, -82.5307],
  "apollo beach": [27.7731, -82.4076],
  "sun city center": [27.7158, -82.3532],
  "gibsonton": [27.8342, -82.3831],
  "thonotosassa": [28.0614, -82.2943],
  "dade city": [28.3647, -82.1962],
  "new port richey": [28.2444, -82.7193],
  "port richey": [28.2717, -82.7193],
  "hudson": [28.3644, -82.6932],
  "holiday": [28.1878, -82.7393],
  "largo": [27.9095, -82.7873],
  "pinellas park": [27.8428, -82.6993],
  "dunedin": [28.0197, -82.7718],
  "oldsmar": [28.0342, -82.6651],
  "safety harbor": [28.0078, -82.6929],
  "seminole": [27.8398, -82.7907],
  "kenneth city": [27.8156, -82.7204],
  "madeira beach": [27.7978, -82.7974],
  "treasure island": [27.7695, -82.7693],
  "indian rocks beach": [27.8854, -82.8513],
  "palm harbor": [28.0781, -82.7635],
  "east lake": [28.1100, -82.6946],
  "citrus park": [28.0764, -82.5718],
  "carrollwood": [28.0500, -82.5100],
  "town n country": [28.0106, -82.5762],
  "town 'n' country": [28.0106, -82.5762],
  "facebook marketplace": [27.93, -82.28], // fallback center
};

// Add ", FL" variants
const withFL = {};
for (const [city, coords] of Object.entries(CITY_COORDS)) {
  withFL[city] = coords;
  withFL[`${city}, fl`] = coords;
  withFL[`${city}, florida`] = coords;
}

function matchCity(locationName) {
  if (!locationName) return null;
  const lower = locationName.toLowerCase().trim();

  // Direct match
  if (withFL[lower]) return withFL[lower];

  // Check if location contains a known city
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (lower.includes(city)) return coords;
  }

  return null;
}

// Add slight randomization so pins don't stack perfectly
function jitter(coords) {
  return [
    coords[0] + (Math.random() - 0.5) * 0.02,
    coords[1] + (Math.random() - 0.5) * 0.02,
  ];
}

const sales = JSON.parse(fs.readFileSync(SALES_PATH, "utf8"));
let geocoded = 0;

for (const sale of sales) {
  if (sale.lat && sale.lng) continue;

  const coords = matchCity(sale.locationName) || matchCity(sale.address);
  if (coords) {
    const [lat, lng] = jitter(coords);
    sale.lat = lat;
    sale.lng = lng;
    sale.confidence = 0.7;
    geocoded++;
  }
}

fs.writeFileSync(SALES_PATH, JSON.stringify(sales, null, 2) + "\n");
console.log(`Geocoded ${geocoded} sales from city names. ${sales.filter(s => !s.lat).length} still missing.`);
