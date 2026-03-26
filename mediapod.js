// ═══════════════════════════════════════════
//  PURE UTILITIES  (defined first — used in state init)
// ═══════════════════════════════════════════

// ── XSS-safe HTML escaping ──
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Safe integer clamp for localStorage values ──
function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : Math.max(min, Math.min(max, n));
}

// ── Safe URL validation — must be http:// or https:// ──
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// ── Stable client ID — generated once, persisted using CSPRNG ──
// Validate any stored value matches expected UUID/hex pattern before trusting it
const _storedClientId = localStorage.getItem('plexClientId');
const _validClientId  = _storedClientId && /^[a-f0-9\-]{32,36}$/.test(_storedClientId)
  ? _storedClientId
  : null;
const PLEX_CLIENT_ID = 'mediapod-web-' + (_validClientId || (() => {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('');
  localStorage.setItem('plexClientId', id);
  return id;
})());

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════

// Validate serverType from localStorage — only allow known values
const _rawServerType = localStorage.getItem('serverType');
const _serverType    = (_rawServerType === 'jellyfin') ? 'jellyfin' : 'plex';

// Read darkMode once to avoid double getItem
const _rawDarkMode = localStorage.getItem('darkMode');
const _darkMode    = _rawDarkMode !== null ? _rawDarkMode === 'true' : true;

const state = {
  serverType: _serverType,
  plexUrl:    localStorage.getItem('plexUrl')    || '',
  plexToken:  localStorage.getItem('plexToken')  || '',
  plexPinId:  null,
  plexPinPoll: null,
  jellyfinUrl:    localStorage.getItem('jellyfinUrl')    || '',
  jellyfinApiKey: localStorage.getItem('jellyfinApiKey') || '',
  jellyfinUserId: localStorage.getItem('jellyfinUserId') || '',
  connected:   false,
  connStatus:  'disconnected', // 'connecting' | 'connected' | 'disconnected'
  navStack:    [],
  audio:       new Audio(),
  playing:     false,
  currentTrack: null,
  queue:       [],
  queueIndex:  0,
  progress:    0,
  duration:    0,
  view:        'setup',
  darkMode:    _darkMode,
  fullscreen:  false,
  theme: {
    uiHue:  clampInt(localStorage.getItem('themeUiHue'),  0, 359, 0),
    podHue: clampInt(localStorage.getItem('themePodHue'), 0, 359, 0),
    podSat: clampInt(localStorage.getItem('themePodSat'), 0, 55,  0),
  },
};

const DEFAULT_THEME = { uiHue: 0, podHue: 0, podSat: 0 };

// Rate-limit: timestamp of last failed Jellyfin connection attempt
let _lastConnectFailTs = 0;

const UI_PRESETS = [
  { hue: 215, label: 'Classic',  color: 'hsl(215,65%,45%)' },
  { hue: 38,  label: 'Plex',     color: '#E5A00D' },
  { hue: 280, label: 'Jellyfin', color: '#AA5CC3' },
  { hue: 168, label: 'Mint',     color: 'hsl(168,65%,38%)' },
  { hue: 0,   label: 'Ruby',     color: 'hsl(0,65%,45%)' },
  { hue: 28,  label: 'Amber',    color: 'hsl(28,80%,50%)' },
  { hue: 190, label: 'Cyan',     color: 'hsl(190,65%,40%)' },
];

const POD_PRESETS = [
  { hue: 0,   sat: 0,  label: 'Silver',    color: '#ccc' },
  { hue: 15,  sat: 38, label: 'Rose Gold', color: 'hsl(15,38%,70%)' },
  { hue: 200, sat: 32, label: 'Sky',       color: 'hsl(200,32%,70%)' },
  { hue: 150, sat: 28, label: 'Mint',      color: 'hsl(150,28%,68%)' },
  { hue: 45,  sat: 42, label: 'Gold',      color: 'hsl(45,42%,68%)' },
  { hue: 270, sat: 30, label: 'Lavender',  color: 'hsl(270,30%,70%)' },
];

// ═══════════════════════════════════════════
//  THEME ENGINE
// ═══════════════════════════════════════════

/** Called by both plexFetch and jellyfinFetch on 401 */
function handleSessionExpiry() {
  state.connected = false; state.connStatus = 'disconnected';
  state.navStack = []; state.view = 'setup'; render();
}

function applyTheme() {
  const r  = document.documentElement.style;
  const h  = state.theme.uiHue;
  const dm = state.darkMode;
  const ph = state.theme.podHue;
  const ps = state.theme.podSat;
  const ps2 = Math.round(ps * 0.55);

  // — UI accent —
  if (dm) {
    const screenBg  = `linear-gradient(180deg, hsl(${h},28%,10%) 0%, hsl(${h},28%,7%) 100%)`;
    r.setProperty('--tb-bg',       `linear-gradient(180deg, hsl(${h},52%,20%) 0%, hsl(${h},52%,13%) 100%)`);
    r.setProperty('--sel-bg',      `linear-gradient(180deg, hsl(${h},55%,21%) 0%, hsl(${h},55%,12%) 100%)`);
    r.setProperty('--list-bg',     screenBg);
    r.setProperty('--nowplay-bg',  screenBg);   // always same as list-bg
    r.setProperty('--prog-fill',   `linear-gradient(90deg, hsl(${h},55%,28%), hsl(${h},55%,40%))`);
    r.setProperty('--prog-track',  `hsla(${h},50%,30%,0.25)`);
    r.setProperty('--item-color',  `hsl(${h},60%,68%)`);
    r.setProperty('--item-border', `hsla(${h},50%,50%,0.15)`);
    r.setProperty('--sel-color',   `hsl(${h},70%,88%)`);
    r.setProperty('--ctrl-color',  `hsl(${h},55%,52%)`);
    r.setProperty('--spin-color',  `hsl(${h},55%,52%)`);
    r.setProperty('--screen-bg',   `hsl(${h},28%,8%)`);
    r.setProperty('--np-song',     `hsl(${h},65%,75%)`);
    r.setProperty('--np-artist',   `hsl(${h},45%,52%)`);
    r.setProperty('--np-album',    `hsl(${h},35%,38%)`);
    r.setProperty('--np-times',    `hsl(${h},35%,42%)`);
    r.setProperty('--load-text',   `hsl(${h},40%,50%)`);
  } else {
    const screenBg  = `linear-gradient(180deg, hsl(${h},28%,78%) 0%, hsl(${h},28%,68%) 100%)`;
    r.setProperty('--tb-bg',       `linear-gradient(180deg, hsl(${h},48%,52%) 0%, hsl(${h},48%,40%) 100%)`);
    r.setProperty('--sel-bg',      `linear-gradient(180deg, hsl(${h},52%,42%) 0%, hsl(${h},52%,28%) 100%)`);
    r.setProperty('--list-bg',     screenBg);
    r.setProperty('--nowplay-bg',  screenBg);
    r.setProperty('--prog-fill',   `linear-gradient(90deg, hsl(${h},52%,36%), hsl(${h},52%,52%))`);
    r.setProperty('--prog-track',  `rgba(0,0,0,0.18)`);
    r.setProperty('--item-color',  `hsl(${h},45%,16%)`);
    r.setProperty('--item-border', `rgba(255,255,255,0.42)`);
    r.setProperty('--sel-color',   `white`);
    r.setProperty('--ctrl-color',  `hsl(${h},45%,18%)`);
    r.setProperty('--spin-color',  `hsl(${h},52%,40%)`);
    r.setProperty('--screen-bg',   `hsl(${h},28%,66%)`);
    r.setProperty('--np-song',     `hsl(${h},45%,14%)`);
    r.setProperty('--np-artist',   `hsl(${h},40%,26%)`);
    r.setProperty('--np-album',    `hsl(${h},35%,38%)`);
    r.setProperty('--np-times',    `hsl(${h},38%,28%)`);
    r.setProperty('--load-text',   `hsl(${h},42%,20%)`);
  }

  // — iPod body —
  if (dm) {
    r.setProperty('--pod-bg',
      `linear-gradient(170deg, hsl(${ph},${ps2}%,18%) 0%, hsl(${ph},${ps2}%,11%) 60%, hsl(${ph},${ps2}%,7%) 100%)`);
    r.setProperty('--pod-shadow',
      `0 0 0 1px hsla(${ph},${ps2}%,40%,0.06) inset, 0 2px 4px rgba(255,255,255,0.02) inset, 0 30px 80px rgba(0,0,0,0.95), 0 10px 30px rgba(0,0,0,0.8)`);
    r.setProperty('--bezel-shadow',
      `0 2px 8px rgba(0,0,0,0.95) inset, 0 1px 0 rgba(255,255,255,0.04)`);
    r.setProperty('--wheel-bg',
      `linear-gradient(145deg, hsl(${ph},${ps2}%,15%) 0%, hsl(${ph},${ps2}%,8%) 50%, hsl(${ph},${ps2}%,12%) 100%)`);
    r.setProperty('--wheel-shadow',
      `0 0 0 1px hsla(${ph},${ps2}%,50%,0.04) inset, 0 3px 8px rgba(0,0,0,0.9), 0 0 20px hsla(${h},60%,40%,0.1)`);
    r.setProperty('--center-bg',
      `linear-gradient(145deg, hsl(${ph},${ps2}%,12%) 0%, hsl(${ph},${ps2}%,7%) 100%)`);
    r.setProperty('--center-color', `hsl(${h},55%,48%)`);
    r.setProperty('--center-shadow',
      `0 0 0 1px hsla(${h},55%,40%,0.22) inset, 0 2px 6px rgba(0,0,0,0.9), 0 0 10px hsla(${h},55%,40%,0.12)`);
    r.setProperty('--wheel-label',  `hsl(${h},35%,38%)`);
  } else {
    r.setProperty('--pod-bg',
      `linear-gradient(170deg, hsl(${ph},${ps}%,94%) 0%, hsl(${ph},${ps}%,86%) 60%, hsl(${ph},${ps}%,78%) 100%)`);
    r.setProperty('--pod-shadow',
      `0 0 0 1px rgba(255,255,255,0.85) inset, 0 2px 4px rgba(255,255,255,0.9) inset, 0 30px 80px rgba(0,0,0,0.65), 0 10px 30px rgba(0,0,0,0.45)`);
    r.setProperty('--bezel-shadow',
      `0 2px 8px rgba(0,0,0,0.8) inset, 0 1px 0 rgba(255,255,255,0.3)`);
    r.setProperty('--wheel-bg',
      `linear-gradient(145deg, hsl(${ph},${ps}%,85%) 0%, hsl(${ph},${ps}%,74%) 50%, hsl(${ph},${ps}%,80%) 100%)`);
    r.setProperty('--wheel-shadow',
      `0 0 0 1px rgba(255,255,255,0.6) inset, 0 3px 8px rgba(0,0,0,0.35), 0 1px 2px rgba(255,255,255,0.8)`);
    r.setProperty('--center-bg',
      `linear-gradient(145deg, hsl(${ph},${ps}%,93%) 0%, hsl(${ph},${ps}%,83%) 100%)`);
    r.setProperty('--center-color', `hsl(${ph > 0 ? ph : 0},${ps > 0 ? 20 : 0}%,36%)`);
    r.setProperty('--center-shadow',
      `0 0 0 1px rgba(255,255,255,0.7) inset, 0 2px 6px rgba(0,0,0,0.28)`);
    r.setProperty('--wheel-label',  `hsl(${ph > 0 ? ph : 0},${ps > 0 ? 15 : 0}%,38%)`);
  }

  updateThemePanel();

  // Keep PWA status bar colour in sync with active theme
  const tcMeta = document.querySelector('meta[name="theme-color"]');
  if (tcMeta) tcMeta.content = dm ? `hsl(${h},52%,10%)` : `hsl(${h},48%,42%)`;
}

