// Tangkap error global
window.onerror = function(msg, src, line, col, err) {
    console.error('[Global Error]', msg, 'at', src, line + ':' + col);
    if (window._guaranteedCloseOverlay) window._guaranteedCloseOverlay();
    return false;
};
window.onunhandledrejection = function(e) {
    console.error('[Unhandled Promise]', e.reason);
};

try {
// ============================================================
//  SUPABASE CONFIG
// ============================================================
const DEFAULT_SUPABASE_URL      = 'https://impssopasjpvnfxaywee.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImltcHNzb3Bhc2pwdm5meGF5d2VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0OTc1MTEsImV4cCI6MjA5ODA3MzUxMX0.94sjgTaTJuV2XPrf3Q8mikeWm7n93bQ-0Sw3JC8cHWQ';

if (localStorage.getItem('custom_supabase_key') === 'sb_publishable_CefxNyDWHK3F4YzlPdwwIQ_vv4hw0Ek' || 
    localStorage.getItem('custom_supabase_url') === 'https://odzgdawrtgbwdpesxrwd.supabase.co') {
    localStorage.removeItem('custom_supabase_key');
    localStorage.removeItem('custom_supabase_url');
}

let supabaseUrl = localStorage.getItem('custom_supabase_url') || DEFAULT_SUPABASE_URL;
let supabaseKey = localStorage.getItem('custom_supabase_key') || DEFAULT_SUPABASE_ANON_KEY;

// Urban environmental & carbon constants
const CO2_KG_PER_KWH    = 0.87;    // kg CO2/kWh emission factor (Indonesia grid average)
const CARBON_VALUATION_IDR = 150.00; // Rp/kg CO2 carbon credit valuation


let supabase = null;
let userSession = null;
let localProjects = [];

// Initialize Supabase Client
try {
    if (window.supabase && window.supabase.createClient) {
        supabase = window.supabase.createClient(supabaseUrl, supabaseKey);
        console.log('[Supabase] Client initialized successfully.');
    }
} catch (e) {
    console.warn('[Supabase] Gagal menginisialisasi sdk client:', e.message);
}

// ============================================================
//  MAP INIT
// ============================================================
const map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [113.9213, -0.7893], // Center over Indonesia
    zoom: 5,
    pitch: 0,
    bearing: 0,
    antialias: true
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

// ============================================================
//  STATE VARIABLES
// ============================================================
let drawMode = 'rectangle'; // 'rectangle', 'circle', 'polygon'
let drawState = 'idle'; // idle, start, drawing, completed
let cornerA = null; // for rectangle
let cornerB = null; // for rectangle
let circleCenter = null; // for circle (lng, lat)
let circleRadius = 0; // for circle (meters)
let polygonPts = []; // for polygon (array of [lng, lat])
let aoiAreaM2 = 0;

let aoiCentroid = null; // [lon, lat] centroid of AOI — used for NASA climate API

let timeMachineActive = false;   // Time Machine mode on/off
let timeMachineYear   = 2024;    // Year currently displayed in Time Machine
let timeMachineTimer  = null;    // setInterval handle for playback animation

let allGeojsonData = null; // raw OSM features from Overpass
let geojsonData = null;    // filtered features currently rendered

let currentFeature = null;
let currentArea = 0;
let isSatelliteOn = false;
let authMode = 'login'; // login, register
let mapColorMode = 'carbon'; // 'carbon', 'solar', 'height'


const analysisState = {
    controller: null,
    active: false,
    cancelled: false,
    stages: ['validate','connect','download','process','solar','visualize','finalize'],
    currentStage: null
};

// ============================================================
//  UI FORMATTING HELPERS
// ============================================================
function fmt(n, decimals = 0) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('id-ID', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtIDR(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e9) return 'Rp ' + fmt(n/1e9, 1) + ' M';
    if (n >= 1e6) return 'Rp ' + fmt(n/1e6, 1) + ' Jt';
    return 'Rp ' + fmt(n);
}
function setStatus(msg, type = '') {
    const bar = document.getElementById('status-bar');
    if (!bar) return;
    bar.className = type;
    bar.innerHTML = `<i class="fa fa-${type === 'success' ? 'circle-check' : type === 'error' ? 'circle-exclamation' : 'circle-notch fa-spin'}"></i><span>${msg}</span>`;
}
function showToast(msg, type = 'info') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = `show toast-${type}`;
    setTimeout(() => t.className = '', 3200);
}

function updateAnalysisQueue(taskId, message, status) {
    const label = document.getElementById(`task-${taskId}`);
    const statusLabel = document.getElementById(`task-${taskId}-status`);
    if (label) label.textContent = message;
    if (statusLabel) {
        statusLabel.textContent = status === 'done' ? 'Selesai' : status === 'active' ? 'Berlangsung' : status === 'pending' ? 'Pending' : status === 'error' ? 'Error' : status;
        statusLabel.className = `task-status status-${status}`;
    }
}

function setAnalysisStage(stage, message, status) {
    analysisState.currentStage = stage;
    const title = document.getElementById(`stage-${stage}-sub`);
    const badge = document.getElementById(`stage-${stage}-status`);
    if (title) title.textContent = message;
    if (badge) {
        badge.textContent = status === 'done' ? 'Selesai' : status === 'active' ? 'Berlangsung' : status === 'pending' ? 'Pending' : status === 'error' ? 'Error' : status;
        badge.className = `stage-status status-${status}`;
    }
    const progressIndex = analysisState.stages.indexOf(stage);
    if (progressIndex >= 0) {
        const percent = Math.round(((progressIndex + (status === 'done' ? 1 : 0)) / analysisState.stages.length) * 100);
        const progressInner = document.getElementById('analysis-progress-inner');
        if (progressInner) progressInner.style.width = `${percent}%`;
    }
}

function resetAnalysisQueue() {
    analysisState.stages.forEach(stage => {
        setAnalysisStage(stage, 'Menunggu', 'pending');
    });
    const progressInner = document.getElementById('analysis-progress-inner');
    if (progressInner) progressInner.style.width = '0%';
    
    const metaAoi = document.getElementById('analysis-meta-aoi');
    if (metaAoi) metaAoi.textContent = '—';
    const metaBuildings = document.getElementById('analysis-meta-buildings');
    if (metaBuildings) metaBuildings.textContent = '—';
    const metaSize = document.getElementById('analysis-meta-size');
    if (metaSize) metaSize.textContent = '—';
    const metaTime = document.getElementById('analysis-meta-time');
    if (metaTime) metaTime.textContent = '—';
}

function showAnalysisOverlay() {
    const overlay = document.getElementById('analysis-overlay');
    if (overlay) overlay.classList.add('active');
    const queueCard = document.getElementById('analysis-queue-card');
    if (queueCard) queueCard.style.display = 'grid';
}

function hideAnalysisOverlay() {
    const overlay = document.getElementById('analysis-overlay');
    if (overlay) overlay.classList.remove('active');
}

function updateAnalysisSummary(areaKm2) {
    const summaryAoi = document.getElementById('summary-aoi-area');
    if (summaryAoi) summaryAoi.textContent = areaKm2 > 0 ? `${fmt(areaKm2, 3)} km²` : '—';
    const metaAoi = document.getElementById('analysis-meta-aoi');
    if (metaAoi) metaAoi.textContent = areaKm2 > 0 ? `${fmt(areaKm2, 3)} km²` : '—';
    
    const summaryDataSize = document.getElementById('summary-data-size');
    const aoiEstSize = document.getElementById('aoi-est-size');
    if (summaryDataSize && aoiEstSize) summaryDataSize.textContent = aoiEstSize.textContent;
    
    const summaryEstTime = document.getElementById('summary-est-time');
    const aoiEstTime = document.getElementById('aoi-est-time');
    if (summaryEstTime && aoiEstTime) summaryEstTime.textContent = aoiEstTime.textContent;
}

function updateAnalysisCounts(count) {
    const summaryBuildingCount = document.getElementById('summary-building-count');
    if (summaryBuildingCount) summaryBuildingCount.textContent = count ? fmt(count) : '—';
    const metaBuildings = document.getElementById('analysis-meta-buildings');
    if (metaBuildings) metaBuildings.textContent = count ? fmt(count) : '—';
}

function updateAnalysisDataEstimate() {
    const metaSize = document.getElementById('analysis-meta-size');
    const aoiEstSize = document.getElementById('aoi-est-size');
    if (metaSize && aoiEstSize) metaSize.textContent = aoiEstSize.textContent;
    
    const metaTime = document.getElementById('analysis-meta-time');
    const aoiEstTime = document.getElementById('aoi-est-time');
    if (metaTime && aoiEstTime) metaTime.textContent = aoiEstTime.textContent;
}

function cancelAnalysis() {
    if (!analysisState.active || !analysisState.controller) return;
    analysisState.cancelled = true;
    analysisState.controller.abort();
    setStatus('Membatalkan analisis...', 'info');
    showToast('Analisis dibatalkan oleh pengguna.', 'info');
}

async function fetchWithRetry(url, options = {}, timeout = 30000, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (analysisState.cancelled) throw new Error('cancelled');
        const controller = new AbortController();
        const signal = controller.signal;
        let abortListener = null;
        if (options.signal) {
            if (options.signal.aborted) controller.abort();
            else {
                abortListener = () => controller.abort();
                options.signal.addEventListener('abort', abortListener, { once: true });
            }
        }
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal });
            clearTimeout(timeoutId);
            if (abortListener && options.signal) options.signal.removeEventListener('abort', abortListener);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            clearTimeout(timeoutId);
            if (abortListener && options.signal) options.signal.removeEventListener('abort', abortListener);
            if (analysisState.cancelled || err.name === 'AbortError') {
                throw new Error('cancelled');
            }
            if (attempt === retries) throw err;
            await waitFor(650 + attempt * 350);
        }
    }
}

