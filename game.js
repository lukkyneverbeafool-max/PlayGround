import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';
import {
  createInitialState, cloneState, applyMove, legalMoves, allMoves, gameStatus,
  inCheck, moveToSan, opposite, positionKey, same, squareName, FILES
} from './chess.js';
import { findBestMove, evaluateState, MATE } from './engine.js';

/* ------------------------------------------------------------------ */
/* Preferences, profile and small helpers                              */
/* ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const GLYPHS = { wk:'♔',wq:'♕',wr:'♖',wb:'♗',wn:'♘',wp:'♙',bk:'♚',bq:'♛',br:'♜',bb:'♝',bn:'♞',bp:'♟' };

const PREFS_KEY = 'gambit.prefs.v2';
const PROFILE_KEY = 'gambit.profile.v2';

const DEFAULT_PREFS = {
  mode: 'computer',
  difficulty: 'club',
  style: 'balanced',
  side: 'w',
  adaptive: true,
  variant: 'standard',
  time: 'unlimited',
  spectator: false,
  boardTheme: 'walnut',
  pieceTheme: 'classic',
  sound: true
};

const DEFAULT_PROFILE = {
  games: 0, wins: 0, losses: 0, draws: 0,
  history: [], lastAccuracy: null, lastBlunders: 0
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...fallback };
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return { ...fallback };
  }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsing */ }
}

let prefs = readJSON(PREFS_KEY, DEFAULT_PREFS);
let profile = readJSON(PROFILE_KEY, DEFAULT_PROFILE);
if (!Array.isArray(profile.history)) profile.history = [];

const TIME_CONTROLS = {
  unlimited: { base: 0, inc: 0, label: 'Untimed' },
  blitz: { base: 180000, inc: 2000, label: 'Blitz 3 + 2' },
  rapid: { base: 600000, inc: 0, label: 'Rapid 10 + 0' },
  classical: { base: 1800000, inc: 0, label: 'Classical 30 + 0' }
};

const DIFFICULTY_LABEL = { casual: 'Casual', club: 'Club', master: 'Master' };
const STYLE_LABEL = { balanced: 'Balanced', aggressive: 'Aggressive', defensive: 'Defensive' };
const VARIANT_LABEL = { standard: 'Standard', chess960: 'Chess960', koth: 'King of the Hill' };
const DIFFICULTY_HINT = {
  casual: 'A relaxed opponent. Gives you room to learn.',
  club: 'A steady club player. Punishes loose pieces.',
  master: 'Deep tactics and positional pressure. No favours.'
};

/* ------------------------------------------------------------------ */
/* App state                                                          */
/* ------------------------------------------------------------------ */

let state = createInitialState();
let history = [];
let capturedBy = { w: [], b: [] };
let selected = null;
let legalTargets = [];
let hintMove = null;
let lastMove = null;

let game = {
  id: 0,
  mode: 'computer',
  variant: 'standard',
  playerColor: 'w',
  difficulty: 'club',
  style: 'balanced',
  adaptive: true,
  timeKey: 'unlimited',
  spectator: false,
  over: false,
  result: null,
  thinking: false,
  started: false,
  paused: false,
  clocks: null,
  lastTick: 0,
  profileRecorded: false,
  analysis: null
};

let aiToken = 0;
let hintToken = 0;
let analysisToken = 0;
let toastTimer = null;
let flipped = false;

/* ------------------------------------------------------------------ */
/* Sound                                                              */
/* ------------------------------------------------------------------ */

let audioCtx = null;

function ensureAudio() {
  if (!prefs.sound) return null;
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try { audioCtx = new Ctor(); } catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function tone(freq, duration, type = 'sine', volume = 0.035, delay = 0, slide = null) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t0 + duration);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.04);
}

