/* Pure chess rules: standard, Chess960 and King of the Hill. */
export const FILES = 'abcdefgh';
export const HOME_RANK = 'rnbqkbnr';
export const CENTER_SQUARES = [[3, 3], [3, 4], [4, 3], [4, 4]];

export function createInitialState(opts = {}) {
  const chess960 = !!opts.chess960;
  const layout = chess960 ? (opts.layout || random960Layout()) : HOME_RANK;
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let f = 0; f < 8; f++) {
    b[0][f] = { c: 'w', t: layout[f] };
    b[1][f] = { c: 'w', t: 'p' };
    b[6][f] = { c: 'b', t: 'p' };
    b[7][f] = { c: 'b', t: layout[f] };
  }
  return {
    b,
    turn: 'w',
    castle: computeCastleRights(b),
    ep: null,
    half: 0,
    full: 1,
    chess960,
    layout
  };
}

export function random960Layout() {
  const arr = Array(8).fill(null);
  const lightFiles = [1, 3, 5, 7];
  const darkFiles = [0, 2, 4, 6];
  const pick = (list) => list.splice(Math.floor(Math.random() * list.length), 1)[0];
  arr[pick(lightFiles)] = 'b';
  arr[pick(darkFiles)] = 'b';
  const empty = () => arr.map((v, i) => v === null ? i : -1).filter(i => i >= 0);
  arr[pick(empty())] = 'q';
  arr[pick(empty())] = 'n';
  arr[pick(empty())] = 'n';
  const rest = empty();
  arr[rest[0]] = 'r';
  arr[rest[1]] = 'k';
  arr[rest[2]] = 'r';
  return arr.join('');
}

function computeCastleRights(b) {
  const rights = { wK: null, wQ: null, bK: null, bQ: null };
  for (const [row, c] of [[0, 'w'], [7, 'b']]) {
    const kf = b[row].findIndex(p => p && p.c === c && p.t === 'k');
    if (kf < 0) continue;
    for (let f = kf - 1; f >= 0; f--) {
      if (b[row][f]?.c === c && b[row][f].t === 'r') { rights[c + 'Q'] = f; break; }
    }
    for (let f = kf + 1; f < 8; f++) {
      if (b[row][f]?.c === c && b[row][f].t === 'r') { rights[c + 'K'] = f; break; }
    }
  }
  return rights;
}

export function cloneState(s) {
  return {
    b: s.b.map(row => row.map(p => p && { ...p })),
    turn: s.turn,
    castle: { ...s.castle },
    ep: s.ep ? [...s.ep] : null,
    half: s.half,
    full: s.full,
    chess960: s.chess960,
    layout: s.layout
  };
}

export function same(a, b) { return !!a && !!b && a[0] === b[0] && a[1] === b[1]; }
export function inBounds(r, f) { return r >= 0 && r < 8 && f >= 0 && f < 8; }
export function opposite(c) { return c === 'w' ? 'b' : 'w'; }
export function squareName([r, f]) { return FILES[f] + (r + 1); }

export function findKing(s, c) {
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = s.b[r][f];
    if (p && p.c === c && p.t === 'k') return [r, f];
  }
  return null;
}

export function attacked(s, r, f, by) {
  const pawnDir = by === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const rr = r - pawnDir, ff = f - df;
    if (inBounds(rr, ff) && s.b[rr][ff]?.c === by && s.b[rr][ff].t === 'p') return true;
  }
  for (const [dr, df] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
    const rr = r + dr, ff = f + df;
    if (inBounds(rr, ff) && s.b[rr][ff]?.c === by && s.b[rr][ff].t === 'n') return true;
  }
  for (const [dr, df] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    let rr = r + dr, ff = f + df, dist = 1;
    while (inBounds(rr, ff)) {
      const p = s.b[rr][ff];
      if (p) {
        if (p.c === by && (p.t === 'q'
          || (p.t === 'r' && (!dr || !df))
          || (p.t === 'b' && dr && df)
          || (p.t === 'k' && dist === 1))) return true;
        break;
      }
      rr += dr; ff += df; dist++;
    }
  }
  return false;
}

export function inCheck(s, c) {
  const k = findKing(s, c);
  return !!k && attacked(s, k[0], k[1], opposite(c));
}