async function waitFor(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Toggle sidebar accordions
window.toggleAccordion = function(contentId, chevronId) {
    const content = document.getElementById(contentId);
    const chevron = document.getElementById(chevronId);
    if (!content) return;
    content.classList.toggle('open');
    if (chevron) {
        chevron.className = content.classList.contains('open') ? 'fa fa-chevron-down' : 'fa fa-chevron-right';
    }
};

// ============================================================
//  CUSTOM DRAWING TOOL LOGIC
// ============================================================
// ============================================================
//  CUSTOM DRAWING TOOL LOGIC & UTILITIES
// ============================================================
window.setDrawMode = function(mode) {
    if (drawState !== 'idle') {
        showToast('⚠️ Batalkan/selesaikan penggambaran yang sedang berjalan terlebih dahulu!', 'warning');
        return;
    }
    drawMode = mode;
    
    // Update active button states
    ['rect', 'circle', 'poly'].forEach(m => {
        const btn = document.getElementById(`mode-${m}-btn`);
        if (btn) {
            if (m === (mode === 'rectangle' ? 'rect' : mode === 'circle' ? 'circle' : 'poly')) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
    });

    const statusMap = {
        'rectangle': 'Gunakan tombol "Mulai Menggambar" lalu klik sudut awal dan sudut akhir di peta.',
        'circle': 'Gunakan tombol "Mulai Menggambar" lalu klik titik pusat dan geser untuk radius.',
        'polygon': 'Gunakan tombol "Mulai Menggambar" lalu klik beberapa titik di peta.'
    };
    setStatus(statusMap[mode], 'info');
};

function getDistanceMeters(pt1, pt2) {
    const R = 6371000; // Earth radius in meters
    const lat1 = pt1[1] * Math.PI / 180;
    const lat2 = pt2[1] * Math.PI / 180;
    const dLat = (pt2[1] - pt1[1]) * Math.PI / 180;
    const dLon = (pt2[0] - pt1[0]) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function createCirclePolygon(center, radiusMeters, points = 64) {
    const coords = [];
    const distanceX = radiusMeters / (111320 * Math.cos(center[1] * Math.PI / 180));
    const distanceY = radiusMeters / 110540;

    for (let i = 0; i < points; i++) {
        const theta = (i / points) * (2 * Math.PI);
        const x = distanceX * Math.cos(theta);
        const y = distanceY * Math.sin(theta);
        coords.push([center[0] + x, center[1] + y]);
    }
    coords.push(coords[0]); // Close polygon
    return {
        type: 'Polygon',
        coordinates: [coords]
    };
}

function isPointInPolygon(pt, polygon) {
    const x = pt[0], y = pt[1];
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

window.toggleAoiDrawing = function() {
    const btn = document.getElementById('draw-aoi-btn');
    if (!btn) return;
    
    if (drawState === 'idle') {
        drawState = 'start';
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa fa-stop"></i> Batalkan Gambar';
        map.getCanvas().style.cursor = 'crosshair';
        setMapInteractions(false); // Disable map navigation
        
        if (drawMode === 'rectangle') {
            setStatus('Klik di peta untuk menentukan sudut awal kotak AOI...', 'info');
        } else if (drawMode === 'circle') {
            setStatus('Klik di peta untuk menentukan titik pusat lingkaran AOI...', 'info');
        } else if (drawMode === 'polygon') {
            polygonPts = [];
            setStatus('Klik di peta untuk menentukan titik sudut pertama poligon AOI...', 'info');
            document.getElementById('btn-finish-poly').style.display = 'inline-flex';
        }
        clearAoi();
    } else {
        // Cancel drawing
        resetDrawingState();
        clearAoi();
        setStatus('Penggambaran AOI dibatalkan.', 'info');
    }
};

function resetDrawingState() {
    drawState = 'idle';
    const btn = document.getElementById('draw-aoi-btn');
    if (btn) {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa fa-pencil-ruler"></i> Mulai Menggambar';
    }
    const finishBtn = document.getElementById('btn-finish-poly');
    if (finishBtn) finishBtn.style.display = 'none';
    
    map.getCanvas().style.cursor = '';
    setMapInteractions(true); // Re-enable map navigation
}

function setMapInteractions(enabled) {
    const handlers = [
        map.dragPan,
        map.doubleClickZoom,
        map.boxZoom,
        map.dragRotate,
        map.keyboard,
        map.touchZoomRotate,
        map.touchPitch
    ];
    handlers.forEach(h => {
        if (h) {
            if (enabled) h.enable();
            else h.disable();
        }
    });
}

window.finishPolygonDrawing = function() {
    if (drawMode !== 'polygon' || drawState !== 'drawing') return;
    if (polygonPts.length < 3) {
        showToast('⚠️ Minimal poligon harus memiliki 3 titik!', 'warning');
        return;
    }
    
    // Close polygon
    polygonPts.push([polygonPts[0][0], polygonPts[0][1]]);
    drawState = 'completed';
    resetDrawingState();
    
    const areaM2 = polygonAreaM2(polygonPts);
    aoiAreaM2 = areaM2;
    const areaKm2 = areaM2 / 1000000;
    
    const aoiAreaVal = document.getElementById('aoi-area-val');
    if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
    updateAoiEstimations(areaKm2);
    
    const clearAoiBtn = document.getElementById('btn-clear-aoi');
    if (clearAoiBtn) clearAoiBtn.style.display = 'block';
    const runBtn = document.getElementById('btn-run-analysis');
    if (runBtn) runBtn.disabled = false;
    
    setStatus(`AOI Poligon Selesai: ${areaKm2.toFixed(3)} km². Klik tombol 'Analisis' untuk memproses.`, 'success');
    // Compute centroid for sun position calculations
    const _sumLon = polygonPts.reduce((s,p) => s + p[0], 0);
    const _sumLat = polygonPts.reduce((s,p) => s + p[1], 0);
    aoiCentroid = [_sumLon / polygonPts.length, _sumLat / polygonPts.length];
};

// Map click event during drawing
map.on('click', (e) => {
    if (drawState === 'idle') return;
    
    const clickCoord = [e.lngLat.lng, e.lngLat.lat];
    
    if (drawMode === 'rectangle') {
        if (drawState === 'start') {
            cornerA = clickCoord;
            drawState = 'drawing';
            setStatus('Geser mouse lalu klik sekali lagi untuk menyelesaikan kotak AOI...', 'info');
        } else if (drawState === 'drawing') {
            cornerB = clickCoord;
            drawState = 'completed';
            resetDrawingState();
            
            const areaM2 = calculateRectArea(cornerA, cornerB);
            aoiAreaM2 = areaM2;
            const areaKm2 = areaM2 / 1000000;
            
            const aoiAreaVal = document.getElementById('aoi-area-val');
            if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
            updateAoiEstimations(areaKm2);
            
            const clearAoiBtn = document.getElementById('btn-clear-aoi');
            if (clearAoiBtn) clearAoiBtn.style.display = 'block';
            const runBtn = document.getElementById('btn-run-analysis');
            if (runBtn) runBtn.disabled = false;
            
            setStatus(`AOI Selesai: ${areaKm2.toFixed(3)} km². Klik tombol 'Analisis' untuk memproses.`, 'success');
            aoiCentroid = [(cornerA[0] + cornerB[0]) / 2, (cornerA[1] + cornerB[1]) / 2];
        }
    } else if (drawMode === 'circle') {
        if (drawState === 'start') {
            circleCenter = clickCoord;
            drawState = 'drawing';
            setStatus('Geser mouse lalu klik sekali lagi untuk menentukan radius lingkaran...', 'info');
        } else if (drawState === 'drawing') {
            const currentCoord = clickCoord;
            const radiusM = getDistanceMeters(circleCenter, currentCoord);
            circleRadius = radiusM;
            drawState = 'completed';
            resetDrawingState();
            
            const areaM2 = Math.PI * radiusM * radiusM;
            aoiAreaM2 = areaM2;
            const areaKm2 = areaM2 / 1000000;
            
            const aoiAreaVal = document.getElementById('aoi-area-val');
            if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
            updateAoiEstimations(areaKm2);
            
            const clearAoiBtn = document.getElementById('btn-clear-aoi');
            if (clearAoiBtn) clearAoiBtn.style.display = 'block';
            const runBtn = document.getElementById('btn-run-analysis');
            if (runBtn) runBtn.disabled = false;
            
            setStatus(`AOI Lingkaran Selesai: ${areaKm2.toFixed(3)} km² (Radius: ${fmt(radiusM)}m). Klik 'Analisis' untuk memproses.`, 'success');
            aoiCentroid = [...circleCenter];
        }
    } else if (drawMode === 'polygon') {
        if (drawState === 'start') {
            polygonPts.push(clickCoord);
            drawState = 'drawing';
            setStatus('Klik titik berikutnya untuk menggambar poligon, atau klik "Selesai"...', 'info');
        } else if (drawState === 'drawing') {
            // Check if clicking near the first point to close
            if (polygonPts.length >= 3) {
                const distToFirst = getDistanceMeters(clickCoord, polygonPts[0]);
                if (distToFirst < 15) { // within 15 meters, close it
                    finishPolygonDrawing();
                    return;
                }
            }
            polygonPts.push(clickCoord);
            setStatus(`Poligon: ${polygonPts.length} titik. Klik titik berikutnya, atau klik "Selesai" untuk mengunci.`, 'info');
        }
    }
});

// Map mousemove event during drawing (preview)
map.on('mousemove', (e) => {
    if (drawState !== 'drawing') return;
    
    const currentCoord = [e.lngLat.lng, e.lngLat.lat];
    let geometry = null;
    let areaKm2 = 0;
    let invalid = false;
    
    if (drawMode === 'rectangle' && cornerA) {
        const areaM2 = calculateRectArea(cornerA, currentCoord);
        areaKm2 = areaM2 / 1000000;
        invalid = areaKm2 > 100.0; // new limit 100 km²
        
        const coords = [
            [cornerA[0], cornerA[1]],
            [currentCoord[0], cornerA[1]],
            [currentCoord[0], currentCoord[1]],
            [cornerA[0], currentCoord[1]],
            [cornerA[0], cornerA[1]]
        ];
        geometry = {
            type: 'Polygon',
            coordinates: [coords]
        };
    } else if (drawMode === 'circle' && circleCenter) {
        const radiusM = getDistanceMeters(circleCenter, currentCoord);
        const areaM2 = Math.PI * radiusM * radiusM;
        areaKm2 = areaM2 / 1000000;
        invalid = areaKm2 > 100.0;
        geometry = createCirclePolygon(circleCenter, radiusM);
    } else if (drawMode === 'polygon' && polygonPts.length > 0) {
        const tempPts = [...polygonPts, currentCoord, polygonPts[0]];
        const areaM2 = polygonAreaM2(tempPts);
        areaKm2 = areaM2 / 1000000;
        invalid = areaKm2 > 100.0;
        geometry = {
            type: 'Polygon',
            coordinates: [tempPts]
        };
    }
    
    if (geometry && map.getSource('aoi-source')) {
        // Update size UI
        const aoiAreaVal = document.getElementById('aoi-area-val');
        if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
        updateAoiEstimations(areaKm2);
        
        map.getSource('aoi-source').setData({
            type: 'Feature',
            properties: { invalid: invalid },
            geometry: geometry
        });
    }
});

function calculateRectArea(pt1, pt2) {
    const latAvg = (pt1[1] + pt2[1]) / 2;
    const dx = Math.abs(pt2[0] - pt1[0]) * 111320 * Math.cos(latAvg * Math.PI / 180);
    const dy = Math.abs(pt2[1] - pt1[1]) * 110540;
    return dx * dy;
}

function updateAoiEstimations(areaKm2) {
    const timeEl = document.getElementById('aoi-est-time');
    const sizeEl = document.getElementById('aoi-est-size');
    const warnEl = document.getElementById('aoi-warn-banner');
    
    if (warnEl) {
        warnEl.style.display = areaKm2 > 5.0 ? 'block' : 'none';
    }
    
    if (areaKm2 <= 0) {
        if (timeEl) timeEl.textContent = '—';
        if (sizeEl) sizeEl.textContent = '—';
        return;
    }
    
    // Heuristic estimations for data/time
    let estTime = '—';
    let estSize = '—';
    if (areaKm2 < 0.5) {
        estTime = '2 - 5 detik';
        estSize = '< 500 KB';
    } else if (areaKm2 <= 2.0) {
        estTime = '5 - 10 detik';
        estSize = '500 KB - 2 MB';
    } else if (areaKm2 <= 5.0) {
        estTime = '10 - 20 detik';
        estSize = '2 - 6 MB';
    } else if (areaKm2 <= 20.0) {
        estTime = '20 - 40 detik';
        estSize = '6 - 20 MB';
    } else {
        estTime = '> 60 detik (Sangat Lama)';
        estSize = '> 20 MB (Sangat Berat)';
    }
    
    if (timeEl) timeEl.textContent = estTime;
    if (sizeEl) sizeEl.textContent = estSize;

    // Enable/disable analysis button based on 100km2 limit
    const runBtn = document.getElementById('btn-run-analysis');
    if (runBtn && drawState === 'completed') {
        runBtn.disabled = (areaKm2 > 100.0 || areaKm2 <= 0);
    }
}

// ============================================================
//  NASA POWER API — REAL SOLAR IRRADIANCE DATA
// ============================================================

/**
 * Fetch actual annual GHI (kWh/m²/year) from NASA POWER climatology API.
 * Uses monthly averages of daily irradiance and converts to annual total.
 * No API key required.
 */




// ============================================================
//  TIME MACHINE — URBAN GROWTH ANIMATOR
// ============================================================

/** Parse building start year from multiple OSM tags. Returns 0 if unknown. */
function parseStartYear(tags) {
    const raw = tags['start_date'] || tags['construction:date'] ||
                tags['year_of_construction'] || tags['opening_date'] ||
                tags['source:date'] || '';
    if (!raw) return 0;
    const match = raw.toString().match(/\b(\d{4})\b/);
    if (!match) return 0;
    const year = parseInt(match[1]);
    return (year >= 1800 && year <= new Date().getFullYear() + 1) ? year : 0;
}

// MapLibre expression: color for greenery
const GREENERY_COLOR_EXPR = [
    'match', ['get', 'greenery_type'],
    'forest', '#14532d',
    'park',   '#22c55e',
    'grass',  '#86efac',
    'scrub',  '#a3e635',
    'tree',   '#15803d',
    '#10b981'
];

// MapLibre expression: color by carbon footprint (used in Carbon mode)
const CARBON_COLOR_EXPR = [
    'case',
    ['get', 'is_greenery'],
    GREENERY_COLOR_EXPR,
    // Building: color by co2_emission_kg
    [
        'interpolate', ['linear'], ['coalesce', ['get', 'co2_emission_kg'], 1000],
        0,      '#60a5fa',   // Blue (Zero/very low)
        10000,  '#22d3ee',   // Cyan (Low)
        30000,  '#facc15',   // Yellow (Medium)
        70000,  '#f97316',   // Orange (Medium-high)
        150000, '#ef4444'    // Red (High)
    ]
];

// MapLibre expression: color by building density (footprint area)
const DENSITY_COLOR_EXPR = [
    'case',
    ['get', 'is_greenery'],
    GREENERY_COLOR_EXPR,
    [
        'interpolate', ['linear'], ['coalesce', ['get', 'area_m2'], 50],
        0,      '#cbd5e1',   // Slate (Very small footprint, < 100 m²)
        150,    '#3b82f6',   // Bright blue (Small footprint, 100-300 m²)
        500,    '#8b5cf6',   // Vibrant purple (Medium footprint, 300-800 m²)
        1200,   '#ec4899',   // Hot pink (Large footprint, 800-2000 m²)
        2000,   '#f43f5e'    // Rose red (Very large footprint, 2000+ m²)
    ]
];

// MapLibre expression: color by building levels (height)
const HEIGHT_COLOR_EXPR = [
    'case',
    ['get', 'is_greenery'],
    GREENERY_COLOR_EXPR,
    [
        'interpolate', ['linear'], ['coalesce', ['get', 'levels'], 1],
        1,      '#cbd5e1',   // Slate (1 floor)
        3,      '#60a5fa',   // Blue (3 floors)
        6,      '#a78bfa',   // Violet (6 floors)
        12,     '#ec4899',   // Pink (12 floors)
        24,     '#db2777'    // Deep pink (24+ floors)
    ]
];

// MapLibre expression: color by era (used when TM is active)
const ERA_COLOR_EXPR = [
    'case',
    ['get', 'is_greenery'],
    GREENERY_COLOR_EXPR,
    // Building Era
    [
        'case',
        ['==', ['get', 'build_year'], 0],        '#374151',  // Unknown — dark grey
        ['<',  ['get', 'build_year'], 1970],     '#f59e0b',  // Pre-1970 — amber
        ['<',  ['get', 'build_year'], 1990],     '#06b6d4',  // 1970–1990 — cyan
        ['<',  ['get', 'build_year'], 2010],     '#10b981',  // 1990–2010 — green
        ['<',  ['get', 'build_year'], 2020],     '#3b82f6',  // 2010–2020 — blue
        '#8b5cf6'                                            // 2020+ — violet
    ]
];

window.toggleTimeMachine = function() {
    if (timeMachineActive) deactivateTimeMachine();
    else activateTimeMachine();
};

function activateTimeMachine() {
    if (!map.getLayer('buildings-3d')) return;
    timeMachineActive = true;

    const btn = document.getElementById('tm-toggle-btn');
    if (btn) { btn.innerHTML = '<i class="fa fa-stop"></i> Nonaktifkan Time Machine'; btn.classList.add('tm-active'); }
    const controls = document.getElementById('time-machine-controls');
    if (controls) controls.style.display = 'block';

    // Hide solar panel overlay during time machine mode
    

    // Switch to era-based coloring
    try {
        map.setPaintProperty('buildings-3d', 'fill-extrusion-color', ERA_COLOR_EXPR);
        map.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', 0.88);
    } catch(e) { console.warn('[TimeMachine] setPaintProperty:', e.message); }

    updateTimeMachineYear(timeMachineYear);
}

function deactivateTimeMachine() {
    timeMachineActive = false;
    pauseTimeMachine();

    const btn = document.getElementById('tm-toggle-btn');
    if (btn) { btn.innerHTML = '<i class="fa fa-clock-rotate-left"></i> Aktifkan Time Machine'; btn.classList.remove('tm-active'); }
    const controls = document.getElementById('time-machine-controls');
    if (controls) controls.style.display = 'none';

    // Remove year filter — show all buildings
    ['buildings-3d','buildings-outline'].forEach(id => {
        try { if (map.getLayer(id)) map.setFilter(id, null); } catch(_) {}
    });

    // Restore color mode expression & opacity
    try {
        if (map.getLayer('buildings-3d')) {
            let expr = CARBON_COLOR_EXPR;
            if (mapColorMode === 'density') expr = DENSITY_COLOR_EXPR;
            else if (mapColorMode === 'height') expr = HEIGHT_COLOR_EXPR;
            map.setPaintProperty('buildings-3d', 'fill-extrusion-color', expr);
            map.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', 0.92);
        }
    } catch(_) {}
}

window.changeColorMode = function() {
    const select = document.getElementById('map-color-mode');
    if (!select) return;
    mapColorMode = select.value;
    
    // Repaint layers if they exist
    if (map.getLayer('buildings-3d')) {
        let expr = CARBON_COLOR_EXPR;
        if (timeMachineActive) {
            expr = ERA_COLOR_EXPR;
        } else {
            if (mapColorMode === 'density') expr = DENSITY_COLOR_EXPR;
            else if (mapColorMode === 'height') expr = HEIGHT_COLOR_EXPR;
        }
        map.setPaintProperty('buildings-3d', 'fill-extrusion-color', expr);
    }
    
    updateLegendUI();
    if (geojsonData) {
        updateStatsDashboard(geojsonData);
    }
};

function updateLegendUI() {
    const titleEl = document.getElementById('legend-title');
    const gradEl = document.getElementById('legend-gradient');
    const minEl = document.getElementById('leg-min');
    const midEl = document.getElementById('leg-mid');
    const maxEl = document.getElementById('leg-max');
    const detMinEl = document.getElementById('leg-detail-min');
    const detMidEl = document.getElementById('leg-detail-mid');
    const detMaxEl = document.getElementById('leg-detail-max');
    
    if (!titleEl || !gradEl) return;
    
    if (mapColorMode === 'carbon') {
        titleEl.innerHTML = '<i class="fa fa-palette"></i> Skala Jejak Karbon';
        gradEl.style.background = 'linear-gradient(90deg, #60a5fa, #22d3ee, #facc15, #f97316, #ef4444)';
        minEl.textContent = 'Rendah';
        midEl.textContent = 'Sedang';
        maxEl.textContent = 'Tinggi';
        detMinEl.textContent = '< 10 t';
        detMidEl.textContent = '50 t';
        detMaxEl.textContent = '150+ t CO₂/thn';
    } else if (mapColorMode === 'density') {
        titleEl.innerHTML = '<i class="fa fa-palette"></i> Skala Kepadatan (Tapak)';
        gradEl.style.background = 'linear-gradient(90deg, #cbd5e1, #3b82f6, #8b5cf6, #ec4899, #f43f5e)';
        minEl.textContent = 'Kecil';
        midEl.textContent = 'Sedang';
        maxEl.textContent = 'Besar';
        detMinEl.textContent = '< 100 m²';
        detMidEl.textContent = '500 m²';
        detMaxEl.textContent = '2000+ m²';
    } else if (mapColorMode === 'height') {
        titleEl.innerHTML = '<i class="fa fa-palette"></i> Skala Tinggi Gedung';
        gradEl.style.background = 'linear-gradient(90deg, #cbd5e1, #60a5fa, #a78bfa, #ec4899, #db2777)';
        minEl.textContent = '1 Lantai';
        midEl.textContent = '6 Lantai';
        maxEl.textContent = '24+ Lantai';
        detMinEl.textContent = '3.5 m';
        detMidEl.textContent = '21 m';
        detMaxEl.textContent = '84+ m';
    }
}

function updateTimeMachineYear(year) {
    timeMachineYear = year;
    if (!allGeojsonData) return;

    // Sync slider and year display
    const slider = document.getElementById('tm-year-slider');
    if (slider) slider.value = year;
    const yearLabel = document.getElementById('tm-year-label');
    if (yearLabel) yearLabel.textContent = year;

    // Apply MapLibre filter: unknown-year buildings always visible; dated buildings only up to `year`
    const yearFilter = ['any',
        ['==', ['get', 'build_year'], 0],
        ['all', ['>', ['get', 'build_year'], 0], ['<=', ['get', 'build_year'], year]]
    ];
    try {
        ['buildings-3d','buildings-outline'].forEach(id => {
            if (map.getLayer(id)) map.setFilter(id, yearFilter);
        });
    } catch(e) { console.warn('[TimeMachine] setFilter:', e.message); }

    // Count visible features and update counter
    const visible = allGeojsonData.features.filter(f => {
        const by = f.properties.build_year || 0;
        return by === 0 || (by > 0 && by <= year);
    });
    const withDate = visible.filter(f => (f.properties.build_year || 0) > 0);
    const counter = document.getElementById('tm-counter');
    if (counter) {
        counter.innerHTML =
            `<span class="tm-count-num">${visible.length.toLocaleString()}</span> bangunan tampil` +
            (withDate.length
                ? ` &nbsp;·&nbsp; <span style="color:var(--cyan-400)">${withDate.length} teridentifikasi</span>`
                : '');
    }
    updateEraBreakdown(visible);
}

window.onTimeMachineSlider = function() {
    const slider = document.getElementById('tm-year-slider');
    if (slider) updateTimeMachineYear(parseInt(slider.value));
};

function updateEraBreakdown(features) {
    const eras = [
        { key: 'unknown',  test: y => y === 0 },
        { key: 'pre1970',  test: y => y > 0 && y < 1970 },
        { key: '1990',     test: y => y >= 1970 && y < 1990 },
        { key: '2010',     test: y => y >= 1990 && y < 2010 },
        { key: '2020',     test: y => y >= 2010 && y < 2020 },
        { key: 'post2020', test: y => y >= 2020 }
    ];
    const total = features.length || 1;
    eras.forEach(era => {
        const count = features.filter(f => era.test(f.properties.build_year || 0)).length;
        const barEl   = document.getElementById(`era-bar-${era.key}`);
        const countEl = document.getElementById(`era-bar-${era.key}-label`);
        if (barEl)   barEl.style.width = Math.round((count / total) * 100) + '%';
        if (countEl) countEl.textContent = count;
    });
}

/** Toggle play/pause — single button controls both states. */
window.playTimeMachine = function() {
    if (timeMachineTimer) { pauseTimeMachine(); return; }

    const playBtn = document.getElementById('tm-play-btn');
    if (playBtn) playBtn.innerHTML = '<i class="fa fa-pause"></i> Pause';

    // Restart from 1950 if already at end
    if (timeMachineYear >= 2024) updateTimeMachineYear(1950);

    timeMachineTimer = setInterval(() => {
        if (timeMachineYear >= 2024) { pauseTimeMachine(); return; }
        updateTimeMachineYear(timeMachineYear + 1);
    }, 150); // ~75 sec for full 1950→2024 sweep
};

function pauseTimeMachine() {
    if (timeMachineTimer) { clearInterval(timeMachineTimer); timeMachineTimer = null; }
    const playBtn = document.getElementById('tm-play-btn');
    if (playBtn) playBtn.innerHTML = '<i class="fa fa-play"></i> Play';
}

window.resetTimeMachine = function() {
    pauseTimeMachine();
    updateTimeMachineYear(1950);
};

function showTimeMachineCard() {
    const card = document.getElementById('time-machine-card');
    if (card) card.style.display = 'block';
    if (!allGeojsonData) return;

    const years  = allGeojsonData.features.map(f => f.properties.build_year || 0).filter(y => y > 0);
    const coverageEl = document.getElementById('tm-date-coverage');
    if (coverageEl) {
        const known = years.length, total = allGeojsonData.features.length;
        coverageEl.innerHTML = known > 0
            ? `<span style="color:var(--green-400)">${known}</span> dari ${total} bangunan memiliki data tahun`
            : `<span style="color:var(--amber-400)">⚠ Area ini belum memiliki data start_date di OSM</span>`;
    }
    if (years.length > 0) {
        const minYear = Math.min(...years);
        const sliderEl = document.getElementById('tm-year-slider');
        if (sliderEl) sliderEl.min = Math.max(1800, minYear - 2);
    }
    // Show era breakdown for all buildings (year = 2024 = full view)
    updateEraBreakdown(allGeojsonData.features);
}

function hideTimeMachineCard() {
    const card = document.getElementById('time-machine-card');
    if (card) card.style.display = 'none';
    pauseTimeMachine();
    if (timeMachineActive) deactivateTimeMachine();
    timeMachineActive = false;
    timeMachineYear   = 2024;
}

window.clearAoi = function() {
    cornerA = null;
    cornerB = null;
    circleCenter = null;
    circleRadius = 0;
    polygonPts = [];
    aoiAreaM2 = 0;
    aoiCentroid = null;
    
    const aoiAreaVal = document.getElementById('aoi-area-val');
    if (aoiAreaVal) aoiAreaVal.textContent = '—';
    const estTime = document.getElementById('aoi-est-time');
    if (estTime) estTime.textContent = '—';
    const estSize = document.getElementById('aoi-est-size');
    if (estSize) estSize.textContent = '—';
    const warnBanner = document.getElementById('aoi-warn-banner');
    if (warnBanner) warnBanner.style.display = 'none';
    const runBtn = document.getElementById('btn-run-analysis');
    if (runBtn) runBtn.disabled = true;
    const clearBtn = document.getElementById('btn-clear-aoi');
    if (clearBtn) clearBtn.style.display = 'none';
    
    if (map.getSource('aoi-source')) {
        map.getSource('aoi-source').setData({
            type: 'FeatureCollection',
            features: []
        });
    }
    
    // Remove buildings if loaded
    hideTimeMachineCard();
    clearBuildingsLayers();
    const statsDashboard = document.getElementById('stats-dashboard');
    if (statsDashboard) statsDashboard.style.display = 'none';
    
    
    const saveProjectBtn = document.getElementById('save-project-btn');
    if (saveProjectBtn) saveProjectBtn.disabled = true;
    closeDetail();
};

function clearBuildingsLayers() {
    ['buildings-labels','buildings-3d','buildings-outline','solar-panel-overlay']
        .forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch(_){} });
    try { if (map.getSource('buildings-source')) map.removeSource('buildings-source'); } catch(_){}
    allGeojsonData = null;
    geojsonData = null;
}

// ============================================================
//  OVERPASS API FETCH & GEOMETRY PARSER
// ============================================================
window.runAnalysis = async function() {
    if (drawMode === 'rectangle' && (!cornerA || !cornerB)) return;
    if (drawMode === 'circle' && (!circleCenter || !circleRadius)) return;
    if (drawMode === 'polygon' && polygonPts.length < 3) return;
    if (analysisState.active) return;

    const runBtn = document.getElementById('btn-run-analysis');
    const clearBtn = document.getElementById('btn-clear-aoi');
    const cancelBtn = document.getElementById('btn-cancel-analysis');
    const loaderWrap = document.getElementById('aoi-loader-wrap');
    const loaderStatus = document.getElementById('aoi-loader-status');
    const loaderPct = document.getElementById('aoi-loader-pct');
    const loaderBar = document.getElementById('aoi-loader-bar');
    const loaderTime = document.getElementById('aoi-loader-time');
    const loaderSize = document.getElementById('aoi-loader-size');

    const areaKm2 = aoiAreaM2 / 1000000;
    if (areaKm2 <= 0) {
        setStatus('AOI tidak valid. Silakan gambarkan ulang area.', 'error');
        showToast('⚠️ AOI tidak valid!', 'error');
        return;
    }

    if (areaKm2 > 10 && !confirm('Area analisis sangat besar. Proses pengunduhan data OSM akan memakan waktu lebih lama. Lanjutkan?')) {
        setStatus('Analisis dibatalkan oleh pengguna karena area besar.', 'info');
        return;
    }

    analysisState.active = true;
    analysisState.cancelled = false;
    analysisState.controller = new AbortController();

    if (runBtn) runBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    if (loaderWrap) loaderWrap.style.display = 'block';
    
    const estTimeEl = document.getElementById('aoi-est-time');
    if (loaderTime && estTimeEl) loaderTime.textContent = estTimeEl.textContent;
    const estSizeEl = document.getElementById('aoi-est-size');
    if (loaderSize && estSizeEl) loaderSize.textContent = estSizeEl.textContent;

    // reset queue first, then show overlay so queue list displays as a grid
    resetAnalysisQueue();
    showAnalysisOverlay();
    
    updateAnalysisSummary(areaKm2);
    updateAnalysisCounts();
    updateAnalysisDataEstimate();
    updateAnalysisQueue('aoi-validated', 'AOI siap divalidasi', 'active');
    setAnalysisStage('validate', 'Memeriksa validitas AOI...', 'active');
    setStatus('Validating AOI area...', 'info');
    if (loaderPct) loaderPct.textContent = '0%';
    if (loaderBar) loaderBar.style.width = '0%';

    const updateLoader = (message) => {
        if (loaderStatus) {
            loaderStatus.innerHTML = `<i class="fa fa-circle-notch fa-spin"></i> ${message}`;
        }
    };

    try {
        if (analysisState.cancelled) throw new Error('cancelled');

        updateAnalysisQueue('aoi-validated', 'AOI divalidasi', 'done');
        updateAnalysisQueue('aoi-area', 'Luas AOI dihitung', 'active');
        setAnalysisStage('validate', 'AOI valid.', 'done');
        setAnalysisStage('connect', 'Menyambung ke Overpass API...', 'active');
        updateLoader('Menyambung ke Overpass API...');

        // Calculate bounding box and write the Overpass query dynamically
        let minLat, minLon, maxLat, maxLon, query;
        if (drawMode === 'rectangle') {
            minLat = Math.min(cornerA[1], cornerB[1]);
            minLon = Math.min(cornerA[0], cornerB[0]);
            maxLat = Math.max(cornerA[1], cornerB[1]);
            maxLon = Math.max(cornerA[0], cornerB[0]);
            query = `[out:json][timeout:90];\n(\n  way["building"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["building"](${minLat},${minLon},${maxLat},${maxLon});\n  way["landuse"="forest"](${minLat},${minLon},${maxLat},${maxLon});\n  way["natural"="wood"](${minLat},${minLon},${maxLat},${maxLon});\n  way["leisure"="park"](${minLat},${minLon},${maxLat},${maxLon});\n  way["landuse"="grass"](${minLat},${minLon},${maxLat},${maxLon});\n  way["leisure"="garden"](${minLat},${minLon},${maxLat},${maxLon});\n  way["natural"="scrub"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["landuse"="forest"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["natural"="wood"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["leisure"="park"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["landuse"="grass"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["leisure"="garden"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["natural"="scrub"](${minLat},${minLon},${maxLat},${maxLon});\n  node["natural"="tree"](${minLat},${minLon},${maxLat},${maxLon});\n);\nout geom;`;
        } else if (drawMode === 'circle') {
            const deltaLat = circleRadius / 110540;
            const deltaLon = circleRadius / (111320 * Math.cos(circleCenter[1] * Math.PI / 180));
            minLat = circleCenter[1] - deltaLat;
            minLon = circleCenter[0] - deltaLon;
            maxLat = circleCenter[1] + deltaLat;
            maxLon = circleCenter[0] + deltaLon;
            query = `[out:json][timeout:90];\n(\n  way["building"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  relation["building"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  way["landuse"="forest"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  way["natural"="wood"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  way["leisure"="park"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  way["landuse"="grass"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  way["leisure"="garden"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  way["natural"="scrub"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  relation["landuse"="forest"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  relation["natural"="wood"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  relation["leisure"="park"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  relation["landuse"="grass"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  relation["leisure"="garden"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  relation["natural"="scrub"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n  node["natural"="tree"](around:${circleRadius},${circleCenter[1]},${circleCenter[0]});\n);\nout geom;`;
        } else if (drawMode === 'polygon') {
            const lats = polygonPts.map(p => p[1]);
            const lons = polygonPts.map(p => p[0]);
            minLat = Math.min(...lats);
            minLon = Math.min(...lons);
            maxLat = Math.max(...lats);
            maxLon = Math.max(...lons);
            query = `[out:json][timeout:90];\n(\n  way["building"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["building"](${minLat},${minLon},${maxLat},${maxLon});\n  way["landuse"="forest"](${minLat},${minLon},${maxLat},${maxLon});\n  way["natural"="wood"](${minLat},${minLon},${maxLat},${maxLon});\n  way["leisure"="park"](${minLat},${minLon},${maxLat},${maxLon});\n  way["landuse"="grass"](${minLat},${minLon},${maxLat},${maxLon});\n  way["leisure"="garden"](${minLat},${minLon},${maxLat},${maxLon});\n  way["natural"="scrub"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["landuse"="forest"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["natural"="wood"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["leisure"="park"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["landuse"="grass"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["leisure"="garden"](${minLat},${minLon},${maxLat},${maxLon});\n  relation["natural"="scrub"](${minLat},${minLon},${maxLat},${maxLon});\n  node["natural"="tree"](${minLat},${minLon},${maxLat},${maxLon});\n);\nout geom;`;
        }

        // Official Overpass interpreter mirrors prioritized first
        const endpoints = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.openstreetmap.fr/api/interpreter'
        ];

        let rawResponse = null;
        let lastError = null;
        for (let i = 0; i < endpoints.length && !analysisState.cancelled; i++) {
            const serverLabel = `Server ${i + 1}/${endpoints.length}`;
            updateLoader(`Mengambil data OSM dari ${serverLabel}...`);
            setAnalysisStage('connect', `Mengambil data dari ${serverLabel}`, 'active');
            updateAnalysisQueue('osm-download', `Menjalankan request ${i + 1}/${endpoints.length}`, 'active');

            try {
                // Use POST request which is faster and more robust
                rawResponse = await fetchWithRetry(endpoints[i], {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: `data=${encodeURIComponent(query)}`,
                    signal: analysisState.controller.signal
                }, 15000, 1); // 15 seconds timeout per request, 1 retry
                break;
            } catch (err) {
                lastError = err;
                console.warn(`[Overpass] ${serverLabel} gagal:`, err.message);
                if (analysisState.cancelled) break;
            }
        }

        if (analysisState.cancelled) {
            throw new Error('cancelled');
        }

        if (!rawResponse) {
            throw new Error('overpass_unavailable');
        }

        updateAnalysisQueue('osm-download', 'Download data selesai', 'done');
        setAnalysisStage('connect', 'Koneksi OSM berhasil.', 'done');
        setAnalysisStage('download', 'Menerima data bangunan...', 'active');
        updateLoader('Menerima data bangunan...');
        updateAnalysisCounts();

        const rawGeojson = overpassToGeoJSON(rawResponse);
        
        // Client-side clipping for Circle and Polygon modes
        if (drawMode === 'circle') {
            rawGeojson.features = rawGeojson.features.filter(f => {
                if (!f.geometry || !f.geometry.coordinates) return false;
                let center = [0,0];
                if (f.geometry.type === 'Polygon') {
                    center = f.geometry.coordinates[0][0];
                } else if (f.geometry.type === 'MultiPolygon') {
                    center = f.geometry.coordinates[0][0][0];
                }
                return getDistanceMeters(circleCenter, center) <= circleRadius;
            });
        } else if (drawMode === 'polygon') {
            rawGeojson.features = rawGeojson.features.filter(f => {
                if (!f.geometry || !f.geometry.coordinates) return false;
                let center = [0,0];
                if (f.geometry.type === 'Polygon') {
                    center = f.geometry.coordinates[0][0];
                } else if (f.geometry.type === 'MultiPolygon') {
                    center = f.geometry.coordinates[0][0][0];
                }
                return isPointInPolygon(center, polygonPts);
            });
        }

        const count = rawGeojson.features.length;
        if (count === 0) {
            throw new Error('empty_osm_response');
        }

        setAnalysisStage('download', 'Data footprint diunduh.', 'done');
        setAnalysisStage('process', 'Memproses geometri bangunan...', 'active');
        updateAnalysisQueue('solar-analysis', 'Analisis karbon menunggu', 'pending');
        updateLoader('Memproses geometri bangunan...');

        allGeojsonData = enrichFeatures(rawGeojson);
        updateAnalysisCounts(count);
        updateAnalysisQueue('aoi-area', `Area ${fmt(areaKm2, 3)} km²`, 'done');
        updateAnalysisQueue('osm-download', `${count} bangunan diterima`, 'done');
        updateAnalysisQueue('solar-analysis', 'Menganalisis jejak karbon', 'active');
        updateAnalysisQueue('3d-rendering', 'Menunggu rendering', 'pending');

        if (analysisState.cancelled) {
            throw new Error('cancelled');
        }

        setAnalysisStage('process', 'Geometri diproses.', 'done');
        updateLoader('Menganalisis jejak karbon kota...');

        // Finalize base variables, then run filter and paint
        setAnalysisStage('solar', 'Jejak karbon dihitung.', 'done');
        updateLoader('Menyiapkan visualisasi 3D...');
        updateAnalysisQueue('solar-analysis', 'Analisis karbon selesai', 'done');
        updateAnalysisQueue('3d-rendering', 'Membuat visualisasi 3D', 'active');

        // Apply filters internally maps to the map layers and global data
        applyFilters();
        fitCameraToAoi(minLon, minLat, maxLon, maxLat);
        // Fetch real climate data from NASA POWER API using AOI centroid
        
        showTimeMachineCard();

        setAnalysisStage('visualize', 'Visualisasi 3D siap.', 'done');
        updateAnalysisQueue('3d-rendering', 'Rendering 3D selesai', 'done');
        setAnalysisStage('finalize', 'Menyiapkan hasil akhir...', 'active');
        updateLoader('Finalizing results...');
        await waitFor(250);

        setAnalysisStage('finalize', 'Selesai.', 'done');
        const progressInner = document.getElementById('analysis-progress-inner');
        if (progressInner) progressInner.style.width = '100%';
        updateLoader('Analisis selesai!');
        setStatus(`Selesai! ${fmt(count)} bangunan dianalisis.`, 'success');
        showToast(`✅ ${fmt(count)} bangunan dimuat!`, 'success');
        const saveProjectBtn = document.getElementById('save-project-btn');
        if (saveProjectBtn) saveProjectBtn.disabled = false;
    } catch (error) {
        if (error.message === 'cancelled') {
            setStatus('Analisis dibatalkan oleh pengguna.', 'info');
            showToast('Analisis dibatalkan oleh pengguna.', 'info');
            setAnalysisStage(analysisState.currentStage || 'validate', 'Dibatalkan.', 'cancelled');
            updateAnalysisQueue('osm-download', 'Dibatalkan', 'cancelled');
        } else if (error.message === 'empty_osm_response') {
            setStatus('Area tidak memiliki bangunan OSM yang dapat diproses.', 'error');
            showToast('⚠️ Tidak ada bangunan ditemukan di area tersebut.', 'error');
            setAnalysisStage('download', 'Respon kosong dari OSM.', 'error');
            updateAnalysisQueue('osm-download', 'Tidak ada data bangunan', 'error');
        } else if (error.message === 'overpass_unavailable') {
            setStatus('Tidak dapat terhubung ke Overpass API. Silakan coba lagi.', 'error');
            showToast('⚠️ Koneksi Overpass gagal.', 'error');
            setAnalysisStage('connect', 'Koneksi Overpass gagal.', 'error');
            updateAnalysisQueue('osm-download', 'Gagal mengunduh data', 'error');
        } else {
            console.error('[Analysis Error]', error);
            setStatus(`Kesalahan analisis: ${error.message}`, 'error');
            showToast('❌ Terjadi kesalahan saat analisis.', 'error');
            setAnalysisStage(analysisState.currentStage || 'validate', 'Kesalahan terjadi.', 'error');
        }
    } finally {
        analysisState.active = false;
        analysisState.controller = null;
        analysisState.cancelled = false;
        if (runBtn) runBtn.disabled = false;
        if (clearBtn) clearBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = 'none';
        
        // DO NOT hide overlay automatically so the user can inspect progress details and close manually.
        if (loaderWrap) loaderWrap.style.display = 'none';
    }
};

function createHexagon(lon, lat, radiusMeters) {
    const degLat = radiusMeters / 111000;
    const degLon = radiusMeters / (111000 * Math.cos(lat * Math.PI / 180));
    const coords = [];
    for (let i = 0; i < 6; i++) {
        const angle = (i * 60 * Math.PI) / 180;
        coords.push([
            lon + degLon * Math.cos(angle),
            lat + degLat * Math.sin(angle)
        ]);
    }
    coords.push([coords[0][0], coords[0][1]]);
    return [coords];
}

function overpassToGeoJSON(overpassJson) {
    const features = [];
    if (!overpassJson || !overpassJson.elements) return { type: 'FeatureCollection', features: [] };

    overpassJson.elements.forEach(el => {
        const tags = el.tags || {};
        
        // Check if it's greenery
        const isGreenery = tags.landuse === 'forest' || tags.natural === 'wood' ||
                           tags.leisure === 'park' || tags.leisure === 'garden' ||
                           tags.landuse === 'grass' || tags.landuse === 'meadow' ||
                           tags.natural === 'scrub' || tags.natural === 'tree';

        if (el.type === 'way' && el.geometry && el.geometry.length >= 3) {
            const coords = el.geometry.map(pt => [pt.lon, pt.lat]);
            if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
                coords.push([coords[0][0], coords[0][1]]);
            }
            
            if (isGreenery) {
                let greeneryType = 'grass';
                let h = 0.5;
                if (tags.landuse === 'forest' || tags.natural === 'wood') { greeneryType = 'forest'; h = 12; }
                else if (tags.leisure === 'park' || tags.leisure === 'garden') { greeneryType = 'park'; h = 4; }
                else if (tags.natural === 'scrub') { greeneryType = 'scrub'; h = 2; }
                
                features.push({
                    type: 'Feature',
                    id: el.id,
                    properties: {
                        id: el.id,
                        name: tags.name || tags['name:id'] || `Vegetasi OSM-${el.id}`,
                        is_greenery: true,
                        greenery_type: greeneryType,
                        height: h,
                        levels: 0,
                        build_year: 0
                    },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [coords]
                    }
                });
            } else {
                // Building
                const levels = parseInt(tags['building:levels'] || tags.levels || Math.round(parseFloat(tags.height || 0) / 3.5) || 1);
                const roofShape = (tags['roof:shape'] || 'flat').toLowerCase();
                const roofAngle = parseFloat(tags['roof:angle'] || 0);
                const roofOrient = (tags['roof:orientation'] || '').toLowerCase();
                features.push({
                    type: 'Feature',
                    id: el.id,
                    properties: {
                        id: el.id,
                        name: tags.name || tags['name:id'] || tags['name:en'] || `Gedung OSM-${el.id}`,
                        building: tags.building || 'building',
                        is_greenery: false,
                        levels: levels,
                        height: parseFloat(tags.height) || (levels * 3.5),
                        roof_shape: roofShape,
                        roof_angle: roofAngle,
                        roof_orient: roofOrient,
                        build_year: parseStartYear(tags)
                    },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [coords]
                    }
                });
            }
        } else if (el.type === 'relation' && el.members) {
            const outerMembers = el.members.filter(m => m.role === 'outer' && m.geometry && m.geometry.length >= 3);
            outerMembers.forEach((m, idx) => {
                const coords = m.geometry.map(pt => [pt.lon, pt.lat]);
                if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
                    coords.push([coords[0][0], coords[0][1]]);
                }
                
                if (isGreenery) {
                    let greeneryType = 'grass';
                    let h = 0.5;
                    if (tags.landuse === 'forest' || tags.natural === 'wood') { greeneryType = 'forest'; h = 12; }
                    else if (tags.leisure === 'park' || tags.leisure === 'garden') { greeneryType = 'park'; h = 4; }
                    else if (tags.natural === 'scrub') { greeneryType = 'scrub'; h = 2; }
                    
                    features.push({
                        type: 'Feature',
                        id: `${el.id}-${idx}`,
                        properties: {
                            id: `${el.id}-${idx}`,
                            name: tags.name || tags['name:id'] || `Vegetasi OSM-${el.id}`,
                            is_greenery: true,
                            greenery_type: greeneryType,
                            height: h,
                            levels: 0,
                            build_year: 0
                       },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [coords]
                        }
                    });
                } else {
                    // Building
                    const levels = parseInt(tags['building:levels'] || tags.levels || Math.round(parseFloat(tags.height || 0) / 3.5) || 1);
                    const roofShape = (tags['roof:shape'] || 'flat').toLowerCase();
                    const roofAngle = parseFloat(tags['roof:angle'] || 0);
                    const roofOrient = (tags['roof:orientation'] || '').toLowerCase();
                    features.push({
                        type: 'Feature',
                        id: `${el.id}-${idx}`,
                        properties: {
                            id: `${el.id}-${idx}`,
                            name: tags.name || tags['name:id'] || tags['name:en'] || `Gedung OSM-${el.id}`,
                            building: tags.building || 'building',
                            is_greenery: false,
                            levels: levels,
                            height: parseFloat(tags.height) || (levels * 3.5),
                            roof_shape: roofShape,
                            roof_angle: roofAngle,
                            roof_orient: roofOrient,
                            build_year: parseStartYear(tags)
                        },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [coords]
                        }
                    });
                }
            });
        } else if (el.type === 'node' && tags.natural === 'tree' && el.lat && el.lon) {
            // Render tree as small hexagon canopy polygon
            const hexCoords = createHexagon(el.lon, el.lat, 2.5); // 2.5m radius
            features.push({
                type: 'Feature',
                id: el.id,
                properties: {
                    id: el.id,
                    name: tags.name || `Pohon OSM-${el.id}`,
                    is_greenery: true,
                    greenery_type: 'tree',
                    height: 8,
                    levels: 0,
                    build_year: 0
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: hexCoords
                }
            });
        }
    });

    return { type: 'FeatureCollection', features: features };
}