function sound(kind) {
  if (!prefs.sound) return;
  switch (kind) {
    case 'move':
      tone(300, 0.075, 'sine', 0.035, 0, 210);
      break;
    case 'capture':
      tone(155, 0.12, 'triangle', 0.055, 0, 80);
      tone(95, 0.16, 'square', 0.022, 0.015, 60);
      break;
    case 'castle':
      tone(240, 0.09, 'sine', 0.032);
      tone(360, 0.11, 'sine', 0.03, 0.09);
      break;
    case 'check':
      tone(760, 0.11, 'triangle', 0.032, 0, 640);
      tone(1040, 0.16, 'sine', 0.024, 0.1);
      break;
    case 'end':
      tone(392, 0.4, 'sine', 0.03);
      tone(494, 0.45, 'sine', 0.026, 0.08);
      tone(587, 0.55, 'sine', 0.024, 0.16);
      break;
    case 'hint':
      tone(660, 0.13, 'sine', 0.032);
      tone(880, 0.16, 'sine', 0.026, 0.11);
      break;
    case 'select':
      tone(520, 0.05, 'sine', 0.02);
      break;
    case 'error':
      tone(180, 0.1, 'square', 0.022, 0, 140);
      break;
    case 'click':
      tone(440, 0.04, 'sine', 0.018);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* DOM shortcuts                                                      */
/* ------------------------------------------------------------------ */

const canvas = $('#chess-canvas');
const boardFrame = $('#board-frame');
const loading = $('#loading');
const moveListEl = $('#move-list');
const gameOverEl = $('#game-over');
const setupModal = $('#setup-modal');
const appearanceModal = $('#appearance-modal');

const el = {
  turnValue: $('#turn-value'), turnIcon: $('#turn-icon'), turnBox: $('#turn-box'),
  whiteMarker: $('#white-marker'), blackMarker: $('#black-marker'),
  whiteSub: $('#white-sub'), blackSub: $('#black-sub'),
  whiteClock: $('#white-clock'), blackClock: $('#black-clock'),
  whiteCaptured: $('#white-captured'), blackCaptured: $('#black-captured'),
  whiteName: $('#white-name'), blackName: $('#black-name'),
  whiteTag: $('#white-tag'), blackTag: $('#black-tag'),
  whiteAvatar: $('#white-avatar'), blackAvatar: $('#black-avatar'),
  whiteCard: $('#white-card'), blackCard: $('#black-card'),
  undo: $('#undo-button'), hint: $('#hint-button'), flip: $('#flip-button'),
  spectate: $('#spectate-button'), analysis: $('#analysis-button'),
  modeBadge: $('#mode-badge'), modeDetail: $('#mode-detail'),
  modeCaption: $('#mode-caption'), panelKicker: $('#panel-kicker'),
  panelTitle: $('#panel-title'), panelDescription: $('#panel-description'),
  panelFooter: $('#panel-footer'), moveCount: $('#move-count'),
  spectatorBanner: $('#spectator-banner'), thinkingBanner: $('#thinking-banner'),
  sound: $('#sound-button'), toast: $('#toast'),
  resultMain: $('#result-main'), resultTitle: $('#result-title'), resultCopy: $('#result-copy'),
  resultEmblem: $('#result-emblem'), resultKicker: $('#result-kicker'), resultStats: $('#result-stats'),
  analysisPanel: $('#analysis-panel'), analysisScore: $('#analysis-score'),
  analysisProgress: $('#analysis-progress'), analysisBar: $('#analysis-progress-bar'),
  analysisSummary: $('#analysis-summary'), analysisList: $('#analysis-list')
};

function notify(text) {
  if (!el.toast) return;
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2300);
}

function formatClock(ms, showTenths = false) {
  const total = Math.max(0, ms);
  const mins = Math.floor(total / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  if (showTenths && total < 20000) {
    const tenths = Math.floor((total % 1000) / 100);
    return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function resultText(result) {
  const reason = result?.reason;
  if (!result?.winner) {
    if (reason === 'stalemate') return { title: 'Stalemate', copy: 'No legal moves remain. The game is drawn.' };
    if (reason === 'fifty') return { title: 'Draw', copy: 'Fifty moves without a pawn move or capture.' };
    if (reason === 'material') return { title: 'Draw', copy: 'Neither side has enough material to checkmate.' };
    if (reason === 'repetition') return { title: 'Draw', copy: 'The same position appeared three times.' };
    return { title: 'Draw', copy: 'The game is drawn.' };
  }
  const winnerName = sideLabel(result.winner);
  const win = game.mode === 'computer'
    ? (result.winner === game.playerColor ? 'You win' : 'The rival wins')
    : `${winnerName} wins`;
  if (reason === 'checkmate') return { title: 'Checkmate', copy: `${win} by checkmate.` };
  if (reason === 'timeout') return { title: "Time's up", copy: `${win} on the clock.` };
  if (reason === 'hill') return { title: 'King of the Hill', copy: `${win} by marching the king to the centre.` };
  return { title: 'Victory', copy: `${win}.` };
}

function sideLabel(c) {
  if (game.mode === 'computer') return c === game.playerColor ? 'You' : 'The rival';
  return c === 'w' ? 'White' : 'Black';
}

function rivalForm() {
  const recent = profile.history.slice(-8);
  let score = recent.reduce((sum, r) => sum + (r === 'W' ? 1 : r === 'L' ? -1 : 0), 0) * 10;
  if (profile.lastAccuracy != null) score += (profile.lastAccuracy - 72) * 1.3;
  score -= Math.min(28, (profile.lastBlunders || 0) * 3);
  return clamp(Math.round(score), -100, 100);
}

function formLabel(form) {
  if (form > 55) return 'in fierce form';
  if (form > 20) return 'sharpening up';
  if (form < -55) return 'taking it easy';
  if (form < -20) return 'easing off';
  return 'balanced';
}

function saveProfile() { writeJSON(PROFILE_KEY, profile); }
function savePrefs() { writeJSON(PREFS_KEY, prefs); }

/* ------------------------------------------------------------------ */
/* Three.js world                                                     */
/* ------------------------------------------------------------------ */

const BOARD_THEMES = {
  walnut: {
    label: 'Walnut', dark: 0x30251e, wood: 0x5a3624, trim: 0x987044,
    felt: 0x21342d, tileA: 0xe4d2ad, tileB: 0x75513a, brass: 0xd0ad68,
    floor: 0x1a2420, bg: 0x1a2420, fog: 0x1a2420
  },
  noir: {
    label: 'Noir', dark: 0x101316, wood: 0x23282d, trim: 0x454d55,
    felt: 0x151b1f, tileA: 0xd8dde1, tileB: 0x3c444d, brass: 0x9daab4,
    floor: 0x12191c, bg: 0x12191c, fog: 0x12191c
  },
  marble: {
    label: 'Marble', dark: 0x2a2925, wood: 0x6f6a60, trim: 0xc7bfae,
    felt: 0x2b3733, tileA: 0xf2eee4, tileB: 0x8b978f, brass: 0xbfb08a,
    floor: 0x1b211e, bg: 0x1b211e, fog: 0x1b211e
  },
  emerald: {
    label: 'Emerald', dark: 0x0b211a, wood: 0x153b2c, trim: 0x8d7945,
    felt: 0x10241e, tileA: 0xdbe5cd, tileB: 0x2f5b47, brass: 0xcaa85a,
    floor: 0x0e1a15, bg: 0x0e1a15, fog: 0x0e1a15
  }
};

const PIECE_THEMES = {
  classic: {
    label: 'Classic', sub: 'Warm ivory & green', white: 0xf1e8d6, black: 0x17342e,
    whiteEdge: 0xb8a77e, blackEdge: 0x071814, whiteAccent: 0x9a7946, blackAccent: 0xd4b269,
    whiteShadow: 0xddd0b5, blackShadow: 0x0b201b,
    whiteMetal: 0.06, blackMetal: 0.3, fantasy: false
  },
  modern: {
    label: 'Modern', sub: 'Bone & graphite', white: 0xf0efe9, black: 0x1a1f24,
    whiteEdge: 0xa3a8ab, blackEdge: 0x050708, whiteAccent: 0x646b73, blackAccent: 0xa8b1ba,
    whiteShadow: 0xd6d7d4, blackShadow: 0x0a0c0e,
    whiteMetal: 0.42, blackMetal: 0.55, fantasy: false
  },
  fantasy: {
    label: 'Fantasy', sub: 'Sunstone & amethyst', white: 0xf2ddb0, black: 0x251334,
    whiteEdge: 0xc99b46, blackEdge: 0x5e3389, whiteAccent: 0xe9b74e, blackAccent: 0xc08cff,
    whiteShadow: 0xd7b978, blackShadow: 0x120a1c,
    whiteMetal: 0.32, blackMetal: 0.38, fantasy: true
  }
};

const PALETTE_GOLD = 0xc2a15e;
let scene, camera, renderer, raycaster;
let boardGroup, pieceGroup, highlightGroup, effectsGroup, floorMesh;
let squareMeshes = [];
let pieceMeshes = new Map();
let moveAnims = [];
let ringEffects = [];
let orbit = { theta: 3 * Math.PI / 4, phi: 0.72, radius: 18.5 };
let pointer = null;
let dragged = false;
const clock = { last: 0 };

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

function activeBoardTheme() { return BOARD_THEMES[prefs.boardTheme] || BOARD_THEMES.walnut; }
function activePieceTheme() { return PIECE_THEMES[prefs.pieceTheme] || PIECE_THEMES.classic; }

function mat(c, rough = 0.35, metal = 0, emissive = 0, emissiveIntensity = 0) {
  const opts = { color: c, roughness: rough, metalness: metal };
  if (emissive) { opts.emissive = emissive; opts.emissiveIntensity = emissiveIntensity; }
  return new THREE.MeshStandardMaterial(opts);
}

function mesh(geo, material, parent, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function lathe(parent, profile, material, y = 0) {
  const m = mesh(
    new THREE.LatheGeometry(profile.map(([x, z]) => new THREE.Vector2(x, z)), 40),
    material, parent, 0, y, 0
  );
  m.castShadow = true;
  return m;
}

function disposeGroup(g) {
  if (!g) return;
  if (g.parent) g.parent.remove(g);
  g.traverse(o => {
    if (o.isMesh || o.isSprite) {
      o.geometry?.dispose();
      if (Array.isArray(o.material)) o.material.forEach(m => { m.map?.dispose(); m.dispose(); });
      else { o.material?.map?.dispose(); o.material?.dispose(); }
    }
  });
  g.clear();
}

function labelSprite(text, x, z, color, size = 0.34) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  ctx.font = '700 38px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, opacity: 0.52, depthWrite: false
  }));
  sprite.scale.set(size, size, size);
  sprite.position.set(x, 0.17, z);
  boardGroup.add(sprite);
  return sprite;
}

function createBoard() {
  const T = activeBoardTheme();
  boardGroup = new THREE.Group();
  scene.add(boardGroup);
  pieceGroup = new THREE.Group();
  boardGroup.add(pieceGroup);
  highlightGroup = new THREE.Group();
  boardGroup.add(highlightGroup);
  effectsGroup = new THREE.Group();
  boardGroup.add(effectsGroup);

  const dark = mat(T.dark, 0.28);
  const wood = mat(T.wood, 0.27);
  const trim = mat(T.trim, 0.25, 0.35);
  const felt = mat(T.felt, 0.83);
  const tileA = mat(T.tileA, 0.38);
  const tileB = mat(T.tileB, 0.36);
  const brass = mat(T.brass, 0.23, 0.55);

  mesh(new THREE.BoxGeometry(9.05, 0.34, 9.05), dark, boardGroup, 0, -0.39, 0);
  mesh(new THREE.BoxGeometry(8.92, 0.1, 8.92), trim, boardGroup, 0, -0.18, 0);
  mesh(new THREE.BoxGeometry(8.78, 0.16, 8.78), wood, boardGroup, 0, -0.095, 0);
  mesh(new THREE.BoxGeometry(8.55, 0.09, 8.55), felt, boardGroup, 0, 0.005, 0);

  const squareGeo = new THREE.BoxGeometry(1, 0.08, 1);
  squareMeshes = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = mesh(squareGeo, (r + f) % 2 ? tileB : tileA, boardGroup, f - 3.5, 0.085, r - 3.5);
    sq.userData.square = [r, f];
    squareMeshes.push(sq);
  }

  for (let i = -1; i <= 1; i += 2) {
    mesh(new THREE.BoxGeometry(8.9, 0.13, 0.055), brass, boardGroup, 0, -0.22, i * 4.43);
    mesh(new THREE.BoxGeometry(0.055, 0.13, 8.9), brass, boardGroup, i * 4.43, -0.22, 0);
  }
  for (const x of [-4.3, 4.3]) for (const z of [-4.3, 4.3]) {
    mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.025, 20), brass, boardGroup, x, -0.13, z);
  }

  const labelColor = T.trim;
  for (let f = 0; f < 8; f++) labelSprite(FILES[f], f - 3.5, 4.3, labelColor);
  for (let r = 0; r < 8; r++) labelSprite(String(r + 1), 4.3, r - 3.5, labelColor);

  moveAnims = [];
  ringEffects = [];
}