function saveTheme() {
  localStorage.setItem('themeUiHue',  state.theme.uiHue);
  localStorage.setItem('themePodHue', state.theme.podHue);
  localStorage.setItem('themePodSat', state.theme.podSat);
}

// ═══════════════════════════════════════════
//  SETUP SCREEN BRAND COLORS
// ═══════════════════════════════════════════
const BRANDS = {
  plex: {
    light: {
      bg:          'linear-gradient(180deg, #d4b86a 0%, #b89442 100%)',
      title:       '#2a1a00',
      text:        '#3a2a00',
      accent:      '#E5A00D',
      accentDark:  '#c48600',
      border:      'rgba(160,100,0,0.45)',
      inputBg:     'rgba(255,248,220,0.8)',
      inputText:   '#2a1a00',
      placeholder: '#8a6a30',
      btnIdle:     'rgba(100,60,0,0.5)',
      shadow:      'rgba(140,80,0,0.4)',
    },
    dark: {
      bg:          'linear-gradient(180deg, #2a1e06 0%, #1a1200 100%)',
      title:       '#E5A00D',
      text:        '#8a6a30',
      accent:      '#E5A00D',
      accentDark:  '#c48600',
      border:      'rgba(200,140,0,0.3)',
      inputBg:     'rgba(50,35,0,0.7)',
      inputText:   '#d4a040',
      placeholder: '#6a4a18',
      btnIdle:     'rgba(200,140,0,0.35)',
      shadow:      'rgba(180,120,0,0.3)',
    },
  },
  jellyfin: {
    light: {
      bg:          'linear-gradient(180deg, #ddc8f0 0%, #c0a0dc 100%)',
      title:       '#2a0a3a',
      text:        '#4a1a5a',
      accent:      '#AA5CC3',
      accentDark:  '#7B2FBE',
      border:      'rgba(130,50,180,0.4)',
      inputBg:     'rgba(245,235,255,0.8)',
      inputText:   '#2a0a3a',
      placeholder: '#8a5aaa',
      btnIdle:     'rgba(100,30,140,0.45)',
      shadow:      'rgba(120,40,160,0.4)',
    },
    dark: {
      bg:          'linear-gradient(180deg, #1e0a2e 0%, #130520 100%)',
      title:       '#c07af0',
      text:        '#7a3aaa',
      accent:      '#AA5CC3',
      accentDark:  '#7B2FBE',
      border:      'rgba(160,80,200,0.3)',
      inputBg:     'rgba(30,8,50,0.8)',
      inputText:   '#c080e8',
      placeholder: '#6a2a9a',
      btnIdle:     'rgba(160,80,200,0.3)',
      shadow:      'rgba(140,60,180,0.3)',
    },
  },
};

function applySetupBranding() {
  const b = BRANDS[state.serverType][state.darkMode ? 'dark' : 'light'];
  const r = document.documentElement.style;
  r.setProperty('--su-bg',          b.bg);
  r.setProperty('--su-title',       b.title);
  r.setProperty('--su-text',        b.text);
  r.setProperty('--su-accent',      b.accent);
  r.setProperty('--su-border',      b.border);
  r.setProperty('--su-input-bg',    b.inputBg);
  r.setProperty('--su-input-text',  b.inputText);
  r.setProperty('--su-placeholder', b.placeholder);
  r.setProperty('--su-btn-idle',    b.btnIdle);
  r.setProperty('--su-shadow',      b.shadow);
}

// ═══════════════════════════════════════════
//  DARK MODE
// ═══════════════════════════════════════════
function applyDarkMode() {
  document.body.classList.toggle('dark-mode', state.darkMode);
  document.body.classList.toggle('dark-page', state.darkMode);
  applyTheme();        // always theme the pod shell (body, wheel, bezel)
  applySetupBranding(); // setup screen content colors (no-op when not on setup)
}

function toggleDarkMode() {
  state.darkMode = !state.darkMode;
  localStorage.setItem('darkMode', state.darkMode);
  applyDarkMode();
  const m = currentMenu();
  if (m && m.title === 'Settings') {
    m.items[0].label = state.darkMode ? '☀️ Light Mode' : '🌙 Dark Mode';
    if (state.view === 'menu') render();
  }
}

// ═══════════════════════════════════════════
//  AUTO-SCALE / NATIVE LAYOUT
// ═══════════════════════════════════════════
const POD_W = 260, POD_H = 450;

function autoScale() {
  const wrapper = document.querySelector('.ipod-wrapper');
  if (!wrapper) return;
  const vw  = window.innerWidth;
  const vh  = window.innerHeight;
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  const isMobile = vw <= 640 || isTouch;

  if (isMobile) {
    // ── Native full-bleed layout ──────────────────────────────────
    document.body.classList.add('native');
    wrapper.style.transform = '';

    // Wheel zone = 42% of viewport height, capped to keep it comfortable
    const wheelZoneH = Math.min(Math.round(vh * 0.42), 320);
    // Wheel diameter = 82% of vw, or 88% of wheelZoneH, whichever is smaller
    const wheelSize  = Math.min(Math.round(vw * 0.82), Math.round(wheelZoneH * 0.88));
    const centerSize = Math.round(wheelSize * 0.41);

    const rs = document.documentElement.style;
    rs.setProperty('--wheel-zone-h',      wheelZoneH + 'px');
    rs.setProperty('--native-wheel-size', wheelSize  + 'px');
    rs.setProperty('--native-center-size',centerSize + 'px');
    rs.setProperty('--native-wheel-font', Math.max(9, Math.round(wheelSize * 0.052)) + 'px');
    rs.setProperty('--native-art-size',   Math.min(Math.round(vw * 0.30), 180) + 'px');
  } else {
    // ── Desktop: scale the iPod shell to fit ─────────────────────
    document.body.classList.remove('native');
    const scale = Math.min((vw * 0.88) / POD_W, (vh * 0.88) / POD_H, 3.5);
    wrapper.style.transform = `scale(${Math.max(0.5, scale)})`;
  }
}

function toggleFullscreen() {
  state.fullscreen = !state.fullscreen;
  document.body.classList.toggle('fullscreen', state.fullscreen);
  if (state.fullscreen) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  // Update label in Settings if open
  const m = currentMenu();
  if (m && m.title === 'Settings') {
    const fi = m.items.find(i => i._id === 'fullscreen');
    if (fi) { fi.label = state.fullscreen ? '✕ Exit Fullscreen' : '⛶ Fullscreen'; render(); }
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.fullscreen) {
    state.fullscreen = false;
    document.body.classList.remove('fullscreen');
  }
});

window.addEventListener('resize', autoScale);
// Also re-scale when virtual keyboard collapses on mobile
window.visualViewport?.addEventListener('resize', autoScale);

// ═══════════════════════════════════════════
//  THEME PANEL — HUE RINGS
// ═══════════════════════════════════════════
function ringAngleToHue(ringWrap, e) {
  const rect = ringWrap.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top  + rect.height / 2;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  let angle = Math.atan2(clientY - cy, clientX - cx) + Math.PI / 2;
  if (angle < 0) angle += Math.PI * 2;
  return Math.round((angle / (Math.PI * 2)) * 360) % 360;
}