function polygonAreaM2(coords) {
    const toRad = d => d * Math.PI / 180;
    let area = 0;
    const n = coords.length;
    for (let i = 0; i < n; i++) {
        const [x1, y1] = coords[i];
        const [x2, y2] = coords[(i + 1) % n];
        area += (toRad(x2) - toRad(x1)) * (2 + Math.sin(toRad(y1)) + Math.sin(toRad(y2)));
    }
    return Math.abs(area * 6378137 * 6378137 / 2);
}

function enrichFeatures(data) {
    const buildingEmissScale  = parseInt(document.getElementById('sl-building-emissions').value) / 100;
    const forestAbsorbRate    = parseFloat(document.getElementById('sl-greenery-absorption').value);

    // Scaling factors for other vegetation types based on forest rate
    const parkAbsorbRate   = forestAbsorbRate * (1.5 / 2.4);
    const grassAbsorbRate  = 0.4;
    const scrubAbsorbRate  = 0.8;
    const treeAbsorbRate   = 22.0;

    const INTENSITY = {
        residential: 80, apartments: 80, house: 80, detached: 80, terrace: 80,
        office: 180, commercial: 180, retail: 180, hotel: 180, supermarket: 180,
        industrial: 150, warehouse: 150, yes: 100
    };

    data.features.forEach(f => {
        if (!f.properties) f.properties = {};
        
        // Calculate footprint area
        if (!f.properties.area_m2 && f.geometry) {
            let coords = [];
            if (f.geometry.type === 'Polygon') coords = f.geometry.coordinates[0];
            else if (f.geometry.type === 'MultiPolygon') coords = f.geometry.coordinates[0][0];
            if (coords.length) f.properties.area_m2 = Math.round(polygonAreaM2(coords));
        }
        
        const area = f.properties.area_m2 || 10;

        if (f.properties.is_greenery) {
            // Greenery calculations
            const type = f.properties.greenery_type || 'grass';
            let absorb = 0;
            if (type === 'forest') absorb = area * forestAbsorbRate;
            else if (type === 'park') absorb = area * parkAbsorbRate;
            else if (type === 'grass') absorb = area * grassAbsorbRate;
            else if (type === 'scrub') absorb = area * scrubAbsorbRate;
            else if (type === 'tree') absorb = treeAbsorbRate; // flat per tree node
            
            f.properties.co2_absorption_kg = Math.round(absorb);
            f.properties.energy_kwh = 0;
            f.properties.co2_saving_kg = 0;
            f.properties.co2_emission_kg = 0;
        } else {
            // Building calculations
            f.properties.energy_kwh = 0;
            f.properties.co2_saving_kg = 0;

            // Building CO2 emissions
            const bType = f.properties.building || 'yes';
            const levels = f.properties.levels || 1;
            const intensity = INTENSITY[bType] || 100;
            f.properties.co2_emission_kg = Math.round(area * levels * intensity * buildingEmissScale * CO2_KG_PER_KWH);
            f.properties.co2_absorption_kg = 0;
        }
    });
    return data;
}