function makePiece(p) {
  const theme = activePieceTheme();
  const dark = p.c === 'b';
  const mainColor = dark ? theme.black : theme.white;
  const edgeColor = dark ? theme.blackEdge : theme.whiteEdge;
  const accentColor = dark ? theme.blackAccent : theme.whiteAccent;
  const shadowColor = dark ? theme.blackShadow : theme.whiteShadow;
  const metal = dark ? theme.blackMetal : theme.whiteMetal;
  const fantasy = theme.fantasy;
  const g = new THREE.Group();

  const main = mat(mainColor, dark ? 0.24 : 0.27, metal);
  const edge = mat(edgeColor, 0.31, 0.2);
  const accent = mat(accentColor, 0.22, 0.62, fantasy ? accentColor : 0, fantasy ? 0.34 : 0);
  const shadow = mat(shadowColor, 0.4);

  const foot = [[.29,0],[.34,.04],[.34,.09],[.31,.13],[.28,.15],[.27,.19],[.24,.22],[.21,.26],[.18,.29],[.16,.33],[.14,.36],[.12,.39]];
  lathe(g, foot, edge, 0.13);
  lathe(g, [[.28,.12],[.32,.135],[.32,.17],[.29,.19]], accent, 0.13);

  const stemProfiles = {
    p: [[.11,.36],[.14,.42],[.12,.52],[.1,.61],[.13,.68],[.2,.72],[.22,.77],[.19,.8]],
    r: [[.13,.35],[.16,.42],[.15,.49],[.14,.55],[.2,.6],[.21,.65],[.18,.7],[.18,.92],[.22,.96],[.22,1],[.17,1.04]],
    n: [[.13,.35],[.16,.42],[.14,.49],[.15,.55],[.2,.6],[.22,.66],[.16,.71],[.14,.8],[.2,.91],[.24,.98],[.21,1.03]],
    b: [[.13,.35],[.16,.42],[.14,.49],[.15,.55],[.2,.61],[.21,.66],[.16,.72],[.13,.84],[.16,.94],[.22,.99],[.21,1.03]],
    q: [[.13,.35],[.16,.42],[.14,.49],[.15,.56],[.21,.61],[.23,.67],[.17,.73],[.15,.83],[.2,.91],[.27,.96],[.28,1]],
    k: [[.13,.35],[.17,.43],[.15,.51],[.15,.58],[.22,.64],[.24,.7],[.17,.76],[.16,.9],[.23,.96],[.26,1.01]]
  };
  lathe(g, stemProfiles[p.t], main, 0.13);

  const ringY = { p:.83,r:.79,n:.79,b:.79,q:1.04,k:1.05 }[p.t];
  const ringRadius = { p:.19,r:.19,n:.19,b:.18,q:.27,k:.25 }[p.t];
  lathe(g, [[ringRadius*.88,ringY],[ringRadius,ringY+.018],[ringRadius,ringY+.05],[ringRadius*.88,ringY+.065]], accent, 0.13);

  if (p.t === 'p') {
    lathe(g, [[.105,.69],[.085,.76],[.073,.85],[.09,.92],[.14,.97],[.18,1.02],[.2,1.08],[.19,1.12],[.16,1.15]], main, 0.13);
    mesh(new THREE.SphereGeometry(.19, 32, 24), main, g, 0, 1.31, 0).scale.set(1, 1.08, 1);
    mesh(new THREE.SphereGeometry(.125, 24, 16), accent, g, 0, 1.48, 0);
  } else if (p.t === 'r') {
    lathe(g, [[.19,1.02],[.22,1.08],[.22,1.17],[.24,1.2]], main, 0.13);
    mesh(new THREE.CylinderGeometry(.24, .24, .1, 32), main, g, 0, 1.35, 0);
    const count = 8;
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2;
      mesh(new THREE.BoxGeometry(.14, .14, .12), accent, g, Math.cos(a) * .19, 1.48, Math.sin(a) * .19).rotation.y = -a;
    }
  } else if (p.t === 'n') {
    const head = mesh(new THREE.SphereGeometry(.22, 24, 20), main, g, 0, 1.31, 0);
    head.scale.set(.73, 1.18, .72);
    const muzzle = mesh(new THREE.SphereGeometry(.13, 20, 16), main, g, 0, 1.19, .14);
    muzzle.scale.set(.85, .65, 1.05);
    const mane = mesh(new THREE.SphereGeometry(.18, 20, 16), shadow, g, 0, 1.39, -.06);
    mane.scale.set(.8, 1.15, .8);
    for (const x of [-.105, .105]) {
      const ear = mesh(new THREE.ConeGeometry(.055, .19, 12), accent, g, x, 1.55, -.015);
      ear.rotation.z = x < 0 ? -.2 : .2;
      mesh(new THREE.SphereGeometry(.028, 12, 10), accent, g, x * 1.35, 1.38, .13);
    }
    for (let i = 0; i < 4; i++) {
      const tuft = mesh(new THREE.ConeGeometry(.055, .17, 12), main, g, 0, 1.5 - i * .055, -.15 - i * .025);
      tuft.rotation.x = -.25;
    }
  } else if (p.t === 'b') {
    const mitre = mesh(new THREE.SphereGeometry(.19, 24, 20), main, g, 0, 1.31, 0);
    mitre.scale.set(.82, 1.12, .82);
    const slit = mesh(new THREE.BoxGeometry(.045, .25, .012), accent, g, 0, 1.34, .176);
    slit.rotation.z = .35;
    mesh(new THREE.SphereGeometry(.065, 20, 16), accent, g, 0, 1.54, 0);
  } else if (p.t === 'q') {
    mesh(new THREE.CylinderGeometry(.24, .2, .11, 32), main, g, 0, 1.12, 0);
    const height = fantasy ? 1.32 : 1.28;
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2;
      const x = Math.cos(a) * .215, z = Math.sin(a) * .215;
      const tip = mesh(new THREE.SphereGeometry(.058, 16, 12), accent, g, x, height, z);
      tip.scale.set(.8, fantasy ? 1.55 : 1.15, .8);
    }
    mesh(new THREE.SphereGeometry(fantasy ? .085 : .065, 18, 14), accent, g, 0, fantasy ? 1.4 : 1.31, 0);
  } else if (p.t === 'k') {
    mesh(new THREE.CylinderGeometry(.22, .2, .11, 32), main, g, 0, 1.16, 0);
    mesh(new THREE.BoxGeometry(.1, .38, .1), accent, g, 0, 1.42, 0);
    mesh(new THREE.BoxGeometry(.29, .09, .1), accent, g, 0, 1.48, 0);
    if (fantasy) mesh(new THREE.SphereGeometry(.075, 18, 14), accent, g, 0, 1.61, 0);
  }

  mesh(new THREE.SphereGeometry(.045, 16, 12), accent, g, 0, .37, .295).scale.set(1, .75, .35);
  g.userData.piece = p;
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function clearGroup(g) {
  g.traverse(o => {
    if (o.isMesh) {
      o.geometry?.dispose();
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
      else o.material?.dispose();
    }
  });
  g.clear();
}

function syncPieces(animateMove = null) {
  if (!pieceGroup) return;
  clearGroup(pieceGroup);
  pieceMeshes.clear();
  moveAnims = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = state.b[r][f];
    if (!p) continue;
    const g = makePiece(p);
    g.position.set(f - 3.5, 0.13, r - 3.5);
    g.userData.square = [r, f];
    pieceGroup.add(g);
    pieceMeshes.set(`${r},${f}`, g);
  }
  if (animateMove) {
    const [tr, tf] = animateMove.to;
    animateMovePiece(`${tr},${tf}`, animateMove.from, animateMove.to, 0.32);
    if (animateMove.castle) {
      animateMovePiece(`${animateMove.rookTo[0]},${animateMove.rookTo[1]}`, animateMove.rookFrom, animateMove.rookTo, 0.34);
    }
  }
}

function animateMovePiece(key, from, to, lift) {
  const group = pieceMeshes.get(key);
  if (!group) return;
  group.position.set(from[1] - 3.5, 0.13, from[0] - 3.5);
  moveAnims.push({
    group,
    from: V3(from[1] - 3.5, 0.13, from[0] - 3.5),
    to: V3(to[1] - 3.5, 0.13, to[0] - 3.5),
    start: performance.now(),
    duration: 280,
    lift
  });
}

function captureFlash(square) {
  if (!effectsGroup) return;
  const material = new THREE.MeshBasicMaterial({
    color: 0xe2b86a, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.52, 36), material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(square[1] - 3.5, 0.18, square[0] - 3.5);
  effectsGroup.add(ring);
  ringEffects.push({ mesh: ring, start: performance.now(), duration: 430 });
}

function clearHighlights() {
  if (highlightGroup) clearGroup(highlightGroup);
}

function addSquareOverlay(r, f, color, opacity, size = 0.98) {
  if (!highlightGroup) return;
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, 0.018, size), material);
  m.position.set(f - 3.5, 0.145, r - 3.5);
  highlightGroup.add(m);
}

function addTargetMarker(r, f, capture) {
  if (!highlightGroup) return;
  const material = new THREE.MeshBasicMaterial({
    color: capture ? 0xc2684b : 0x5aa37c,
    transparent: true, opacity: capture ? 0.82 : 0.75, depthWrite: false
  });
  const radius = capture ? 0.39 : 0.13;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.026, 40), material);
  m.position.set(f - 3.5, 0.157, r - 3.5);
  highlightGroup.add(m);
}