function pushCastles(s, r, f, out) {
  const p = s.b[r][f];
  if (!p || p.t !== 'k') return;
  const row = p.c === 'w' ? 0 : 7;
  const enemy = opposite(p.c);
  if (r !== row || inCheck(s, p.c)) return;
  for (const side of ['K', 'Q']) {
    const rf = s.castle[p.c + side];
    if (rf === null || rf === undefined) continue;
    const rook = s.b[row][rf];
    if (!rook || rook.c !== p.c || rook.t !== 'r') continue;
    const kDest = side === 'K' ? 6 : 2;
    const rDest = side === 'K' ? 5 : 3;
    const loK = Math.min(f, kDest), hiK = Math.max(f, kDest);
    const loR = Math.min(rf, rDest), hiR = Math.max(rf, rDest);
    let clear = true;
    for (let x = loK; x <= hiK && clear; x++) {
      if (x !== f && x !== rf && s.b[row][x]) clear = false;
    }
    for (let x = loR; x <= hiR && clear; x++) {
      if (x !== f && x !== rf && s.b[row][x]) clear = false;
    }
    if (!clear) continue;
    const step = Math.sign(kDest - f);
    let safe = true;
    if (step === 0) {
      safe = !attacked(s, row, kDest, enemy);
    } else {
      for (let x = f + step; ; x += step) {
        if (attacked(s, row, x, enemy)) { safe = false; break; }
        if (x === kDest) break;
      }
    }
    if (safe) out.push({
      from: [r, f], to: [row, kDest], castle: side,
      rookFrom: [row, rf], rookTo: [row, rDest]
    });
  }
}

export function pseudoMoves(s, r, f) {
  const p = s.b[r][f];
  if (!p) return [];
  const out = [];
  const add = (rr, ff, extra = {}) => {
    if (inBounds(rr, ff)) out.push({ from: [r, f], to: [rr, ff], ...extra });
  };
  if (p.t === 'p') {
    const d = p.c === 'w' ? 1 : -1;
    const start = p.c === 'w' ? 1 : 6;
    const promo = p.c === 'w' ? 7 : 0;
    if (inBounds(r + d, f) && !s.b[r + d][f]) {
      add(r + d, f, r + d === promo ? { promotion: 'q' } : {});
      if (r === start && !s.b[r + 2 * d][f]) add(r + 2 * d, f, { double: true });
    }
    for (const df of [-1, 1]) {
      const rr = r + d, ff = f + df;
      if (inBounds(rr, ff) && s.b[rr][ff] && s.b[rr][ff].c !== p.c) {
        add(rr, ff, rr === promo ? { promotion: 'q' } : {});
      }
      if (s.ep && same(s.ep, [rr, ff])) add(rr, ff, { ep: true });
    }
  } else if (p.t === 'n') {
    for (const [dr, df] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
      const rr = r + dr, ff = f + df;
      if (inBounds(rr, ff) && s.b[rr][ff]?.c !== p.c) add(rr, ff);
    }
  } else if ('brq'.includes(p.t)) {
    const dirs = [];
    if (p.t !== 'b') dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    if (p.t !== 'r') dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
    for (const [dr, df] of dirs) {
      let rr = r + dr, ff = f + df;
      while (inBounds(rr, ff)) {
        if (!s.b[rr][ff]) add(rr, ff);
        else {
          if (s.b[rr][ff].c !== p.c) add(rr, ff);
          break;
        }
        rr += dr; ff += df;
      }
    }
  } else if (p.t === 'k') {
    for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
      if (!dr && !df) continue;
      const rr = r + dr, ff = f + df;
      if (inBounds(rr, ff) && s.b[rr][ff]?.c !== p.c) add(rr, ff);
    }
    pushCastles(s, r, f, out);
  }
  return out;
}

function revokeRookRight(n, row, file) {
  for (const c of ['w', 'b']) {
    for (const side of ['K', 'Q']) {
      if (n.castle[c + side] === file && (c === 'w' ? 0 : 7) === row) n.castle[c + side] = null;
    }
  }
}

export function applyMove(s, m) {
  const n = cloneState(s);
  const [r, f] = m.from, [rr, ff] = m.to;
  const p = n.b[r][f];
  const target = n.b[rr][ff];
  if (!p) return n;

  if (m.ep) {
    n.b[r][ff] = null;
  }

  if (m.castle) {
    const rook = n.b[m.rookFrom[0]][m.rookFrom[1]];
    n.b[r][f] = null;
    n.b[m.rookFrom[0]][m.rookFrom[1]] = null;
    n.b[rr][ff] = p;
    if (rook) n.b[m.rookTo[0]][m.rookTo[1]] = rook;
  } else {
    n.b[r][f] = null;
    n.b[rr][ff] = p;
    if (m.promotion) n.b[rr][ff] = { c: p.c, t: m.promotion };
  }

  if (p.t === 'k') {
    n.castle[p.c + 'K'] = null;
    n.castle[p.c + 'Q'] = null;
  }
  if (p.t === 'r') revokeRookRight(n, r, f);
  if (target?.t === 'r') revokeRookRight(n, rr, ff);

  n.ep = m.double ? [(r + rr) / 2, f] : null;
  n.half = (p.t === 'p' || target || m.ep) ? 0 : n.half + 1;
  if (s.turn === 'b') n.full++;
  n.turn = opposite(s.turn);
  return n;
}