// ============================================================
//  FILTER & DYNAMIC RENDERING
// ============================================================
window.applyFilters = function() {
    if (!allGeojsonData) return { type: 'FeatureCollection', features: [] };
    
    const minLevels = parseInt(document.getElementById('sl-min-levels').value);
    const buildingEmissScale  = parseInt(document.getElementById('sl-building-emissions').value) / 100;
    const forestAbsorbRate    = parseFloat(document.getElementById('sl-greenery-absorption').value);

    const parkAbsorbRate   = forestAbsorbRate * (1.5 / 2.4);
    const grassAbsorbRate  = 0.4;
    const scrubAbsorbRate  = 0.8;
    const treeAbsorbRate   = 22.0;
    
    const INTENSITY = {
        residential: 80, apartments: 80, house: 80, detached: 80, terrace: 80,
        office: 180, commercial: 180, retail: 180, hotel: 180, supermarket: 180,
        industrial: 150, warehouse: 150, yes: 100
    };

    // Deep copy parameters & recalculate
    const filteredFeatures = allGeojsonData.features
        .filter(f => f.properties.is_greenery || f.properties.levels >= minLevels)
        .map(f => {
            const area = f.properties.area_m2 || 10;
            const props = { ...f.properties };

            if (props.is_greenery) {
                const type = props.greenery_type || 'grass';
                let absorb = 0;
                if (type === 'forest') absorb = area * forestAbsorbRate;
                else if (type === 'park') absorb = area * parkAbsorbRate;
                else if (type === 'grass') absorb = area * grassAbsorbRate;
                else if (type === 'scrub') absorb = area * scrubAbsorbRate;
                else if (type === 'tree') absorb = treeAbsorbRate;
                props.co2_absorption_kg = Math.round(absorb);
            } else {
                const bType = props.building || 'yes';
                const levels = props.levels || 1;
                const intensity = INTENSITY[bType] || 100;
                props.co2_emission_kg = Math.round(area * levels * intensity * buildingEmissScale * CO2_KG_PER_KWH);
                props.energy_kwh = 0;
                props.co2_saving_kg = 0;
            }

            return {
                ...f,
                properties: props
            };
        });
        
    geojsonData = {
        type: 'FeatureCollection',
        features: filteredFeatures
    };
    
    // Render 3D and update stats dashboard
    renderBuildingsLayer(geojsonData);
    updateStatsDashboard(geojsonData);

    return geojsonData;
};

window.updateParametersUI = function() {
    const valMinLevels = document.getElementById('val-min-levels');
    if (valMinLevels && document.getElementById('sl-min-levels')) {
        valMinLevels.textContent = document.getElementById('sl-min-levels').value;
    }

    const valBuildingEmiss = document.getElementById('val-building-emissions');
    if (valBuildingEmiss && document.getElementById('sl-building-emissions')) {
        valBuildingEmiss.textContent = document.getElementById('sl-building-emissions').value + '%';
    }

    const valGreeneryAbsorb = document.getElementById('val-greenery-absorption');
    if (valGreeneryAbsorb && document.getElementById('sl-greenery-absorption')) {
        valGreeneryAbsorb.textContent = document.getElementById('sl-greenery-absorption').value;
    }
    
    // Instantly recalculate & render on parameter slide
    applyFilters();
    
    // If sidebar is open, update simulator values
    if (currentFeature) {
        updateSim();
    }
};

function renderBuildingsLayer(data) {
    // Cleanup old layers
    ['buildings-labels','buildings-3d','buildings-outline','solar-panel-overlay']
        .forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch(_){} });
    try { if (map.getSource('buildings-source')) map.removeSource('buildings-source'); } catch(_){}
    
    // Add fresh geojson source
    map.addSource('buildings-source', { type: 'geojson', data, generateId: true });
    
    // Get active coloring expression
    let colorExpr = CARBON_COLOR_EXPR;
    if (timeMachineActive) {
        colorExpr = ERA_COLOR_EXPR;
    } else {
        if (mapColorMode === 'density') colorExpr = DENSITY_COLOR_EXPR;
        else if (mapColorMode === 'height') colorExpr = HEIGHT_COLOR_EXPR;
    }

    // 3D Extrusion
    map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'buildings-source',
        paint: {
            'fill-extrusion-height': [
                'case',
                ['get', 'is_greenery'],
                ['coalesce', ['get', 'height'], 5],
                ['*', ['coalesce', ['get', 'levels'], 1], 3.5]
            ],
            'fill-extrusion-base': 0,
            'fill-extrusion-color': colorExpr,
            'fill-extrusion-opacity': 0.92,
            'fill-extrusion-vertical-gradient': true
        }
    });
    
    // Outline (for buildings only)
    map.addLayer({
        id: 'buildings-outline',
        type: 'line',
        source: 'buildings-source',
        filter: ['!', ['get', 'is_greenery']],
        paint: {
            'line-color': 'rgba(148, 210, 255, 0.45)',
            'line-width': 1
        }
    });
    
    setupBuildingInteractions();
}

function updateStatsDashboard(data) {
    const count = data.features.length;
    const statsDashboard = document.getElementById('stats-dashboard');
    if (statsDashboard) statsDashboard.style.display = count > 0 ? 'block' : 'none';
    
    if (count === 0) return;
    
    let totalBuildings = 0;
    let totalGreenArea = 0;
    let totalCO2Emissions = 0;
    let totalCO2Absorption = 0;
    
    data.features.forEach(f => {
        const p = f.properties;
        const area = p.area_m2 || 0;
        if (p.is_greenery) {
            totalGreenArea += area;
            totalCO2Absorption += p.co2_absorption_kg || 0;
        } else {
            totalBuildings++;
            totalCO2Emissions += p.co2_emission_kg || 0;
        }
    });
    
    const netBalance = totalCO2Emissions - totalCO2Absorption;

    // Update DOM values
    const statBuildings = document.getElementById('stat-buildings');
    if (statBuildings) statBuildings.textContent = fmt(totalBuildings);
    
    const statGreenArea = document.getElementById('stat-green-area');
    if (statGreenArea) statGreenArea.textContent = fmt(totalGreenArea);
    
    const statCO2Emiss = document.getElementById('stat-co2-emissions');
    if (statCO2Emiss) statCO2Emiss.textContent = fmt(totalCO2Emissions / 1000, 1) + ' t';
    
    const statCO2Absorb = document.getElementById('stat-co2-absorption');
    if (statCO2Absorb) statCO2Absorb.textContent = fmt(totalCO2Absorption / 1000, 1) + ' t';
    
    const balEl = document.getElementById('stat-carbon-balance');
    const statusEl = document.getElementById('stat-carbon-status');
    if (balEl && statusEl) {
        if (netBalance > 0) {
            balEl.textContent = '+' + fmt(netBalance / 1000, 1) + ' t/thn';
            balEl.style.color = 'var(--red-400)';
            statusEl.textContent = 'Pelepasan (Carbon Source)';
            statusEl.style.color = 'var(--red-400)';
        } else {
            balEl.textContent = '-' + fmt(Math.abs(netBalance) / 1000, 1) + ' t/thn';
            balEl.style.color = 'var(--green-400)';
            statusEl.textContent = 'Penyerapan (Carbon Sink)';
            statusEl.style.color = 'var(--green-400)';
        }
    }

    // Rebuild Top 5 list based on mapColorMode
    const titleEl = document.getElementById('top-list-title');
    let sortedFeatures = [];
    let topLabel = 'Top 5 Potensi Terbesar';
    
    const buildingsOnly = data.features.filter(f => !f.properties.is_greenery);
    
    if (mapColorMode === 'height') {
        topLabel = 'Top 5 Bangunan Tertinggi';
        if (titleEl) titleEl.textContent = topLabel;
        sortedFeatures = [...buildingsOnly]
            .sort((a,b) => (b.properties.levels || 0) - (a.properties.levels || 0))
            .slice(0, 5);
    } else if (mapColorMode === 'density') {
        topLabel = 'Top 5 Tapak Gedung Terluas';
        if (titleEl) titleEl.textContent = topLabel;
        sortedFeatures = [...buildingsOnly]
            .sort((a,b) => (b.properties.area_m2 || 0) - (a.properties.area_m2 || 0))
            .slice(0, 5);
    } else {
        // carbon
        topLabel = 'Top 5 Emisi CO₂ Terbesar';
        if (titleEl) titleEl.textContent = topLabel;
        sortedFeatures = [...buildingsOnly]
            .sort((a,b) => (b.properties.co2_emission_kg || 0) - (a.properties.co2_emission_kg || 0))
            .slice(0, 5);
    }
    
    const container = document.getElementById('top-buildings-container');
    if (container) {
        container.innerHTML = '';
        if (sortedFeatures.length > 0) {
            let maxVal = 1;
            if (mapColorMode === 'height') maxVal = sortedFeatures[0].properties.levels || 1;
            else if (mapColorMode === 'density') maxVal = sortedFeatures[0].properties.area_m2 || 1;
            else maxVal = sortedFeatures[0].properties.co2_emission_kg || 1;
            
            sortedFeatures.forEach(f => {
                const p = f.properties;
                let val = 0;
                let unit = '';
                let desc = '';
                if (mapColorMode === 'density') {
                    val = p.area_m2;
                    unit = ' m²';
                    desc = `Tipe: ${p.building.toUpperCase()} | Lantai: ${p.levels}`;
                } else if (mapColorMode === 'height') {
                    val = p.levels;
                    unit = ' Lantai';
                    desc = `Tinggi: ${fmt(p.height, 1)} m | Luas: ${fmt(p.area_m2)} m²`;
                } else {
                    val = p.co2_emission_kg;
                    unit = ' kg CO₂/thn';
                    desc = `Tipe: ${p.building.toUpperCase()} | Lantai: ${p.levels}`;
                }
                
                const pct = Math.min(100, Math.round((val / maxVal) * 100));
                
                const div = document.createElement('div');
                div.className = 'top-item';
                div.innerHTML = `
                    <div class="top-item-header">
                        <span style="color:var(--white); font-weight:600;">${p.name}</span>
                        <span style="color:var(--cyan-400);">${fmt(val)}${unit}</span>
                    </div>
                    <div class="top-item-stats">
                        <span>${desc}</span>
                    </div>
                    <div class="top-item-bar-bg">
                        <div class="top-item-bar" style="width: ${pct}%; background: ${mapColorMode === 'density' ? 'var(--cyan-500)' : mapColorMode === 'height' ? 'var(--violet-500)' : 'var(--red-500)'};"></div>
                    </div>
                `;
                div.style.cursor = 'pointer';
                div.onclick = () => selectBuildingFeature(f);
                container.appendChild(div);
            });
        } else {
            container.innerHTML = '<div class="no-projects">Tidak ada gedung untuk ditampilkan</div>';
        }
    }
}