function paintHighlights() {
  if (!highlightGroup) return;
  clearHighlights();
  if (lastMove) {
    addSquareOverlay(lastMove.from[0], lastMove.from[1], 0xc8ad6e, 0.20);
    addSquareOverlay(lastMove.to[0], lastMove.to[1], 0xe0c27e, 0.30);
  }
  if (hintMove) {
    addSquareOverlay(hintMove.from[0], hintMove.from[1], 0x86c8d8, 0.38);
    addSquareOverlay(hintMove.to[0], hintMove.to[1], 0x86c8d8, 0.46);
  }
  if (selected) addSquareOverlay(selected[0], selected[1], 0xe9c96e, 0.46);
  for (const m of legalTargets) {
    addTargetMarker(m.to[0], m.to[1], !!(state.b[m.to[0]][m.to[1]] || m.ep));
  }
  if (game.over || state) {
    const st = currentStatus();
    if (st.check) {
      const k = findKingSquare(state.turn);
      if (k) addSquareOverlay(k[0], k[1], 0xc4563e, 0.58);
    }
  }
}

function findKingSquare(c) {
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = state.b[r][f];
    if (p && p.c === c && p.t === 'k') return [r, f];
  }
  return null;
}

function updateCamera() {
  const { theta, phi, radius } = orbit;
  camera.position.set(
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.cos(theta)
  );
  camera.lookAt(0, 0.15, 0);
}

function updateSceneMood() {
  const T = activeBoardTheme();
  if (scene) {
    scene.background = new THREE.Color(T.bg);
    scene.fog = new THREE.Fog(T.fog, 18, 33);
  }
  if (floorMesh) floorMesh.material.color.setHex(T.floor);
}

function init3D() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(activeBoardTheme().bg);
  scene.fog = new THREE.Fog(activeBoardTheme().fog, 18, 33);
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 80);
  raycaster = new THREE.Raycaster();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.13;

  scene.add(new THREE.HemisphereLight(0xdce9ee, 0x453222, 2.1));
  const key = new THREE.DirectionalLight(0xffe6bd, 3.2);
  key.position.set(-5, 10, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1536, 1536);
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -7;
  key.shadow.bias = -0.00015;
  key.shadow.normalBias = 0.025;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb8d8dc, 1.25);
  fill.position.set(6, 7, -5);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffd69a, 1);
  rim.position.set(-6, 4, -7);
  scene.add(rim);

  floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat(activeBoardTheme().floor, 0.95));
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -0.63;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  createBoard();
  syncPieces();
  resize();
  new ResizeObserver(resize).observe(boardFrame);
  window.addEventListener('resize', resize);
  updateCamera();

  renderer.setAnimationLoop(loop);
  loading.classList.add('hidden');
}