function positionDot(dotEl, hue, size = 76) {
  const r = size * 0.315; // mid-ring radius
  const angle = (hue / 360) * Math.PI * 2 - Math.PI / 2;
  dotEl.style.left = (size / 2 + r * Math.cos(angle)) + 'px';
  dotEl.style.top  = (size / 2 + r * Math.sin(angle)) + 'px';
  dotEl.style.background = `hsl(${hue}, 100%, 50%)`;
}

function setupRing(ringId, dotId, onChange) {
  const ring = document.getElementById(ringId);
  const dot  = document.getElementById(dotId);
  if (!ring || !dot) return;

  let dragging = false;
  const handle = e => {
    const hue = ringAngleToHue(ring, e);
    onChange(hue);
    positionDot(dot, hue);
  };
  ring.addEventListener('mousedown', e => { dragging = true; handle(e); e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (dragging) handle(e); });
  document.addEventListener('mouseup',   () => { dragging = false; });
  ring.addEventListener('touchstart', e => { e.preventDefault(); handle(e); }, { passive: false });
  ring.addEventListener('touchmove',  e => { e.preventDefault(); handle(e); }, { passive: false });
}

function initThemePanel() {
  const uiDot  = document.getElementById('ui-dot');
  const podDot = document.getElementById('pod-dot');

  setupRing('ui-ring', 'ui-dot', hue => {
    state.theme.uiHue = hue;
    saveTheme(); applyTheme();
  });
  setupRing('pod-ring', 'pod-dot', hue => {
    state.theme.podHue = hue;
    saveTheme(); applyTheme();
  });

  // Sat slider
  const satSlider = document.getElementById('pod-sat');
  satSlider.value = state.theme.podSat;
  satSlider.addEventListener('input', () => {
    state.theme.podSat = parseInt(satSlider.value, 10);
    saveTheme(); applyTheme();
  });

  // UI presets
  const uiPresetsEl = document.getElementById('ui-presets');
  UI_PRESETS.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'tp-chip';
    chip.style.background = p.color;
    chip.title = p.label;
    chip.addEventListener('click', () => {
      state.theme.uiHue = p.hue;
      saveTheme(); applyTheme();
      positionDot(uiDot, p.hue);
    });
    uiPresetsEl.appendChild(chip);
  });

  // Pod presets
  const podPresetsEl = document.getElementById('pod-presets');
  POD_PRESETS.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'tp-chip';
    chip.style.background = p.color;
    chip.title = p.label;
    chip.addEventListener('click', () => {
      state.theme.podHue = p.hue;
      state.theme.podSat = p.sat;
      satSlider.value = p.sat;
      saveTheme(); applyTheme();
      positionDot(podDot, p.hue);
    });
    podPresetsEl.appendChild(chip);
  });

  // Reset
  document.getElementById('tp-reset').addEventListener('click', () => {
    state.theme = { ...DEFAULT_THEME };
    satSlider.value = 0;
    saveTheme(); applyTheme();
    positionDot(uiDot,  state.theme.uiHue);
    positionDot(podDot, state.theme.podHue);
  });

  // Init dot positions
  positionDot(uiDot,  state.theme.uiHue);
  positionDot(podDot, state.theme.podHue);
}

function updateThemePanel() {
  const uiSwatch  = document.getElementById('ui-swatch');
  const podSwatch = document.getElementById('pod-swatch');
  const satSlider = document.getElementById('pod-sat');
  if (!uiSwatch) return;

  const h = state.theme.uiHue;
  const ph = state.theme.podHue;
  const ps = state.theme.podSat;

  uiSwatch.style.background = state.darkMode
    ? `linear-gradient(135deg, hsl(${h},52%,20%), hsl(${h},52%,13%))`
    : `linear-gradient(135deg, hsl(${h},48%,52%), hsl(${h},48%,40%))`;

  podSwatch.style.background = state.darkMode
    ? `linear-gradient(135deg, hsl(${ph},${Math.round(ps*0.55)}%,18%), hsl(${ph},${Math.round(ps*0.55)}%,11%))`
    : `linear-gradient(135deg, hsl(${ph},${ps}%,92%), hsl(${ph},${ps}%,78%))`;

  if (satSlider) satSlider.value = ps;

  // Update sat slider track gradient
  if (satSlider) {
    satSlider.style.background =
      `linear-gradient(90deg, hsl(${ph},0%,50%) 0%, hsl(${ph},60%,60%) 100%)`;
  }

  // Highlight active presets
  const uiChips  = document.querySelectorAll('#ui-presets .tp-chip');
  const podChips = document.querySelectorAll('#pod-presets .tp-chip');
  uiChips.forEach((c, i) => c.classList.toggle('selected', UI_PRESETS[i]?.hue === h));
  podChips.forEach((c, i) => c.classList.toggle('selected',
    POD_PRESETS[i]?.hue === ph && POD_PRESETS[i]?.sat === ps));
}

function openThemePanel() {
  const panel    = document.getElementById('theme-panel');
  const backdrop = document.getElementById('tp-backdrop');
  panel.classList.remove('tp-hidden');
  backdrop.classList.remove('tp-hidden');
  positionDot(document.getElementById('ui-dot'),  state.theme.uiHue);
  positionDot(document.getElementById('pod-dot'), state.theme.podHue);
  updateThemePanel();
}

function closeThemePanel() {
  document.getElementById('theme-panel').classList.add('tp-hidden');
  document.getElementById('tp-backdrop').classList.add('tp-hidden');
}

document.getElementById('tp-close').addEventListener('click', closeThemePanel);
document.getElementById('tp-backdrop').addEventListener('click', closeThemePanel);

// ═══════════════════════════════════════════
//  PLEX API
// ═══════════════════════════════════════════
function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

// Safe JSON parse — verifies Content-Type before parsing to avoid confusing
// SyntaxErrors when a server returns an HTML error page instead of JSON.
async function safeJson(res) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(`Expected JSON but got ${ct || 'no content-type'} (HTTP ${res.status})`);
  }
  return res.json();
}

