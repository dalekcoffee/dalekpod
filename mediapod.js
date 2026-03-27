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

// serverType is always 'plex' (Jellyfin removed)
const _serverType = 'plex';

// Read darkMode once to avoid double getItem
const _rawDarkMode = localStorage.getItem('darkMode');
const _darkMode    = _rawDarkMode !== null ? _rawDarkMode === 'true' : true;

// ── Validate stored URLs/tokens before trusting them ──
const _storedPlexUrl    = localStorage.getItem('plexUrl')   || '';
const _storedPlexToken  = localStorage.getItem('plexToken') || '';
const _storedLbToken    = localStorage.getItem('lbToken')   || '';

const _tokenRe = /^[a-zA-Z0-9_-]+$/;
const _uuidRe  = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const state = {
  serverType: _serverType,
  plexUrl:    isValidUrl(_storedPlexUrl) ? _storedPlexUrl : '',
  plexToken:  _tokenRe.test(_storedPlexToken) ? _storedPlexToken : '',
  plexPinId:  null,
  plexPinPoll: null,
  lbToken:    _uuidRe.test(_storedLbToken) ? _storedLbToken : '',
  connected:   false,
  connStatus:  'disconnected', // 'connecting' | 'connected' | 'disconnected'
  coverFlowAlbums: [],
  coverFlowIndex: 0,
  coverFlowSectionKey: '',
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
  fullscreen:      false,
  hapticStrength:  localStorage.getItem('hapticStrength') || 'medium',
  repeat:          localStorage.getItem('repeat')    || 'off', // 'off' | 'all' | 'one'
  shuffle:         localStorage.getItem('shuffle')   === 'true',
  crossfade:       clampInt(localStorage.getItem('crossfade'), 0, 10, 0), // seconds
  sleepTimerId:    null,
  sleepMins:       0,
  sleepEndsAt:     null,
  theme: {
    uiHue:  clampInt(localStorage.getItem('themeUiHue'),  0, 359, 0),
    podHue: clampInt(localStorage.getItem('themePodHue'), 0, 359, 0),
    podSat: clampInt(localStorage.getItem('themePodSat'), 0, 55,  0),
  },
};

const DEFAULT_THEME = { uiHue: 0, podHue: 0, podSat: 0 };

// Rate-limit: timestamp of last failed Manual connection attempt
let _lastConnectFailTs = 0;

// CoverFlow spring animation state
const cfAnim = { offset: 0, raf: null };

const UI_PRESETS = [
  { hue: 215, label: 'Classic',  color: 'hsl(215,65%,45%)' },
  { hue: 38,  label: 'Plex',     color: '#E5A00D' },

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

/** Called by plexFetch on 401 */
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
};