function resize() {
  if (!renderer || !camera) return;
  const w = Math.max(1, boardFrame.clientWidth);
  const h = Math.max(1, boardFrame.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function loop(t) {
  if (!renderer) return;
  const now = performance.now();
  if (moveAnims.length) {
    for (const anim of moveAnims) {
      const p = clamp((now - anim.start) / anim.duration, 0, 1);
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      anim.group.position.x = anim.from.x + (anim.to.x - anim.from.x) * ease;
      anim.group.position.z = anim.from.z + (anim.to.z - anim.from.z) * ease;
      anim.group.position.y = 0.13 + Math.sin(Math.PI * p) * anim.lift;
      if (p >= 1) {
        anim.group.position.copy(anim.to);
        anim.done = true;
      }
    }
    moveAnims = moveAnims.filter(a => !a.done);
  }
  if (ringEffects.length) {
    for (const fx of ringEffects) {
      const p = clamp((now - fx.start) / fx.duration, 0, 1);
      fx.mesh.material.opacity = 0.75 * (1 - p);
      fx.mesh.scale.setScalar(0.9 + p * 1.25);
      if (p >= 1) {
        effectsGroup.remove(fx.mesh);
        fx.mesh.geometry.dispose();
        fx.mesh.material.dispose();
        fx.done = true;
      }
    }
    ringEffects = ringEffects.filter(f => !f.done);
  }
  if (game.spectator && !pointer) {
    orbit.theta += 0.0014;
    updateCamera();
  }
  renderer.render(scene, camera);
}

/* ------------------------------------------------------------------ */
/* Game flow                                                          */
/* ------------------------------------------------------------------ */

function currentStatus() {
  return gameStatus(state, { kingOfHill: game.variant === 'koth' });
}

function isPlayerTurn() {
  if (game.mode !== 'computer') return true;
  return state.turn === game.playerColor;
}

function settleClock() {
  if (!game.clocks || !game.started || game.over || game.paused) return;
  const now = performance.now();
  const side = state.turn;
  const elapsed = Math.max(0, now - game.lastTick);
  game.clocks[side] = Math.max(0, game.clocks[side] - elapsed);
  game.lastTick = now;
}

function pauseGameClock() {
  if (!game.clocks || !game.started || game.over || game.paused) return;
  settleClock();
  game.paused = true;
}

function resumeGameClock() {
  if (!game.clocks || game.over || !game.paused) return;
  game.paused = false;
  if (game.started) game.lastTick = performance.now();
}

function repetitionCount() {
  const key = positionKey(state);
  let count = 1;
  for (const h of history) {
    if (positionKey(h.state) === key) count++;
  }
  return count;
}

function commitMove(move, opts = {}) {
  if (!move || game.over) return;
  const mover = state.turn;
  if (game.clocks && !game.started) {
    game.started = true;
    game.lastTick = performance.now();
  } else {
    settleClock();
  }
  if (game.clocks && game.clocks[mover] <= 0) {
    game.clocks[mover] = 0;
    endGame({ winner: opposite(mover), reason: 'timeout', check: false });
    return;
  }

  const pre = cloneState(state);
  const clocksBefore = game.clocks ? { ...game.clocks } : null;
  const capturedBefore = {
    w: capturedBy.w.map(p => ({ ...p })),
    b: capturedBy.b.map(p => ({ ...p }))
  };
  const notation = moveToSan(state, move);
  const piece = state.b[move.from[0]][move.from[1]];
  const victim = state.b[move.to[0]][move.to[1]]
    || (move.ep ? state.b[move.from[0]][move.to[1]] : null);

  history.push({
    state: pre,
    clocks: clocksBefore,
    captured: capturedBefore,
    notation,
    move,
    byAI: !!opts.byAI,
    started: game.started,
    grade: null,
    bestSan: null,
    loss: null
  });

  state = applyMove(state, move);
  if (victim) capturedBy[piece.c].push({ ...victim });

  if (game.clocks) {
    game.clocks[mover] += TIME_CONTROLS[game.timeKey].inc;
    game.lastTick = performance.now();
  }

  lastMove = move;
  selected = null;
  legalTargets = [];
  hintMove = null;
  game.analysis = null;
  syncPieces(move);
  if (victim) captureFlash(move.to);
  paintHighlights();
  updateUI();

  const status = currentStatus();
  if (status.over) {
    endGame(status);
    return;
  }
  if (repetitionCount() >= 3) {
    endGame({ winner: null, reason: 'repetition', check: false });
    return;
  }

  if (status.check) {
    sound('check');
    notify(`${state.turn === 'w' ? 'White' : 'Black'} is in check`);
  } else if (move.castle) {
    sound('castle');
  } else if (victim) {
    sound('capture');
  } else {
    sound('move');
  }

  if (!game.over) {
    if (game.mode === 'computer' && state.turn !== game.playerColor) maybeAIMove();
    else if (opts.byAI) notify('Your move.');
  }
}

function maybeAIMove() {
  if (game.mode !== 'computer' || game.over || game.spectator) return;
  if (state.turn === game.playerColor) return;
  const id = game.id;
  const token = ++aiToken;
  game.thinking = true;
  updateUI();

  setTimeout(() => {
    if (game.id !== id || game.over || token !== aiToken) return;
    let result = null;
    try {
      result = findBestMove(state, {
        difficulty: game.difficulty,
        style: game.style,
        adaptive: game.adaptive,
        form: rivalForm(),
        kingOfHill: game.variant === 'koth',
        historyMoves: history.map(h => ({ from: h.move.from, to: h.move.to }))
      });
    } catch (err) {
      console.error('Rival search failed', err);
    }
    if (game.id !== id || game.over || token !== aiToken) return;
    game.thinking = false;
    if (result?.move) {
      commitMove(result.move, { byAI: true });
    } else {
      updateUI();
      notify('The rival has no legal reply.');
    }
  }, 260);
}

function undoMove() {
  if (game.over || !history.length || game.thinking || game.spectator || game.paused) return;
  aiToken++;
  hintToken++;
  let restored = null;
  let steps = 0;
  do {
    const entry = history.pop();
    if (!entry) break;
    restored = entry;
    state = cloneState(entry.state);
    capturedBy = {
      w: entry.captured.w.map(p => ({ ...p })),
      b: entry.captured.b.map(p => ({ ...p }))
    };
    game.started = entry.started;
    game.clocks = entry.clocks ? { ...entry.clocks } : game.clocks;
    steps++;
    if (game.mode !== 'computer') break;
  } while (state.turn !== game.playerColor && history.length);

  selected = null;
  legalTargets = [];
  hintMove = null;
  lastMove = history.length ? history[history.length - 1].move : null;
  game.over = false;
  game.result = null;
  game.thinking = false;
  game.analysis = null;
  game.profileRecorded = false;
  game.lastTick = performance.now();
  game.paused = false;
  gameOverEl.hidden = true;
  syncPieces();
  paintHighlights();
  updateUI();
  sound('click');
  notify(steps > 1 ? 'Two moves taken back.' : 'Move taken back.');
}

function requestHint() {
  if (game.mode !== 'computer' || game.over || game.thinking || game.spectator || game.paused) return;
  if (state.turn !== game.playerColor) {
    notify('Wait for the rival to move.');
    return;
  }
  const id = game.id;
  const token = ++hintToken;
  notify('Reading the board…');
  setTimeout(() => {
    if (game.id !== id || game.over || token !== hintToken) return;
    let result = null;
    try {
      result = findBestMove(state, {
        difficulty: 'club',
        depth: 2,
        timeMs: 320,
        analysis: true,
        noise: 0,
        blunder: 0,
        noBook: true,
        style: game.style,
        kingOfHill: game.variant === 'koth'
      });
    } catch (err) {
      console.error('Hint search failed', err);
    }
    if (!result?.move) { notify('No clear idea — trust your instincts.'); return; }
    hintMove = result.move;
    paintHighlights();
    sound('hint');
    notify(`Try ${moveToSan(state, result.move)} — ${hintBlurb(state, result.move)}`);
  }, 80);
}

function hintBlurb(s, move) {
  const piece = s.b[move.from[0]][move.from[1]];
  const victim = s.b[move.to[0]][move.to[1]];
  if (victim) return 'it wins material';
  if (move.castle) return 'it tucks the king away';
  if (move.promotion) return 'it crowns a pawn';
  if (piece.t === 'n' || piece.t === 'b') return 'it develops a piece';
  if (piece.t === 'p') return 'it claims space';
  if (piece.t === 'q' || piece.t === 'r') return 'it improves the heavy pieces';
  return 'it keeps the position healthy';
}

function setCameraForSide(side) {
  flipped = side === 'b';
  orbit.theta = 3 * Math.PI / 4 + (flipped ? Math.PI : 0);
  updateCamera();
}

function flipBoard() {
  flipped = !flipped;
  orbit.theta += Math.PI;
  updateCamera();
  updateUI();
  sound('click');
}

function toggleSpectator() {
  if (game.mode !== 'local') return;
  game.spectator = !game.spectator;
  prefs.spectator = game.spectator;
  savePrefs();
  if (game.spectator) {
    pauseGameClock();
    selected = null;
    legalTargets = [];
    hintMove = null;
    paintHighlights();
    sound('click');
    notify('Spectator view — board input paused.');
  } else {
    resumeGameClock();
    sound('click');
    notify('Play resumed.');
  }
  updateUI();
}

function recordProfile(result) {
  if (game.mode !== 'computer' || game.profileRecorded) return;
  game.profileRecorded = true;
  profile.games = (profile.games || 0) + 1;
  if (!result?.winner) profile.draws = (profile.draws || 0) + 1;
  else if (result.winner === game.playerColor) profile.wins = (profile.wins || 0) + 1;
  else profile.losses = (profile.losses || 0) + 1;
  profile.history.push(!result?.winner ? 'D' : result.winner === game.playerColor ? 'W' : 'L');
  if (profile.history.length > 16) profile.history = profile.history.slice(-16);
  saveProfile();
}

function endGame(result) {
  if (game.over) return;
  game.over = true;
  game.thinking = false;
  game.result = result;
  game.paused = false;
  selected = null;
  legalTargets = [];
  hintMove = null;
  aiToken++;
  syncPieces();
  paintHighlights();
  updateUI();
  recordProfile(result);
  sound('end');
  const id = game.id;
  setTimeout(() => {
    if (game.id === id && game.over) showResult();
  }, 620);
}

function startGame() {
  if (prefs.mode === 'local') syncLocalSettings();
  syncCommonSettings();
  savePrefs();

  const variant = prefs.mode === 'computer' ? 'standard' : prefs.variant;
  const playerColor = prefs.mode === 'computer'
    ? (prefs.side === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : prefs.side)
    : 'w';
  const timeKey = prefs.time;

  state = createInitialState({ chess960: variant === 'chess960' });
  history = [];
  capturedBy = { w: [], b: [] };
  selected = null;
  legalTargets = [];
  hintMove = null;
  lastMove = null;
  analysisToken++;
  aiToken++;
  hintToken++;

  const tc = TIME_CONTROLS[timeKey] || TIME_CONTROLS.unlimited;
  game = {
    id: game.id + 1,
    mode: prefs.mode,
    variant,
    playerColor,
    difficulty: prefs.difficulty,
    style: prefs.style,
    adaptive: prefs.adaptive,
    timeKey,
    spectator: prefs.mode === 'local' && prefs.spectator,
    over: false,
    result: null,
    thinking: false,
    started: false,
    paused: prefs.mode === 'local' && prefs.spectator,
    clocks: tc.base ? { w: tc.base, b: tc.base } : null,
    lastTick: performance.now(),
    profileRecorded: false,
    analysis: null
  };

  setupModal.hidden = true;
  appearanceModal.hidden = true;
  gameOverEl.hidden = true;
  document.body.classList.remove('modal-open');

  syncPieces();
  paintHighlights();
  setCameraForSide(playerColor);
  updateUI();

  if (game.mode === 'computer') {
    if (playerColor === 'w') notify('You have White. Your move.');
    else notify('The rival has White and moves first.');
    if (playerColor === 'b') setTimeout(() => maybeAIMove(), 520);
  } else if (game.spectator) {
    notify('Spectator view — resume play when you are ready.');
  } else if (variant === 'chess960') {
    notify('Chess960 — a brand new back rank.');
  } else if (variant === 'koth') {
    notify('King of the Hill — reach the centre to win.');
  } else {
    notify('White to move.');
  }
}

/* End of part 3 */

/* ------------------------------------------------------------------ */
/* Interface rendering                                                */
/* ------------------------------------------------------------------ */

function topSide() { return flipped ? 'w' : 'b'; }

function updateClocks() {
  const timed = !!game.clocks;
  el.whiteClock.hidden = !timed;
  el.blackClock.hidden = !timed;
  if (!timed) return;
  const now = performance.now();
  const top = topSide();
  for (const side of ['w', 'b']) {
    let ms = game.clocks[side];
    if (game.started && !game.over && !game.paused && state.turn === side) {
      ms -= Math.max(0, now - game.lastTick);
    }
    ms = Math.max(0, ms);
    const node = side === top ? el.blackClock : el.whiteClock;
    node.textContent = formatClock(ms, ms < 20000);
    node.classList.toggle('low', ms <= 30000);
    node.classList.toggle('active-clock', game.started && !game.over && state.turn === side && !game.paused);
  }
}

function updateUI() {
  if (!el.turnValue) return;
  const status = currentStatus();
  const whiteTurn = state.turn === 'w';
  const top = topSide();
  const bottom = opposite(top);

  el.turnValue.textContent = whiteTurn ? 'White' : 'Black';
  el.turnIcon.textContent = whiteTurn ? '♙' : '♟';
  el.turnBox.classList.toggle('in-check', status.check);
  el.turnBox.classList.toggle('game-ended', game.over);

  el.blackCard.classList.toggle('active', state.turn === top && !game.over);
  el.whiteCard.classList.toggle('active', state.turn === bottom && !game.over);

  const checkLine = status.check ? 'In check — find safety' : '';
  const lineFor = (side) => {
    if (game.over) return 'Game complete';
    if (game.spectator) return 'Spectator view';
    if (game.mode === 'computer') {
      if (game.thinking && state.turn !== game.playerColor) {
        return state.turn === side ? 'Thinking…' : (side === game.playerColor ? 'Your move' : 'Waiting');
      }
      if (state.turn === side) {
        return side === game.playerColor ? (checkLine || 'Your move') : (checkLine || 'Rival to move');
      }
      return side === game.playerColor ? 'Waiting' : 'Waiting';
    }
    return state.turn === side ? (checkLine || 'To move') : 'Waiting';
  };
  const nameFor = (side) => {
    if (game.mode === 'computer') return side === game.playerColor ? 'You' : 'The rival';
    return side === 'w' ? 'White pieces' : 'Black pieces';
  };
  const tagFor = (side) => {
    if (game.mode === 'computer') return side === game.playerColor ? 'YOU' : 'RIVAL';
    return side === 'w' ? 'PLAYER 1' : 'PLAYER 2';
  };
  const glyphFor = (side) => side === 'w' ? '♔' : '♚';

  el.blackName.textContent = nameFor(top);
  el.whiteName.textContent = nameFor(bottom);
  el.blackTag.textContent = tagFor(top);
  el.whiteTag.textContent = tagFor(bottom);
  el.blackAvatar.textContent = glyphFor(top);
  el.whiteAvatar.textContent = glyphFor(bottom);
  el.blackAvatar.className = 'avatar ' + (top === 'w' ? 'light-avatar' : 'dark-avatar');
  el.whiteAvatar.className = 'avatar ' + (bottom === 'w' ? 'light-avatar' : 'dark-avatar');
  el.blackSub.textContent = lineFor(top);
  el.whiteSub.textContent = lineFor(bottom);
  el.blackCaptured.textContent = capturedBy[top].map(p => GLYPHS[opposite(top) + p.t]).join('');
  el.whiteCaptured.textContent = capturedBy[bottom].map(p => GLYPHS[opposite(bottom) + p.t]).join('');
  updateClocks();

  const tc = TIME_CONTROLS[game.timeKey] || TIME_CONTROLS.unlimited;
  const modeLabel = game.mode === 'computer' ? 'VS COMPUTER' : 'LOCAL 1V1';
  el.modeBadge.textContent = modeLabel;
  el.modeBadge.classList.toggle('local', game.mode === 'local');
  if (game.mode === 'computer') {
    el.modeDetail.textContent = `${DIFFICULTY_LABEL[game.difficulty]} · ${STYLE_LABEL[game.style]}`;
  } else {
    el.modeDetail.textContent = `${VARIANT_LABEL[game.variant]} · ${tc.label}`;
  }

  el.modeCaption.textContent = game.mode === 'computer'
    ? 'ADAPTIVE RIVAL · OFFLINE'
    : `${VARIANT_LABEL[game.variant].toUpperCase()} · PASS & PLAY`;
  el.panelKicker.textContent = game.mode === 'computer' ? 'YOUR RIVAL AWAITS' : 'SHARE THE BOARD';
  el.panelTitle.innerHTML = game.mode === 'computer' ? 'Make your<br><em>move.</em>' : 'Two minds.<br><em>One board.</em>';
  el.panelDescription.innerHTML = game.mode === 'computer'
    ? `A ${DIFFICULTY_LABEL[game.difficulty].toLowerCase()} rival with a ${STYLE_LABEL[game.style].toLowerCase()} temperament.${game.adaptive ? '<br class="wide-only"> It learns from every game.' : ''}`
    : `${VARIANT_LABEL[game.variant]} chess,${game.variant === 'koth' ? ' centre-square victory,' : ''} played face to face.`;
  el.panelFooter.innerHTML = game.mode === 'computer'
    ? `<span class="gold-star">✦</span> ${tc.label} <span class="footer-dot">·</span> ${game.adaptive ? `Rival form ${formLabel(rivalForm())}` : 'Fixed rival strength'}`
    : `<span class="gold-star">✦</span> Same device <span class="footer-dot">·</span> ${VARIANT_LABEL[game.variant]} <span class="footer-dot">·</span> ${tc.label}`;

  el.undo.disabled = !history.length || game.over || game.thinking || game.spectator || game.paused;
  el.hint.hidden = game.mode !== 'computer';
  el.hint.disabled = game.over || game.thinking || game.spectator || game.paused || state.turn !== game.playerColor;
  el.flip.disabled = game.paused;
  el.spectate.hidden = game.mode !== 'local';
  el.spectate.classList.toggle('active', game.spectator);
  el.spectate.textContent = game.spectator ? '◎ Resume play' : '◎ Spectate';
  el.analysis.hidden = !game.over || history.length < 4;
  const subActions = el.spectate.parentElement;
  if (subActions) subActions.hidden = el.spectate.hidden && el.analysis.hidden;

  el.spectatorBanner.hidden = !(game.spectator && game.mode === 'local');
  el.thinkingBanner.hidden = !game.thinking || game.over;
  el.moveCount.textContent = `${history.length} ${history.length === 1 ? 'MOVE' : 'MOVES'}`;
  el.sound.textContent = prefs.sound ? '♪' : '×';
  el.sound.classList.toggle('muted', !prefs.sound);
  el.sound.title = prefs.sound ? 'Sound on' : 'Sound off';

  renderMoveList();
  if (game.over) fillResult();
}

function renderMoveList() {
  if (!history.length) {
    moveListEl.innerHTML = '<div class="empty-state"><span>♟</span><br>Your game begins with a single move.</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < history.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'move-row';
    const first = history[i];
    const second = history[i + 1];
    const mark = (h) => h?.grade
      ? `<i class="grade-dot ${h.grade}" title="${gradeLabel(h.grade)}"></i>`
      : '';
    row.innerHTML = `<span class="move-index">${String(i / 2 + 1).padStart(2, '0')}.</span>` +
      `<span class="move-cell">${first.notation}${mark(first)}</span>` +
      `<span class="move-cell">${second ? second.notation + mark(second) : ''}</span>`;
    fragment.appendChild(row);
  }
  moveListEl.innerHTML = '';
  moveListEl.appendChild(fragment);
  moveListEl.scrollTop = moveListEl.scrollHeight;
}

function gradeLabel(grade) {
  return { best: 'Best move', good: 'Good', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' }[grade] || '';
}

function fillResult() {
  if (!game.result) return;
  const info = resultText(game.result);
  el.resultTitle.textContent = info.title;
  el.resultCopy.textContent = info.copy;
  el.resultEmblem.textContent = game.result.winner ? '♛' : '½';
  el.resultKicker.textContent = game.result.winner ? 'THE GAME IS DECIDED' : 'HONOURS EVEN';
  const tc = TIME_CONTROLS[game.timeKey] || TIME_CONTROLS.unlimited;
  const moves = Math.ceil(history.length / 2);
  const pieces = game.mode === 'computer'
    ? `${DIFFICULTY_LABEL[game.difficulty]} rival · ${STYLE_LABEL[game.style]}`
    : `${VARIANT_LABEL[game.variant]} · local`;
  const accuracy = game.analysis?.accuracy != null ? ` · ${game.analysis.accuracy}% accuracy` : '';
  el.resultStats.textContent = `${moves} ${moves === 1 ? 'move' : 'moves'} · ${pieces} · ${tc.label}${accuracy}`;
  document.querySelector('#analyse-button').textContent = game.analysis?.done ? '▤ View game report' : '▤ Analyse game';
  if (game.analysis?.done) {
    el.resultStats.textContent = `${moves} ${moves === 1 ? 'move' : 'moves'} · ${pieces} · ${accuracy.replace(' · ', '')}`;
  }
}

function showResult() {
  if (!game.result) return;
  fillResult();
  el.resultMain.hidden = false;
  el.analysisPanel.hidden = true;
  gameOverEl.hidden = false;
  document.body.classList.add('modal-open');
  updateUI();
}

/* ------------------------------------------------------------------ */
/* Coach / game analysis                                              */
/* ------------------------------------------------------------------ */

function classifyLoss(loss) {
  if (loss <= 18) return 'best';
  if (loss <= 50) return 'good';
  if (loss <= 110) return 'inaccuracy';
  if (loss <= 230) return 'mistake';
  return 'blunder';
}

function gradeIcon(grade) {
  return { best: '★', good: '✓', inaccuracy: '?!', mistake: '?', blunder: '??' }[grade] || '';
}

function analysisRow(entry, index) {
  const num = Math.floor(index / 2) + 1;
  const prefix = index % 2 === 0 ? `${num}.` : `${num}…`;
  const bestLine = entry.bestSan && entry.bestSan !== entry.notation
    ? `<span class="analysis-best">Best: <b>${entry.bestSan}</b></span>`
    : '<span class="analysis-best muted">Top choice</span>';
  return `<div class="analysis-row">
    <span class="analysis-num">${prefix}</span>
    <span class="analysis-move">${entry.notation}</span>
    <span class="analysis-grade ${entry.grade}"><i>${gradeIcon(entry.grade)}</i>${gradeLabel(entry.grade)}</span>
    ${bestLine}
  </div>`;
}

function invalidateAnalysis() {
  analysisToken++;
  game.analysis = null;
  el.analysisPanel.hidden = true;
  el.resultMain.hidden = false;
  el.analysisList.innerHTML = '';
  el.analysisSummary.innerHTML = '';
  el.analysisScore.textContent = '—';
  el.analysisProgress.textContent = 'Reading the game…';
  el.analysisBar.style.width = '0%';
}

function showAnalysisPanel() {
  el.resultMain.hidden = true;
  el.analysisPanel.hidden = false;
  gameOverEl.hidden = false;
  document.body.classList.add('modal-open');
}

async function runAnalysis() {
  if (!history.length) return;
  if (game.analysis?.done) {
    showAnalysisPanel();
    return;
  }
  if (game.analysis?.running) {
    showAnalysisPanel();
    return;
  }
  const id = game.id;
  const token = ++analysisToken;
  const entries = history.slice();
  const total = entries.length;
  game.analysis = { running: true, done: false, accuracy: null };
  showAnalysisPanel();
  el.analysisList.innerHTML = '';
  el.analysisSummary.innerHTML = '';
  el.analysisScore.textContent = '…';
  el.analysisProgress.textContent = 'Reading the game…';
  el.analysisBar.style.width = '0%';
  updateUI();

  let totalLoss = 0;
  let bestCount = 0;
  let blunders = 0;
  let mistakes = 0;
  let inaccuracies = 0;

  for (let i = 0; i < entries.length; i++) {
    if (token !== analysisToken || id !== game.id) return;
    const entry = entries[i];
    const pre = entry.state;
    let best = null;
    try {
      best = findBestMove(pre, {
        depth: 2, timeMs: 55, analysis: true, noise: 0, blunder: 0, noBook: true,
        style: 'balanced', kingOfHill: game.variant === 'koth'
      });
    } catch (err) { console.error('Review search failed', err); }

    let bestScore = best ? best.score : evaluateState(pre, 'balanced', game.variant === 'koth');
    let playedScore;
    const after = applyMove(pre, entry.move);
    const afterStatus = gameStatus(after, { kingOfHill: game.variant === 'koth' });
    if (afterStatus.over) {
      playedScore = afterStatus.winner === pre.turn ? MATE - 10 : (afterStatus.winner ? -MATE + 10 : 0);
    } else {
      let reply = null;
      try {
        reply = findBestMove(after, {
          depth: 1, timeMs: 24, analysis: true, noise: 0, blunder: 0, noBook: true,
          style: 'balanced', kingOfHill: game.variant === 'koth'
        });
      } catch (err) { console.error('Review reply failed', err); }
      playedScore = reply ? -reply.score : -evaluateState(after, 'balanced', game.variant === 'koth');
    }
    if (best && same(best.move.from, entry.move.from) && same(best.move.to, entry.move.to)) {
      if (bestScore > MATE / 2) bestScore = MATE - 10;
      playedScore = bestScore;
    }
    bestScore = clamp(bestScore, -MATE + 50, MATE - 50);
    playedScore = clamp(playedScore, -MATE + 50, MATE - 50);
    const loss = Math.max(0, Math.min(800, Math.round(bestScore - playedScore)));
    const grade = classifyLoss(loss);
    const isBest = !!best?.move && same(best.move.from, entry.move.from) && same(best.move.to, entry.move.to);
    entry.loss = loss;
    entry.grade = grade;
    entry.bestSan = best?.move && !isBest ? moveToSan(pre, best.move) : null;
    if (grade === 'best') bestCount++;
    else if (grade === 'blunder') blunders++;
    else if (grade === 'mistake') mistakes++;
    else if (grade === 'inaccuracy') inaccuracies++;
    totalLoss += loss;

    el.analysisList.insertAdjacentHTML('beforeend', analysisRow(entry, i));
    el.analysisList.scrollTop = el.analysisList.scrollHeight;
    const pct = Math.round(((i + 1) / total) * 100);
    el.analysisBar.style.width = pct + '%';
    el.analysisProgress.textContent = `Evaluating move ${i + 1} of ${total}…`;
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }

  if (token !== analysisToken || id !== game.id) return;
  const accuracy = clamp(Math.round(100 - (totalLoss / Math.max(1, total)) * 0.34 - blunders * 1.2), 0, 100);
  game.analysis = { running: false, done: true, accuracy };
  el.analysisScore.textContent = `${accuracy}%`;
  el.analysisProgress.textContent = 'Review complete';
  el.analysisBar.style.width = '100%';
  el.analysisSummary.innerHTML = `
    <div class="summary-stat"><b>${accuracy}%</b><span>accuracy</span></div>
    <div class="summary-stat"><b>${bestCount}</b><span>best moves</span></div>
    <div class="summary-stat warn"><b>${inaccuracies + mistakes}</b><span>inaccuracies</span></div>
    <div class="summary-stat bad"><b>${blunders}</b><span>blunders</span></div>`;
  if (game.mode === 'computer') {
    profile.lastAccuracy = accuracy;
    profile.lastBlunders = blunders;
    saveProfile();
  }
  renderMoveList();
  fillResult();
  updateUI();
}

/* End of part 4 */

/* ------------------------------------------------------------------ */
/* Setup, themes and appearance                                       */
/* ------------------------------------------------------------------ */

function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }

function updateModalState() {
  const open = !setupModal.hidden || !appearanceModal.hidden || !gameOverEl.hidden;
  document.body.classList.toggle('modal-open', open);
}

function syncCommonSettings() {
  prefs.style = $('#style-select').value;
  prefs.side = $('#side-select').value;
  prefs.time = $('#time-select').value;
  prefs.adaptive = $('#adaptive-toggle').checked;
  if (prefs.mode === 'local') {
    prefs.variant = $('#variant-select').value;
    prefs.spectator = $('#spectator-toggle').checked;
  }
  savePrefs();
}

function syncLocalSettings() {
  prefs.variant = $('#variant-select').value;
  prefs.spectator = $('#spectator-toggle').checked;
}

function updateSetupReadout() {
  document.querySelectorAll('#difficulty-group button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === prefs.difficulty);
  });
  $('#difficulty-hint').textContent = DIFFICULTY_HINT[prefs.difficulty] || '';
  document.querySelectorAll('.mode-tab').forEach(tab => {
    const active = tab.dataset.mode === prefs.mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $('#computer-options').hidden = prefs.mode !== 'computer';
  $('#local-options').hidden = prefs.mode !== 'local';

  const form = rivalForm();
  const readout = $('#form-readout');
  if (prefs.adaptive) {
    readout.innerHTML = `Rival form · <b>${formLabel(form)}</b> · ${profile.history.length ? `${profile.wins || 0}W–${profile.losses || 0}L` : 'no games yet'}`;
  } else {
    readout.innerHTML = 'Rival form · <b>fixed</b> · adaptive learning off';
  }

  const tc = TIME_CONTROLS[prefs.time] || TIME_CONTROLS.unlimited;
  const side = prefs.mode === 'computer'
    ? (prefs.side === 'random' ? 'a random side' : prefs.side === 'w' ? 'White' : 'Black')
    : 'two players';
  const variant = prefs.mode === 'local' ? VARIANT_LABEL[prefs.variant] : 'Standard';
  const board = BOARD_THEMES[prefs.boardTheme]?.label || 'Walnut';
  $('#setup-note').textContent = `${prefs.mode === 'computer' ? `You play ${side}` : 'Local 1v1'} · ${variant} · ${tc.label} · ${board}`;
  $('#start-game').innerHTML = `Start match <span>→</span>`;
}

function openSetup() {
  pauseGameClock();
  document.querySelectorAll('.mode-tab').forEach(tab => {
    const active = tab.dataset.mode === prefs.mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('#difficulty-group button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === prefs.difficulty);
  });
  $('#style-select').value = prefs.style;
  $('#side-select').value = prefs.side;
  $('#variant-select').value = prefs.variant;
  $('#time-select').value = prefs.time;
  $('#adaptive-toggle').checked = !!prefs.adaptive;
  $('#spectator-toggle').checked = !!prefs.spectator;
  updateSetupReadout();
  gameOverEl.hidden = true;
  appearanceModal.hidden = true;
  setupModal.hidden = false;
  updateModalState();
}

function closeSetup() {
  setupModal.hidden = true;
  if (appearanceModal.hidden) resumeGameClock();
  updateModalState();
}

function openAppearance() {
  pauseGameClock();
  renderThemeOptions();
  $('#sound-toggle').checked = !!prefs.sound;
  appearanceModal.hidden = false;
  updateModalState();
}

function closeAppearance() {
  appearanceModal.hidden = true;
  if (setupModal.hidden) resumeGameClock();
  updateModalState();
}

function renderThemeOptions() {
  const boardGrid = $('#board-theme-grid');
  boardGrid.innerHTML = '';
  for (const [key, theme] of Object.entries(BOARD_THEMES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-option' + (prefs.boardTheme === key ? ' active' : '');
    btn.dataset.theme = key;
    const c1 = hex(theme.tileA), c2 = hex(theme.tileB), frame = hex(theme.wood);
    btn.innerHTML = `<span class="swatch" style="background:linear-gradient(135deg,${c1} 0 50%,${c2} 50% 100%);box-shadow:inset 0 0 0 3px ${frame}"></span>` +
      `<span class="theme-copy"><strong>${theme.label}</strong><small>${key === 'noir' ? 'Cool graphite' : key === 'marble' ? 'Stone & sage' : key === 'emerald' ? 'Forest club' : 'Warm timber'}</small></span>`;
    boardGrid.appendChild(btn);
  }

  const pieceGrid = $('#piece-theme-grid');
  pieceGrid.innerHTML = '';
  for (const [key, theme] of Object.entries(PIECE_THEMES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-option piece-theme' + (prefs.pieceTheme === key ? ' active' : '');
    btn.dataset.piece = key;
    btn.innerHTML = `<span class="piece-swatch" style="background:linear-gradient(145deg,${hex(theme.white)},${hex(theme.whiteEdge)});color:${hex(theme.black)};border-color:${hex(theme.whiteAccent)}">♞</span>` +
      `<span class="theme-copy"><strong>${theme.label}</strong><small>${theme.sub}</small></span>`;
    pieceGrid.appendChild(btn);
  }
}

function setBoardTheme(key) {
  if (!BOARD_THEMES[key]) return;
  prefs.boardTheme = key;
  savePrefs();
  applyAppearance();
  renderThemeOptions();
  updateSetupReadout();
  sound('click');
}

function setPieceTheme(key) {
  if (!PIECE_THEMES[key]) return;
  prefs.pieceTheme = key;
  savePrefs();
  applyAppearance();
  renderThemeOptions();
  updateSetupReadout();
  sound('click');
}

function applyAppearance() {
  updateSceneMood();
  if (!scene) return;
  const hadBoard = !!boardGroup;
  if (hadBoard) disposeGroup(boardGroup);
  boardGroup = pieceGroup = highlightGroup = effectsGroup = null;
  pieceMeshes = new Map();
  squareMeshes = [];
  createBoard();
  syncPieces();
  paintHighlights();
}

function resetPreferences() {
  prefs = { ...DEFAULT_PREFS };
  savePrefs();
  renderThemeOptions();
  applyAppearance();
  updateSetupReadout();
}

/* ------------------------------------------------------------------ */
/* Input                                                              */
/* ------------------------------------------------------------------ */

function canInteract() {
  if (game.over || game.paused || game.spectator) return false;
  if (!isPlayerTurn()) return false;
  return true;
}

function handleSquare(pos) {
  if (!canInteract()) return;
  const [r, f] = pos;
  if (selected) {
    const chosen = legalTargets.find(m => same(m.to, pos));
    if (chosen) {
      commitMove(chosen);
      return;
    }
  }
  const p = state.b[r][f];
  if (p && p.c === state.turn && (game.mode !== 'computer' || p.c === game.playerColor)) {
    const changed = !same(selected, pos);
    selected = pos;
    legalTargets = legalMoves(state, r, f);
    hintMove = null;
    paintHighlights();
    if (changed) sound('select');
    return;
  }
  if (selected) {
    selected = null;
    legalTargets = [];
    paintHighlights();
  }
}

function hitTest(event) {
  const rect = canvas.getBoundingClientRect();
  const pointerNdc = new THREE.Vector2(
    (event.clientX - rect.left) / rect.width * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(pieceGroup.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o && o !== pieceGroup && !o.userData.square) o = o.parent;
    if (o?.userData.square) return o.userData.square;
  }
  const squares = raycaster.intersectObjects(squareMeshes, false);
  return squares[0]?.object.userData.square || null;
}

canvas.addEventListener('pointerdown', e => {
  if (e.button !== undefined && e.button !== 0) return;
  ensureAudio();
  pointer = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, id: e.pointerId };
  dragged = false;
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!pointer) return;
  const dx = e.clientX - pointer.lastX, dy = e.clientY - pointer.lastY;
  if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 5) dragged = true;
  if (dragged) {
    orbit.theta -= dx * 0.008;
    orbit.phi = clamp(orbit.phi + dy * 0.006, 0.35, 1.13);
    updateCamera();
  }
  pointer.lastX = e.clientX;
  pointer.lastY = e.clientY;
});
canvas.addEventListener('pointerup', e => {
  if (!pointer) return;
  const wasDrag = dragged;
  pointer = null;
  if (!wasDrag) {
    const sq = hitTest(e);
    if (sq) handleSquare(sq);
  }
});
canvas.addEventListener('pointercancel', () => { pointer = null; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  orbit.radius = clamp(orbit.radius + Math.sign(e.deltaY) * 0.7, 10, 19);
  updateCamera();
}, { passive: false });

/* End of part 5 */

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    prefs.mode = tab.dataset.mode;
    savePrefs();
    updateSetupReadout();
    sound('click');
  });
});