async function plexFetch(path) {
  if (state.plexToken.length > 512) { handleSessionExpiry(); throw new Error('Invalid session token.'); }
  const sep = path.includes('?') ? '&' : '?';
  const url = `${state.plexUrl}${path}${sep}X-Plex-Client-Identifier=${encodeURIComponent(PLEX_CLIENT_ID)}`;
  const res = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json', 'X-Plex-Token': state.plexToken }
  });
  if (res.status === 401) { handleSessionExpiry(); throw new Error('Session expired. Please sign in again.'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return safeJson(res);
}

function plexThumb(thumb, size = 80) {
  if (!thumb) return null;
  // Token must be in URL — browser <img> cannot send custom headers
  return `${state.plexUrl}/photo/:/transcode?width=${size}&height=${size}&url=${encodeURIComponent(thumb)}&X-Plex-Token=${encodeURIComponent(state.plexToken)}`;
}

function plexStream(key) {
  // Token must be in URL — <audio> cannot send custom headers
  return `${state.plexUrl}${key}?X-Plex-Token=${encodeURIComponent(state.plexToken)}`;
}

// ═══════════════════════════════════════════
//  JELLYFIN API
// ═══════════════════════════════════════════
async function jellyfinFetch(path) {
  if (state.jellyfinApiKey.length > 512) { handleSessionExpiry(); throw new Error('Invalid session token.'); }
  const res = await fetchWithTimeout(`${state.jellyfinUrl}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `MediaBrowser Token="${state.jellyfinApiKey}"`,
    }
  });
  if (res.status === 401) { handleSessionExpiry(); throw new Error('Session expired. Please sign in again.'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return safeJson(res);
}

function jellyfinThumb(itemId, size = 80) {
  if (!itemId) return null;
  // Token must be in URL — browser <img> cannot send custom headers
  return `${state.jellyfinUrl}/Items/${itemId}/Images/Primary?width=${size}&height=${size}&api_key=${encodeURIComponent(state.jellyfinApiKey)}`;
}

function jellyfinStream(itemId) {
  // Token must be in URL — <audio> cannot send custom headers
  return `${state.jellyfinUrl}/Audio/${itemId}/universal?UserId=${encodeURIComponent(state.jellyfinUserId)}&api_key=${encodeURIComponent(state.jellyfinApiKey)}&Container=mp3,aac,ogg,opus,flac,wav`;
}

function normalizeJfTrack(item) {
  return {
    title:            item.Name         || 'Unknown',
    grandparentTitle: item.AlbumArtist  || item.Artists?.[0] || '',
    parentTitle:      item.Album        || '',
    _thumbUrl:  jellyfinThumb(item.AlbumId || item.Id, 160),
    _streamUrl: jellyfinStream(item.Id),
  };
}

// ═══════════════════════════════════════════
//  UNIFIED HELPERS
// ═══════════════════════════════════════════
function getThumb(track, size = 160) {
  if (track._thumbUrl) return track._thumbUrl;
  return plexThumb(track.thumb || track.parentThumb || track.grandparentThumb, size);
}

function getStreamUrl(track) {
  if (track._streamUrl) return track._streamUrl;
  try { return plexStream(track.Media[0].Part[0].key); }
  catch (_) { throw new Error(`No streamable media for "${esc(track.title)}"`); }
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ═══════════════════════════════════════════
//  WAKE LOCK — prevent screen sleep while playing
// ═══════════════════════════════════════════
let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (wakeLock) return; // already held
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) { wakeLock = null; }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

// Re-acquire wake lock when the page becomes visible again (e.g. after screen-on)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.playing) acquireWakeLock();
});

// ═══════════════════════════════════════════
//  MEDIA SESSION — lock screen, notification, headphone buttons
// ═══════════════════════════════════════════
function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return;

  // Build artwork array — try the resolved thumb URL
  const artSrc = getThumb(track, 512);
  const artwork = artSrc ? [
    { src: artSrc, sizes: '512x512', type: 'image/jpeg' },
  ] : [];

  navigator.mediaSession.metadata = new MediaMetadata({
    title:  track.title            || 'Unknown',
    artist: track.grandparentTitle || '',
    album:  track.parentTitle      || '',
    artwork,
  });

  navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';

  // Register action handlers (idempotent — safe to call on every track change)
  navigator.mediaSession.setActionHandler('play',          () => { state.audio.play().catch(() => {}); });
  navigator.mediaSession.setActionHandler('pause',         () => { state.audio.pause(); });
  navigator.mediaSession.setActionHandler('stop',          () => { state.audio.pause(); state.audio.currentTime = 0; });
  navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  navigator.mediaSession.setActionHandler('nexttrack',     () => nextTrack());
  navigator.mediaSession.setActionHandler('seekto', details => {
    if (details.seekTime != null) state.audio.currentTime = details.seekTime;
  });
  navigator.mediaSession.setActionHandler('seekbackward', details => {
    const skip = details.seekOffset ?? 10;
    state.audio.currentTime = Math.max(0, state.audio.currentTime - skip);
  });
  navigator.mediaSession.setActionHandler('seekforward', details => {
    const skip = details.seekOffset ?? 10;
    state.audio.currentTime = Math.min(state.duration, state.audio.currentTime + skip);
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !state.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration:     state.duration,
      playbackRate: state.audio.playbackRate,
      position:     Math.min(state.audio.currentTime, state.duration),
    });
  } catch (_) {}
}

// ═══════════════════════════════════════════
//  AUDIO
// ═══════════════════════════════════════════
let positionStateThrottle = 0;

state.audio.addEventListener('timeupdate', () => {
  state.progress = state.audio.currentTime;
  state.duration = state.audio.duration || 0;
  if (state.view === 'nowplaying') renderNowPlaying();
  // Throttle position state updates to ~4× per second (enough for scrub bar on lock screen)
  const now = Date.now();
  if (now - positionStateThrottle > 250) {
    positionStateThrottle = now;
    updatePositionState();
  }
});

state.audio.addEventListener('ended', nextTrack);

state.audio.addEventListener('play', () => {
  state.playing = true;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  acquireWakeLock();
  if (state.view === 'nowplaying') renderNowPlaying();
});

state.audio.addEventListener('pause', () => {
  state.playing = false;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  releaseWakeLock();
  if (state.view === 'nowplaying') renderNowPlaying();
});

state.audio.addEventListener('loadedmetadata', () => {
  state.duration = state.audio.duration || 0;
  updatePositionState();
});

function playTrack(track, queue, index) {
  state.currentTrack = track;
  state.queue = queue; state.queueIndex = index;
  state.audio.src = getStreamUrl(track);
  state.audio.play().catch(e => {
    // Autoplay blocked — update UI to paused so user can tap play
    state.playing = false;
    if (state.view === 'nowplaying') renderNowPlaying();
  });
  state.view = 'nowplaying';
  updateMediaSession(track);
  render();
}

function togglePlay() {
  if (state.audio.paused) state.audio.play().catch(() => {}); else state.audio.pause();
}

function nextTrack() {
  if (!state.queue.length) return;
  state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  playTrack(state.queue[state.queueIndex], state.queue, state.queueIndex);
}

function prevTrack() {
  if (state.audio.currentTime > 3) { state.audio.currentTime = 0; return; }
  if (!state.queue.length) return;
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playTrack(state.queue[state.queueIndex], state.queue, state.queueIndex);
}

// ═══════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════
const currentMenu  = () => state.navStack[state.navStack.length - 1];
const selectedItem = () => { const m = currentMenu(); return m ? m.items[m.selectedIndex] : null; };

function scrollMenu(dir) {
  const menu = currentMenu();
  if (!menu) return;
  menu.selectedIndex = (menu.selectedIndex + dir + menu.items.length) % menu.items.length;
  if (state.view === 'menu') render();
}

function selectItem() { const item = selectedItem(); if (item?.action) item.action(item); }

function goBack() {
  if (state.view === 'nowplaying') { state.view = 'menu'; render(); return; }
  if (state.navStack.length > 1) { state.navStack.pop(); render(); }
}

/** Push a menu onto the nav stack and render it */
function pushMenu(title, items) {
  state.navStack.push({ title, selectedIndex: 0, items });
  state.view = 'menu';
  render();
}

/**
 * Factory for the standard "show loader → fetch → build items → push menu" pattern.
 * @param {string} loadMsg   - Loading message
 * @param {Function} fetchFn - Async function returning raw data
 * @param {Function} mapFn   - Maps raw data to [{label, sublabel?, arrow, action}]
 * @param {string} title     - Menu title
 */
async function apiMenu(loadMsg, fetchFn, mapFn, title) {
  showLoading(loadMsg);
  try {
    const data = await fetchFn();
    pushMenu(title, mapFn(data));
  } catch(e) { showMenuError(e.message); }
}

// ═══════════════════════════════════════════
//  MENUS — SHARED
// ═══════════════════════════════════════════
function buildMainMenu() {
  const title = state.serverType === 'jellyfin' ? 'JellyPod' : 'PlexPod';
  return {
    title, selectedIndex: 0,
    items: [
      { label: 'Music',       arrow: true, action: openMusicMenu },
      { label: 'Now Playing', arrow: true, action: () => { if (state.currentTrack) { state.view = 'nowplaying'; render(); } } },
      { label: 'Settings',   arrow: true, action: openSettings },
    ]
  };
}

async function openMusicMenu() {
  if (state.serverType === 'jellyfin') return jfOpenMusicMenu();
  showLoading('Loading...');
  try {
    const data = await plexFetch('/library/sections');
    const musicSections = (data.MediaContainer.Directory || []).filter(s => s.type === 'artist');
    if (!musicSections.length) throw new Error('No music libraries found');
    const sectionKey = musicSections[0].key;
    pushMenu('Music', [
      { label: 'Artists',   arrow: true, action: () => openArtistList(sectionKey, 'Artists') },
      { label: 'Albums',    arrow: true, action: () => openAlbumList(sectionKey, 'Albums') },
      { label: 'Songs',     arrow: true, action: () => openSongList(sectionKey, 'Songs') },
      { label: 'Playlists', arrow: true, action: openPlaylists },
    ]);
  } catch(e) { showMenuError(e.message); }
}

function openSettings() {
  state.navStack.push({
    title: 'Settings', selectedIndex: 0,
    items: [
      { label: state.darkMode ? '☀️ Light Mode' : '🌙 Dark Mode', arrow: false, action: () => {
          toggleDarkMode();
          currentMenu().items[0].label = state.darkMode ? '☀️ Light Mode' : '🌙 Dark Mode';
          render();
      }},
      { label: '🎨 Customize Theme', arrow: false, action: () => { openThemePanel(); }},
      { _id: 'fullscreen', label: state.fullscreen ? '✕ Exit Fullscreen' : '⛶ Fullscreen', arrow: false, action: () => {
          toggleFullscreen();
      }},
      { label: 'Disconnect', arrow: false, action: () => {
          state.audio.pause();
          stopPlexPoll();
          state.plexUrl = ''; state.plexToken = '';
          state.jellyfinUrl = ''; state.jellyfinApiKey = ''; state.jellyfinUserId = '';
          localStorage.removeItem('plexUrl'); localStorage.removeItem('plexToken');
          localStorage.removeItem('jellyfinUrl'); localStorage.removeItem('jellyfinApiKey');
          localStorage.removeItem('jellyfinUserId'); localStorage.removeItem('serverType');
          state.connected = false; state.connStatus = 'disconnected';
          state.navStack = []; state.currentTrack = null;
          state.serverType = 'plex';
          closeThemePanel();
          state.view = 'setup'; render();
      }}
    ]
  });
  state.view = 'menu'; render();
}

// ═══════════════════════════════════════════
//  MENUS — PLEX
// ═══════════════════════════════════════════
async function openArtistList(sectionKey, title) {
  await apiMenu('Loading artists...', () => plexFetch(`/library/sections/${sectionKey}/all?type=8`), d =>
    (d.MediaContainer.Metadata || []).map(a => ({ label: a.title, arrow: true, action: () => openArtistAlbums(a.ratingKey, a.title) })), title);
}

async function openArtistAlbums(key, name) {
  await apiMenu('Loading...', () => plexFetch(`/library/metadata/${key}/children`), d =>
    (d.MediaContainer.Metadata || []).map(a => ({ label: a.title, arrow: true, action: () => openAlbumTracks(a.ratingKey, a.title) })), name);
}

async function openAlbumList(sectionKey, title) {
  await apiMenu('Loading albums...', () => plexFetch(`/library/sections/${sectionKey}/all?type=9`), d =>
    (d.MediaContainer.Metadata || []).map(a => ({ label: a.title, sublabel: a.parentTitle, arrow: true, action: () => openAlbumTracks(a.ratingKey, a.title) })), title);
}

async function openAlbumTracks(key, title) {
  await apiMenu('Loading tracks...', () => plexFetch(`/library/metadata/${key}/children`), d => {
    const tracks = d.MediaContainer.Metadata || [];
    return tracks.map((t, i) => ({ label: t.title, sublabel: t.grandparentTitle, arrow: false, action: () => playTrack(t, tracks, i) }));
  }, title);
}

async function openSongList(sectionKey, title) {
  await apiMenu('Loading songs...', () => plexFetch(`/library/sections/${sectionKey}/all?type=10`), d => {
    const tracks = d.MediaContainer.Metadata || [];
    return tracks.map((t, i) => ({ label: t.title, sublabel: t.grandparentTitle, arrow: false, action: () => playTrack(t, tracks, i) }));
  }, title);
}

async function openPlaylists() {
  await apiMenu('Loading playlists...', () => plexFetch('/playlists?type=audio'), d =>
    (d.MediaContainer.Metadata || []).map(p => ({ label: p.title, arrow: true, action: () => openPlaylistTracks(p.ratingKey, p.title) })), 'Playlists');
}

async function openPlaylistTracks(key, title) {
  await apiMenu('Loading...', () => plexFetch(`/playlists/${key}/items`), d => {
    const tracks = d.MediaContainer.Metadata || [];
    return tracks.map((t, i) => ({ label: t.title, sublabel: t.grandparentTitle, arrow: false, action: () => playTrack(t, tracks, i) }));
  }, title);
}

// ═══════════════════════════════════════════
//  MENUS — JELLYFIN
// ═══════════════════════════════════════════
function jfOpenMusicMenu() {
  pushMenu('Music', [
    { label: 'Artists',   arrow: true, action: jfOpenArtistList },
    { label: 'Albums',    arrow: true, action: jfOpenAlbumList },
    { label: 'Songs',     arrow: true, action: jfOpenSongList },
    { label: 'Playlists', arrow: true, action: jfOpenPlaylists },
  ]);
}

async function jfOpenArtistList() {
  await apiMenu('Loading artists...', () => jellyfinFetch(`/Items?IncludeItemTypes=MusicArtist&Recursive=true&SortBy=SortName&SortOrder=Ascending&UserId=${encodeURIComponent(state.jellyfinUserId)}`), d =>
    (d.Items || []).map(a => ({ label: a.Name, arrow: true, action: () => jfOpenArtistAlbums(a.Id, a.Name) })), 'Artists');
}

async function jfOpenArtistAlbums(artistId, name) {
  await apiMenu('Loading...', () => jellyfinFetch(`/Items?IncludeItemTypes=MusicAlbum&Recursive=true&ArtistIds=${encodeURIComponent(artistId)}&SortBy=ProductionYear,SortName&SortOrder=Ascending&UserId=${encodeURIComponent(state.jellyfinUserId)}`), d =>
    (d.Items || []).map(a => ({ label: a.Name, sublabel: a.ProductionYear ? String(a.ProductionYear) : '', arrow: true, action: () => jfOpenAlbumTracks(a.Id, a.Name) })), name);
}

async function jfOpenAlbumList() {
  await apiMenu('Loading albums...', () => jellyfinFetch(`/Items?IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=SortName&SortOrder=Ascending&UserId=${encodeURIComponent(state.jellyfinUserId)}`), d =>
    (d.Items || []).map(a => ({ label: a.Name, sublabel: a.AlbumArtist || '', arrow: true, action: () => jfOpenAlbumTracks(a.Id, a.Name) })), 'Albums');
}

async function jfOpenAlbumTracks(albumId, title) {
  await apiMenu('Loading tracks...', () => jellyfinFetch(`/Items?ParentId=${encodeURIComponent(albumId)}&IncludeItemTypes=Audio&SortBy=IndexNumber,SortName&SortOrder=Ascending&UserId=${encodeURIComponent(state.jellyfinUserId)}`), d => {
    const tracks = (d.Items || []).map(normalizeJfTrack);
    return tracks.map((t, i) => ({ label: t.title, sublabel: t.grandparentTitle, arrow: false, action: () => playTrack(t, tracks, i) }));
  }, title);
}

async function jfOpenSongList() {
  await apiMenu('Loading songs...', () => jellyfinFetch(`/Items?IncludeItemTypes=Audio&Recursive=true&SortBy=SortName&SortOrder=Ascending&Limit=500&UserId=${encodeURIComponent(state.jellyfinUserId)}`), d => {
    const tracks = (d.Items || []).map(normalizeJfTrack);
    return tracks.map((t, i) => ({ label: t.title, sublabel: t.grandparentTitle, arrow: false, action: () => playTrack(t, tracks, i) }));
  }, 'Songs');
}

async function jfOpenPlaylists() {
  await apiMenu('Loading playlists...', () => jellyfinFetch(`/Items?IncludeItemTypes=Playlist&Recursive=true&SortBy=SortName&SortOrder=Ascending&UserId=${encodeURIComponent(state.jellyfinUserId)}`), d =>
    (d.Items || []).map(p => ({ label: p.Name, arrow: true, action: () => jfOpenPlaylistTracks(p.Id, p.Name) })), 'Playlists');
}

async function jfOpenPlaylistTracks(playlistId, title) {
  await apiMenu('Loading...', () => jellyfinFetch(`/Playlists/${encodeURIComponent(playlistId)}/Items?UserId=${encodeURIComponent(state.jellyfinUserId)}`), d => {
    const tracks = (d.Items || []).map(normalizeJfTrack);
    return tracks.map((t, i) => ({ label: t.title, sublabel: t.grandparentTitle, arrow: false, action: () => playTrack(t, tracks, i) }));
  }, title);
}

// ═══════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════
function render() {
  const screen = document.getElementById('screen');
  if (state.view === 'setup')      renderSetup(screen);
  else if (state.view === 'nowplaying') renderNowPlaying(screen);
  else if (state.view === 'menu')  renderMenu(screen);
}

/** Show an in-screen error bar instead of alert() — works in PWA standalone mode */
function showMenuError(msg) {
  // If not already in menu view, go there first
  if (state.view !== 'menu') { state.view = 'menu'; render(); }

  // Inject error bar on next frame so the menu list DOM exists
  requestAnimationFrame(() => {
    const list = document.querySelector('.menu-list');
    if (!list) return;
    // Remove any existing error bar first
    list.querySelector('.menu-error-bar')?.remove();
    const bar = document.createElement('div');
    bar.className = 'menu-error-bar';
    bar.style.cssText = 'padding:5px 10px;font-size:10px;color:#ff6666;background:rgba(180,0,0,0.18);border-bottom:1px solid rgba(255,100,100,0.2);cursor:pointer;user-select:none';
    bar.textContent = '⚠ ' + msg;
    bar.onclick = () => bar.remove();
    list.prepend(bar);
    setTimeout(() => bar.remove?.(), 5000);
  });
}

function showLoading(msg) {
  if (msg === 'Connecting...') state.connStatus = 'connecting';
  document.getElementById('screen').innerHTML =
    `<div class="loading"><div class="spinner"></div><p>${msg}</p></div>`;
}

// ═══════════════════════════════════════════
//  PLEX OAUTH PIN FLOW
// ═══════════════════════════════════════════
const PLEX_HEADERS = {
  'Accept': 'application/json',
  'X-Plex-Product': 'MediaPod',
  'X-Plex-Version': '1.0',
  'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
  'X-Plex-Platform': 'Web',
};

function stopPlexPoll() {
  if (state.plexPinPoll) { clearInterval(state.plexPinPoll); state.plexPinPoll = null; }
}

async function startPlexOAuth() {
  stopPlexPoll();
  const btn = document.getElementById('plex-oauth-btn');
  if (btn) { btn.textContent = 'Opening Plex…'; btn.disabled = true; }

  // Open the auth window SYNCHRONOUSLY (before any await) so popup blockers
  // treat it as a direct user gesture. We'll navigate it to the real URL once
  // we have the PIN code.
  const authWin = window.open('about:blank', '_blank');

  try {
    const pinRes = await fetchWithTimeout('https://plex.tv/api/v2/pins', {
      method: 'POST',
      headers: { ...PLEX_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'strong=true',
    }, 8000);
    if (!pinRes.ok) throw new Error('Could not reach plex.tv');
    const pin = await safeJson(pinRes);
    state.plexPinId = pin.id;

    // Navigate the already-open window to the real auth URL
    const authUrl = `https://app.plex.tv/auth#?clientID=${PLEX_CLIENT_ID}&code=${pin.code}&context[device][product]=MediaPod`;
    if (authWin && !authWin.closed) {
      authWin.location.href = authUrl;
    } else {
      // Popup was blocked despite our best effort — fall back to same-tab redirect hint
      window.open(authUrl, '_blank');
    }

    renderPlexWaiting(pin.code);

    let attempts = 0;
    state.plexPinPoll = setInterval(async () => {
      attempts++;
      if (attempts > 150) { stopPlexPoll(); renderSetup(document.getElementById('screen')); return; }
      try {
        const checkRes = await fetchWithTimeout(
          `https://plex.tv/api/v2/pins/${pin.id}`,
          { headers: PLEX_HEADERS },
          6000
        );
        const data = await safeJson(checkRes);
        if (typeof data.authToken === 'string' && data.authToken.length > 0) {
          stopPlexPoll();
          try { authWin?.close(); } catch (_) {}
          await completePlexAuth(data.authToken);
        }
      } catch (_) {}
    }, 2000);

  } catch (e) {
    try { authWin?.close(); } catch (_) {}
    if (btn) { btn.textContent = 'Sign in with Plex'; btn.disabled = false; }
    const err = document.getElementById('setup-error');
    if (err) { err.textContent = e.message; err.style.display = 'block'; }
  }
}

function renderPlexWaiting(code) {
  const screen = document.getElementById('screen');
  const brand  = BRANDS.plex[state.darkMode ? 'dark' : 'light'];
  screen.innerHTML = `
    ${DALEK_BANNER}
    <div class="setup-screen">
      <h2>🟠 PlexPod</h2>
      <p class="su-sub" style="font-size:clamp(9px,2.2vw,11px)">Sign in on the Plex page that just opened, then come back here.</p>
      <div class="spinner" style="margin:6px auto"></div>
      <p class="su-hint">Waiting for Plex…</p>
      <p class="su-hint" style="opacity:0.4;font-size:7px;letter-spacing:0.5px">PIN: ${esc(code)}</p>
      <button class="setup-btn" id="plex-cancel-btn"
        style="background:rgba(0,0,0,0.25);margin-top:4px;font-size:9px">Cancel</button>
    </div>`;
  document.getElementById('plex-cancel-btn').addEventListener('click', () => {
    stopPlexPoll();
    state.view = 'setup'; render();
  });
}

async function completePlexAuth(token) {
  showLoading('Signing in…');
  state.connStatus = 'connecting';
  try {
    const resRes = await fetchWithTimeout(
      `https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`,
      { headers: { ...PLEX_HEADERS, 'X-Plex-Token': token } },
      10000
    );
    if (!resRes.ok) throw new Error('Could not fetch servers');
    const resources = await safeJson(resRes);
    const servers = resources.filter(r => r.provides === 'server' && r.connections?.length);

    if (!servers.length) throw new Error('No Plex servers found on your account');

    if (servers.length === 1) {
      await connectToPlexServer(servers[0], token);
    } else {
      renderPlexServerPicker(servers, token);
    }
  } catch (e) {
    state.connStatus = 'disconnected';
    state.plexPinId = null;
    state.view = 'setup'; render();
    setTimeout(() => {
      const err = document.getElementById('setup-error');
      if (err) { err.textContent = e.message; err.style.display = 'block'; }
    }, 30);
  }
}

function renderPlexServerPicker(servers, token) {
  const screen = document.getElementById('screen');
  const brand  = BRANDS.plex[state.darkMode ? 'dark' : 'light'];
  const rows = servers.map((s, i) =>
    `<button class="setup-btn srv-pick" data-i="${i}"
      style="background:rgba(0,0,0,0.2);font-size:clamp(9px,2.2vw,11px);text-align:left;padding:5px 8px;margin:0">
      <strong>${esc(s.name)}</strong>
      <span style="opacity:0.6;font-size:8px;display:block">${s.owned ? 'Owned' : 'Shared'} · ${s.connections.length} connection${s.connections.length !== 1 ? 's' : ''}</span>
    </button>`
  ).join('');
  screen.innerHTML = `
    ${DALEK_BANNER}
    <div class="setup-screen" style="gap:4px">
      <h2>🟠 Choose Server</h2>
      ${rows}
      <p id="picker-error" class="setup-error" style="display:none"></p>
      <button class="setup-btn" id="plex-back-btn"
        style="background:rgba(0,0,0,0.25);font-size:9px;margin-top:2px">← Back</button>
    </div>`;
  screen.querySelectorAll('.srv-pick').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.i, 10);
      if (isNaN(idx) || idx < 0 || idx >= servers.length) return;
      const srv = servers[idx];
      showLoading('Connecting…');
      try {
        await connectToPlexServer(srv, token);
      } catch (e) {
        renderPlexServerPicker(servers, token);
        setTimeout(() => {
          const errEl = document.getElementById('picker-error');
          if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
        }, 30);
      }
    });
  });
  document.getElementById('plex-back-btn').addEventListener('click', () => {
    state.view = 'setup'; render();
  });
}

