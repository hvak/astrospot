const ESRI_TILES = 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LABELS = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const MOON_EMOJIS = ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'];

let map;
let currentPin = null;
let nearestCdsMarker = null;
let cdsData = null;
let cdsVisible = true;
let suppressMapClick = false;
let searchDebounce = null;

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  initMap();
  buildDayStrip();
  initSearch();
  initControls();
  await mapReady();
  await loadCdsLayer();
  requestGps();
}

function mapReady() {
  return new Promise(resolve => map.on('load', resolve));
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        esri: {
          type: 'raster',
          tiles: [ESRI_TILES],
          tileSize: 256,
          attribution: '© Esri, Maxar, Earthstar Geographics',
        },
        'esri-labels': {
          type: 'raster',
          tiles: [ESRI_LABELS],
          tileSize: 256,
        },
      },
      layers: [
        { id: 'esri-tiles', type: 'raster', source: 'esri' },
        { id: 'esri-labels', type: 'raster', source: 'esri-labels' },
      ],
    },
    center: [-98, 39],
    zoom: 4,
  });

  map.addControl(
    new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }),
    'bottom-right'
  );
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  map.on('click', e => {
    if (suppressMapClick) { suppressMapClick = false; return; }
    // Ignore clicks on overlay UI elements
    if (e.originalEvent.target.closest('#search-box, #pin-panel, #cds-controls, #day-strip')) return;
    placePin(e.lngLat.lat, e.lngLat.lng);
  });
}

function requestGps() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    map.flyTo({ center: [lng, lat], zoom: 9 });
    placePin(lat, lng);
  });
}

// ── CDS layer ──────────────────────────────────────────────────────────────

async function loadCdsLayer() {
  const resp = await fetch('cds_locations.json');
  cdsData = await resp.json();

  const geojson = {
    type: 'FeatureCollection',
    features: cdsData.map(s => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { key: s.key, name: s.name },
    })),
  };

  map.addSource('cds', {
    type: 'geojson',
    data: geojson,
    cluster: true,
    clusterMaxZoom: 9,
    clusterRadius: 50,
  });

  // Cluster circles — size scales with point count
  map.addLayer({
    id: 'cds-clusters',
    type: 'circle',
    source: 'cds',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': [
        'step', ['get', 'point_count'],
        '#2a7fff', 10,
        '#1a6fef', 50,
        '#0a5fdf',
      ],
      'circle-radius': ['step', ['get', 'point_count'], 13, 10, 18, 50, 24],
      'circle-opacity': 0.75,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(150, 200, 255, 0.5)',
    },
  });

  // Individual site circles
  map.addLayer({
    id: 'cds-points',
    type: 'circle',
    source: 'cds',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': '#4a9eff',
      'circle-radius': 6,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#fff',
      'circle-opacity': 0.85,
    },
  });

  // Line from pin to nearest CDS site
  map.addSource('pin-line', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'pin-line-layer',
    type: 'line',
    source: 'pin-line',
    paint: { 'line-color': '#ffd700', 'line-width': 1.5, 'line-dasharray': [4, 3], 'line-opacity': 0.8 },
  });

  // Click individual CDS site
  map.on('click', 'cds-points', e => {
    suppressMapClick = true;
    const { key, name } = e.features[0].properties;
    const coords = e.features[0].geometry.coordinates.slice();
    new maplibregl.Popup({ offset: 8 })
      .setLngLat(coords)
      .setHTML(`<strong>${name}</strong><br><a href="https://www.cleardarksky.com/c/${key}key.html" target="_blank">CDS chart ↗</a>`)
      .addTo(map);
  });

  // Click cluster → zoom to expand
  map.on('click', 'cds-clusters', async e => {
    suppressMapClick = true;
    const feature = e.features[0];
    const zoom = await map.getSource('cds').getClusterExpansionZoom(feature.properties.cluster_id);
    map.easeTo({ center: feature.geometry.coordinates, zoom });
  });

  map.on('mouseenter', 'cds-points', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'cds-points', () => { map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'cds-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'cds-clusters', () => { map.getCanvas().style.cursor = ''; });
}

function toggleCdsLayer(visible) {
  const vis = visible ? 'visible' : 'none';
  ['cds-clusters', 'cds-points'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

// ── Search ─────────────────────────────────────────────────────────────────

function initSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = input.value.trim();
    if (q.length < 3) { results.hidden = true; return; }
    searchDebounce = setTimeout(() => nominatimSearch(q), 350);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { results.hidden = true; input.blur(); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#search-box')) results.hidden = true;
  });
}

async function nominatimSearch(query) {
  const results = document.getElementById('search-results');
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
    const data = await fetch(url, { headers: { 'Accept-Language': 'en' } }).then(r => r.json());
    results.innerHTML = '';
    if (!data.length) { results.hidden = true; return; }
    data.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item.display_name;
      li.addEventListener('mousedown', e => e.preventDefault()); // prevent input blur before click
      li.addEventListener('click', () => {
        document.getElementById('search-input').value = item.display_name.split(',')[0].trim();
        results.hidden = true;
        const lat = parseFloat(item.lat), lng = parseFloat(item.lon);
        map.flyTo({ center: [lng, lat], zoom: 10 });
        placePin(lat, lng);
      });
      results.appendChild(li);
    });
    results.hidden = false;
  } catch {
    results.hidden = true;
  }
}