document.querySelectorAll('#difficulty-group button').forEach(btn => {
  btn.addEventListener('click', () => {
    prefs.difficulty = btn.dataset.value;
    savePrefs();
    updateSetupReadout();
    sound('click');
  });
});

['#style-select', '#side-select', '#variant-select', '#time-select'].forEach(sel => {
  $(sel).addEventListener('change', () => {
    syncCommonSettings();
    updateSetupReadout();
    sound('click');
  });
});

$('#adaptive-toggle').addEventListener('change', e => {
  prefs.adaptive = e.target.checked;
  savePrefs();
  updateSetupReadout();
  sound('click');
});
$('#spectator-toggle').addEventListener('change', e => {
  prefs.spectator = e.target.checked;
  savePrefs();
  updateSetupReadout();
  sound('click');
});

$('#start-game').addEventListener('click', () => { ensureAudio(); startGame(); });

$('#appearance-button').addEventListener('click', openAppearance);
$('#appearance-close').addEventListener('click', closeAppearance);
$('#theme-button').addEventListener('click', openAppearance);
$('#setup-close').addEventListener('click', closeSetup);

$('#board-theme-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-theme]');
  if (b) setBoardTheme(b.dataset.theme);
});
$('#piece-theme-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-piece]');
  if (b) setPieceTheme(b.dataset.piece);
});