async function connectToPlexServer(server, token) {
  // When served from a custom domain, direct *.plex.direct connections are
  // blocked by CORS (Plex only allows app.plex.tv). Prefer relay connections
  // first — they go through Plex's own infrastructure which allows any origin.
  // Fall back to direct connections for local/self-hosted setups.
  const conns = [...server.connections].sort((a, b) => {
    const score = c => (c.relay ? 0 : 2) + (c.local ? 0 : 1) + (c.protocol === 'https' ? 0 : 1);
    return score(a) - score(b);
  });

  let lastErr = 'All connections failed';
  for (const conn of conns) {
    const url = conn.uri.replace(/\/$/, '');
    // Skip non-http(s) URIs — fetch doesn't execute them but avoids unexpected behaviour
    if (!isValidUrl(url)) continue;
    try {
      const test = await fetchWithTimeout(
        `${url}/`,
        { headers: { Accept: 'application/json', 'X-Plex-Token': token } },
        4000
      );
      if (!test.ok) continue;
      // Validate token format before storing — defense in depth
      if (!/^[a-zA-Z0-9_-]+$/.test(token)) throw new Error('Unexpected token format received from Plex.');
      // ✓ reachable — commit
      state.plexUrl   = url;
      state.plexToken = token;
      localStorage.setItem('plexUrl',    url);
      localStorage.setItem('plexToken',  token);
      localStorage.setItem('serverType', 'plex');
      state.connected   = true;
      state.connStatus  = 'connected';
      state.navStack    = [buildMainMenu()];
      state.view        = 'menu';
      applyTheme(); render();
      return;
    } catch (_) { lastErr = `Could not reach ${url}`; }
  }
  throw new Error(lastErr);
}

