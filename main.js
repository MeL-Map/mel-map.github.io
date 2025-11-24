const EMBED = /[?&](embed|embedded)=1/i.test(location.search);
if(EMBED) document.documentElement.classList.add('embed');

const DATA_URLS = {
    locations: 'mapdata/locations.json',
    flows: {
        '20 Years of MeLCat - 2006-2025': 'mapdata/20 Years of MeLCat - 2006-2025.json',
        '2025': 'mapdata/2025.json',
        '2024': 'mapdata/2024.json',
        '2023': 'mapdata/2023.json',
        '2022': 'mapdata/2022.json',
        '2021': 'mapdata/2021.json',
        '2020': 'mapdata/2020.json'
    }
};
let PLACES = [];
let byId = {};
let RAW_FLOWS = [];
let FLOWS = [];
let FLOWS_X = [];
let TOTALS = {};
let FLOW_MIN = 0,
    FLOW_MAX = 1;
let HUB_ID = 'Detroit';
const MONTH_ORDER = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let state = {
    mode: 'all',
    filters: new Set(),
    groups: new Set(),
    months: new Set(),
    monthCumulative: true,
    datasetYear: '20 Years of MeLCat - 2006-2025'
};

function lerp(a, b, t) {
    return a * (1 - t) + b * t;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function bearingDegGeo(sLon, sLat, tLon, tLat) {
    return Math.atan2(tLat - sLat, tLon - sLon) * 180 / Math.PI;
}

function bearingDegScreen(sLon, sLat, tLon, tLat) {
    try {
        const a = map.project([sLon, sLat]);
        const b = map.project([tLon, tLat]);
        const dx = b.x - a.x,
            dy = b.y - a.y;
        return Math.atan2(-dy, dx) * 180 / Math.PI;
    } catch (_) {
        return bearingDegGeo(sLon, sLat, tLon, tLat);
    }
}

function hashStringToFloat01(s) {
    let h = 2166136261 >>> 0;
    for(let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
}

function flowSeed01(flow) {
    return hashStringToFloat01(flow.source + '->' + flow.target);
}

function parseGroupsStr(s) {
    if(!s) return [];
    if(Array.isArray(s)) return s.map(x => String(x));
    if(typeof s === 'string') {
        const t = s.trim();
        if(t === '[]') return [];
        try {
            const arr = JSON.parse(t.replace(/'/g, '"'));
            return Array.isArray(arr) ? arr.map(x => String(x)) : [];
        } catch (e) {
            return [];
        }
    }
    return [];
}
mapboxgl.accessToken = 'pk.eyJ1Ijoid3N1Zmxvd21hcCIsImEiOiJjbWhiNXZ2bWgwdXF3MmtwenIwaTc1azgxIn0.ax1IYU791A58S6pv_met1Q';
const STYLE_URL = 'mapbox://styles/wsuflowmap/cmdnb3xow002k01rv5k9w7b14';

function rasterStyleFromStudio(styleUrl, token, size = 256) {
    const m = /^mapbox:\/\/styles\/([^/]+)\/([^/]+)$/.exec(styleUrl);
    if(!m) throw new Error('Bad style URL: ' + styleUrl);
    const [_, user, styleId] = m;
    const tiles = [
        `https://api.mapbox.com/styles/v1/${user}/${styleId}/tiles/${size}/{z}/{x}/{y}?access_token=${token}`
    ];
    return {
        version: 8,
        sources: {
            'mb-raster': {
                type: 'raster',
                tiles,
                tileSize: size
            }
        },
        layers: [{
            id: 'base',
            type: 'raster',
            source: 'mb-raster',
            paint: {
                'raster-fade-duration': 80
            }
        }]
    };
}

const map = new mapboxgl.Map({
    container: 'map',
    style: rasterStyleFromStudio(STYLE_URL, mapboxgl.accessToken, 256),
    center: [-85.4, 44],
    zoom: 6.5,
    pitch: 40,
    antialias: false,
    attributionControl: true
});
map.addControl(new mapboxgl.AttributionControl({
    compact: true,
    customAttribution: `<a href='https://mapbox.com/about/maps' target ='_blank'>© Mapbox</a> | <a href='https://openstreetmap.org/about/' target ='_blank'>© OpenStreetMap</a> | <a href='https://apps.mapbox.com/feedback' target ='_blank'>Improve this map</a> | <a href='https://mel.org' target ='_blank'>MeL © State of Michigan</a>`
}));
map.addControl(new mapboxgl.NavigationControl({
    visualizePitch: true
}), 'top-right');
map.addControl(new mapboxgl.FullscreenControl());
map.setMinPitch(40);
map.setMaxPitch(40);

let overlay = null;
map.once('load', () => {
    overlay = new deck.MapboxOverlay({
        interleaved: false,
        layers: [],
        glOptions: {
            powerPreference: 'high-performance',
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false
        },
        useDevicePixels: 1
    });
    map.addControl(overlay);
});

let nodesLayer = null,
    nodesDirty = true;
let hoveredNodeId = null;
const datasetSel = document.getElementById('datasetSel');
const monthMulti = document.getElementById('monthMulti');
const monthBtn = document.getElementById('monthBtn');
const monthPanel = document.getElementById('monthPanel');
const searchCity = document.getElementById('searchCity');
const cityList = document.getElementById('cityList');
const chipsEl = document.getElementById('chips');
const resetBtn = document.getElementById('reset');
const groupMulti = document.getElementById('groupMulti');
const groupBtn = document.getElementById('groupBtn');
const groupPanel = document.getElementById('groupPanel');
const radios = document.querySelectorAll('input[name="mode"]');
const RECT_SVG = encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='20' height='6' viewBox='0 0 20 6'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='white' stop-opacity='0'/><stop offset='1' stop-color='white' stop-opacity='1'/></linearGradient></defs><rect x='0' y='0' width='20' height='6' fill='url(#g)'/></svg>`);
const RECT_ATLAS = `data:image/svg+xml;charset=utf-8,${RECT_SVG}`;
const RECT_MAP = {
    rect: {
        x: 0,
        y: 0,
        width: 20,
        height: 6,
        mask: true,
        anchorX: 10,
        anchorY: 3
    }
};
const TRAIL_STEPS = 36;
const RECT_SPEED = 0.022;
const ICON_ASPECT = RECT_MAP.rect.width / RECT_MAP.rect.height;
async function safeFetchJSON(url) {
    try {
        const r = await fetch(url, {
            cache: 'no-store'
        });
        if(!r.ok) return null;
        return await r.json();
    } catch (_) {
        return null;
    }
}
async function loadLocations(url = DATA_URLS.locations) {
    const arr = await safeFetchJSON(url);
    let src = arr;
    PLACES = src.map(p => ({
        id: String(p.id),
        lon: +p.lon,
        lat: +p.lat,
        uni: (typeof p.uni === 'boolean') ? p.uni : String(p.uni).toUpperCase() === 'TRUE',
        groups: parseGroupsStr(p.groups),
        logo: (typeof p.logo === 'string' && p.logo) ? p.logo : null
    }));
    PLACES = PLACES.map(p => {
        const base = Array.isArray(p.groups) ? [...new Set(p.groups)] : [];
        const uniTag = p.uni ? 'Academic' : 'Public';
        if(!base.includes(uniTag)) base.push(uniTag);
        return {
            ...p,
            groups: base
        };
    });
    byId = Object.fromEntries(PLACES.map(p => [p.id.toLowerCase(), p]));
    buildCityList();
    buildGroupPanel();
}
async function loadFlows(year) {
    const url = DATA_URLS.flows[String(year)] || `${year}.json`;
    const arr = await safeFetchJSON(url);
    let src = arr;
    RAW_FLOWS = src.map(r => ({
        origin: String(r.origin),
        dest: String(r.dest),
        month: String(r.month),
        count: +r.count || 0
    }));
}

function deriveMonths() {
    const s = new Set(RAW_FLOWS.map(r => r.month));
    return MONTH_ORDER.filter(m => s.has(m));
}

function buildMonthsPanel() {
    const months = deriveMonths();
    monthPanel.innerHTML = '';
    const cumRow = document.createElement('label');
    cumRow.className = 'check';
    const cumCB = document.createElement('input');
    cumCB.type = 'checkbox';
    cumCB.value = '__cum';
    cumCB.checked = state.monthCumulative;
    cumCB.addEventListener('change', () => {
        state.monthCumulative = cumCB.checked;
        if(cumCB.checked) {
            state.months.clear();
            monthPanel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if(cb !== cumCB) cb.checked = false;
            });
        }
        updateMonthBtnLabel();
        rebuildAggregates();
        render();
    });
    cumRow.appendChild(cumCB);
    const cumSpan = document.createElement('span');
    cumSpan.textContent = 'Cumulative';
    cumRow.appendChild(cumSpan);
    monthPanel.appendChild(cumRow);
    for(const m of months) {
        const row = document.createElement('label');
        row.className = 'check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = m;
        cb.checked = state.months.has(m) && !state.monthCumulative;
        cb.addEventListener('change', () => {
            if(cumCB.checked) {
                cumCB.checked = false;
                state.monthCumulative = false;
            }
            if(cb.checked) state.months.add(m);
            else state.months.delete(m);
            updateMonthBtnLabel();
            rebuildAggregates();
            render();
        });
        row.appendChild(cb);
        const span = document.createElement('span');
        span.textContent = m;
        row.appendChild(span);
        monthPanel.appendChild(row);
    }
    updateMonthBtnLabel();
}

function setMonthsEnabled(enabled) {}

function updateMonthBtnLabel() {
    if(state.monthCumulative) {
        monthBtn.textContent = 'Cumulative';
        return;
    }
    if(state.months.size === 0) {
        monthBtn.textContent = 'Select months…';
        return;
    }
    const arr = MONTH_ORDER.filter(m => state.months.has(m));
    monthBtn.textContent = arr.length <= 4 ? `Months: ${arr.join(', ')}` : `${arr.length} months selected`;
}
monthBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    monthMulti.classList.toggle('open');
    const open = monthMulti.classList.contains('open');
    monthBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.addEventListener('click', (e) => {
    if(!monthMulti.contains(e.target)) {
        monthMulti.classList.remove('open');
        monthBtn.setAttribute('aria-expanded', 'false');
    }
});

function aggregateFlows() {
    const useAll = state.monthCumulative;
    const selected = new Set(state.months);
    const key = (o, d) => `${o}__${d}`;
    const acc = new Map();
    for(const r of RAW_FLOWS) {
        if(!useAll && selected.size > 0 && !selected.has(r.month)) continue;
        const k = key(r.origin, r.dest);
        const prev = acc.get(k) || 0;
        acc.set(k, prev + (+r.count || 0));
    }
    const out = [];
    for(const [k, v] of acc.entries()) {
        const [o, d] = k.split('__');
        if(v > 0) out.push({
            source: o,
            target: d,
            count: v
        });
    }
    return out;
}

function addCoords(flow) {
    const s = byId[flow.source.toLowerCase()];
    const t = byId[flow.target.toLowerCase()];
    if(!s || !t) return null;
    return {
        ...flow,
        sourceLon: s.lon,
        sourceLat: s.lat,
        sourceUni: s.uni,
        sourceGroups: s.groups,
        targetLon: t.lon,
        targetLat: t.lat,
        targetUni: t.uni,
        targetGroups: t.groups
    };
}

function computeTotals(flows) {
    const totals = {};
    for(const p of PLACES) totals[p.id] = {
        in: 0,
        out: 0,
        total: 0
    };
    for(const f of flows) {
        if(!totals[f.source]) totals[f.source] = {
            in: 0,
            out: 0,
            total: 0
        };
        if(!totals[f.target]) totals[f.target] = {
            in: 0,
            out: 0,
            total: 0
        };
        totals[f.source].out += f.count;
        totals[f.target].in += f.count;
    }
    for(const k in totals) totals[k].total = totals[k].in + totals[k].out;
    return totals;
}

function rebuildAggregates() {
    FLOWS = aggregateFlows();
    FLOWS_X = FLOWS.map(addCoords).filter(Boolean);
    TOTALS = computeTotals(FLOWS);
    const counts = FLOWS.map(f => +f.count || 0);
    FLOW_MIN = counts.length ? Math.min(...counts) : 0;
    FLOW_MAX = counts.length ? Math.max(...counts) : 1;
    if(FLOW_MAX === FLOW_MIN) FLOW_MAX = FLOW_MIN + 1;
    let best = HUB_ID,
        bestVal = -1;
    for(const [id, v] of Object.entries(TOTALS)) {
        const tot = v.total || 0;
        if(tot > bestVal) {
            best = id;
            bestVal = tot;
        }
    }
    HUB_ID = best || HUB_ID;
    buildCityList();
    nodesDirty = true;
}

function filterByMode(f) {
    if(state.mode === 'out') return f.source === HUB_ID;
    if(state.mode === 'in') return f.target === HUB_ID;
    return true;
}

function filterBySearch(f) {
    if(state.filters.size === 0) return true;
    for(const name of state.filters) {
        if(f.source === name || f.target === name) return true;
    }
    return false;
}

function nonDetroitGroups(f) {
    if(f.source === HUB_ID) return f.targetGroups;
    if(f.target === HUB_ID) return f.sourceGroups;
    return f.targetGroups?.length ? f.targetGroups : f.sourceGroups;
}

function filterByGroups(f) {
    if(state.groups.size === 0) return true;
    const gs = new Set(nonDetroitGroups(f) || []);
    for(const g of state.groups)
        if(gs.has(g)) return true;
    return false;
}

function filterFlows() {
    return FLOWS_X.filter(f => filterByMode(f) && filterBySearch(f) && filterByGroups(f));
}

function colorByUni(uni, alpha = 220) {
    return uni ? [18, 128, 112, alpha] : [255, 204, 51, alpha];
}

function nonDetroitUni(flow) {
    if(flow.source === HUB_ID) return flow.targetUni;
    if(flow.target === HUB_ID) return flow.sourceUni;
    return (typeof flow.targetUni === 'boolean') ? flow.targetUni : ((typeof flow.sourceUni === 'boolean') ? flow.sourceUni : true);
}

function colorByNonDetroit(flow, alpha = 220) {
    return colorByUni(nonDetroitUni(flow), alpha);
}

function flowSizePx(basePx, count) {
    const norm = clamp01(((+count || 0) - FLOW_MIN) / (FLOW_MAX - FLOW_MIN));
    const s = 0.6 + 4.6 * Math.pow(norm, 1.15);
    return Math.round(basePx * s);
}

function flowDynamics(zoom) {
    const t = clamp01((zoom - 3) / (9 - 3));
    const eased = t * t;
    const steps = Math.round(lerp(7, 56, eased));
    const gap = lerp(1.0, 0.01, eased);
    const basePx = lerp(9, 5.5, t);
    const speed = lerp(1.4, 1.85, eased);
    return {
        steps,
        gap,
        basePx,
        speed
    };
}

function segmentLengthPx(f) {
    try {
        const a = map.project([f.sourceLon, f.sourceLat]);
        const b = map.project([f.targetLon, f.targetLat]);
        return Math.hypot(b.x - a.x, b.y - a.y);
    } catch (_) {
        return 0;
    }
}

function strideAndSizeFor(flow, props) {
    const segPx = segmentLengthPx(flow);
    const baseH = flowSizePx(props.basePx, flow.count);
    const baseW = baseH * ICON_ASPECT;
    const stepsEff = Math.max(1, Math.min(props.steps, Math.round(segPx / Math.max(1, baseW))));
    const stride = Math.max(1, Math.ceil(props.steps / stepsEff));
    const stepPxEff = segPx / stepsEff;
    const maxW = Math.max(2, stepPxEff);
    const sizePx = Math.max(1, Math.min(baseH, maxW / ICON_ASPECT));
    const renderW = sizePx * ICON_ASPECT;
    return {
        stepsEff,
        stride,
        stepPxEff,
        sizePx,
        renderW
    };
}

function fadeAlphaFor(uRaw, halfFrac, fadeLenFrac) {
    const eps = 1e-6;
    const fl = Math.max(eps, fadeLenFrac);
    const fadeIn = clamp01(uRaw / fl);
    const fadeOut = clamp01(((1 - halfFrac) - uRaw) / fl);
    return clamp01(fadeIn * fadeOut);
}

function computeTrailData(ts = 0, respectFilters = false, dyn = null) {
    let flows = respectFilters ? filterFlows() : FLOWS_X;
    if(respectFilters) {
        try {
            const b = map.getBounds();
            flows = flows.filter(f => b.contains([f.sourceLon, f.sourceLat]) || b.contains([f.targetLon, f.targetLat]));
        } catch (_) {}
    }
    const speedZ = dyn?.speed || 1;
    const t = (ts / 1000) * RECT_SPEED * speedZ;
    const steps = dyn?.steps || TRAIL_STEPS;
    const data = [];
    const fudgeAlpha = !respectFilters;
    for(const f of flows) {
        const angle = bearingDegScreen(f.sourceLon, f.sourceLat, f.targetLon, f.targetLat);
        const seed = flowSeed01(f);
        const magNorm = clamp01(((+f.count || 0) - FLOW_MIN) / (FLOW_MAX - FLOW_MIN));
        const speedMul = 0.6 + 0.5 * magNorm + 0.6 * seed;
        const tAdj = t * speedMul;
        const {
            stepsEff,
            sizePx,
            renderW,
            stepPxEff
        } = strideAndSizeFor(f, dyn || flowDynamics(map.getZoom()));
        const stepSpacingEff = 1 / stepsEff;
        const segPxEff = stepsEff * stepPxEff;
        const halfFrac = Math.min(0.49, (renderW / 2) / Math.max(1, segPxEff));
        let lastI = -1;
        for(let j = 0; j < steps; j++) {
            const i = Math.floor(j * stepsEff / steps);
            const visible = (i !== lastI);
            if(!visible) continue;
            lastI = i;
            const phase = (tAdj + i * stepSpacingEff - seed) % 1;
            const uRaw = (phase + 1) % 1;
            const u = Math.min(uRaw, 1 - halfFrac);
            const x = lerp(f.sourceLon, f.targetLon, u);
            const y = lerp(f.sourceLat, f.targetLat, u);
            const fadeLenFrac = clamp01(Math.min(0.20, Math.max(0.02, renderW / Math.max(1, segPxEff))));
            const fadeF = fadeAlphaFor(uRaw, halfFrac, fadeLenFrac);
            const aRaw = Math.round(255 * fadeF);
            const a = fudgeAlpha ? Math.max(1, aRaw) : aRaw;
            const col = colorByNonDetroit(f, a);
            data.push({
                id: `${f.source}->${f.target}:${j}`,
                flow: f,
                position: [x, y],
                angle,
                color: col,
                sizePx
            });
        }
    }
    return data;
}

function nodeTooltipHTML(obj) {
    const t = TOTALS[obj.id] || {
        in: 0,
        out: 0,
        total: 0
    };
    const logo = obj.logo ? `<img class='tt-logo' alt='' src='${obj.logo}'/>` : '';
    return `<div class='tt-header'>${logo}<div class='tt-title'>${obj.id}</div></div>
          <div class='tt-stat'>Received: ${t.in.toLocaleString()}</div>
          <div class='tt-stat'>Loaned: ${t.out.toLocaleString()}</div>`;
}

function makeLayers(ts = 0, zoom = 6) {
    const dyn = flowDynamics(zoom);
    const rectsData = computeTrailData(ts, true, dyn);
    const rects = new deck.IconLayer({
        id: 'flows-rects',
        data: rectsData,
        pickable: true,
        iconAtlas: RECT_ATLAS,
        iconMapping: RECT_MAP,
        getIcon: d => 'rect',
        sizeUnits: 'pixels',
        getSize: d => d.sizePx,
        getPosition: d => d.position,
        getColor: d => d.color,
        getAngle: d => d.angle,
        parameters: {
            depthTest: false
        },
        updateTriggers: {
            getPosition: ts,
            getColor: ts,
            getSize: zoom,
            getAngle: ts
        }
    });
    if(!nodesLayer || nodesDirty) {
        const nodesData = PLACES.map(p => ({
            ...p,
            totals: TOTALS[p.id]
        }));
        const computeRadius = d => 560 + Math.sqrt((d.totals?.total) || 0) * 30;
        for(const d of nodesData) d._radius = computeRadius(d);
        nodesData.sort((a, b) => (b._radius - a._radius) || a.id.localeCompare(b.id));

        nodesLayer = new deck.ScatterplotLayer({
            id: 'nodes',
            data: nodesData,
            pickable: true,
            radiusUnits: 'meters',
            parameters: {
                depthTest: false
            },
            getPosition: d => [d.lon, d.lat],
            getRadius: d => d._radius,
            stroked: true,
            getLineColor: [30, 30, 30, 220],
            lineWidthMinPixels: 1,
            getFillColor: d => (hoveredNodeId && d.id === hoveredNodeId) ? [200, 200, 200, 255] : [255, 255, 255, 230],
            onHover: info => {
                hoveredNodeId = info.object ? info.object.id : null;
            },
            onClick: info => {
                const p = info.object;
                if(!p) return;
                state.filters.add(p.id);
                renderChips();
                render();
            },
            updateTriggers: {
                getFillColor: [() => hoveredNodeId]
            }
        });
        nodesDirty = false;
    }
    return [rects, nodesLayer];
}

function render(ts = 0) {
    if(!overlay) return;
    const zoom = map.getZoom();
    overlay.setProps({
        layers: makeLayers(ts, zoom),
        getTooltip: ({
            layer,
            object
        }) => {
            if(!object) return null;
            if(layer && layer.id === 'flows-rects') {
                const f = object.flow;
                const other = (f.source === HUB_ID) ? byId[f.target.toLowerCase()] : byId[f.source.toLowerCase()];
                return other ? {
                    html: nodeTooltipHTML(other)
                } : null;
            }
            if(layer && layer.id === 'nodes') {
                return {
                    html: nodeTooltipHTML(object)
                };
            }
            return null;
        }
    });
}

function buildCityList() {
    cityList.innerHTML = '';
    for(const p of PLACES) {
        const opt = document.createElement('option');
        opt.value = p.id;
        cityList.appendChild(opt);
    }
}

function renderChips() {
    chipsEl.innerHTML = '';
    for(const name of state.filters) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = name;
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.addEventListener('click', () => {
            state.filters.delete(name);
            render();
            renderChips();
        });
        chip.appendChild(x);
        chipsEl.appendChild(chip);
    }
}

function addFilterFromValue(val) {
    const key = val.toLowerCase();
    const p = byId[key];
    if(p) {
        state.filters.add(p.id);
        renderChips();
        render();
        return true;
    }
    return false;
}

function handleSearchInput() {
    const v = searchCity.value.trim();
    if(!v) return;
    if(addFilterFromValue(v)) searchCity.value = '';
}
searchCity.addEventListener('input', handleSearchInput);
searchCity.addEventListener('change', handleSearchInput);
searchCity.addEventListener('keydown', (e) => {
    if(e.key === 'Enter') {
        e.preventDefault();
        handleSearchInput();
    }
});
const ALL_GROUPS = new Set();

function updateGroupBtnLabel() {
    if(state.groups.size === 0) {
        groupBtn.textContent = 'All groups';
        return;
    }
    const labels = Array.from(state.groups).slice(0, 4);
    groupBtn.textContent = state.groups.size <= 4 ? `Groups: ${labels.join(', ')}` : `${state.groups.size} groups selected`;
}

function buildGroupPanel() {
    ALL_GROUPS.clear();
    PLACES.forEach(p => {
        (p.groups || []).forEach(g => ALL_GROUPS.add(g));
        const uniTag = p.uni ? 'Academic' : 'Public';
        ALL_GROUPS.add(uniTag);
        if(!(p.groups || []).includes(uniTag)) {
            p.groups = [...(p.groups || []), uniTag];
        }
    });
    const rest = Array.from(ALL_GROUPS).filter(g => g !== 'Academic' && g !== 'Public').sort();
    const arr = ['Academic', 'Public', ...rest];
    groupPanel.innerHTML = '';
    for(const g of arr) {
        const row = document.createElement('label');
        row.className = 'check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = g;
        cb.checked = state.groups.has(g);
        cb.setAttribute('role', 'option');
        cb.setAttribute('aria-selected', state.groups.has(g) ? 'true' : 'false');
        cb.addEventListener('change', () => {
            if(cb.checked) state.groups.add(g);
            else state.groups.delete(g);
            updateGroupBtnLabel();
            render();
        });
        row.appendChild(cb);
        const txt = document.createElement('span');
        txt.textContent = g;
        row.appendChild(txt);
        groupPanel.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    const clr = document.createElement('button');
    clr.className = 'btn link';
    clr.type = 'button';
    clr.textContent = 'Clear selection';
    clr.addEventListener('click', () => {
        state.groups.clear();
        groupPanel.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
        updateGroupBtnLabel();
        groupMulti.classList.remove('open');
        groupBtn.setAttribute('aria-expanded', 'false');
        render();
    });
    actions.appendChild(clr);
    groupPanel.appendChild(actions);
    updateGroupBtnLabel();
}
groupBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    groupMulti.classList.toggle('open');
    const open = groupMulti.classList.contains('open');
    groupBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.addEventListener('click', (e) => {
    if(!groupMulti.contains(e.target)) {
        groupMulti.classList.remove('open');
        groupBtn.setAttribute('aria-expanded', 'false');
    }
});
radios.forEach(r => r.addEventListener('change', () => {
    const selected = document.querySelector('input[name="mode"]:checked');
    state.mode = selected ? selected.value : 'all';
    render();
}));
resetBtn.addEventListener('click', () => {
    state = {
        ...state,
        mode: 'all',
        filters: new Set(),
        groups: new Set(),
        months: new Set(),
        monthCumulative: true
    };
    renderChips();
    groupPanel.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
    monthPanel.querySelectorAll('input[type="checkbox"]').forEach(c => {
        c.checked = (c.value === '__cum');
    });
    updateGroupBtnLabel();
    updateMonthBtnLabel();
    const radioAll = document.querySelector('input[name="mode"][value="all"]');
    if(radioAll) radioAll.checked = true;
    map.flyTo({
        center: [-85.4, 44],
        zoom: 6.5,
        pitch: 40,
        speed: 0.8
    });
    rebuildAggregates();
    render();
});
document.querySelectorAll('.ui .ui-min').forEach(btn => {
    btn.addEventListener('click', () => {
        const panel = btn.closest('.ui');
        panel.classList.toggle('collapsed');
        const collapsed = panel.classList.contains('collapsed');
        btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
        btn.textContent = collapsed ? '+' : '–';
    });
});
const dataReady = (async () => {
    await loadLocations();
    await loadFlows(state.datasetYear);
    buildMonthsPanel();
    rebuildAggregates();
})();
datasetSel.addEventListener('change', async () => {
    state.datasetYear = datasetSel.value;
    await loadFlows(state.datasetYear);
    state.monthCumulative = true;
    state.months.clear();
    buildMonthsPanel();
    rebuildAggregates();
    render();
});

function animate(ts) {
    render(ts);
    requestAnimationFrame(animate);
}
map.on('load', async () => {
    await dataReady;
    try {
        overlay = new deck.MapboxOverlay({
            interleaved: false,
            layers: []
        });
        map.addControl(overlay);
    } catch (e) {
        console.error('Deck MapboxOverlay init failed:', e);
    }
    render(0);
    requestAnimationFrame(animate);
});

function showCredits() {
    alert('Designed and programmed by Vaughn Haynes\n\nWith support from Theresa Hovey, Maria Nuccilli, and Mike Hawthorne\n\nCode support by Shannon McDermitt\n\nSpecial thanks to Tara Kanon, Megan Dudek, and Sarah Zawacki at MeL')
}