$('#sound-toggle').addEventListener('change', e => {
  prefs.sound = e.target.checked;
  savePrefs();
  updateUI();
  if (prefs.sound) { ensureAudio(); sound('click'); }
});
$('#sound-button').addEventListener('click', () => {
  prefs.sound = !prefs.sound;
  savePrefs();
  if (prefs.sound) { ensureAudio(); sound('click'); notify('Sound on'); }
  else notify('Sound off');
  updateUI();
});

$('#new-game').addEventListener('click', () => {
  sound('click');
  openSetup();
});
$('#undo-button').addEventListener('click', undoMove);
$('#hint-button').addEventListener('click', requestHint);
$('#flip-button').addEventListener('click', flipBoard);
$('#spectate-button').addEventListener('click', toggleSpectator);
$('#analysis-button').addEventListener('click', () => {
  gameOverEl.hidden = false;
  updateModalState();
  runAnalysis();
});

$('#analyse-button').addEventListener('click', runAnalysis);
$('#rematch-button').addEventListener('click', () => {
  gameOverEl.hidden = true;
  updateModalState();
  startGame();
});
$('#setup-button').addEventListener('click', () => {
  gameOverEl.hidden = true;
  updateModalState();
  openSetup();
});
$('#analysis-close').addEventListener('click', () => {
  el.analysisPanel.hidden = true;
  el.resultMain.hidden = false;
});