// ═══════════════════════════════════════════
//  SETUP RENDER
// ═══════════════════════════════════════════
// ── Branding banner — shown on login screen only ──
const DALEK_BANNER = `<a class="dalek-banner" href="https://dalek.coffee" target="_blank" rel="noopener noreferrer">
  <span>By Dalek ☕🫰</span>
</a>`;

function renderSetup(screen) {
  applySetupBranding();
  stopPlexPoll();
  const isPlex = state.serverType === 'plex';
  const brand  = BRANDS[state.serverType][state.darkMode ? 'dark' : 'light'];

  screen.innerHTML = `
    ${DALEK_BANNER}
    <div class="setup-screen">
      <h2>${isPlex ? '🟠 PlexPod' : '🟣 JellyPod'}</h2>
      <div class="server-toggle">
        <button class="srv-btn ${isPlex ? 'active' : ''}" id="srv-plex">Plex</button>
        <button class="srv-btn ${!isPlex ? 'active' : ''}" id="srv-jf">Jellyfin</button>
      </div>

      ${isPlex ? `
        <!-- ── Plex: one-tap OAuth only ── -->
        <button class="setup-btn" id="plex-oauth-btn"
          style="background:${brand.accent};box-shadow:0 2px 6px ${brand.shadow}">
          Sign in with Plex
        </button>
      ` : `
        <!-- ── Jellyfin: URL + API key ── -->
        <input id="srv-url"    type="url"  placeholder="http://192.168.1.x:8096" value="${esc(state.jellyfinUrl)}" autocomplete="url" />
        <input id="srv-secret" type="text" placeholder="API Key" value="${esc(state.jellyfinApiKey)}" autocomplete="off" spellcheck="false" />
        <p class="su-hint">API Key: Dashboard → API Keys → +</p>
        <button class="setup-btn" id="connect-btn"
          style="background:${brand.accent};box-shadow:0 2px 6px ${brand.shadow}">Connect</button>
      `}
      <p id="setup-error" class="setup-error" style="display:none"></p>
    </div>
  `;

  // Server toggle
  document.getElementById('srv-plex').addEventListener('click', () => {
    if (state.serverType === 'plex') return;
    state.serverType = 'plex'; render();
  });
  document.getElementById('srv-jf').addEventListener('click', () => {
    if (state.serverType === 'jellyfin') return;
    state.serverType = 'jellyfin'; render();
  });

  const showErr = msg => {
    state.connStatus = 'disconnected';
    state.view = 'setup'; render();
    setTimeout(() => {
      const el = document.getElementById('setup-error');
      if (el) { el.textContent = msg; el.style.display = 'block'; }
    }, 30);
  };

  if (isPlex) {
    document.getElementById('plex-oauth-btn').addEventListener('click', startPlexOAuth);

  } else {
    // Jellyfin: URL + API key
    document.getElementById('connect-btn').addEventListener('click', async () => {
      // Rate limit: require 5 s between failed attempts
      if (Date.now() - _lastConnectFailTs < 5000) { showErr('Please wait before trying again.'); return; }
      const url    = document.getElementById('srv-url').value.trim().replace(/\/$/, '');
      const secret = document.getElementById('srv-secret').value.trim();
      if (!url || !secret) { showErr('Fill in both fields.'); return; }
      if (!isValidUrl(url)) { showErr('URL must start with http:// or https://'); return; }
      showLoading('Connecting...');
      state.connStatus = 'connecting';
      try {
        state.jellyfinUrl    = url;
        state.jellyfinApiKey = secret;
        const usersRes = await fetchWithTimeout(
          `${url}/Users`,
          { headers: { Accept: 'application/json', Authorization: `MediaBrowser Token="${secret}"` } },
          8000
        );
        if (!usersRes.ok) throw new Error(`HTTP ${usersRes.status}`);
        const users = await safeJson(usersRes);
        if (!users.length) throw new Error('No users found');
        // Validate API key format before storing — defense in depth
        if (!/^[a-zA-Z0-9_-]+$/.test(secret)) throw new Error('API key contains unexpected characters.');
        state.jellyfinUserId = users[0].Id;
        localStorage.setItem('jellyfinUrl',    url);
        localStorage.setItem('jellyfinApiKey', secret);
        localStorage.setItem('jellyfinUserId', state.jellyfinUserId);
        localStorage.setItem('serverType', 'jellyfin');
        state.connected = true; state.connStatus = 'connected';
        state.navStack = [buildMainMenu()]; state.view = 'menu';
        applyTheme(); render();
      } catch (e) { _lastConnectFailTs = Date.now(); showErr(e.message || 'Could not connect. Check URL and API key.'); }
    });

    ['srv-url','srv-secret'].forEach(id =>
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('connect-btn').click();
      })
    );
  }
}