// ── Controls ───────────────────────────────────────────────────────────────

function initControls() {
  document.getElementById('cds-toggle').addEventListener('click', () => {
    cdsVisible = !cdsVisible;
    document.getElementById('cds-toggle').classList.toggle('active', cdsVisible);
    if (map.getLayer('cds-points')) toggleCdsLayer(cdsVisible);
  });

  document.getElementById('clearoutside-btn').addEventListener('click', () => {
    const { lat, lng } = map.getCenter();
    window.open(`https://clearoutside.com/forecast/${lat.toFixed(4)}/${lng.toFixed(4)}`, '_blank');
  });

  document.getElementById('close-panel').addEventListener('click', closePanel);
}

function closePanel() {
  document.getElementById('pin-panel').classList.add('hidden');
  if (currentPin) { currentPin.remove(); currentPin = null; }
  if (nearestCdsMarker) { nearestCdsMarker.remove(); nearestCdsMarker = null; }
  if (map.getSource('pin-line')) map.getSource('pin-line').setData(emptyFC());
}

// ── 7-day strip ────────────────────────────────────────────────────────────

function moonEmoji(phase) {
  return MOON_EMOJIS[Math.round(phase * 8) % 8];
}

function buildDayStrip() {
  const strip = document.getElementById('day-strip');
  const today = new Date();
  today.setHours(21, 0, 0, 0); // evening time for moon phase relevance

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const moon = SunCalc.getMoonIllumination(date);
    const emoji = moonEmoji(moon.phase);
    const pct = Math.round(moon.fraction * 100);

    const label = i === 0
      ? 'Today'
      : date.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

    // Brighter moon = warmer blue tint (worse for astrophotography)
    const alpha = moon.fraction * 0.4;
    const bg = `rgba(140, 180, 255, ${alpha})`;

    const pill = document.createElement('div');
    pill.className = 'day-pill';
    pill.style.background = bg;
    pill.innerHTML = `
      <span class="day-label">${label}</span>
      <span class="moon-icon">${emoji}</span>
      <span class="moon-frac">${pct}%</span>
    `;
    strip.appendChild(pill);
  }
}

// ── Pin + info panel ───────────────────────────────────────────────────────

async function placePin(lat, lng) {
  if (currentPin) currentPin.remove();

  const el = document.createElement('div');
  el.className = 'custom-pin';
  el.textContent = '📍';

  currentPin = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([lng, lat])
    .addTo(map);

  document.getElementById('panel-coords').textContent =
    `${lat >= 0 ? lat.toFixed(4) + '°N' : Math.abs(lat).toFixed(4) + '°S'}  ${lng >= 0 ? lng.toFixed(4) + '°E' : Math.abs(lng).toFixed(4) + '°W'}`;

  const content = document.getElementById('panel-content');
  content.innerHTML = '<p class="loading">Loading…</p>';
  document.getElementById('pin-panel').classList.remove('hidden');

  // Draw line to nearest CDS site and fit map to show both points
  const nearest = cdsData ? findNearestCds(lat, lng) : null;
  if (nearest && map.getSource('pin-line')) {
    map.getSource('pin-line').setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[lng, lat], [nearest.site.lon, nearest.site.lat]] },
        properties: {},
      }],
    });
    map.setPaintProperty('pin-line-layer', 'line-color', nearest.dist < 10 ? '#4caf50' : nearest.dist < 30 ? '#ffd700' : '#e05555');

    if (nearestCdsMarker) nearestCdsMarker.remove();
    const cdsEl = document.createElement('div');
    cdsEl.className = 'custom-pin';
    cdsEl.textContent = '🔭';
    nearestCdsMarker = new maplibregl.Marker({ element: cdsEl, anchor: 'bottom' })
      .setLngLat([nearest.site.lon, nearest.site.lat])
      .addTo(map);
    map.fitBounds(
      [[Math.min(lng, nearest.site.lon), Math.min(lat, nearest.site.lat)],
       [Math.max(lng, nearest.site.lon), Math.max(lat, nearest.site.lat)]],
      { padding: { top: 80, bottom: 100, left: 80, right: 320 }, maxZoom: 12 }
    );
  }

  const [weather, lp] = await Promise.all([
    fetchWeather(lat, lng),
    fetchLightPollution(lat, lng),
  ]);

  const tonight = new Date();
  tonight.setHours(21, 0, 0, 0);
  const moonToday = SunCalc.getMoonIllumination(tonight);

  content.innerHTML = buildPanelHTML({ lat, lng, nearest, weather, lp, moonToday });
}