function applySetupBranding() {
  const brandKey = BRANDS[state.serverType] ? state.serverType : 'plex';
  const b = BRANDS[brandKey][state.darkMode ? 'dark' : 'light'];
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
    rs.setProperty('--native-art-size',   Math.min(Math.round(vw * 0.52), 240) + 'px');
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
    state.theme.podSat = Math.max(0, Math.min(55, parseInt(satSlider.value, 10)));
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

// CORS proxy — Plex servers only allow origin https://app.plex.tv.
// On desktop browsers this blocks all fetch() calls from our custom domain.
// A lightweight Cloudflare Worker (see cloudflare-worker.js) relays requests
// and rewrites the CORS header. Mobile PWAs work without it (same-origin or
// relaxed CORS in standalone mode). Set to '' to disable.
const PLEX_PROXY_ORIGIN = 'https://plex-proxy.dalek.coffee';

// True when the proxy is needed (desktop browser, not localhost dev)
const _needsProxy = !window.matchMedia('(pointer: coarse)').matches
  && PLEX_PROXY_ORIGIN
  && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';

function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

/**
 * Fetch via CORS proxy when needed. Sends the real URL in X-Proxy-URL header
 * and targets the proxy origin instead. Falls through to direct fetch on mobile
 * or when no proxy is configured.
 */
function proxiedFetch(url, opts = {}, ms = 8000) {
  if (_needsProxy) {
    const proxyUrl = `${PLEX_PROXY_ORIGIN}/`;
    const headers = { ...(opts.headers || {}), 'X-Proxy-URL': url };
    return fetchWithTimeout(proxyUrl, { ...opts, headers }, ms);
  }
  return fetchWithTimeout(url, opts, ms);
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
  const res = await proxiedFetch(url, {
    headers: { Accept: 'application/json', 'X-Plex-Token': state.plexToken }
  });
  if (res.status === 401) { handleSessionExpiry(); throw new Error('Session expired. Please sign in again.'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return safeJson(res);
}

// Generic placeholder for items without artwork — inline SVG, no external dep
const PLACEHOLDER_THUMB = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
  '<rect width="80" height="80" rx="4" fill="#2a2a2e"/>' +
  '<text x="40" y="53" text-anchor="middle" font-size="38" font-family="system-ui,sans-serif" fill="#4a4a5e">♪</text>' +
  '</svg>'
)}`;

function plexThumb(thumb, size = 80) {
  if (!thumb) return null;
  // Token must be in URL — browser <img> cannot send custom headers
  return `${state.plexUrl}/photo/:/transcode?width=${size}&height=${size}&url=${encodeURIComponent(thumb)}&X-Plex-Token=${encodeURIComponent(state.plexToken)}`;
}

function thumbOrPlaceholder(thumb, size = 80) {
  return plexThumb(thumb, size) || PLACEHOLDER_THUMB;
}

function plexStream(key) {
  // Token must be in URL — <audio> cannot send custom headers
  return `${state.plexUrl}${key}?X-Plex-Token=${encodeURIComponent(state.plexToken)}`;
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
let _xfRaf = null; // crossfade animation frame

state.audio.addEventListener('timeupdate', () => {
  state.progress = state.audio.currentTime;
  state.duration = state.audio.duration || 0;
  // Crossfade fade-out approaching end of track
  if (state.crossfade > 0 && state.duration > 0 && !_xfRaf) {
    const remaining = state.duration - state.progress;
    if (remaining > 0 && remaining <= state.crossfade) {
      state.audio.volume = Math.max(0, remaining / state.crossfade);
    } else if (state.audio.volume < 1) {
      state.audio.volume = 1;
    }
  }
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

// ── ListenBrainz scrobbling ──
let _lbTimer = null;

async function lbSubmit(listenType, track, listenedAt) {
  if (!state.lbToken) return;
  const body = {
    listen_type: listenType,
    payload: [{
      ...(listenedAt != null ? { listened_at: listenedAt } : {}),
      track_metadata: {
        artist_name:  track.grandparentTitle || '',
        track_name:   track.title            || '',
        release_name: track.parentTitle      || ''
      }
    }]
  };
  try {
    await fetch('https://api.listenbrainz.org/1/submit-listens', {
      method: 'POST',
      headers: { 'Authorization': `Token ${state.lbToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (_) {} // silent fail — never interrupt playback
}

function scrobbleStart(track) {
  clearTimeout(_lbTimer);
  if (!state.lbToken) return;
  const listenedAt = Math.floor(Date.now() / 1000);
  lbSubmit('playing_now', track);
  // Schedule listen submit at 50% of duration or 4 minutes, whichever is sooner.
  // Poll until duration is known (loadedmetadata may not have fired yet).
  const arm = () => {
    const dur = state.duration;
    if (dur > 0) {
      _lbTimer = setTimeout(() => lbSubmit('single', track, listenedAt),
        Math.min(dur * 0.5, 240) * 1000);
    } else {
      _lbTimer = setTimeout(arm, 300);
    }
  };
  arm();
}

function playTrack(track, queue, index) {
  clearTimeout(_lbTimer); // cancel any pending scrobble for the previous track
  state.currentTrack = track;
  state.queue = queue; state.queueIndex = index;
  state.audio.src = getStreamUrl(track);
  state.audio.play().catch(e => {
    // Autoplay blocked — update UI to paused so user can tap play
    state.playing = false;
    if (state.view === 'nowplaying') renderNowPlaying();
  });
  // Crossfade fade-in: start volume at 0 and ramp up
  if (_xfRaf) { cancelAnimationFrame(_xfRaf); _xfRaf = null; }
  if (state.crossfade > 0) {
    state.audio.volume = 0;
    const fadeMs = state.crossfade * 1000;
    const startMs = performance.now();
    function _fadeIn() {
      const t = Math.min((performance.now() - startMs) / fadeMs, 1);
      state.audio.volume = t;
      if (t < 1) _xfRaf = requestAnimationFrame(_fadeIn); else _xfRaf = null;
    }
    _xfRaf = requestAnimationFrame(_fadeIn);
  } else {
    state.audio.volume = 1;
  }
  state.view = 'nowplaying';
  updateMediaSession(track);
  scrobbleStart(track);
  render();
}

function togglePlay() {
  if (state.audio.paused) state.audio.play().catch(() => {}); else state.audio.pause();
}

function nextTrack() {
  if (!state.queue.length) return;
  if (state.repeat === 'one') { state.audio.currentTime = 0; state.audio.play().catch(() => {}); return; }
  let next;
  if (state.shuffle) {
    next = Math.floor(Math.random() * state.queue.length);
  } else {
    next = state.queueIndex + 1;
    if (next >= state.queue.length) {
      if (state.repeat === 'all') next = 0;
      else { state.audio.volume = 1; return; } // end of queue
    }
  }
  state.queueIndex = next;
  playTrack(state.queue[next], state.queue, next);
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

function playShuffled(tracks) {
  if (!tracks.length) return;
  const shuffled = [...tracks].sort(() => Math.random() - 0.5);
  playTrack(shuffled[0], shuffled, 0);
}

function toggleRepeat() {
  const cycle = { off: 'all', all: 'one', one: 'off' };
  state.repeat = cycle[state.repeat] || 'off';
  localStorage.setItem('repeat', state.repeat);
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  localStorage.setItem('shuffle', state.shuffle);
}

// ── Sleep timer ──────────────────────────────────────────────────────────────
const SLEEP_OPTIONS = [0, 15, 30, 60, 90];
function sleepLabel() {
  return state.sleepMins ? `💤 Sleep: ${state.sleepMins}m` : '💤 Sleep Timer: Off';
}
function sleepStatusHtml() {
  if (!state.sleepEndsAt) return '';
  const mins = Math.max(1, Math.ceil((state.sleepEndsAt - Date.now()) / 60000));
  return ` <span class="sleep-status-badge">💤 ${mins}m</span>`;
}
function cycleSleep() {
  if (state.sleepTimerId) { clearTimeout(state.sleepTimerId); state.sleepTimerId = null; }
  const idx = SLEEP_OPTIONS.indexOf(state.sleepMins);
  state.sleepMins  = SLEEP_OPTIONS[(idx + 1) % SLEEP_OPTIONS.length];
  state.sleepEndsAt = state.sleepMins ? Date.now() + state.sleepMins * 60000 : null;
  if (state.sleepMins) {
    state.sleepTimerId = setTimeout(() => {
      state.audio.pause();
      state.sleepMins = 0; state.sleepEndsAt = null; state.sleepTimerId = null;
    }, state.sleepMins * 60000);
  }
  const m = currentMenu();
  const item = m?.items.find(i => i._id === 'sleep');
  if (item) { item.label = sleepLabel(); render(); }
}

// ── Crossfade ─────────────────────────────────────────────────────────────────
const CROSSFADE_OPTIONS = [0, 2, 5, 10];
function crossfadeLabel() {
  return state.crossfade === 0 ? '🎵 Crossfade: Off' : `🎵 Crossfade: ${state.crossfade}s`;
}
function cycleCrossfade() {
  const idx = CROSSFADE_OPTIONS.indexOf(state.crossfade);
  state.crossfade = CROSSFADE_OPTIONS[(idx + 1) % CROSSFADE_OPTIONS.length];
  localStorage.setItem('crossfade', state.crossfade);
  if (state.crossfade === 0) { if (_xfRaf) { cancelAnimationFrame(_xfRaf); _xfRaf = null; } state.audio.volume = 1; }
  const m = currentMenu();
  const item = m?.items.find(i => i._id === 'crossfade');
  if (item) { item.label = crossfadeLabel(); render(); }
}

function goBack() {
  if (state.view === 'nowplaying') { state.view = 'menu'; render(); return; }
  if (state.view === 'lbsetup')    { state.view = 'menu'; render(); return; }
  if (state.view === 'coverflow')  { if (cfAnim.raf) { cancelAnimationFrame(cfAnim.raf); cfAnim.raf = null; } state.returnToCoverFlow = false; state.view = 'menu'; render(); return; }
  if (state.navStack.length > 1) {
    state.navStack.pop();
    // If we just returned to the root menu and came from CoverFlow, go straight back there
    if (state.navStack.length === 1 && state.returnToCoverFlow) {
      state.returnToCoverFlow = false;
      state.view = 'coverflow';
    }
    render(); return;
  }
  if (state.returnToCoverFlow) { state.returnToCoverFlow = false; state.view = 'coverflow'; render(); }
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
  return {
    title: 'MediaPod', selectedIndex: 0,
    items: [
      { label: 'Cover Flow',  arrow: true, action: openCoverFlow },
      { label: 'Music',       arrow: true, action: openMusicMenu },
      { label: 'Now Playing', arrow: true, action: () => { if (state.currentTrack) { state.view = 'nowplaying'; render(); } } },
      { label: 'Settings',   arrow: true, action: openSettings },
    ]
  };
}

async function openMusicMenu() {
  showLoading('Loading...');
  try {
    const data = await plexFetch('/library/sections');
    const musicSections = (data.MediaContainer.Directory || []).filter(s => s.type === 'artist');
    if (!musicSections.length) throw new Error('No music libraries found');
    const sectionKey = musicSections[0].key;
    pushMenu('Music', [
      { label: '⇄ Shuffle All', arrow: false, action: async () => {
          showLoading('Loading tracks…');
          try {
            const d = await plexFetch(`/library/sections/${sectionKey}/all?type=10`);
            playShuffled(d.MediaContainer.Metadata || []);
          } catch(e) { showMenuError(e.message); }
      }},
      { label: 'Artists',   arrow: true, action: () => openArtistList(sectionKey, 'Artists') },
      { label: 'Albums',    arrow: true, action: () => openAlbumList(sectionKey, 'Albums') },
      { label: 'Songs',     arrow: true, action: () => openSongList(sectionKey, 'Songs') },
      { label: 'Playlists', arrow: true, action: openPlaylists },
    ]);
  } catch(e) { showMenuError(e.message); }
}

const HAPTIC_LEVELS = ['off', 'light', 'medium', 'strong'];
function hapticLabel() {
  const cap = s => s[0].toUpperCase() + s.slice(1);
  return `📳 Haptics: ${cap(state.hapticStrength)}`;
}
function cycleHaptic() {
  const idx = HAPTIC_LEVELS.indexOf(state.hapticStrength);
  state.hapticStrength = HAPTIC_LEVELS[(idx + 1) % HAPTIC_LEVELS.length];
  localStorage.setItem('hapticStrength', state.hapticStrength);
  vibe(HAPTIC.tick); // preview the new level
  const m = currentMenu();
  const item = m?.items.find(i => i._id === 'haptic');
  if (item) { item.label = hapticLabel(); render(); }
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
      { _id: 'lb', label: state.lbToken ? '♫ Scrobbling: On' : '♫ Scrobbling: Off', arrow: true, action: () => {
          state.view = 'lbsetup'; render();
      }},
      { _id: 'haptic',     label: hapticLabel(),     arrow: false, action: cycleHaptic },
      { _id: 'sleep',      label: sleepLabel(),      arrow: false, action: cycleSleep },
      { _id: 'crossfade',  label: crossfadeLabel(),  arrow: false, action: cycleCrossfade },
      { _id: 'fullscreen', label: state.fullscreen ? '✕ Exit Fullscreen' : '⛶ Fullscreen', arrow: false, action: () => {
          toggleFullscreen();
      }},
      { label: 'Disconnect', arrow: false, action: () => {
          state.audio.pause();
          stopPlexPoll();
          state.plexUrl = ''; state.plexToken = '';
          localStorage.removeItem('plexUrl'); localStorage.removeItem('plexToken');
          localStorage.removeItem('serverType');
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
    (d.MediaContainer.Metadata || []).map(a => ({ label: esc(a.title), thumb: thumbOrPlaceholder(a.thumb, 80), arrow: true, action: () => openArtistAlbums(a.ratingKey, a.title) })), title);
}

async function openArtistAlbums(key, name) {
  await apiMenu('Loading...', () => plexFetch(`/library/metadata/${key}/children`), d => {
    const albums = (d.MediaContainer.Metadata || []).map(a => ({ label: esc(a.title), thumb: thumbOrPlaceholder(a.thumb, 80), arrow: true, action: () => openAlbumTracks(a.ratingKey, a.title) }));
    return [
      { label: '⇄ Shuffle Artist', arrow: false, action: async () => {
          showLoading('Loading tracks…');
          try {
            const d = await plexFetch(`/library/metadata/${key}/allLeaves`);
            playShuffled(d.MediaContainer.Metadata || []);
          } catch(e) { showMenuError(e.message); }
      }},
      ...albums
    ];
  }, name);
}

async function openAlbumList(sectionKey, title) {
  await apiMenu('Loading albums...', () => plexFetch(`/library/sections/${sectionKey}/all?type=9`), d =>
    (d.MediaContainer.Metadata || []).map(a => ({ label: esc(a.title), sublabel: esc(a.parentTitle || ''), thumb: thumbOrPlaceholder(a.thumb, 80), arrow: true, action: () => openAlbumTracks(a.ratingKey, a.title) })), title);
}

async function openAlbumTracks(key, title) {
  await apiMenu('Loading tracks...', () => plexFetch(`/library/metadata/${key}/children`), d => {
    const tracks = d.MediaContainer.Metadata || [];
    return [
      { label: '⇄ Shuffle', arrow: false, action: () => playShuffled(tracks) },
      ...tracks.map((t, i) => ({ label: esc(t.title), sublabel: esc(t.grandparentTitle || ''), thumb: thumbOrPlaceholder(t.thumb || t.parentThumb || t.grandparentThumb, 80), arrow: false, action: () => playTrack(t, tracks, i) }))
    ];
  }, title);
}

async function openSongList(sectionKey, title) {
  await apiMenu('Loading songs...', () => plexFetch(`/library/sections/${sectionKey}/all?type=10`), d => {
    const tracks = d.MediaContainer.Metadata || [];
    return [
      { label: '⇄ Shuffle All', arrow: false, action: () => playShuffled(tracks) },
      ...tracks.map((t, i) => ({ label: esc(t.title), sublabel: esc(t.grandparentTitle || ''), thumb: thumbOrPlaceholder(t.thumb || t.parentThumb || t.grandparentThumb, 80), arrow: false, action: () => playTrack(t, tracks, i) }))
    ];
  }, title);
}

async function openPlaylists() {
  await apiMenu('Loading playlists...', () => plexFetch('/playlists?playlistType=audio'), d =>
    (d.MediaContainer.Metadata || []).map(p => ({ label: esc(p.title), thumb: thumbOrPlaceholder(p.composite || p.thumb, 80), arrow: true, action: () => openPlaylistTracks(p.ratingKey, p.title) })), 'Playlists');
}

async function openPlaylistTracks(key, title) {
  await apiMenu('Loading...', () => plexFetch(`/playlists/${key}/items`), d => {
    const tracks = d.MediaContainer.Metadata || [];
    return [
      { label: '⇄ Shuffle', arrow: false, action: () => playShuffled(tracks) },
      ...tracks.map((t, i) => ({ label: esc(t.title), sublabel: esc(t.grandparentTitle || ''), thumb: thumbOrPlaceholder(t.thumb || t.parentThumb || t.grandparentThumb, 80), arrow: false, action: () => playTrack(t, tracks, i) }))
    ];
  }, title);
}

// ═══════════════════════════════════════════
//  COVER FLOW
// ═══════════════════════════════════════════
async function openCoverFlow() {
  showLoading('Loading albums…');
  try {
    const data = await plexFetch('/library/sections');
    const musicSections = (data.MediaContainer.Directory || []).filter(s => s.type === 'artist');
    if (!musicSections.length) throw new Error('No music libraries found');
    const sectionKey = musicSections[0].key;
    state.coverFlowSectionKey = sectionKey;
    const albums = await plexFetch(`/library/sections/${sectionKey}/all?type=9`);
    state.coverFlowAlbums = albums.MediaContainer.Metadata || [];
    if (!state.coverFlowAlbums.length) throw new Error('No albums found');
    state.coverFlowIndex = 0;
    state.view = 'coverflow';
    render();
  } catch(e) { showMenuError(e.message); }
}

function cfNavigate(dir) {
  const len = state.coverFlowAlbums.length;
  if (!len) return;
  const next = Math.max(0, Math.min(len - 1, state.coverFlowIndex + dir));
  if (next === state.coverFlowIndex) { vibe(HAPTIC.boundary); return; }
  state.coverFlowIndex = next;
  vibe(HAPTIC.tick);
  if (state.view === 'coverflow') { cfUpdateSrcs(); cfStartAnim(); }
}

function cfOpenCurrentAlbum() {
  const album = state.coverFlowAlbums[state.coverFlowIndex];
  if (!album) return;
  vibe(HAPTIC.select);
  state.returnToCoverFlow = true;
  openAlbumTracks(album.ratingKey, album.title);
}

// ── CoverFlow spring animation ───────────────────────────────────────────────

/** Piecewise-linear transform matching the original CSS class values exactly */
function cfCalcTransform(vp) {
  const sign = vp >= 0 ? 1 : -1;
  const abs  = Math.abs(vp);
  let tx, ry, sc, br;
  if (abs <= 1) {
    tx = sign * abs * 62;   ry = -sign * abs * 52;
    sc = 1 - abs * 0.18;    br = 1 - abs * 0.5;
  } else {
    const t = abs - 1;
    tx = sign * (62 + t * 46);   ry = -sign * (52 + t * 12);
    sc = 0.82 - t * 0.18;        br = 0.5  - t * 0.22;
  }
  const op = abs > 2.2 ? Math.max(0, 1 - (abs - 2.2) * 3) : 1;
  const zi = Math.round(Math.max(1, 10 - abs * 3));
  return { tx, ry, sc: Math.max(0.55, sc), br: Math.max(0.15, br), op, zi };
}

function cfApplyTransforms() {
  const screen = document.getElementById('screen');
  if (!screen) return;
  const items = screen.querySelectorAll('.cf-item');
  if (!items.length) return;
  const albums    = state.coverFlowAlbums;
  const targetIdx = state.coverFlowIndex;
  items.forEach((el, i) => {
    const slotOffset = i - 2; // slots: -2, -1, 0, 1, 2
    const albumIdx   = targetIdx + slotOffset;
    const hasAlbum   = albumIdx >= 0 && albumIdx < albums.length;
    const vp = slotOffset + (targetIdx - cfAnim.offset);
    const { tx, ry, sc, br, op, zi } = cfCalcTransform(vp);
    el.style.transform     = `translateX(${tx}%) rotateY(${ry}deg) scale(${sc})`;
    el.style.filter        = `brightness(${br})`;
    el.style.opacity       = hasAlbum ? op : 0;
    el.style.zIndex        = zi;
    el.style.pointerEvents = hasAlbum ? '' : 'none';
  });
}

function cfUpdateInfo() {
  const screen = document.getElementById('screen');
  if (!screen) return;
  const albums = state.coverFlowAlbums;
  const nearIdx = Math.max(0, Math.min(albums.length - 1, Math.round(cfAnim.offset)));
  const cur = albums[nearIdx] || {};
  const titleEl  = screen.querySelector('.cf-album-title');
  const artistEl = screen.querySelector('.cf-artist-name');
  const countEl  = screen.querySelector('.cf-track-count');
  const connEl   = screen.querySelector('.conn-status');
  if (titleEl)  titleEl.textContent  = cur.title       || '';
  if (artistEl) artistEl.textContent = cur.parentTitle || '';
  if (countEl)  countEl.textContent  = cur.leafCount
    ? `${cur.leafCount} track${cur.leafCount !== 1 ? 's' : ''}` : '';
  if (connEl)   connEl.textContent   = `${nearIdx + 1} / ${albums.length}`;
}

function cfUpdateSrcs() {
  const screen = document.getElementById('screen');
  if (!screen) return;
  const items = screen.querySelectorAll('.cf-item');
  if (!items.length) return;
  const albums = state.coverFlowAlbums;
  const targetIdx = state.coverFlowIndex;
  const thumb = a => a ? (plexThumb(a.thumb, 400) || PLACEHOLDER_THUMB) : PLACEHOLDER_THUMB;
  items.forEach((el, i) => {
    const albumIdx = targetIdx + (i - 2);
    const img = el.querySelector('img');
    if (img) img.src = thumb(albums[albumIdx]);
    el.dataset.idx = albumIdx;
  });
}

function cfStartAnim() {
  if (cfAnim.raf) return; // already running
  cfAnim.raf = requestAnimationFrame(cfAnimFrame);
}

function cfAnimFrame() {
  const target = state.coverFlowIndex;
  const diff   = target - cfAnim.offset;
  if (Math.abs(diff) < 0.004) {
    cfAnim.offset = target;
    cfAnim.raf    = null;
    cfApplyTransforms();
    cfUpdateInfo();
    return;
  }
  cfAnim.offset += diff * 0.16; // spring: lerp 16% of remaining gap per frame (smoother)
  cfApplyTransforms();
  cfUpdateInfo();
  cfAnim.raf = requestAnimationFrame(cfAnimFrame);
}

function renderCoverFlow(screen) {
  const albums = state.coverFlowAlbums;
  const idx    = state.coverFlowIndex;
  const cur    = albums[idx] || {};
  const vw     = window.innerWidth;
  const cfSize = Math.min(Math.round(vw * 0.52), 210);

  // Snap animation position to current index (no animation on initial render)
  if (cfAnim.raf) { cancelAnimationFrame(cfAnim.raf); cfAnim.raf = null; }
  cfAnim.offset = idx;

  const albumThumb = a => a ? (plexThumb(a.thumb, 400) || PLACEHOLDER_THUMB) : PLACEHOLDER_THUMB;

  // Render 5 slots; rAF animation drives all transforms via inline styles
  const offsets = [-2, -1, 0, 1, 2];

  const itemsHtml = offsets.map(offset => {
    const album = albums[idx + offset];
    const src   = albumThumb(album);
    const aidx  = idx + offset;
    return `<div class="cf-item" data-idx="${aidx}">
      <img src="${esc(src)}" referrerpolicy="no-referrer" loading="lazy" draggable="false" />
    </div>`;
  }).join('');

  const npBar = state.currentTrack
    ? `<div class="cf-np-bar">♪ ${esc(state.currentTrack.title)}</div>` : '';

  screen.innerHTML = `
    <div class="coverflow-screen" style="--cf-size:${cfSize}px">
      <div class="menu-titlebar">
        <div class="title">Cover Flow</div>
        <div class="conn-status ${state.connStatus}">${idx + 1} / ${albums.length}${sleepStatusHtml()}</div>
      </div>
      <div class="cf-stage">${itemsHtml}</div>
      <div class="cf-info">
        <div class="cf-album-title">${esc(cur.title || '')}</div>
        <div class="cf-artist-name">${esc(cur.parentTitle || '')}</div>
        <div class="cf-track-count">${cur.leafCount ? `${cur.leafCount} track${cur.leafCount !== 1 ? 's' : ''}` : ''}</div>
      </div>
      ${npBar}
    </div>`;

  // Apply initial transforms so items are positioned immediately (no animation jump)
  cfApplyTransforms();

  // Touch swipe on the stage
  const stage = screen.querySelector('.cf-stage');
  let cfTx = null;
  stage.addEventListener('touchstart', e => { cfTx = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (cfTx === null) return;
    const dx = e.changedTouches[0].clientX - cfTx;
    cfTx = null;
    if (Math.abs(dx) < 24) { cfOpenCurrentAlbum(); return; }
    cfNavigate(dx < 0 ? 1 : -1);
  }, { passive: true });

  // Click on side items to navigate; click active to open
  screen.querySelectorAll('.cf-item').forEach(el => {
    el.addEventListener('click', () => {
      const itemIdx = parseInt(el.dataset.idx, 10);
      if (isNaN(itemIdx)) return;
      if (itemIdx === state.coverFlowIndex) { cfOpenCurrentAlbum(); return; }
      const clamped = Math.max(0, Math.min(albums.length - 1, itemIdx));
      state.coverFlowIndex = clamped;
      vibe(HAPTIC.tick);
      cfUpdateSrcs();
      cfStartAnim();
    });
  });
}

// ═══════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════
function render() {
  const screen = document.getElementById('screen');
  if (state.view === 'setup')           renderSetup(screen);
  else if (state.view === 'nowplaying') renderNowPlaying(screen);
  else if (state.view === 'coverflow')  renderCoverFlow(screen);
  else if (state.view === 'menu')       renderMenu(screen);
  else if (state.view === 'lbsetup')    renderLbSetup(screen);
}

/** Show an in-screen error bar instead of alert() — works in PWA standalone mode */
function showMenuError(msg) {
  // Always render the menu — showLoading() stomps innerHTML directly without
  // changing state.view, so we can't rely on state.view to detect loading state.
  state.view = 'menu';
  render();

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
    `<div class="loading"><div class="spinner"></div><p>${esc(msg)}</p></div>`;
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
    const pinId = parseInt(pin.id, 10);
    if (!Number.isFinite(pinId) || pinId <= 0) throw new Error('Invalid PIN response from Plex.');
    state.plexPinId = pinId;

    // Navigate the already-open window to the real auth URL
    const authUrl = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(PLEX_CLIENT_ID)}&code=${encodeURIComponent(pin.code)}&context[device][product]=MediaPod`;
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
          `https://plex.tv/api/v2/pins/${pinId}`,
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
  // With CORS proxy available on desktop, prefer remote/relay connections.
  // The proxy can't reach LAN IPs (192.168.x.x) — skip local when proxied.
  // Without proxy (mobile), prefer relay for CORS, then try local/direct.
  const conns = [...server.connections]
    .filter(c => !(_needsProxy && c.local)) // proxy can't reach LAN
    .sort((a, b) => {
      const score = c => {
        if (_needsProxy) {
          // Proxy: prefer relay (Plex infra, most reliable), then direct remote
          return (c.relay ? 0 : 1) + (c.protocol === 'https' ? 0 : 1);
        }
        // No proxy — prefer relay (CORS-safe), then direct
        return (c.relay ? 0 : 2) + (c.local ? 0 : 1) + (c.protocol === 'https' ? 0 : 1);
      };
      return score(a) - score(b);
    });

  let lastErr = 'All connections failed';
  for (const conn of conns) {
    const url = conn.uri.replace(/\/$/, '');
    // Skip non-http(s) URIs — fetch doesn't execute them but avoids unexpected behaviour
    if (!isValidUrl(url)) continue;
    try {
      const test = await proxiedFetch(
        `${url}/`,
        { headers: { ...PLEX_HEADERS, Accept: 'application/json', 'X-Plex-Token': token } },
        6000
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
  const isOAuth = state.serverType !== 'manual';
  const brand   = BRANDS['plex'][state.darkMode ? 'dark' : 'light'];

  screen.innerHTML = `
    ${DALEK_BANNER}
    <div class="setup-screen">
      <h2>MediaPod</h2>
      <div class="server-toggle">
        <button class="srv-btn ${isOAuth ? 'active' : ''}" id="srv-plex">Plex Auth</button>
        <button class="srv-btn ${!isOAuth ? 'active' : ''}" id="srv-jf">Manual</button>
      </div>

      ${isOAuth ? `
        <!-- ── Plex: one-tap OAuth ── -->
        <button class="setup-btn" id="plex-oauth-btn"
          style="background:${brand.accent};box-shadow:0 2px 6px ${brand.shadow}">
          Sign in with Plex
        </button>
      ` : `
        <!-- ── Manual: direct server URL + Plex token ── -->
        <input id="srv-url"    type="url"  placeholder="https://192.168.1.x:32400" autocomplete="url" />
        <input id="srv-secret" type="text" placeholder="Plex Token" autocomplete="off" spellcheck="false" />
        <p class="su-hint">Get your token: Plex Web → ⋮ → Account → Plex Media Server</p>
        <button class="setup-btn" id="connect-btn"
          style="background:${brand.accent};box-shadow:0 2px 6px ${brand.shadow}">Connect</button>
      `}
      <p id="setup-error" class="setup-error" style="display:none"></p>
    </div>
  `;

  // Tab toggle
  document.getElementById('srv-plex').addEventListener('click', () => {
    if (isOAuth) return;
    state.serverType = 'plex'; render();
  });
  document.getElementById('srv-jf').addEventListener('click', () => {
    if (!isOAuth) return;
    state.serverType = 'manual'; render();
  });

  const showErr = msg => {
    state.connStatus = 'disconnected';
    state.view = 'setup'; render();
    setTimeout(() => {
      const el = document.getElementById('setup-error');
      if (el) { el.textContent = msg; el.style.display = 'block'; }
    }, 30);
  };

  if (isOAuth) {
    document.getElementById('plex-oauth-btn').addEventListener('click', startPlexOAuth);
  } else {
    // Manual: direct Plex server URL + token
    document.getElementById('connect-btn').addEventListener('click', async () => {
      if (Date.now() - _lastConnectFailTs < 5000) { showErr('Please wait before trying again.'); return; }
      const url   = document.getElementById('srv-url').value.trim().replace(/\/$/, '');
      const token = document.getElementById('srv-secret').value.trim();
      if (!url || !token) { showErr('Fill in both fields.'); return; }
      if (!isValidUrl(url)) { showErr('URL must start with http:// or https://'); return; }
      if (!/^[a-zA-Z0-9_-]+$/.test(token)) { showErr('Token contains unexpected characters.'); return; }
      showLoading('Connecting...');
      state.connStatus = 'connecting';
      try {
        const test = await proxiedFetch(
          `${url}/`,
          { headers: { ...PLEX_HEADERS, Accept: 'application/json', 'X-Plex-Token': token } },
          8000
        );
        if (!test.ok) throw new Error(`Server returned ${test.status}. Check your URL and token.`);
        state.plexUrl   = url;
        state.plexToken = token;
        state.serverType = 'plex';
        localStorage.setItem('plexUrl',    url);
        localStorage.setItem('plexToken',  token);
        localStorage.setItem('serverType', 'plex');
        state.connected = true; state.connStatus = 'connected';
        state.navStack = [buildMainMenu()]; state.view = 'menu';
        applyTheme(); render();
      } catch (e) {
        _lastConnectFailTs = Date.now();
        showErr(e.message || 'Could not connect. Check your server URL and Plex token.');
      }
    });

    ['srv-url', 'srv-secret'].forEach(id =>
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('connect-btn').click();
      })
    );
  }
}

function renderMenu(screen) {
  if (!currentMenu()) state.navStack = [buildMainMenu()];
  const m = currentMenu();

  // Render all items — programmatic scrollTop keeps selected visible without
  // a scrollbar. overflow:hidden allows scrollTop even with no visible scrollbar.
  const rows = m.items.map((item, i) => {
    const sel = i === m.selectedIndex;
    const arrow = item.arrow ? '<span class="arrow">›</span>' : '';
    const sub = item.sublabel ? `<span class="menu-sub">${item.sublabel}</span>` : '';
    const thumbHtml = item.thumb
      ? `<img class="menu-thumb" src="${esc(item.thumb)}" referrerpolicy="no-referrer" loading="lazy" />`
      : '';
    return `<div class="menu-item ${sel ? 'selected' : ''}${item.thumb ? ' has-thumb' : ''}" data-idx="${i}">
      ${thumbHtml}<span class="menu-text">${item.label}${sub}</span>${arrow}
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
        }${sleepStatusHtml()}</div>
      </div>
      ${npBar}
      <div class="menu-list">${rows}</div>
    </div>`;

  // Scroll so selected item sits ~2 rows from the top
  const list = screen.querySelector('.menu-list');
  const selEl = list?.querySelector('.menu-item.selected');
  if (list && selEl) {
    const itemH = selEl.offsetHeight || 44;
    list.scrollTop = Math.max(0, selEl.offsetTop - itemH * 2);
  }

  screen.querySelectorAll('.menu-item').forEach(el =>
    el.addEventListener('click', () => { m.selectedIndex = parseInt(el.dataset.idx, 10); selectItem(); })
  );
}

function renderLbSetup(screen) {
  screen.innerHTML = `
    <div class="setup-screen">
      <h2>ListenBrainz</h2>
      <p class="su-sub">Scrobble your listening history to ListenBrainz — the open, community-owned music tracking service.</p>
      <a href="https://listenbrainz.org/settings/" target="_blank" rel="noopener noreferrer"
         style="font-size:11px;color:var(--np-artist,#6a9aba);text-decoration:underline;text-align:center;display:block;padding:4px 0">
        Get your token at listenbrainz.org/settings →
      </a>
      <input id="lb-input" type="text" placeholder="Paste user token here"
             autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"
             value="${esc(state.lbToken)}" />
      <button id="lb-save" class="setup-btn">Save</button>
      ${state.lbToken ? '<button id="lb-clear" class="setup-btn" style="background:rgba(180,0,0,0.25)">Disable Scrobbling</button>' : ''}
      <button id="lb-cancel" class="setup-btn" style="background:transparent;border:1px solid rgba(255,255,255,0.15);opacity:0.7">Cancel</button>
    </div>`;

  screen.querySelector('#lb-save').addEventListener('click', () => {
    const token = screen.querySelector('#lb-input').value.trim();
    // ListenBrainz tokens are UUIDs — validate before storing
    if (token && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token)) {
      const err = screen.querySelector('#lb-input');
      if (err) err.style.borderColor = '#e53030';
      return;
    }
    state.lbToken = token;
    if (token) localStorage.setItem('lbToken', token);
    else localStorage.removeItem('lbToken');
    const item = currentMenu()?.items?.find(i => i._id === 'lb');
    if (item) item.label = state.lbToken ? '♫ Scrobbling: On' : '♫ Scrobbling: Off';
    state.view = 'menu'; render();
  });
  screen.querySelector('#lb-cancel').addEventListener('click', () => {
    state.view = 'menu'; render();
  });
  screen.querySelector('#lb-clear')?.addEventListener('click', () => {
    state.lbToken = '';
    localStorage.removeItem('lbToken');
    const item = currentMenu()?.items?.find(i => i._id === 'lb');
    if (item) item.label = '♫ Scrobbling: Off';
    state.view = 'menu'; render();
  });
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
    const sleep = el.querySelector('#np-sleep');
    if (fill)  fill.style.width = pct + '%';
    if (times) times.innerHTML  =
      `<span>${formatTime(state.progress)}</span><span>-${formatTime(state.duration - state.progress)}</span>`;
    if (play)  play.innerHTML   = playIcon;
    if (sleep) sleep.textContent = state.sleepEndsAt
      ? `💤 ${Math.max(1, Math.ceil((state.sleepEndsAt - Date.now()) / 60000))}m` : '';
    return;
  }

  // ── Full build (first render, track change, or explicit screen arg) ──
  const thumb   = getThumb(t, 480);
  const bgThumb = getThumb(t, 800); // larger for better blur quality
  el.innerHTML = `
    <div class="nowplaying-screen${bgThumb ? ' has-blur' : ''}">
      ${bgThumb ? '<div class="np-bg-blur"></div>' : ''}
      <div class="np-titlebar"><div class="title">Now Playing</div></div>
      <div class="np-art">
        ${thumb ? `<img id="np-thumb" src="${esc(thumb)}" referrerpolicy="no-referrer" />` : '<div class="no-art">♪</div>'}
      </div>
      <div class="np-info">
        <div class="np-song marquee"><span>${esc(t.title)}</span></div>
        <div class="np-artist marquee${t.grandparentRatingKey ? ' np-tappable' : ''}"><span>${esc(t.grandparentTitle || '')}</span></div>
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
        <span class="np-ctrl-btn np-ctrl-side${state.shuffle ? ' np-active' : ''}" id="np-shuffle">⇄</span>
        <span class="np-ctrl-btn" id="np-prev">⏮</span>
        <span class="np-ctrl-btn play-pause" id="np-play">${playIcon}</span>
        <span class="np-ctrl-btn" id="np-next">⏭</span>
        <span class="np-ctrl-btn np-ctrl-side${state.repeat !== 'off' ? ' np-active' : ''}" id="np-repeat">${state.repeat === 'one' ? '↺¹' : '↺'}</span>
      </div>
      <div class="np-sleep-row">
        <span class="np-sleep-badge" id="np-sleep">${state.sleepEndsAt ? `💤 ${Math.max(1, Math.ceil((state.sleepEndsAt - Date.now()) / 60000))}m` : ''}</span>
      </div>
      <div id="scrub-indicator">◁◁ &nbsp; SCRUBBING &nbsp; ▷▷</div>
    </div>`;

  // Set blur background via DOM to avoid CSS injection through inline style
  const blurDiv = el.querySelector('.np-bg-blur');
  if (blurDiv && bgThumb) blurDiv.style.backgroundImage = `url("${bgThumb.replace(/["\\]/g, '\\$&')}")`;

  el.querySelector('#np-play').addEventListener('click', togglePlay);
  el.querySelector('#np-prev').addEventListener('click', prevTrack);
  el.querySelector('#np-next').addEventListener('click', nextTrack);
  el.querySelector('#np-shuffle').addEventListener('click', () => {
    toggleShuffle();
    el.querySelector('#np-shuffle')?.classList.toggle('np-active', state.shuffle);
  });
  el.querySelector('#np-repeat').addEventListener('click', () => {
    toggleRepeat();
    const btn = el.querySelector('#np-repeat');
    if (btn) { btn.classList.toggle('np-active', state.repeat !== 'off'); btn.innerHTML = state.repeat === 'one' ? '↺¹' : '↺'; }
  });
  const artistEl = el.querySelector('.np-tappable');
  if (artistEl && t.grandparentRatingKey) {
    artistEl.style.cursor = 'pointer';
    artistEl.addEventListener('click', () => { vibe(HAPTIC.select); openArtistAlbums(t.grandparentRatingKey, t.grandparentTitle || 'Artist'); });
  }
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
const HAPTIC_SCALE = { off: 0, light: 0.4, medium: 0.65, strong: 1.0 };
function vibe(p) {
  const mult = HAPTIC_SCALE[state.hapticStrength] ?? 0.65;
  if (mult === 0) return;
  const scale = v => Math.max(1, Math.round(v * mult));
  const scaled = Array.isArray(p) ? p.map(scale) : scale(p);
  try { navigator.vibrate?.(scaled); } catch(_) {}
}
const HAPTIC = {
  tick:     20,           // menu step — single short pulse (reference = strong)
  select:   [20, 40, 20], // SELECT press
  back:     [15, 30, 15], // MENU / back
  boundary: [30, 40, 30], // hit list edge
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

function startCfMomentum(initialVelDegPerSec) {
  cancelMomentum();
  let vel = initialVelDegPerSec;
  let accum = 0;
  function frame() {
    if (Math.abs(vel) < MOMENTUM_MIN_VEL || state.view !== 'coverflow') return;
    accum += vel / 60;
    const ticks = Math.trunc(accum / DEG_PER_MENU_TICK);
    if (ticks !== 0) {
      accum -= ticks * DEG_PER_MENU_TICK;
      const prev = state.coverFlowIndex;
      cfNavigate(ticks);
      if (state.coverFlowIndex === prev) return; // hit boundary — stop
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

  } else if (state.view === 'coverflow') {
    wheel.accum += delta;
    const ticks = Math.trunc(wheel.accum / DEG_PER_MENU_TICK);
    if (ticks !== 0) {
      wheel.accum -= ticks * DEG_PER_MENU_TICK;
      cfNavigate(ticks);
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
  if (wheel.velBuf.length >= 2) {
    const f = wheel.velBuf[0];
    const l = wheel.velBuf[wheel.velBuf.length - 1];
    const dt = (l.ts - f.ts) / 1000;
    if (dt > 0.01) {
      const vel = angleDiff(l.angle, f.angle) / dt;
      if (Math.abs(vel) > MOMENTUM_MIN_VEL * 2) {
        if (state.view === 'menu')       startMomentum(vel);
        else if (state.view === 'coverflow') startCfMomentum(vel);
      }
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
  } else if (state.view === 'coverflow') {
    cfNavigate(e.deltaY > 0 ? 1 : -1);
  } else if (state.view === 'nowplaying' && state.duration > 0) {
    const skip = e.deltaY > 0 ? 5 : -5;
    state.audio.currentTime = Math.max(0, Math.min(state.duration, state.audio.currentTime + skip));
    vibe(HAPTIC.scrubTick);
  }
}, { passive: false });

// ── Zone buttons (cardinal quadrants) ──
// Zones overlap the rim, so onRimStart sees their touches and calls preventDefault,
// suppressing synthetic clicks. We handle taps directly in touchend by checking
// that the finger barely moved AND the wheel accumulated no rotation (not a drag).
// The click handler covers desktop mouse clicks where no touch events fire.
function addZoneTap(id, action) {
  const el = document.getElementById(id);
  let ts = null;
  el.addEventListener('touchstart', e => {
    ts = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    // Do NOT stopPropagation — rim must still receive drag gestures
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!ts) return;
    const moved = Math.hypot(
      e.changedTouches[0].clientX - ts.x,
      e.changedTouches[0].clientY - ts.y
    );
    ts = null;
    // Tap = finger barely moved AND wheel didn't rotate (accum reset to 0 on start)
    if (moved < 12 && wheel.accum === 0) { e.preventDefault(); action(); }
  }, { passive: false });
  el.addEventListener('touchcancel', () => { ts = null; }, { passive: true });
  el.addEventListener('click', action); // desktop mouse clicks
}

addZoneTap('zone-top',    () => { vibe(HAPTIC.back); goBack(); });
addZoneTap('zone-bottom', () => { if (state.currentTrack) { vibe(HAPTIC.select); togglePlay(); } });
addZoneTap('zone-left',   () => { vibe(HAPTIC.tick); if (state.view === 'nowplaying') prevTrack(); else if (state.view === 'coverflow') cfNavigate(-1); else scrollMenu(-1); });
addZoneTap('zone-right',  () => { vibe(HAPTIC.tick); if (state.view === 'nowplaying') nextTrack(); else if (state.view === 'coverflow') cfNavigate(1);  else scrollMenu(1);  });
document.getElementById('wheel-center').addEventListener('click', () => {
  if (state.view === 'menu')           { vibe(HAPTIC.select); selectItem(); }
  else if (state.view === 'coverflow') { vibe(HAPTIC.select); cfOpenCurrentAlbum(); }
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
    case 'ArrowLeft':  if (state.view === 'nowplaying') prevTrack(); else if (state.view === 'coverflow') cfNavigate(-1); break;
    case 'ArrowRight': if (state.view === 'nowplaying') nextTrack(); else if (state.view === 'coverflow') cfNavigate(1);  break;
    case 'Enter':      if (state.view === 'menu') selectItem(); else if (state.view === 'coverflow') cfOpenCurrentAlbum(); else if (state.view === 'nowplaying') togglePlay(); break;
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


const hasPlex = state.plexUrl && state.plexToken;

if (hasPlex) {
  showLoading('Connecting...');
  plexFetch('/').then(() => {
    state.connected = true; state.connStatus = 'connected';
    state.navStack = [buildMainMenu()];
    state.view = 'menu';
    applyTheme(); render();
  }).catch(() => { state.connStatus = 'disconnected'; state.view = 'setup'; render(); });
} else {
  render();
}


// ═══════════════════════════════════════════
//  SERVICE WORKER
// ═══════════════════════════════════════════
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}