function renderMenu(screen) {
  if (!currentMenu()) state.navStack = [buildMainMenu()];
  const m = currentMenu();
  const VISIBLE = 6;
  const total = m.items.length;
  let start = Math.max(0, m.selectedIndex - 2);
  if (start + VISIBLE > total) start = Math.max(0, total - VISIBLE);
  const visible = m.items.slice(start, start + VISIBLE);

  const rows = visible.map((item, i) => {
    const absIdx = start + i;
    const sel = absIdx === m.selectedIndex;
    const arrow = item.arrow ? '<span class="arrow">›</span>' : '';
    const sub = item.sublabel ? `<span style="font-size:9px;opacity:0.65;margin-left:4px">${esc(item.sublabel)}</span>` : '';
    return `<div class="menu-item ${sel ? 'selected' : ''}" data-idx="${absIdx}">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(item.label)}${sub}</span>${arrow}
    </div>`;
  }).join('');

  const npBar = state.currentTrack
    ? `<div style="background:rgba(0,0,0,0.12);padding:2px 8px;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.75">♪ ${esc(state.currentTrack.title)}</div>`
    : '';

  screen.innerHTML = `
    <div class="menu-screen">
      <div class="menu-titlebar">
        <div class="title">${esc(m.title)}</div>
        <div class="conn-status ${state.connStatus}">${
          state.connStatus === 'connected'   ? 'Connected'   :
          state.connStatus === 'connecting'  ? 'Connecting…' : 'Disconnected'
        }</div>
      </div>
      ${npBar}
      <div class="menu-list">${rows}</div>
    </div>`;

  screen.querySelectorAll('.menu-item').forEach(el =>
    el.addEventListener('click', () => { m.selectedIndex = parseInt(el.dataset.idx, 10); selectItem(); })
  );
}

function renderNowPlaying(screen) {
  const el = screen || document.getElementById('screen');
  if (!state.currentTrack) return;
  const t = state.currentTrack;
  const pct = state.duration > 0 ? (state.progress / state.duration) * 100 : 0;
  const playIcon = state.playing
    ? '<svg width="0.65em" height="0.8em" viewBox="0 0 7 9" style="display:inline-block;vertical-align:-0.05em"><rect x="0" y="0" width="2.5" height="9" rx="0.4" fill="currentColor"/><rect x="4.5" y="0" width="2.5" height="9" rx="0.4" fill="currentColor"/></svg>'
    : '▶';

  // ── Lightweight tick: only update progress if full structure already exists ──
  if (!screen && el.querySelector('.nowplaying-screen')) {
    const fill  = el.querySelector('.np-progress-fill');
    const times = el.querySelector('.np-times');
    const play  = el.querySelector('#np-play');
    if (fill)  fill.style.width  = pct + '%';
    if (times) times.innerHTML   =
      `<span>${formatTime(state.progress)}</span><span>-${formatTime(state.duration - state.progress)}</span>`;
    if (play)  play.innerHTML    = playIcon;
    return;
  }

  // ── Full build (first render, track change, or explicit screen arg) ──
  const thumb = getThumb(t, 160);
  el.innerHTML = `
    <div class="nowplaying-screen">
      <div class="np-titlebar"><div class="title">Now Playing</div></div>
      <div class="np-art">
        ${thumb ? `<img id="np-thumb" src="${esc(thumb)}" referrerpolicy="no-referrer" />` : '<div class="no-art">♪</div>'}
      </div>
      <div class="np-info">
        <div class="np-song marquee"><span>${esc(t.title)}</span></div>
        <div class="np-artist marquee"><span>${esc(t.grandparentTitle || '')}</span></div>
        <div class="np-album">${esc(t.parentTitle || '')}</div>
      </div>
      <div class="np-progress-area">
        <div class="np-progress-bar" id="np-bar">
          <div class="np-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="np-times">
          <span>${formatTime(state.progress)}</span>
          <span>-${formatTime(state.duration - state.progress)}</span>
        </div>
      </div>
      <div class="np-controls">
        <span class="np-ctrl-btn" id="np-prev">⏮</span>
        <span class="np-ctrl-btn play-pause" id="np-play">${playIcon}</span>
        <span class="np-ctrl-btn" id="np-next">⏭</span>
      </div>
      <div id="scrub-indicator">◁◁ &nbsp; SCRUBBING &nbsp; ▷▷</div>
    </div>`;

  el.querySelector('#np-play').addEventListener('click', togglePlay);
  el.querySelector('#np-prev').addEventListener('click', prevTrack);
  el.querySelector('#np-next').addEventListener('click', nextTrack);
  const thumbImg = el.querySelector('#np-thumb');
  if (thumbImg) {
    thumbImg.addEventListener('error', () => {
      const art = thumbImg.parentElement;
      if (art) art.innerHTML = '<div class="no-art">♪</div>';
    }, { once: true });
  }
  const bar = el.querySelector('#np-bar');
  if (bar) bar.addEventListener('click', e => {
    const rect = bar.getBoundingClientRect();
    state.audio.currentTime = ((e.clientX - rect.left) / rect.width) * state.duration;
  });

  // Fix #6 - defer marquee check until after layout
  requestAnimationFrame(() => {
    el.querySelectorAll('.marquee').forEach(m => {
      if (m.scrollWidth > m.clientWidth + 4) m.classList.add('active');
    });
  });
}

// ═══════════════════════════════════════════
//  HAPTICS
// ═══════════════════════════════════════════
const vibe = (p) => { try { navigator.vibrate?.(p); } catch(_) {} };
const HAPTIC = {
  tick:     2,          // menu step — single short pulse
  select:   [6, 20, 6], // SELECT press
  back:     [3, 15, 3], // MENU / back
  boundary: [10,25,10], // hit list edge
  scrubTick: 1,         // scrub position tick
};

// ═══════════════════════════════════════════
//  CLICKWHEEL ENGINE
// ═══════════════════════════════════════════
// Tuning constants
const DEG_PER_MENU_TICK = 16;   // ~22 ticks per full revolution (real iPod ≈ 20)
const SCRUB_DEG_PER_SEC = 18;   // 18° rotation = 1 second of scrub
const SCRUB_EXIT_MS     = 1400; // auto-exit scrub after this much idle time
const MOMENTUM_FRICTION  = 0.86; // velocity decay per frame
const MOMENTUM_MIN_VEL   = 25;   // deg/s below which momentum stops
const RIM_INNER_RATIO    = 0.40; // fraction of wheel radius = inner dead zone (center button)

const cwEl = document.getElementById('clickwheel');

const wheel = {
  active:      false,
  prevAngle:   0,
  accum:       0,       // accumulated degrees toward next menu tick
  velBuf:      [],      // [{angle, ts}] for velocity estimation
  momentumRaf: null,
  scrubMode:   false,
  scrubTimer:  null,
  scrubLive:   0,       // live scrub offset in seconds (applied on release)
  lastScrubHapticAt: 0, // to throttle scrub haptic ticks
};

/** Get angle in degrees from wheel center for a pointer/touch event */
function getAngle(e, rect) {
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;
  const px = e.touches ? e.touches[0].clientX : e.clientX;
  const py = e.touches ? e.touches[0].clientY : e.clientY;
  return Math.atan2(py - cy, px - cx) * 180 / Math.PI;
}