setupModal.addEventListener('click', e => { if (e.target === setupModal) closeSetup(); });
appearanceModal.addEventListener('click', e => { if (e.target === appearanceModal) closeAppearance(); });

window.addEventListener('keydown', e => {
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const key = e.key.toLowerCase();
  if (e.key === 'Escape') {
    if (!appearanceModal.hidden) { closeAppearance(); return; }
    if (!setupModal.hidden) { closeSetup(); return; }
    if (selected) {
      selected = null;
      legalTargets = [];
      hintMove = null;
      paintHighlights();
    }
    return;
  }
  if (key === 'u') undoMove();
  else if (key === 'h') requestHint();
  else if (key === 'f') flipBoard();
});

/* Keep the clocks alive without re-rendering the whole interface. */
setInterval(() => {
  if (!game.started || game.over || game.paused || !game.clocks) return;
  updateClocks();
  const side = state.turn;
  const remaining = game.clocks[side] - Math.max(0, performance.now() - game.lastTick);
  if (remaining <= 0) {
    game.clocks[side] = 0;
    endGame({ winner: opposite(side), reason: 'timeout', check: false });
  }
}, 180);

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

try {
  init3D();
} catch (err) {
  console.error('Could not start the 3D board', err);
  loading.innerHTML = '<span style="color:#d8bd83">The 3D board could not start.</span><span>Please reload the page.</span>';
}

paintHighlights();
updateUI();
updateModalState();
setTimeout(() => {
  if (setupModal.hidden) openSetup();
}, 80);

/* Small, unobtrusive debug surface used by automated visual checks. */
window.__gambit = {
  snapshot: () => ({
    turn: state.turn,
    selected,
    legalTargets: legalTargets.map(m => m.to),
    history: history.map(h => h.notation),
    mode: game.mode,
    variant: game.variant,
    layout: state.layout,
    over: game.over,
    thinking: game.thinking,
    spectator: game.spectator,
    result: game.result,
    clocks: game.clocks ? { ...game.clocks } : null,
    analysis: game.analysis
  }),
  project: (r, f) => {
    const v = new THREE.Vector3(f - 3.5, 0.2, r - 3.5).project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x + 1) / 2 * rect.width,
      y: rect.top + (1 - v.y) / 2 * rect.height
    };
  },
  clickSquare: (r, f) => {
    const p = window.__gambit.project(r, f);
    handleSquare([r, f]);
    return p;
  },
  setClocks: (ms) => {
    if (!game.clocks) return null;
    game.clocks.w = ms;
    game.clocks.b = ms;
    game.lastTick = performance.now() - 1100;
    return { ...game.clocks };
  }
};