function fitCameraToAoi(minLon, minLat, maxLon, maxLat) {
    map.fitBounds([
        [minLon, minLat],
        [maxLon, maxLat]
    ], {
        padding: 50,
        duration: 1500,
        essential: true
    });
    
    setTimeout(() => {
        map.flyTo({
            pitch: 60,
            bearing: -15,
            duration: 1000
        });
    }, 1600);
}

// ============================================================
//  INTERACTIVE ACTIONS (Hover & Click)
// ============================================================
let hoveredId = null;
let interactionsSetup = false;

function setupBuildingInteractions() {
    // Prevent duplicate event listener registrations
    if (interactionsSetup) return;
    interactionsSetup = true;

    map.on('mousemove', 'buildings-3d', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features[0];
        
        if (hoveredId !== null) map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: false });
        hoveredId = f.id;
        map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: true });

        const p = f.properties || {};
        const tt = document.getElementById('hover-tooltip');
        if (tt) {
            tt.style.display = 'block';
            tt.style.left = (e.point.x + 12) + 'px';
            tt.style.top  = (e.point.y - 10) + 'px';
        }
        
        const htName = document.getElementById('ht-name');
        const htLevels = document.getElementById('ht-levels');
        const htArea = document.getElementById('ht-area');
        const htEnergy = document.getElementById('ht-energy');
        
        const label1 = document.querySelector('#hover-tooltip .ht-row:nth-child(2) span:first-child');
        const label2 = document.querySelector('#hover-tooltip .ht-row:nth-child(3) span:first-child');
        const label3 = document.querySelector('#hover-tooltip .ht-row:nth-child(4) span:first-child');
        
        if (p.is_greenery) {
            if (htName) htName.textContent = p.name || 'Vegetasi';
            if (label1) label1.textContent = 'Tipe';
            if (htLevels) htLevels.textContent = p.greenery_type.toUpperCase();
            if (label2) label2.textContent = 'Luas';
            if (htArea) htArea.textContent = fmt(p.area_m2) + ' m²';
            if (label3) label3.textContent = 'Serapan CO₂';
            if (htEnergy) htEnergy.textContent = fmt(p.co2_absorption_kg) + ' kg/thn';
        } else {
            if (htName) htName.textContent = p.name || 'Gedung';
            if (label1) label1.textContent = 'Lantai';
            if (htLevels) htLevels.textContent = (p.levels || 1) + ' lantai';
            if (label2) label2.textContent = 'Atap';
            if (htArea) htArea.textContent = fmt(p.area_m2) + ' m²';
            if (label3) label3.textContent = 'Pot. Energi';
            if (htEnergy) htEnergy.textContent = fmt(p.energy_kwh) + ' kWh';
        }
    });
    
    map.on('mouseleave', 'buildings-3d', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredId !== null) map.setFeatureState({ source: 'buildings-source', id: hoveredId }, { hover: false });
        hoveredId = null;
        const tt = document.getElementById('hover-tooltip');
        if (tt) tt.style.display = 'none';
    });
    
    map.on('click', 'buildings-3d', (e) => {
        const f = e.features[0];
        selectBuildingFeature(f);
    });
}

function selectBuildingFeature(feature) {
    currentFeature = feature;
    const p = feature.properties || {};
    currentArea = p.area_m2 || 10;
    
    const bName = document.getElementById('detail-building-name');
    const bType = document.getElementById('detail-building-type');
    
    const lbl1 = document.getElementById('lbl-metric-1');
    const val1 = document.getElementById('d-levels');
    const lbl2 = document.getElementById('lbl-metric-2');
    const val2 = document.getElementById('d-height');
    const lbl3 = document.getElementById('lbl-metric-3');
    const val3 = document.getElementById('d-area');
    const lbl4 = document.getElementById('lbl-metric-4');
    const val4 = document.getElementById('d-energy');
    const lbl5 = document.getElementById('lbl-metric-5');
    const val5 = document.getElementById('d-co2');
    const lbl6 = document.getElementById('lbl-metric-6');
    const val6 = document.getElementById('d-roof-shape');
    const lbl7 = document.getElementById('lbl-metric-7');
    const val7 = document.getElementById('d-roof-modifier');
    
    // Carbon price valuation (IDR 150/kg)
    const carbonRate = 150.00;

    const row6 = document.getElementById('metric-row-6');
    const row7 = document.getElementById('metric-row-7');

    if (p.is_greenery) {
        if (bName) bName.textContent = p.name || 'Vegetasi';
        if (bType) bType.textContent = ('Vegetasi ' + p.greenery_type).toUpperCase();
        
        if (lbl1) lbl1.innerHTML = '<i class="fa fa-tree"></i> Tipe Vegetasi';
        if (val1) val1.textContent = p.greenery_type.toUpperCase();
        
        if (lbl2) lbl2.innerHTML = '<i class="fa fa-ruler-vertical"></i> Tinggi Kanopi';
        if (val2) val2.textContent = p.height.toFixed(1) + ' m';
        
        if (lbl3) lbl3.innerHTML = '<i class="fa fa-vector-square"></i> Luas Vegetasi';
        if (val3) val3.textContent = fmt(currentArea) + ' m²';
        
        if (lbl4) lbl4.innerHTML = '<i class="fa fa-cloud-arrow-down"></i> Serapan CO₂';
        if (val4) val4.textContent = fmt(p.co2_absorption_kg) + ' kg/thn';
        
        if (lbl5) lbl5.innerHTML = '<i class="fa fa-sack-dollar"></i> Valuasi Karbon';
        const carbonValuation = Math.round(p.co2_absorption_kg * carbonRate);
        if (val5) val5.textContent = fmtIDR(carbonValuation) + '/thn';
        
        if (lbl6) lbl6.innerHTML = '<i class="fa fa-calculator"></i> Est. Jumlah Pohon';
        const estTrees = p.greenery_type === 'tree' ? 1 : Math.max(1, Math.round(currentArea / 10));
        if (val6) val6.textContent = fmt(estTrees) + ' pohon';
        if (row6) row6.style.display = 'flex';
        
        if (lbl7) lbl7.innerHTML = '<i class="fa fa-circle-nodes"></i> Kepadatan Kanopi';
        if (val7) val7.textContent = p.greenery_type === 'forest' ? '90% (Tinggi)' : p.greenery_type === 'park' ? '65% (Sedang)' : '30% (Rendah)';
        if (row7) row7.style.display = 'flex';
        
        // Update Simulator Panel
        const simTitle = document.getElementById('sim-title');
        if (simTitle) simTitle.innerHTML = '<i class="fa fa-leaf"></i> Simulator Penghijauan';
        const lblSim1 = document.getElementById('lbl-sim-slider-1');
        if (lblSim1) lblSim1.textContent = 'Kepadatan Pohon (Virtual)';
        const slCoverage = document.getElementById('sl-coverage');
        if (slCoverage) { slCoverage.min = 50; slCoverage.max = 200; slCoverage.value = 100; }
        const valCoverage = document.getElementById('val-coverage');
        if (valCoverage) valCoverage.textContent = '100%';
        
        // Hide second slider for greenery
        const row2 = document.getElementById('sim-slider-2-row');
        if (row2) row2.style.display = 'none';
        const slEfficiency = document.getElementById('sl-efficiency');
        if (slEfficiency) slEfficiency.style.display = 'none';
        
        // Update outputs labels
        const lblOut1 = document.getElementById('lbl-out-1');
        if (lblOut1) lblOut1.textContent = 'Jumlah Pohon';
        const lblOut2 = document.getElementById('lbl-out-2');
        if (lblOut2) lblOut2.textContent = 'Serapan Baru';
        const lblOut3 = document.getElementById('lbl-out-3');
        if (lblOut3) lblOut3.textContent = 'Valuasi Ekologis';
        const lblOut4 = document.getElementById('lbl-out-4');
        if (lblOut4) lblOut4.textContent = 'Status Kawasan';
    } else {
        if (bName) bName.textContent = p.name || 'Gedung Tanpa Nama';
        if (bType) bType.textContent = (p.building || 'building').toUpperCase();
        
        if (lbl1) lbl1.innerHTML = '<i class="fa fa-layer-group"></i> Jumlah Lantai';
        if (val1) val1.textContent = (p.levels || 1) + ' lantai';
        
        if (lbl2) lbl2.innerHTML = '<i class="fa fa-ruler-vertical"></i> Est. Tinggi Gedung';
        if (val2) val2.textContent = (p.height || (p.levels*3.5)).toFixed(1) + ' m';
        
        if (lbl3) lbl3.innerHTML = '<i class="fa fa-vector-square"></i> Luas Tapak';
        if (val3) val3.textContent = fmt(currentArea) + ' m²';
        
        if (lbl4) lbl4.innerHTML = '<i class="fa fa-leaf"></i> Emisi CO₂ Gedung';
        if (val4) val4.textContent = fmt(p.co2_emission_kg || 0) + ' kg/thn';
        
        if (lbl5) lbl5.innerHTML = '<i class="fa fa-circle-nodes"></i> Tipe Gedung';
        if (val5) val5.textContent = (p.building || 'yes').toUpperCase();
        
        if (lbl6) lbl6.innerHTML = '<i class="fa fa-calendar"></i> Tahun Konstruksi';
        if (val6) val6.textContent = p.build_year === 0 ? 'Tdk Diketahui' : p.build_year;
        if (row6) row6.style.display = 'flex';
        
        if (row7) row7.style.display = 'none'; // hide row 7 for building
        
        // Update Simulator Panel
        const simTitle = document.getElementById('sim-title');
        if (simTitle) simTitle.innerHTML = '<i class="fa fa-sliders"></i> Simulator Efisiensi Energi';
        const lblSim1 = document.getElementById('lbl-sim-slider-1');
        if (lblSim1) lblSim1.textContent = 'Target Pengurangan Emisi';
        const slCoverage = document.getElementById('sl-coverage');
        if (slCoverage) { slCoverage.min = 0; slCoverage.max = 50; slCoverage.value = 0; }
        const valCoverage = document.getElementById('val-coverage');
        if (valCoverage) valCoverage.textContent = '0%';
        
        // Hide second slider for building as we only do Retrofit % target
        const row2 = document.getElementById('sim-slider-2-row');
        if (row2) row2.style.display = 'none';
        const slEfficiency = document.getElementById('sl-efficiency');
        if (slEfficiency) slEfficiency.style.display = 'none';
        
        // Update outputs labels
        const lblOut1 = document.getElementById('lbl-out-1');
        if (lblOut1) lblOut1.textContent = 'Emisi Awal';
        const lblOut2 = document.getElementById('lbl-out-2');
        if (lblOut2) lblOut2.textContent = 'Emisi Target';
        const lblOut3 = document.getElementById('lbl-out-3');
        if (lblOut3) lblOut3.textContent = 'Reduksi CO₂';
        const lblOut4 = document.getElementById('lbl-out-4');
        if (lblOut4) lblOut4.textContent = 'Kelas Emisi';
    }
    
    const rightPanel = document.getElementById('right-panel');
    if (rightPanel) rightPanel.classList.add('open');
    updateSim();
    
    let center = [0, 0];
    if (feature.geometry) {
        const g = feature.geometry;
        if (g.type === 'Polygon') center = g.coordinates[0][0];
        else if (g.type === 'MultiPolygon') center = g.coordinates[0][0][0];
    }
    if (center[0] !== 0) {
        map.flyTo({ center, zoom: Math.max(map.getZoom(), 16), pitch: 65, duration: 1000 });
    }
}

window.closeDetail = function() {
    const rightPanel = document.getElementById('right-panel');
    if (rightPanel) rightPanel.classList.remove('open');
    currentFeature = null;
};

// Simulator for selected building or greenery
window.updateSim = function() {
    if (!currentFeature) return;
    const p = currentFeature.properties || {};
    
    const valCoverage = document.getElementById('val-coverage');
    const outEnergy = document.getElementById('out-energy');
    const outSaving = document.getElementById('out-saving');
    const outCo2 = document.getElementById('out-co2');
    const outRoi = document.getElementById('out-roi');
    
    // Carbon price valuation (IDR 150/kg)
    const carbonRate = 150.00;

    if (p.is_greenery) {
        const density = parseInt(document.getElementById('sl-coverage').value);
        if (valCoverage) valCoverage.textContent = density + '%';
        
        const area = currentArea || 10;
        const baseTrees = p.greenery_type === 'tree' ? 1 : Math.max(1, Math.round(area / 10));
        const simTrees = Math.round(baseTrees * (density / 100));
        
        // Recalculate absorption based on tree density
        const baseAbsorb = p.co2_absorption_kg || 0;
        const simAbsorb = Math.round(baseAbsorb * (density / 100));
        const simValuation = Math.round(simAbsorb * carbonRate);
        
        if (outEnergy) outEnergy.textContent = fmt(simTrees) + ' phn';
        if (outSaving) outSaving.textContent = fmt(simAbsorb) + ' kg';
        if (outCo2) outCo2.textContent = fmtIDR(simValuation);
        
        let statusText = 'Standar';
        if (density >= 150) statusText = 'Rimbun';
        else if (density <= 70) statusText = 'Gersang';
        if (outRoi) outRoi.textContent = statusText;
    } else {
        const reductionPct = parseInt(document.getElementById('sl-coverage').value);
        if (valCoverage) valCoverage.textContent = reductionPct + '%';
        
        const area = currentArea || 10;
        const levels = p.levels || 1;
        const baseEmissions = p.co2_emission_kg || 0;
        
        const simEmissions = Math.round(baseEmissions * (1 - reductionPct / 100));
        const simReduction = baseEmissions - simEmissions;
        
        if (outEnergy) outEnergy.textContent = fmt(baseEmissions) + ' kg';
        if (outSaving) outSaving.textContent = fmt(simEmissions) + ' kg';
        if (outCo2) outCo2.textContent = fmt(simReduction) + ' kg';
        
        // Classify building based on kg CO2 emissions per m2
        const emissPerM2 = baseEmissions / (area * levels);
        let bClass = 'E';
        if (emissPerM2 < 30) bClass = 'A';
        else if (emissPerM2 < 60) bClass = 'B';
        else if (emissPerM2 < 90) bClass = 'C';
        else if (emissPerM2 < 120) bClass = 'D';
        
        if (outRoi) outRoi.textContent = 'Kelas ' + bClass;
    }
};