export function legalMoves(s, r, f) {
  const p = s.b[r][f];
  if (!p) return [];
  return pseudoMoves(s, r, f).filter(m => !inCheck(applyMove(s, m), p.c));
}

export function allMoves(s, c = s.turn) {
  const out = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    if (s.b[r][f]?.c === c) out.push(...legalMoves(s, r, f));
  }
  return out;
}

export function moveToSan(s, m) {
  const piece = s.b[m.from[0]][m.from[1]];
  if (!piece) return '?';
  const target = s.b[m.to[0]][m.to[1]];
  const capture = target || m.ep;
  let text;
  if (m.castle) {
    text = m.castle === 'K' ? 'O-O' : 'O-O-O';
  } else {
    text = piece.t === 'p' ? '' : piece.t.toUpperCase();
    if (piece.t !== 'p') {
      const alternatives = [];
      for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
        if (r === m.from[0] && f === m.from[1]) continue;
        const q = s.b[r][f];
        if (!q || q.c !== piece.c || q.t !== piece.t) continue;
        if (legalMoves(s, r, f).some(x => same(x.to, m.to))) alternatives.push([r, f]);
      }
      if (alternatives.length) {
        const fileConflict = alternatives.some(([, f]) => f === m.from[1]);
        const rankConflict = alternatives.some(([r]) => r === m.from[0]);
        if (!fileConflict) text += FILES[m.from[1]];
        else if (!rankConflict) text += (m.from[0] + 1);
        else text += FILES[m.from[1]] + (m.from[0] + 1);
      }
    } else if (capture) {
      text += FILES[m.from[1]];
    }
    if (capture) text += 'x';
    text += squareName(m.to);
    if (m.promotion) text += '=' + m.promotion.toUpperCase();
  }
  const after = applyMove(s, m);
  if (inCheck(after, after.turn)) text += allMoves(after).length ? '+' : '#';
  return text;
}

export function positionKey(s) {
  let key = '';
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = s.b[r][f];
    key += p ? (p.c === 'w' ? p.t.toUpperCase() : p.t) : '.';
  }
  key += s.turn;
  key += Object.entries(s.castle).map(([k, v]) => k + (v ?? '-')).join(',');
  key += s.ep ? squareName(s.ep) : '-';
  return key;
}

export function insufficientMaterial(s) {
  const pieces = { w: [], b: [] };
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = s.b[r][f];
    if (p && p.t !== 'k') pieces[p.c].push({ ...p, r, f });
  }
  const w = pieces.w, b = pieces.b;
  if (w.length === 0 && b.length === 0) return true;
  const minor = (p) => p.t === 'n' || p.t === 'b';
  if (w.length <= 1 && b.length <= 1 && w.every(minor) && b.every(minor)) {
    if (w.length === 0 || b.length === 0) return true;
    if (w[0].t === 'b' && b[0].t === 'b' && (w[0].r + w[0].f) % 2 === (b[0].r + b[0].f) % 2) return true;
    return false;
  }
  if (w.length && b.length && w.every(minor) && b.every(minor)) {
    const allBishops = [...w, ...b].every(p => p.t === 'b');
    if (allBishops) {
      const colors = new Set([...w, ...b].map(p => (p.r + p.f) % 2));
      if (colors.size === 1) return true;
    }
  }
  return false;
}

export function gameStatus(s, opts = {}) {
  const kingOfHill = !!opts.kingOfHill;
  if (kingOfHill) {
    for (const [r, f] of CENTER_SQUARES) {
      const p = s.b[r][f];
      if (p && p.t === 'k') {
        return { over: true, check: inCheck(s, s.turn), winner: p.c, reason: 'hill', checkmate: false };
      }
    }
  }
  const moves = allMoves(s);
  const check = inCheck(s, s.turn);
  if (!moves.length) {
    return {
      over: true, check, checkmate: check,
      winner: check ? opposite(s.turn) : null,
      reason: check ? 'checkmate' : 'stalemate'
    };
  }
  if (s.half >= 100) return { over: true, check, winner: null, reason: 'fifty', checkmate: false };
  if (insufficientMaterial(s)) return { over: true, check, winner: null, reason: 'material', checkmate: false };
  return { over: false, check, winner: null, reason: null, checkmate: false };
}

export function pieceValue(t) {
  return { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }[t] || 0;
}