function findNearestCds(lat, lng) {
  let best = null, bestDist = Infinity;
  for (const site of cdsData) {
    const d = haversine(lat, lng, site.lat, site.lon);
    if (d < bestDist) { bestDist = d; best = site; }
  }
  return best ? { site: best, dist: bestDist } : null;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchWeather(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=cloud_cover,temperature_2m,weather_code,wind_speed_10m`;
    return (await fetch(url).then(r => r.json())).current;
  } catch { return null; }
}

async function fetchLightPollution(lat, lng) {
  try {
    const lonFromDateLine = ((lng + 180) % 360 + 360) % 360;
    const latFromStart = lat + 65.0;
    const tilex = Math.floor(lonFromDateLine / 5.0) + 1;
    const tiley = Math.floor(latFromStart / 5.0) + 1;
    if (tiley < 1 || tiley > 28) return null; // outside coverage (-65 to 75 lat)

    const ix = Math.round(120 * (lonFromDateLine - 5.0 * (tilex - 1) + 1 / 240));
    const iy = Math.round(120 * (latFromStart    - 5.0 * (tiley - 1) + 1 / 240));

    const url = `https://djlorenz.github.io/astronomy/binary_tiles/2024/binary_tile_${tilex}_${tiley}.dat.gz`;
    const buf = await fetch(url).then(r => r.arrayBuffer());
    const data = new Int8Array(pako.ungzip(new Uint8Array(buf)));

    let change = 0;
    const first = 128 * Number(data[0]) + Number(data[1]);
    for (let i = 1; i < iy; i++) change += Number(data[600 * i + 1]);
    for (let i = 1; i < ix; i++) change += Number(data[600 * (iy - 1) + 1 + i]);

    const brightnessRatio = (5 / 195) * (Math.exp(0.0195 * (first + change)) - 1);
    const sqm = 22.0 - 5.0 * Math.log(1.0 + brightnessRatio) / Math.log(100);
    const zone = brightnessToZone(brightnessRatio);
    return { zone, sqm, brightnessRatio };
  } catch { return null; }
}

function brightnessToZone(b) {
  if (b < 0.01)  return '0';
  if (b < 0.06)  return '1a';
  if (b < 0.11)  return '1b';
  if (b < 0.19)  return '2a';
  if (b < 0.33)  return '2b';
  if (b < 0.58)  return '3a';
  if (b < 1.00)  return '3b';
  if (b < 1.73)  return '4a';
  if (b < 3.00)  return '4b';
  if (b < 5.20)  return '5a';
  if (b < 9.00)  return '5b';
  if (b < 15.59) return '6a';
  if (b < 27.00) return '6b';
  if (b < 46.77) return '7a';
  return '7b';
}

const ZONE_INFO = {
  '0':  ['🌑', 'Bortle 1',   '#000'],
  '1a': ['🌑', 'Bortle 1-2', '#222'],
  '1b': ['🌒', 'Bortle 2',   '#424242'],
  '2a': ['🌒', 'Bortle 2-3', '#14306e'],
  '2b': ['🌒', 'Bortle 3',   '#2154d8'],
  '3a': ['🌓', 'Bortle 3-4', '#0f5714'],
  '3b': ['🌓', 'Bortle 4',   '#1fa12a'],
  '4a': ['🌔', 'Bortle 4-5', '#6e641e'],
  '4b': ['🌔', 'Bortle 5',   '#b8a625'],
  '5a': ['🌕', 'Bortle 5-6', '#bf641e'],
  '5b': ['🌕', 'Bortle 6',   '#fd9650'],
  '6a': ['🌖', 'Bortle 6-7', '#fb5a49'],
  '6b': ['🌖', 'Bortle 7',   '#fb998a'],
  '7a': ['🌟', 'Bortle 8',   '#a0a0a0'],
  '7b': ['🌟', 'Bortle 9',   '#f2f2f2'],
};