// ============================================================
//  EXPORTS SECTION
// ============================================================
window.exportGeoJSON = function() {
    if (!userSession) {
        showToast('⚠️ Fitur ekspor GeoJSON hanya tersedia untuk pengguna terdaftar!', 'warning');
        return;
    }
    if (!geojsonData) return;
    const blob = new Blob([JSON.stringify(geojsonData, null, 2)], { type: 'application/geojson;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `UrbanAnalysis_3D_${Date.now()}.geojson`;
    a.click();
    showToast('📂 GeoJSON berhasil diekspor!', 'success');
};

window.exportCSV = function() {
    if (!userSession) {
        showToast('⚠️ Fitur ekspor CSV hanya tersedia untuk pengguna terdaftar!', 'warning');
        return;
    }
    if (!geojsonData) return;
    let csv = 'id_osm;nama_objek;is_greenery;tipe;jumlah_lantai;luas_m2;emisi_co2_kg;serapan_co2_kg;energi_kwh_tahun\n';
    
    geojsonData.features.forEach(f => {
        const p = f.properties;
        const isG = p.is_greenery ? 'YA' : 'TIDAK';
        const type = p.is_greenery ? p.greenery_type : p.building;
        csv += `"${p.id}";"${p.name}";"${isG}";"${type}";${p.levels || 0};${p.area_m2 || 0};${p.co2_emission_kg || 0};${p.co2_absorption_kg || 0};${p.energy_kwh || 0}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `UrbanAnalysis_Analisis_${Date.now()}.csv`;
    a.click();
    showToast('📋 CSV berhasil diekspor!', 'success');
};

window.exportLaporan = function() {
    if (!userSession) {
        showToast('⚠️ Fitur ekspor Laporan hanya tersedia untuk pengguna terdaftar!', 'warning');
        return;
    }
    if (!geojsonData) return;
    
    let totalBuildings = 0;
    let totalGreenArea = 0;
    let totalCO2Emissions = 0;
    let totalCO2Absorption = 0;
    
    geojsonData.features.forEach(f => {
        const p = f.properties;
        const area = p.area_m2 || 0;
        if (p.is_greenery) {
            totalGreenArea += area;
            totalCO2Absorption += p.co2_absorption_kg || 0;
        } else {
            totalBuildings++;
            totalCO2Emissions += p.co2_emission_kg || 0;
        }
    });
    
    const netBalance = totalCO2Emissions - totalCO2Absorption;
    const netBalanceTons = netBalance / 1000;

    const report = `==========================================================
LAPORAN ANALISIS URBAN 3D & NERACA KARBON
==========================================================
Dihasilkan pada: ${new Date().toLocaleString('id-ID')}
Cakupan Wilayah: Area of Interest (OSM)

METRIK PERKOTAAN & LINGKUNGAN:
----------------------------------------------------------
1. Jumlah Bangunan Teranalisis: ${totalBuildings} unit
2. Luas Area Hijau (RTH): ${totalGreenArea.toLocaleString('id-ID')} m²
3. Total Emisi CO2 Gedung: ${(totalCO2Emissions / 1000).toLocaleString('id-ID', {maximumFractionDigits: 2})} ton / tahun
4. Total Serapan CO2 RTH: ${(totalCO2Absorption / 1000).toLocaleString('id-ID', {maximumFractionDigits: 2})} ton / tahun

NERACA KARBON NETTO:
----------------------------------------------------------
Status: ${netBalance > 0 ? '🔴 PELEPASAN KARBON (Carbon Source)' : '🟢 PENYERAPAN KARBON (Carbon Sink)'}
Nilai Bersih: ${Math.abs(netBalanceTons).toLocaleString('id-ID', {maximumFractionDigits: 2})} ton CO₂ / tahun

PARAMETER GLOBAL:
- Min. Lantai Gedung: ${document.getElementById('sl-min-levels').value} lantai
- Faktor Emisi Bangunan: ${document.getElementById('sl-building-emissions').value}%
- Daya Serap Hutan RTH: ${document.getElementById('sl-greenery-absorption').value} kg/m²/tahun

Dihasilkan secara otomatis oleh Urban3D.
==========================================================`;

    const blob = new Blob([report], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `UrbanAnalysis_Laporan_${Date.now()}.txt`;
    a.click();
    showToast('📝 Laporan TXT berhasil diekspor!', 'success');
};

// ============================================================
//  PROJECT LIBRARY & SUPABASE STORAGE
// ============================================================

// Load local projects from localStorage
function loadLocalProjects() {
    try {
        const raw = localStorage.getItem('solarcadastre_local_projects');
        localProjects = raw ? JSON.parse(raw) : [];
    } catch(e) {
        console.error('Gagal memuat local storage projects:', e);
        localProjects = [];
    }
    renderProjectList();
}

// Render list of projects in sidebar
let currentLibraryTab = 'library'; // 'library' or 'archive'
let lastLoadedProjectList = [];

// Helper to get archived project IDs from localStorage
function getArchivedIds() {
    return JSON.parse(localStorage.getItem('archived_projects') || '[]');
}

// Helper to save archived project IDs to localStorage
function saveArchivedIds(ids) {
    localStorage.setItem('archived_projects', JSON.stringify(ids));
}

// Function to switch tabs in the Library modal
window.switchLibraryTab = function(tab) {
    currentLibraryTab = tab;
    
    // Update active tab buttons UI
    const tabLib = document.getElementById('tab-library');
    const tabArc = document.getElementById('tab-archive');
    if (tabLib) tabLib.classList.toggle('active', tab === 'library');
    if (tabArc) tabArc.classList.toggle('active', tab === 'archive');
    
    // Show/hide save section (only save projects in active library)
    const saveSec = document.getElementById('library-save-section');
    if (saveSec) saveSec.style.display = tab === 'library' ? 'block' : 'none';
    
    // Update lists label
    const listLabel = document.getElementById('library-list-label');
    if (listLabel) listLabel.textContent = tab === 'library' ? 'Daftar Project Aktif' : 'Daftar Project di Arsip';
    
    // Re-render
    renderMergedProjectList(lastLoadedProjectList);
};

window.archiveProject = function(id, event) {
    if (event) event.stopPropagation();
    const archivedIds = getArchivedIds();
    if (!archivedIds.includes(id)) {
        archivedIds.push(id);
        saveArchivedIds(archivedIds);
        showToast('📦 Project dipindahkan ke Arsip!', 'info');
        renderMergedProjectList(lastLoadedProjectList);
    }
};

window.unarchiveProject = function(id, event) {
    if (event) event.stopPropagation();
    let archivedIds = getArchivedIds();
    archivedIds = archivedIds.filter(x => x !== id);
    saveArchivedIds(archivedIds);
    showToast('📂 Project dikembalikan ke Library!', 'success');
    renderMergedProjectList(lastLoadedProjectList);
};

function renderProjectList() {
    renderMergedProjectList(localProjects);
}

async function fetchCloudProjects() {
    if (!supabase || !userSession) return;
    try {
        const { data, error } = await supabase
            .from('projects')
            .select('*')
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        
        const cloudProjects = (data || []).map(p => ({
            id: p.id,
            name: p.name + ' ☁️',
            isCloud: true,
            aoi_geojson: p.aoi_geojson,
            geojson_data: p.geojson_data,
            project_stats: p.project_stats || p.solar_stats
        }));
        
        const merged = [...cloudProjects, ...localProjects];
        renderMergedProjectList(merged);
    } catch (err) {
        console.warn('[Library] Table projects mungkin belum dibuat:', err.message);
        loadLocalProjects();
    }
}

function renderMergedProjectList(list) {
    const container = document.getElementById('project-list-container');
    if (!container) return;
    container.innerHTML = '';
    
    lastLoadedProjectList = list || [];
    const archivedIds = getArchivedIds();
    
    // Filter list based on current tab
    const filteredList = lastLoadedProjectList.filter(p => {
        const isArchived = archivedIds.includes(p.id);
        return currentLibraryTab === 'library' ? !isArchived : isArchived;
    });
    
    if (filteredList.length === 0) {
        container.innerHTML = `<div class="no-projects">Tidak ada project di ${currentLibraryTab === 'library' ? 'Library' : 'Arsip'}</div>`;
        return;
    }
    
    filteredList.forEach((p) => {
        const item = document.createElement('div');
        item.className = 'project-item';
        
        const nameBtn = document.createElement('button');
        nameBtn.className = 'project-name-btn';
        nameBtn.innerHTML = `<i class="fa fa-map"></i> ${p.name}`;
        nameBtn.onclick = () => {
            loadProject(p);
            closeLibraryModal();
        };
        
        // Archive / Unarchive Button
        const archiveBtn = document.createElement('button');
        archiveBtn.className = 'project-delete-btn';
        archiveBtn.style.color = 'var(--cyan-400)';
        archiveBtn.style.marginRight = '6px';
        if (currentLibraryTab === 'library') {
            archiveBtn.innerHTML = '<i class="fa fa-box-archive"></i>';
            archiveBtn.title = 'Pindahkan ke Arsip';
            archiveBtn.onclick = (e) => archiveProject(p.id, e);
        } else {
            archiveBtn.innerHTML = '<i class="fa fa-box-open"></i>';
            archiveBtn.title = 'Kembalikan ke Library';
            archiveBtn.onclick = (e) => unarchiveProject(p.id, e);
        }
        
        const delBtn = document.createElement('button');
        delBtn.className = 'project-delete-btn';
        delBtn.innerHTML = '<i class="fa fa-trash-can"></i>';
        delBtn.title = 'Hapus Permanen';
        delBtn.onclick = () => deleteProject(p.id, p.isCloud);
        
        item.appendChild(nameBtn);
        item.appendChild(archiveBtn);
        item.appendChild(delBtn);
        container.appendChild(item);
    });
}

// Save current analysis to library
window.saveCurrentProject = async function() {
    const nameInput = document.getElementById('new-project-name');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) { showToast('⚠️ Harap masukkan nama project!', 'error'); return; }
    
    const hasAoi = (drawMode === 'rectangle' && cornerA && cornerB) || 
                    (drawMode === 'circle' && circleCenter && circleRadius) || 
                    (drawMode === 'polygon' && polygonPts.length >= 3);
                    
    if (!allGeojsonData || !hasAoi) { showToast('⚠️ Lakukan analisis terlebih dahulu!', 'error'); return; }
    
    const saveBtn = document.getElementById('save-project-btn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i>';
    }

    let aoiGeoJSON = null;
    if (drawMode === 'rectangle') {
        aoiGeoJSON = {
            type: 'Feature',
            properties: { drawMode: 'rectangle' },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [cornerA[0], cornerA[1]],
                    [cornerB[0], cornerA[1]],
                    [cornerB[0], cornerB[1]],
                    [cornerA[0], cornerB[1]],
                    [cornerA[0], cornerA[1]]
                ]]
            }
        };
    } else if (drawMode === 'circle') {
        aoiGeoJSON = {
            type: 'Feature',
            properties: { drawMode: 'circle', circleCenter: circleCenter, circleRadius: circleRadius },
            geometry: createCirclePolygon(circleCenter, circleRadius)
        };
    } else if (drawMode === 'polygon') {
        aoiGeoJSON = {
            type: 'Feature',
            properties: { drawMode: 'polygon', polygonPts: polygonPts },
            geometry: {
                type: 'Polygon',
                coordinates: [polygonPts]
            }
        };
    }

    const stats = {
        minLevels: parseInt(document.getElementById('sl-min-levels').value),
        buildingEmissions: parseInt(document.getElementById('sl-building-emissions').value),
        greeneryAbsorption: parseFloat(document.getElementById('sl-greenery-absorption').value)
    };

    const projectPayload = {
        name: name,
        aoi_geojson: aoiGeoJSON,
        geojson_data: allGeojsonData,
        solar_stats: stats
    };

    if (supabase && userSession) {
        try {
            const { error } = await supabase
                .from('projects')
                .insert({
                    name: name,
                    aoi_geojson: aoiGeoJSON,
                    geojson_data: allGeojsonData,
                    project_stats: stats,
                    user_id: userSession.user.id
                });
            if (error) throw error;
            showToast('✅ Berhasil disimpan ke Supabase Cloud!', 'success');
            nameInput.value = '';
            fetchCloudProjects();
        } catch (err) {
            console.error('[Supabase Save Error]', err);
            showToast('⚠️ Gagal simpan ke Cloud. Pastikan tabel projects siap di DDL.', 'error');
            saveLocalFallback(projectPayload);
        }
    } else {
        saveLocalFallback(projectPayload);
    }
    
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = 'Simpan';
    }
};

function saveLocalFallback(projectPayload) {
    projectPayload.id = 'local_' + Date.now();
    projectPayload.isCloud = false;
    localProjects.unshift(projectPayload);
    localStorage.setItem('solarcadastre_local_projects', JSON.stringify(localProjects));
    showToast('✅ Berhasil disimpan di Local Browser!', 'success');
    
    const nameInput = document.getElementById('new-project-name');
    if (nameInput) nameInput.value = '';
    
    if (userSession) {
        fetchCloudProjects();
    } else {
        loadLocalProjects();
    }
}

function loadProject(project) {
    setStatus(`Memuat project '${project.name}'...`, 'info');
    
    const stats = project.project_stats || project.solar_stats || {};
    if (document.getElementById('sl-min-levels')) document.getElementById('sl-min-levels').value = stats.minLevels || 3;
    if (document.getElementById('sl-building-emissions')) document.getElementById('sl-building-emissions').value = stats.buildingEmissions || 100;
    if (document.getElementById('sl-greenery-absorption')) document.getElementById('sl-greenery-absorption').value = stats.greeneryAbsorption || 2.4;
    
    updateParametersUI();

    if (project.aoi_geojson && project.aoi_geojson.geometry) {
        const props = project.aoi_geojson.properties || {};
        const mode = props.drawMode || 'rectangle';
        
        // Switch to the correct mode visually
        setDrawMode(mode);
        
        if (mode === 'rectangle' && project.aoi_geojson.geometry.coordinates) {
            const coords = project.aoi_geojson.geometry.coordinates[0];
            cornerA = coords[0];
            cornerB = coords[2];
            aoiAreaM2 = calculateRectArea(cornerA, cornerB);
        } else if (mode === 'circle') {
            circleCenter = props.circleCenter;
            circleRadius = props.circleRadius;
            aoiAreaM2 = Math.PI * circleRadius * circleRadius;
        } else if (mode === 'polygon') {
            polygonPts = props.polygonPts || project.aoi_geojson.geometry.coordinates[0];
            aoiAreaM2 = polygonAreaM2(polygonPts);
        }
        
        const areaKm2 = aoiAreaM2 / 1000000;
        
        const aoiAreaVal = document.getElementById('aoi-area-val');
        if (aoiAreaVal) aoiAreaVal.textContent = areaKm2.toFixed(3) + ' km²';
        updateAoiEstimations(areaKm2);
        
        const clearBtn = document.getElementById('btn-clear-aoi');
        if (clearBtn) clearBtn.style.display = 'block';
        const runBtn = document.getElementById('btn-run-analysis');
        if (runBtn) {
            runBtn.disabled = false;
            // Force status completed so button enables correctly
            drawState = 'completed';
        }
        
        if (map.getSource('aoi-source')) {
            map.getSource('aoi-source').setData(project.aoi_geojson);
        }
        
        let lons = [], lats = [];
        if (project.aoi_geojson.geometry.coordinates) {
            let pts = project.aoi_geojson.geometry.coordinates[0];
            if (project.aoi_geojson.geometry.type === 'MultiPolygon') {
                pts = project.aoi_geojson.geometry.coordinates[0][0];
            }
            lons = pts.map(c => c[0]);
            lats = pts.map(c => c[1]);
        }
        if (lons.length > 0) {
            fitCameraToAoi(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
        }
    }

    if (project.geojson_data) {
        allGeojsonData = project.geojson_data;
        applyFilters();
        setStatus(`Project '${project.name}' berhasil dimuat!`, 'success');
        const saveProjectBtn = document.getElementById('save-project-btn');
        if (saveProjectBtn) saveProjectBtn.disabled = false;
    }
}

async function deleteProject(id, isCloud) {
    if (!confirm('Apakah Anda yakin ingin menghapus project ini?')) return;
    
    // Bersihkan id dari arsip lokal
    let archivedIds = JSON.parse(localStorage.getItem('archived_projects') || '[]');
    archivedIds = archivedIds.filter(x => x !== id);
    localStorage.setItem('archived_projects', JSON.stringify(archivedIds));
    
    if (isCloud && supabase) {
        setStatus('Menghapus project di cloud...', 'info');
        try {
            const { error } = await supabase
                .from('projects')
                .delete()
                .eq('id', id);
            if (error) throw error;
            showToast('🗑️ Project cloud berhasil dihapus!', 'success');
            fetchCloudProjects();
        } catch (err) {
            showToast('❌ Gagal menghapus project cloud: ' + err.message, 'error');
        }
    } else {
        localProjects = localProjects.filter(p => p.id !== id);
        localStorage.setItem('solarcadastre_local_projects', JSON.stringify(localProjects));
        showToast('🗑️ Project lokal berhasil dihapus!', 'success');
        if (userSession) {
            fetchCloudProjects();
        } else {
            loadLocalProjects();
        }
    }
}

// ============================================================
//  SUPABASE USER AUTHENTICATION
// ============================================================
window.openAuthModal = function() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.add('open');
};
window.closeAuthModal = function() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.remove('open');
};
window.switchAuthMode = function() {
    const title = document.getElementById('auth-modal-title');
    const submitBtn = document.getElementById('auth-action-submit');
    const switchText = document.getElementById('auth-switch');
    
    if (authMode === 'login') {
        authMode = 'register';
        if (title) title.textContent = 'Daftar Akun Supabase';
        if (submitBtn) submitBtn.textContent = 'Daftar Akun Baru';
        if (switchText) switchText.innerHTML = 'Sudah punya akun? <span>Masuk Di Sini</span>';
    } else {
        authMode = 'login';
        if (title) title.textContent = 'Masuk ke Supabase';
        if (submitBtn) submitBtn.textContent = 'Masuk';
        if (switchText) switchText.innerHTML = 'Belum punya akun? <span>Daftar Sekarang</span>';
    }
};

window.handleWelcomeOption = function(opt) {
    const welcomeModal = document.getElementById('welcome-modal');
    if (opt === 'guest') {
        if (welcomeModal) welcomeModal.classList.remove('open');
        showToast('🚶 Masuk sebagai Tamu (Data disimpan lokal)', 'info');
        openProjectSetupModal();
        return;
    }
    
    authMode = opt; // 'login' or 'register'
    
    const title = document.getElementById('auth-modal-title');
    const submitBtn = document.getElementById('auth-action-submit');
    const switchText = document.getElementById('auth-switch');
    
    if (authMode === 'register') {
        if (title) title.textContent = 'Daftar Akun Baru';
        if (submitBtn) submitBtn.textContent = 'Daftar Akun Baru';
        if (switchText) switchText.innerHTML = 'Sudah punya akun? <span>Masuk Di Sini</span>';
    } else {
        if (title) title.textContent = 'Masuk ke Supabase';
        if (submitBtn) submitBtn.textContent = 'Masuk';
        if (switchText) switchText.innerHTML = 'Belum punya akun? <span>Daftar Sekarang</span>';
    }
    
    const usernameInput = document.getElementById('auth-email-input');
    const passwordInput = document.getElementById('auth-password-input');
    if (usernameInput) usernameInput.value = '';
    if (passwordInput) passwordInput.value = '';
    
    openAuthModal();
};

window.submitAuth = async function() {
    const usernameInput = document.getElementById('auth-email-input');
    const passwordInput = document.getElementById('auth-password-input');
    if (!usernameInput || !passwordInput) return;
    
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    
    if (!username || !password) {
        showToast('⚠️ Harap isi username dan kata sandi!', 'error');
        return;
    }
    
    // Validasi format username / email dan password
    const credentialRegex = /^[A-Za-z0-9!@#&._+-]+$/;
    if (!credentialRegex.test(username)) {
        showToast('⚠️ Username hanya boleh berisi huruf, angka, dan karakter !@#&._+-', 'error');
        return;
    }
    if (!credentialRegex.test(password)) {
        showToast('⚠️ Kata sandi hanya boleh berisi huruf, angka, dan karakter !@#&._+-', 'error');
        return;
    }
    
    if (!supabase) {
        showToast('❌ Supabase Client tidak aktif!', 'error');
        return;
    }
    
    const submitBtn = document.getElementById('auth-action-submit');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Memproses...';
    }
    
    // Cek apakah input adalah email asli (mengandung @ dan .)
    let email = username;
    if (!username.includes('@') || !username.includes('.')) {
        email = `${username}@webgis.local`;
    }
    
    try {
        if (authMode === 'login') {
            window.isManualLogin = true;
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) throw error;
            showToast('🔑 Berhasil masuk!', 'success');
        } else {
            const { data, error } = await supabase.auth.signUp({ email, password });
            if (error) throw error;
            
            // Force sign out immediately if auto-logged in by the signup API
            if (supabase && supabase.auth && supabase.auth.signOut) {
                await supabase.auth.signOut();
            }
            userSession = null;
            updateUserDisplay();
            
            showToast('✨ Pendaftaran akun berhasil! Silakan masuk dengan akun baru Anda.', 'success');
            authMode = 'login';
            const title = document.getElementById('auth-modal-title');
            const submitBtnEl = document.getElementById('auth-action-submit');
            const switchText = document.getElementById('auth-switch');
            if (title) title.textContent = 'Masuk ke Supabase';
            if (submitBtnEl) submitBtnEl.textContent = 'Masuk';
            if (switchText) switchText.innerHTML = 'Belum punya akun? <span>Daftar Sekarang</span>';
            if (passwordInput) passwordInput.value = '';
            
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Masuk';
            }
            return;
        }
        
        const welcomeModal = document.getElementById('welcome-modal');
        if (welcomeModal) welcomeModal.classList.remove('open');
        closeAuthModal();
    } catch (err) {
        showToast('❌ Auth error: ' + err.message, 'error');
        console.error('[Auth Error]', err);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = authMode === 'login' ? 'Masuk' : 'Daftar';
        }
    }
};

async function handleLogout() {
    if (!supabase) return;
    try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        showToast('🚪 Berhasil keluar!', 'info');
        const welcomeModal = document.getElementById('welcome-modal');
        if (welcomeModal) welcomeModal.classList.add('open');
    } catch (err) {
        showToast('Gagal keluar', 'error');
    }
}

if (supabase) {
    supabase.auth.onAuthStateChange((event, session) => {
        userSession = session;
        const authBtn = document.getElementById('auth-toggle-btn');
        const statusEl = document.getElementById('auth-email');
        const connStatus = document.getElementById('conn-status');
        const welcomeModal = document.getElementById('welcome-modal');
        
        // Perbarui tampilan avatar profil di ujung kanan atas
        updateUserDisplay();
        
        if (session) {
            const displayUser = session.user.user_metadata?.display_name || (session.user.email ? session.user.email.split('@')[0] : 'User');
            if (statusEl) statusEl.innerHTML = `<i class="fa fa-user-check" style="color:var(--green-400)"></i> ${displayUser}`;
            if (authBtn) {
                authBtn.textContent = 'Keluar';
                authBtn.onclick = handleLogout;
            }
            if (connStatus) connStatus.textContent = 'Cloud Active';
            
            if (welcomeModal) welcomeModal.classList.remove('open');
            closeAuthModal();
            
            fetchCloudProjects();

            // If manual login, trigger the project setup modal
            if (window.isManualLogin) {
                window.isManualLogin = false;
                setTimeout(() => {
                    openProjectSetupModal();
                }, 400);
            }
        } else {
            if (statusEl) statusEl.innerHTML = '<i class="fa fa-user-circle"></i> Mode Tamu';
            if (authBtn) {
                authBtn.textContent = 'Masuk';
                authBtn.onclick = function() {
                    if (welcomeModal) welcomeModal.classList.add('open');
                };
            }
            if (connStatus) connStatus.textContent = 'Mode Tamu';
            loadLocalProjects();
        }
    });
}

// ============================================================
//  VIEW CONTROLS & BASEMAP TOGGLE
// ============================================================
window.toggleSatelliteLayer = function() {
    if (!map.isStyleLoaded()) return;
    
    isSatelliteOn = !isSatelliteOn;
    if (isSatelliteOn) {
        if (!map.getSource('satellite-source')) {
            map.addSource('satellite-source', {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            });
        }
        
        if (!map.getLayer('satellite-layer')) {
            map.addLayer({
                id: 'satellite-layer',
                type: 'raster',
                source: 'satellite-source',
                paint: { 'raster-opacity': 0.65 }
            }, 'buildings-3d');
        } else {
            map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
        }
        showToast('🛰️ Satelit Basemap Aktif (Opacity 65%)', 'info');
    } else {
        if (map.getLayer('satellite-layer')) {
            map.setLayoutProperty('satellite-layer', 'visibility', 'none');
        }
        showToast('🗺️ Dark Vector Basemap Aktif', 'info');
    }
};

window.resetView = function() {
    if (cornerA && cornerB) {
        const minLat = Math.min(cornerA[1], cornerB[1]);
        const minLon = Math.min(cornerA[0], cornerB[0]);
        const maxLat = Math.max(cornerA[1], cornerB[1]);
        const maxLon = Math.max(cornerA[0], cornerB[0]);
        fitCameraToAoi(minLon, minLat, maxLon, maxLat);
    } else {
        map.flyTo({ center: [113.9213, -0.7893], zoom: 5, pitch: 0, bearing: 0, duration: 1500 });
    }
};

window.topView = function() {
    map.flyTo({ pitch: 0, bearing: 0, duration: 800 });
};

window.set3DView = function() {
    map.flyTo({ pitch: 65, bearing: -15, duration: 800 });
};

window.hideAnalysisOverlay = function() {
    hideAnalysisOverlay();
};

// ============================================================
//  SQL HELPERS DDL COPY
// ============================================================
window.copySQL = function() {
    const sqlCode = document.getElementById('sql-code');
    if (!sqlCode) return;
    const code = sqlCode.textContent;
    navigator.clipboard.writeText(code)
        .then(() => showToast('📋 SQL berhasil disalin!', 'success'))
        .catch(() => showToast('Gagal menyalin SQL', 'error'));
};

// ============================================================
//  AUTO LAYOUT & PRINT MAP FEATURES
// ============================================================
let mapParentOriginal = null;
let printGridActive = true;

// Open Map Print Layout Overlay
window.openPrintLayout = function() {
    const overlay = document.getElementById('print-layout-overlay');
    if (!overlay) return;

    // Get current project name as default map title
    const printTitleInput = document.getElementById('print-title-input');
    const newProjectName = document.getElementById('new-project-name');
    if (printTitleInput && newProjectName && newProjectName.value.trim()) {
        printTitleInput.value = "PETA " + newProjectName.value.trim().toUpperCase();
    } else {
        if (printTitleInput) printTitleInput.value = "PETA ANALISIS URBAN 3D";
    }

    // Set initial values in layout sheet
    syncPrintText();

    // Clone and display current active legend
    const legendCloneBox = document.getElementById('pm-legend-clone');
    const originalLegend = document.getElementById('legend-card');
    if (legendCloneBox && originalLegend) {
        legendCloneBox.innerHTML = originalLegend.innerHTML;
        // Strip or hide any buttons inside cloned legend to look clean
        const titles = legendCloneBox.querySelectorAll('.panel-title i');
        titles.forEach(i => i.style.marginRight = '5px');
    }

    // Save original parent of map container
    const mapEl = document.getElementById('map');
    if (mapEl) {
        mapParentOriginal = mapEl.parentNode;
        // Migrate map container to print layout sheet
        const printMapContainer = document.getElementById('print-map-container');
        if (printMapContainer) {
            printMapContainer.appendChild(mapEl);
        }
    }

    overlay.classList.add('active');

    // Resize map to fit the print canvas
    setTimeout(() => {
        map.resize();
        updatePrintScaleAndNorth();
        updatePrintGrid();
    }, 100);

    // Register map listeners for real-time scale and grid updates
    map.on('zoom', updatePrintScaleAndNorth);
    map.on('move', updatePrintScaleAndNorth);
    map.on('rotate', updatePrintScaleAndNorth);
    map.on('moveend', updatePrintGrid);
    map.on('zoomend', updatePrintGrid);

    showToast('🗺️ Memasuki Mode Layout Cetak', 'info');
};

// Close Map Print Layout Overlay
window.closePrintLayout = function() {
    const overlay = document.getElementById('print-layout-overlay');
    if (!overlay) return;

    // Migrate map container back to original parent (body)
    const mapEl = document.getElementById('map');
    if (mapEl && mapParentOriginal) {
        mapParentOriginal.appendChild(mapEl);
    }

    overlay.classList.remove('active');

    // Deregister listeners
    map.off('zoom', updatePrintScaleAndNorth);
    map.off('move', updatePrintScaleAndNorth);
    map.off('rotate', updatePrintScaleAndNorth);
    map.off('moveend', updatePrintGrid);
    map.off('zoomend', updatePrintGrid);

    // Resize map back to normal
    setTimeout(() => {
        map.resize();
    }, 100);

    showToast('🚪 Keluar dari Mode Layout Cetak', 'info');
};

// Sync input text to layout preview sheet
window.syncPrintText = function() {
    const titleInput = document.getElementById('print-title-input');
    const authorInput = document.getElementById('print-author-input');
    
    const pmTitle = document.getElementById('pm-map-title');
    const pmAuthor = document.getElementById('pm-map-author');

    if (titleInput && pmTitle) pmTitle.textContent = titleInput.value.trim() || 'PETA TANPA JUDUL';
    if (authorInput && pmAuthor) pmAuthor.textContent = authorInput.value.trim() || 'Anonim';
};

// Change A4/A3 Aspect ratio classes
window.changePaperSize = function() {
    const select = document.getElementById('print-paper-select');
    const sheet = document.getElementById('print-sheet');
    if (!select || !sheet) return;

    // Remove all layout classes
    sheet.className = '';
    // Apply selected paper class
    sheet.classList.add(select.value);

    // Force map to resize to new dimensions
    setTimeout(() => {
        map.resize();
        updatePrintScaleAndNorth();
        updatePrintGrid();
    }, 100);
};

// Toggle Grid coordinates visibility
window.togglePrintGrid = function() {
    const toggle = document.getElementById('print-grid-toggle');
    const gridOverlay = document.getElementById('print-grid-overlay');
    if (!toggle || !gridOverlay) return;

    printGridActive = toggle.checked;
    gridOverlay.style.display = printGridActive ? 'block' : 'none';
    if (printGridActive) {
        updatePrintGrid();
    }
};

// Trigger browser Print Dialog
window.triggerPrint = function() {
    showToast('🖨️ Membuka jendela cetak...', 'info');
    setTimeout(() => {
        window.print();
    }, 500);
};

// Helper: Convert decimal degrees to Degrees Minutes Seconds (DMS) format
function toDMS(val, isLat) {
    const dir = isLat ? (val >= 0 ? 'LU' : 'LS') : (val >= 0 ? 'BT' : 'BB'); // Indonesian LU (North), LS (South), BT (East), BB (West)
    const absVal = Math.abs(val);
    const deg = Math.floor(absVal);
    const min = Math.floor((absVal - deg) * 60);
    const sec = Math.round(((absVal - deg) * 60 - min) * 60);
    return `${deg}°${min}'${sec}" ${dir}`;
}

// Compute map scale and update north arrow rotation
function updatePrintScaleAndNorth() {
    const scaleVal = document.getElementById('pm-map-scale');
    const compassIcon = document.getElementById('pm-compass-icon');
    
    // 1. Compass rotation
    if (compassIcon) {
        const bearing = map.getBearing();
        compassIcon.style.transform = `rotate(${-bearing}deg)`;
    }

    // 2. Numeric scale estimation based on physical paper width
    if (scaleVal) {
        const paperSelect = document.getElementById('print-paper-select');
        const paperSize = paperSelect ? paperSelect.value : 'a4-landscape';
        
        const MAP_PHYSICAL_WIDTHS = {
            'a4-landscape': 0.202,
            'a4-portrait': 0.190,
            'a3-landscape': 0.302,
            'a3-portrait': 0.277
        };
        
        const physicalWidthMeters = MAP_PHYSICAL_WIDTHS[paperSize] || 0.202;
        
        const mapEl = document.getElementById('map');
        const pixelWidth = mapEl ? mapEl.clientWidth : 800;
        
        const zoom = map.getZoom();
        const lat = map.getCenter().lat;
        
        // meters per pixel on screen
        const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
        
        // real-world width of the map viewport in meters
        const realWidthMeters = metersPerPixel * pixelWidth;
        
        // scale ratio = real width in meters / physical width in meters
        const scaleRatio = realWidthMeters / physicalWidthMeters;
        
        // Snap to nice standard cartographic scales
        let roundedScale = Math.round(scaleRatio);
        if (roundedScale > 100000) roundedScale = Math.round(roundedScale / 10000) * 10000;
        else if (roundedScale > 20000) roundedScale = Math.round(roundedScale / 5000) * 5000;
        else if (roundedScale > 5000) roundedScale = Math.round(roundedScale / 1000) * 1000;
        else if (roundedScale > 1000) roundedScale = Math.round(roundedScale / 500) * 500;
        else roundedScale = Math.round(roundedScale / 100) * 100;
        if (roundedScale < 100) roundedScale = 100;

        scaleVal.textContent = `1:${roundedScale.toLocaleString('id-ID')}`;

        // 3. Dynamic Scale Bar (Physical width scales with zoom/paper size)
        const pmScaleBar = document.querySelector('.pm-scale-bar');
        const pmScaleBarLabels = document.getElementById('pm-scale-bar-labels');
        const pmScaleMid = document.getElementById('pm-scale-mid');
        const pmScaleMax = document.getElementById('pm-scale-max');
        
        if (pmScaleBar && pmScaleBarLabels && pmScaleMid && pmScaleMax) {
            // Find a nice target distance (in meters) representing around 30mm on paper
            const D_ideal = roundedScale * 0.03;
            const NICE_DISTANCES = [
                1, 2, 5, 10, 20, 50, 100, 200, 500, 
                1000, 2000, 5000, 10000, 20000, 50000, 100000
            ];
            
            let targetDistance = 100;
            let closestDiff = Infinity;
            for (const dist of NICE_DISTANCES) {
                const diff = Math.abs(dist - D_ideal);
                if (diff < closestDiff) {
                    closestDiff = diff;
                    targetDistance = dist;
                }
            }
            
            // Physical width of scale bar in millimeters = (targetDistance / roundedScale) * 1000
            const barPhysicalWidthMm = (targetDistance / roundedScale) * 1000;
            
            // Set widths dynamically
            pmScaleBar.style.width = `${barPhysicalWidthMm}mm`;
            pmScaleBarLabels.style.width = `${barPhysicalWidthMm}mm`;
            
            // Format labels
            const formatDistance = (m) => {
                if (m >= 1000) return `${m / 1000} km`;
                return `${m} m`;
            };
            
            pmScaleMid.textContent = formatDistance(targetDistance / 2);
            pmScaleMax.textContent = formatDistance(targetDistance);
        }
    }
}

// Draw Coordinate Grid Lines and Labels dynamically
window.updatePrintGrid = function() {
    const gridOverlay = document.getElementById('print-grid-overlay');
    if (!gridOverlay || !printGridActive) return;

    gridOverlay.innerHTML = '';

    const bounds = map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    const south = bounds.getSouth();

    // Map container size
    const wrapper = document.getElementById('print-map-wrapper');
    if (!wrapper) return;
    const wWidth = wrapper.clientWidth;
    const wHeight = wrapper.clientHeight;

    // Grid count: 3 vertical lines, 3 horizontal lines
    const steps = 4;
    
    // Vertical Grid Lines (Longitude)
    for (let i = 1; i < steps; i++) {
        const pct = i / steps;
        const lon = west + (east - west) * pct;
        const x = pct * wWidth;

        // Create line
        const line = document.createElement('div');
        line.className = 'grid-line grid-line-v';
        line.style.left = `${x}px`;
        gridOverlay.appendChild(line);

        // Label at Top
        const labelTop = document.createElement('div');
        labelTop.className = 'grid-label';
        labelTop.textContent = toDMS(lon, false);
        labelTop.style.left = `${x - 25}px`;
        labelTop.style.top = '4px';
        gridOverlay.appendChild(labelTop);

        // Label at Bottom
        const labelBottom = document.createElement('div');
        labelBottom.className = 'grid-label';
        labelBottom.textContent = toDMS(lon, false);
        labelBottom.style.left = `${x - 25}px`;
        labelBottom.style.bottom = '4px';
        gridOverlay.appendChild(labelBottom);
    }

    // Horizontal Grid Lines (Latitude)
    for (let i = 1; i < steps; i++) {
        const pct = i / steps;
        const lat = north - (north - south) * pct; // Lattitude decreases as we go down
        const y = pct * wHeight;

        // Create line
        const line = document.createElement('div');
        line.className = 'grid-line grid-line-h';
        line.style.top = `${y}px`;
        gridOverlay.appendChild(line);

        // Label at Left
        const labelLeft = document.createElement('div');
        labelLeft.className = 'grid-label';
        labelLeft.textContent = toDMS(lat, true);
        labelLeft.style.left = '4px';
        labelLeft.style.top = `${y - 6}px`;
        gridOverlay.appendChild(labelLeft);

        // Label at Right
        const labelRight = document.createElement('div');
        labelRight.className = 'grid-label';
        labelRight.textContent = toDMS(lat, true);
        labelRight.style.right = '4px';
        labelRight.style.top = `${y - 6}px`;
        gridOverlay.appendChild(labelRight);
    }
};

// ============================================================
//  MAP LOAD & INITIAL SETUPS
// ============================================================
map.on('load', () => {
    map.addSource('aoi-source', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: []
        }
    });
    
    map.addLayer({
        id: 'aoi-fill',
        type: 'fill',
        source: 'aoi-source',
        paint: {
            'fill-color': [
                'case',
                ['boolean', ['get', 'invalid'], false],
                'rgba(239, 68, 68, 0.15)', // Red if > 5km²
                'rgba(16, 185, 129, 0.15)'  // Green if valid
            ]
        }
    });
    
    map.addLayer({
        id: 'aoi-stroke',
        type: 'line',
        source: 'aoi-source',
        paint: {
            'line-color': [
                'case',
                ['boolean', ['get', 'invalid'], false],
                '#f87171',
                '#34d399'
            ],
            'line-width': 2,
            'line-dasharray': [4, 3]
        }
    });

    loadLocalProjects();

    setTimeout(() => {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        
        // Tampilkan modal selamat datang jika belum login
        if (!userSession) {
            const welcomeModal = document.getElementById('welcome-modal');
            if (welcomeModal) welcomeModal.classList.add('open');
        }
    }, 500);
});


// Toggle password input visibility
window.togglePasswordVisibility = function() {
    const pwdInput = document.getElementById('auth-password-input');
    const toggleIcon = document.getElementById('password-toggle-icon');
    if (!pwdInput || !toggleIcon) return;
    if (pwdInput.type === 'password') {
        pwdInput.type = 'text';
        toggleIcon.classList.remove('fa-eye');
        toggleIcon.classList.add('fa-eye-slash');
    } else {
        pwdInput.type = 'password';
        toggleIcon.classList.remove('fa-eye-slash');
        toggleIcon.classList.add('fa-eye');
    }
};

// Custom Supabase configuration actions
window.saveCustomSupabaseConfig = function() {
    const urlInput = document.getElementById('cfg-supabase-url');
    const keyInput = document.getElementById('cfg-supabase-key');
    if (!urlInput || !keyInput) return;
    let url = urlInput.value.trim();
    const key = keyInput.value.trim();
    if (!url || !key) {
        showToast('⚠️ URL dan Key kustom harus diisi!', 'warning');
        return;
    }
    
    // Auto-correction jika user memasukkan URL dashboard
    if (url.includes('supabase.com/dashboard/project/')) {
        const parts = url.split('/project/');
        if (parts.length > 1) {
            const projectRef = parts[1].split('/')[0];
            url = `https://${projectRef}.supabase.co`;
        }
    }
    
    localStorage.setItem('custom_supabase_url', url);
    localStorage.setItem('custom_supabase_key', key);
    showToast('💾 Konfigurasi disimpan! Memuat ulang...', 'success');
    setTimeout(() => {
        window.location.reload();
    }, 1200);
};

window.resetSupabaseConfig = function() {
    localStorage.removeItem('custom_supabase_url');
    localStorage.removeItem('custom_supabase_key');
    showToast('🔄 Konfigurasi di-reset ke default! Memuat ulang...', 'info');
    setTimeout(() => {
        window.location.reload();
    }, 1200);
};

// ============================================================
//  PROFILE DROPDOWN & MODALS HANDLERS
// ============================================================
window.toggleProfileDropdown = function(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('profile-dropdown');
    const widget = document.getElementById('profile-widget');
    if (!dropdown || !widget) return;
    
    const isOpen = dropdown.classList.contains('open');
    if (isOpen) {
        dropdown.classList.remove('open');
        widget.classList.remove('active');
    } else {
        dropdown.classList.add('open');
        widget.classList.add('active');
    }
};

// Tutup dropdown jika pengguna mengeklik di luar area widget
document.addEventListener('click', (e) => {
    const widget = document.getElementById('profile-widget');
    const dropdown = document.getElementById('profile-dropdown');
    if (widget && dropdown && !widget.contains(e.target)) {
        dropdown.classList.remove('open');
        widget.classList.remove('active');
    }
});

// Aksi Modal Profil (Ubah Profil)
window.openProfileModal = function(event) {
    if (event) event.stopPropagation();
    document.getElementById('profile-dropdown').classList.remove('open');
    document.getElementById('profile-widget').classList.remove('active');
    
    if (!supabase || !userSession) {
        showToast('⚠️ Silakan masuk terlebih dahulu untuk mengubah profil!', 'warning');
        return;
    }
    
    const modal = document.getElementById('profile-modal');
    const nickInput = document.getElementById('nickname-input');
    if (nickInput) {
        nickInput.value = userSession.user.user_metadata?.display_name || userSession.user.email.split('@')[0] || '';
    }
    if (modal) modal.classList.add('open');
};

window.closeProfileModal = function() {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.classList.remove('open');
};

window.submitChangeProfile = async function() {
    const nickInput = document.getElementById('nickname-input');
    if (!nickInput) return;
    const nickname = nickInput.value.trim();
    if (!nickname) {
        showToast('⚠️ Nama panggilan tidak boleh kosong!', 'error');
        return;
    }
    
    const credentialRegex = /^[A-Za-z0-9!@#& ]+$/;
    if (!credentialRegex.test(nickname)) {
        showToast('⚠️ Nama hanya boleh berisi huruf, angka, spasi, dan karakter !@#&', 'error');
        return;
    }
    
    if (!supabase || !userSession) {
        showToast('❌ Supabase session tidak aktif!', 'error');
        return;
    }
    
    try {
        const { error } = await supabase.auth.updateUser({
            data: { display_name: nickname }
        });
        if (error) throw error;
        showToast('👤 Profil berhasil diperbarui!', 'success');
        
        // Perbarui data lokal user display
        if (!userSession.user.user_metadata) userSession.user.user_metadata = {};
        userSession.user.user_metadata.display_name = nickname;
        updateUserDisplay();
        
        closeProfileModal();
    } catch (err) {
        showToast('❌ Gagal memperbarui profil: ' + err.message, 'error');
    }
};

// Aksi Modal Kata Sandi (Ubah Sandi)
window.openPasswordModal = function(event) {
    if (event) event.stopPropagation();
    document.getElementById('profile-dropdown').classList.remove('open');
    document.getElementById('profile-widget').classList.remove('active');
    
    if (!supabase || !userSession) {
        showToast('⚠️ Silakan masuk terlebih dahulu untuk mengubah kata sandi!', 'warning');
        return;
    }
    
    const modal = document.getElementById('password-modal');
    const pwdInput = document.getElementById('new-password-input');
    const confirmInput = document.getElementById('confirm-password-input');
    if (pwdInput) pwdInput.value = '';
    if (confirmInput) confirmInput.value = '';
    
    if (modal) modal.classList.add('open');
};

window.closePasswordModal = function() {
    const modal = document.getElementById('password-modal');
    if (modal) modal.classList.remove('open');
};

window.submitChangePassword = async function() {
    const pwdInput = document.getElementById('new-password-input');
    const confirmInput = document.getElementById('confirm-password-input');
    if (!pwdInput || !confirmInput) return;
    const newPwd = pwdInput.value;
    const confirmPwd = confirmInput.value;
    
    if (!newPwd || !confirmPwd) {
        showToast('⚠️ Harap isi kedua kolom sandi!', 'error');
        return;
    }
    
    const credentialRegex = /^[A-Za-z0-9!@#&._+-]+$/;
    if (!credentialRegex.test(newPwd)) {
        showToast('⚠️ Sandi baru hanya boleh berisi huruf, angka, dan karakter !@#&._+-', 'error');
        return;
    }
    
    if (newPwd !== confirmPwd) {
        showToast('⚠️ Konfirmasi kata sandi tidak cocok!', 'error');
        return;
    }
    
    if (!supabase || !userSession) {
        showToast('❌ Supabase session tidak aktif!', 'error');
        return;
    }
    
    try {
        const { error } = await supabase.auth.updateUser({ password: newPwd });
        if (error) throw error;
        showToast('🔑 Kata sandi berhasil diperbarui!', 'success');
        closePasswordModal();
    } catch (err) {
        showToast('❌ Gagal memperbarui sandi: ' + err.message, 'error');
    }
};

// Aksi Modal Library & Archive Project
window.openLibraryModal = function(event) {
    if (event) event.stopPropagation();
    document.getElementById('profile-dropdown').classList.remove('open');
    document.getElementById('profile-widget').classList.remove('active');
    
    const modal = document.getElementById('library-modal');
    if (modal) modal.classList.add('open');
    switchLibraryTab('library');
    
    const nameInput = document.getElementById('new-project-name');
    if (nameInput && window.currentProjectName) {
        nameInput.value = window.currentProjectName;
    }
};

window.openArchiveModal = function(event) {
    if (event) event.stopPropagation();
    document.getElementById('profile-dropdown').classList.remove('open');
    document.getElementById('profile-widget').classList.remove('active');
    
    const modal = document.getElementById('library-modal');
    if (modal) modal.classList.add('open');
    switchLibraryTab('archive');
};

window.closeLibraryModal = function() {
    const modal = document.getElementById('library-modal');
    if (modal) modal.classList.remove('open');
};

window.openProjectSetupModal = function() {
    const modal = document.getElementById('project-setup-modal');
    if (modal) modal.classList.add('open');
    
    // Set default project name with current date
    const nameInput = document.getElementById('setup-project-name');
    if (nameInput) {
        const d = new Date();
        const dateStr = `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
        nameInput.value = `Project ${dateStr}`;
    }
    const descInput = document.getElementById('setup-project-desc');
    if (descInput) descInput.value = '';
};

window.closeProjectSetupModal = function() {
    const modal = document.getElementById('project-setup-modal');
    if (modal) modal.classList.remove('open');
};

window.startNewProject = function() {
    const nameInput = document.getElementById('setup-project-name');
    const name = nameInput ? nameInput.value.trim() : 'Project Baru';
    const desc = document.getElementById('setup-project-desc') ? document.getElementById('setup-project-desc').value.trim() : '';
    const loc = document.getElementById('setup-project-location') ? document.getElementById('setup-project-location').value : 'jakarta';

    if (!name) {
        showToast('⚠️ Nama project tidak boleh kosong!', 'error');
        return;
    }

    // Set active project name
    window.currentProjectName = name;
    localStorage.setItem('active_project_name', name);

    // Update active project badge in header
    const projBadge = document.getElementById('project-badge');
    if (projBadge) {
        projBadge.innerHTML = `<i class="fa fa-folder-open" style="color:var(--cyan-400)"></i> <span>${name}</span>`;
    }

    // Fly map camera to selected location coordinates
    const coordinates = {
        jakarta: [106.8272, -6.1751],
        bandung: [107.6191, -6.9175],
        surabaya: [112.7521, -7.2575],
        yogyakarta: [110.3705, -7.7956],
        medan: [98.6720, 3.5952],
        makassar: [119.4327, -5.1477]
    };

    if (loc !== 'kustom' && coordinates[loc]) {
        map.flyTo({
            center: coordinates[loc],
            zoom: 14,
            pitch: 45,
            bearing: 0,
            essential: true
        });
        showToast(`✈️ Terbang ke wilayah fokus: ${loc.charAt(0).toUpperCase() + loc.slice(1)}`, 'info');
    }

    showToast(`✨ Project "${name}" diinisialisasi! Silakan tentukan Area Analisis (AOI).`, 'success');
    closeProjectSetupModal();
};

window.handleDropdownAuth = function(event) {
    if (event) event.stopPropagation();
    document.getElementById('profile-dropdown').classList.remove('open');
    document.getElementById('profile-widget').classList.remove('active');
    
    if (userSession) {
        handleLogout();
    } else {
        const welcomeModal = document.getElementById('welcome-modal');
        if (welcomeModal) welcomeModal.classList.add('open');
    }
};

// Perbarui status tampilan user di avatar profil atas dan dropdown
function updateUserDisplay() {
    const displayNameEl = document.getElementById('profile-display-name');
    const avatarCharEl = document.getElementById('profile-avatar-char');
    const dropdownNameEl = document.getElementById('dropdown-user-name');
    const dropdownStatusEl = document.getElementById('dropdown-user-status');
    const dropdownAuthBtn = document.getElementById('dropdown-auth-btn');
    
    if (userSession) {
        const displayUser = userSession.user.user_metadata?.display_name || (userSession.user.email ? userSession.user.email.split('@')[0] : 'User');
        const firstChar = displayUser.charAt(0).toUpperCase();
        
        if (displayNameEl) displayNameEl.textContent = displayUser;
        if (avatarCharEl) avatarCharEl.textContent = firstChar;
        if (dropdownNameEl) dropdownNameEl.textContent = displayUser;
        if (dropdownStatusEl) dropdownStatusEl.textContent = 'Cloud Active';
        if (dropdownAuthBtn) {
            dropdownAuthBtn.innerHTML = '<i class="fa fa-right-from-bracket"></i> Keluar';
            dropdownAuthBtn.className = 'dropdown-logout-btn';
        }
    } else {
        if (displayNameEl) displayNameEl.textContent = 'Mode Tamu';
        if (avatarCharEl) avatarCharEl.textContent = 'T';
        if (dropdownNameEl) dropdownNameEl.textContent = 'Tamu';
        if (dropdownStatusEl) dropdownStatusEl.textContent = 'Mode Tamu (Lokal)';
        if (dropdownAuthBtn) {
            dropdownAuthBtn.innerHTML = '<i class="fa fa-right-to-bracket"></i> Masuk';
            dropdownAuthBtn.className = 'dropdown-logout-btn';
            dropdownAuthBtn.style.background = 'rgba(59, 130, 246, 0.12)';
            dropdownAuthBtn.style.border = '1px solid rgba(59, 130, 246, 0.3)';
            dropdownAuthBtn.style.color = 'var(--blue-400)';
        }
    }
}

// Pre-populate custom configuration inputs
document.addEventListener('DOMContentLoaded', () => {
    const urlInput = document.getElementById('cfg-supabase-url');
    const keyInput = document.getElementById('cfg-supabase-key');
    if (urlInput) urlInput.value = localStorage.getItem('custom_supabase_url') || '';
    if (keyInput) keyInput.value = localStorage.getItem('custom_supabase_key') || '';
});
map.on('error', e => console.warn('[MapLibre Log]', e?.error?.message ?? e));

map.on('style.load', () => {
    try {
        if (map.getFog) {
            map.setFog({
                color: '#020617',
                'high-color': '#0f172a',
                'horizon-blend': 0.08,
                'space-color': '#020617',
                'star-intensity': 0.2
            });
        }
    } catch(_) {}
});

} catch(GLOBAL_ERR) {
    console.error('[FATAL] Script crash:', GLOBAL_ERR);
    if (window._guaranteedCloseOverlay) window._guaranteedCloseOverlay();
    var sb = document.getElementById('status-bar');
    if (sb) sb.innerHTML = '<span style="color:#f87171">⚠️ Fatal Error: ' + GLOBAL_ERR.message + '</span>';
}