/** Wrap angle delta into [-180, 180] */
function angleDiff(a, b) {
  let d = a - b;
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** True if pointer is on the rotating rim (not the center button zone) */
function isOnRim(e, rect) {
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;
  const px = e.touches ? e.touches[0].clientX : e.clientX;
  const py = e.touches ? e.touches[0].clientY : e.clientY;
  const d = Math.hypot(px - cx, py - cy);
  const r = rect.width / 2;
  return d > r * RIM_INNER_RATIO && d <= r * 1.08;
}

function cancelMomentum() {
  if (wheel.momentumRaf) { cancelAnimationFrame(wheel.momentumRaf); wheel.momentumRaf = null; }
}

function startMomentum(initialVelDegPerSec) {
  cancelMomentum();
  let vel = initialVelDegPerSec;
  function frame() {
    if (Math.abs(vel) < MOMENTUM_MIN_VEL || state.view !== 'menu') return;
    wheel.accum += vel / 60; // approx deg per frame at 60fps
    const ticks = Math.trunc(wheel.accum / DEG_PER_MENU_TICK);
    if (ticks !== 0) {
      wheel.accum -= ticks * DEG_PER_MENU_TICK;
      const m = currentMenu();
      if (!m) return;
      const prev = m.selectedIndex;
      m.selectedIndex = Math.max(0, Math.min(m.items.length - 1, m.selectedIndex + ticks));
      if (m.selectedIndex !== prev) { vibe(HAPTIC.tick); render(); }
      else { return; } // hit boundary — stop momentum
    }
    vel *= MOMENTUM_FRICTION;
    wheel.momentumRaf = requestAnimationFrame(frame);
  }
  wheel.momentumRaf = requestAnimationFrame(frame);
}

// ── Scrub mode ──
function enterScrubMode() {
  if (wheel.scrubMode) return;
  wheel.scrubMode   = true;
  wheel.scrubLive   = 0;
  wheel.lastScrubHapticAt = state.audio.currentTime;
  const el = document.getElementById('scrub-indicator');
  if (el) el.style.opacity = '1';
}

function commitScrub() {
  if (!wheel.scrubMode) return;
  if (state.duration > 0) {
    state.audio.currentTime = Math.max(0, Math.min(state.duration,
      state.audio.currentTime + wheel.scrubLive));
  }
  wheel.scrubLive = 0;
  wheel.scrubMode = false;
  clearTimeout(wheel.scrubTimer);
  const el = document.getElementById('scrub-indicator');
  if (el) el.style.opacity = '0';
}

// ── Pointer handlers ──
function onRimStart(e) {
  const rect = cwEl.getBoundingClientRect();
  if (!isOnRim(e, rect)) return;
  e.preventDefault();
  cancelMomentum();
  wheel.active    = true;
  wheel.prevAngle = getAngle(e, rect);
  wheel.accum     = 0;
  wheel.velBuf    = [{ angle: wheel.prevAngle, ts: performance.now() }];
  cwEl.classList.add('spinning');
}

function onRimMove(e) {
  if (!wheel.active) return;
  e.preventDefault();
  const rect  = cwEl.getBoundingClientRect();
  const angle = getAngle(e, rect);
  const delta = angleDiff(angle, wheel.prevAngle);
  wheel.prevAngle = angle;
  const now = performance.now();
  wheel.velBuf.push({ angle, ts: now });
  wheel.velBuf = wheel.velBuf.filter(v => now - v.ts < 100);

  if (state.view === 'menu') {
    wheel.accum += delta;
    const ticks = Math.trunc(wheel.accum / DEG_PER_MENU_TICK);
    if (ticks !== 0) {
      wheel.accum -= ticks * DEG_PER_MENU_TICK;
      const m = currentMenu();
      if (!m) return;
      const prev = m.selectedIndex;
      m.selectedIndex = Math.max(0, Math.min(m.items.length - 1, m.selectedIndex + ticks));
      if (m.selectedIndex !== prev) { vibe(HAPTIC.tick); render(); }
      else { vibe(HAPTIC.boundary); }
    }

  } else if (state.view === 'nowplaying' && state.duration > 0) {
    enterScrubMode();
    clearTimeout(wheel.scrubTimer);

    // Accumulate scrub offset
    const scrubSecs = delta / SCRUB_DEG_PER_SEC;
    wheel.scrubLive += scrubSecs;

    // Update progress display live without seeking (seek happens on release)
    const preview = Math.max(0, Math.min(state.duration,
      state.audio.currentTime + wheel.scrubLive));
    state.progress = preview;
    // Update progress bar and times without full re-render
    const fill  = document.querySelector('.np-progress-fill');
    const times = document.querySelector('.np-times');
    if (fill)  fill.style.width  = ((preview / state.duration) * 100) + '%';
    if (times) times.innerHTML   =
      `<span>${formatTime(preview)}</span><span>-${formatTime(state.duration - preview)}</span>`;

    // Haptic tick every 5 seconds of scrubbed time
    if (Math.abs(preview - wheel.lastScrubHapticAt) >= 5) {
      vibe(HAPTIC.scrubTick);
      wheel.lastScrubHapticAt = preview;
    }

    wheel.scrubTimer = setTimeout(commitScrub, SCRUB_EXIT_MS);
  }
}

function onRimEnd(e) {
  if (!wheel.active) return;
  wheel.active = false;
  cwEl.classList.remove('spinning');

  if (wheel.scrubMode) { commitScrub(); return; }

  // Momentum for menu — compute angular velocity from recent buffer
  if (state.view === 'menu' && wheel.velBuf.length >= 2) {
    const f = wheel.velBuf[0];
    const l = wheel.velBuf[wheel.velBuf.length - 1];
    const dt = (l.ts - f.ts) / 1000;
    if (dt > 0.01) {
      const vel = angleDiff(l.angle, f.angle) / dt;
      if (Math.abs(vel) > MOMENTUM_MIN_VEL * 2) startMomentum(vel);
    }
  }
}

// Attach touch + mouse
cwEl.addEventListener('touchstart',  onRimStart, { passive: false });
cwEl.addEventListener('touchmove',   onRimMove,  { passive: false });
cwEl.addEventListener('touchend',    onRimEnd,   { passive: false });
cwEl.addEventListener('touchcancel', onRimEnd,   { passive: false });
cwEl.addEventListener('mousedown',   onRimStart);
document.addEventListener('mousemove', e => { if (wheel.active) onRimMove(e); });
document.addEventListener('mouseup',   e => { if (wheel.active) onRimEnd(e); });

// Desktop scroll wheel (also works in Now Playing as scrub)
let wheelThrottle = false;
cwEl.addEventListener('wheel', e => {
  e.preventDefault();
  if (wheelThrottle) return;
  wheelThrottle = true; setTimeout(() => wheelThrottle = false, 110);
  if (state.view === 'menu') {
    scrollMenu(e.deltaY > 0 ? 1 : -1);
    vibe(HAPTIC.tick);
  } else if (state.view === 'nowplaying' && state.duration > 0) {
    const skip = e.deltaY > 0 ? 5 : -5;
    state.audio.currentTime = Math.max(0, Math.min(state.duration, state.audio.currentTime + skip));
    vibe(HAPTIC.scrubTick);
  }
}, { passive: false });

// ── Zone buttons (cardinal quadrants) ──
// addZoneTap: direct touchstart/touchend handlers so that e.preventDefault()
// on the rim's touchstart doesn't swallow the tap. Click handler kept for desktop.
function addZoneTap(id, action) {
  const el = document.getElementById(id);
  let ts = null;
  el.addEventListener('touchstart', e => {
    e.stopPropagation(); // prevent onRimStart from seeing this touch
    ts = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!ts) return;
    const moved = Math.hypot(
      e.changedTouches[0].clientX - ts.x,
      e.changedTouches[0].clientY - ts.y
    );
    ts = null;
    if (moved < 12) { e.preventDefault(); action(); }
  }, { passive: false });
  el.addEventListener('click', action);
}

addZoneTap('zone-top',    () => { vibe(HAPTIC.back); goBack(); });
addZoneTap('zone-bottom', () => { if (state.currentTrack) { vibe(HAPTIC.select); togglePlay(); } });
addZoneTap('zone-left',   () => { vibe(HAPTIC.tick); if (state.view === 'nowplaying') prevTrack();  else scrollMenu(-1); });
addZoneTap('zone-right',  () => { vibe(HAPTIC.tick); if (state.view === 'nowplaying') nextTrack(); else scrollMenu(1);  });
document.getElementById('wheel-center').addEventListener('click', () => {
  if (state.view === 'menu')           { vibe(HAPTIC.select); selectItem(); }
  else if (state.view === 'nowplaying') { vibe(HAPTIC.select); togglePlay(); }
  else if (state.view === 'setup') {
    // Trigger whichever primary action button is visible
    const btn = document.getElementById('plex-oauth-btn')
             || document.getElementById('connect-btn')
             || document.getElementById('plex-cancel-btn');
    btn?.click();
  }
});

document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  switch(e.key) {
    case 'ArrowUp':    scrollMenu(-1); break;
    case 'ArrowDown':  scrollMenu(1); break;
    case 'ArrowLeft':  if (state.view === 'nowplaying') prevTrack(); break;
    case 'ArrowRight': if (state.view === 'nowplaying') nextTrack(); break;
    case 'Enter':      if (state.view === 'menu') selectItem(); else if (state.view === 'nowplaying') togglePlay(); break;
    case 'Escape': case 'Backspace': goBack(); break;
    case ' ':          if (state.currentTrack) { e.preventDefault(); togglePlay(); } break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'd': case 'D': toggleDarkMode(); break;
  }
});

// ═══════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════
applyDarkMode();      // sets dark-mode class + calls applySetupBranding
initThemePanel();     // wires up hue rings, presets, reset
autoScale();          // scale iPod to fill viewport immediately

const hasPlex     = state.plexUrl && state.plexToken;
const hasJellyfin = state.jellyfinUrl && state.jellyfinApiKey && state.jellyfinUserId;

if (state.serverType === 'plex' && hasPlex) {
  showLoading('Connecting...');
  plexFetch('/').then(() => {
    state.connected = true; state.connStatus = 'connected';
    state.navStack = [buildMainMenu()];
    state.view = 'menu';
    applyTheme(); render();
  }).catch(() => { state.connStatus = 'disconnected'; state.view = 'setup'; render(); });
} else if (state.serverType === 'jellyfin' && hasJellyfin) {
  showLoading('Connecting...');
  jellyfinFetch('/System/Info/Public').then(() => {
    state.connected = true; state.connStatus = 'connected';
    state.navStack = [buildMainMenu()];
    state.view = 'menu';
    applyTheme(); render();
  }).catch(() => { state.connStatus = 'disconnected'; state.view = 'setup'; render(); });
} else {
  render();
}