const WMO = {
  0: ['☀️','Clear sky'], 1: ['🌤','Mainly clear'], 2: ['⛅','Partly cloudy'], 3: ['☁️','Overcast'],
  45: ['🌫','Fog'], 48: ['🌫','Depositing rime fog'],
  51: ['🌦','Light drizzle'], 53: ['🌦','Drizzle'], 55: ['🌧','Heavy drizzle'],
  61: ['🌧','Light rain'], 63: ['🌧','Rain'], 65: ['🌧','Heavy rain'],
  71: ['🌨','Light snow'], 73: ['🌨','Snow'], 75: ['❄️','Heavy snow'], 77: ['🌨','Snow grains'],
  80: ['🌦','Light showers'], 81: ['🌦','Showers'], 82: ['⛈','Heavy showers'],
  85: ['🌨','Snow showers'], 86: ['🌨','Heavy snow showers'],
  95: ['⛈','Thunderstorm'], 96: ['⛈','Thunderstorm + hail'], 99: ['⛈','Thunderstorm + hail'],
};

function cloudEmoji(pct) {
  if (pct <= 15) return '☀️';
  if (pct <= 50) return '⛅';
  if (pct <= 80) return '🌥';
  return '☁️';
}

function buildPanelHTML({ lat, lng, nearest, weather, lp, moonToday }) {
  const rows = [];
  const latStr = lat.toFixed(4), lngStr = lng.toFixed(4);

  // Moon phase tonight
  const mEmoji = moonEmoji(moonToday.phase);
  const mPct = Math.round(moonToday.fraction * 100);
  rows.push(tr(mEmoji, 'Moon tonight', `${mEmoji} ${mPct}% illuminated`));

  // Light pollution
  if (lp) {
    const [emoji, bortle, color] = ZONE_INFO[lp.zone];
    const swatch = `<span style="color:${color};text-shadow:0 0 2px #fff">█</span>`;
    rows.push(tr(emoji, 'Light pollution',
      `${swatch} ${bortle} · SQM ${lp.sqm.toFixed(1)} · Zone ${lp.zone}<br><span style="color:#5a6880;font-size:11px"><a href="https://djlorenz.github.io/astronomy/lp/" target="_blank" style="color:#4a7aaa">Source ↗</a></span>`));
  } else {
    rows.push(tr('🔦', 'Light pollution', 'Unavailable'));
  }

  // Cloud cover
  if (weather) {
    const cc = weather.cloud_cover;
    const ce = cloudEmoji(cc);
    rows.push(tr(ce, 'Cloud cover', `${ce} ${cc}%`));

    const [we, wl] = WMO[weather.weather_code] ?? ['🌡', `Code ${weather.weather_code}`];
    const temp = Math.round(weather.temperature_2m);
    const wind = Math.round(weather.wind_speed_10m);
    rows.push(tr(we, 'Weather', `${we} ${wl} · ${temp}°C · ${wind} km/h`));
  } else {
    rows.push(tr('🌡', 'Weather', 'Unavailable'));
  }

  // Nearest dark sky site
  if (nearest) {
    const { site, dist } = nearest;
    const distStr = dist < 1 ? '<1' : dist < 100 ? dist.toFixed(0) : Math.round(dist / 10) * 10;
    const distColor = dist < 10 ? '#4caf50' : dist < 30 ? '#ffd700' : '#e05555';
    rows.push(tr('🔭', 'Nearest dark site',
      `<a href="https://www.cleardarksky.com/c/${site.key}key.html" target="_blank">${site.name}</a><br><span style="color:${distColor};font-size:11px">${distStr} km away</span>`));
  }

  // External links
  rows.push(tr('🌐', 'ClearOutside',
    `<a href="https://clearoutside.com/forecast/${latStr}/${lngStr}" target="_blank">Open forecast ↗</a>`));
  rows.push(tr('🌤', 'AccuWeather',
    `<a href="https://www.accuweather.com/en/search-locations?query=${latStr},${lngStr}" target="_blank">Open forecast ↗</a>`));

  return `<table class="info-table">${rows.join('')}</table>`;
}

function tr(icon, label, value) {
  return `<tr>
    <td class="info-icon">${icon}</td>
    <td class="info-label">${label}</td>
    <td class="info-value">${value}</td>
  </tr>`;
}

init();
