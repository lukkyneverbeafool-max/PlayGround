/*
 * A compact chess engine used by the rival and by the post-game coach.
 * Negamax + alpha-beta + quiescence, with a style-aware evaluation.
 */
import { allMoves, applyMove, inCheck, same } from './chess.js';

const INF = 1e9;
const MATE = 100000;

const VALUES = { p: 100, n: 320, b: 335, r: 505, q: 950, k: 0 };

/* Tables are written from White's first rank to the eighth rank. */
const PAWN_PST = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 8, 8, -12, -12, 8, 8, 5],
  [4, 6, 12, 8, 8, 12, 6, 4],
  [2, 4, 8, 18, 18, 8, 4, 2],
  [0, 0, 4, 20, 20, 4, 0, 0],
  [2, -4, -6, 2, 2, -6, -4, 2],
  [2, 4, 4, -12, -12, 4, 4, 2],
  [0, 0, 0, 0, 0, 0, 0, 0]
];
const KNIGHT_PST = [
  [-18, -10, -8, -8, -8, -8, -10, -18],
  [-10, -2, 4, 6, 6, 4, -2, -10],
  [-6, 6, 12, 14, 14, 12, 6, -6],
  [-4, 8, 14, 18, 18, 14, 8, -4],
  [-4, 8, 14, 18, 18, 14, 8, -4],
  [-6, 6, 12, 14, 14, 12, 6, -6],
  [-10, -2, 4, 6, 6, 4, -2, -10],
  [-18, -10, -8, -8, -8, -8, -10, -18]
];
const BISHOP_PST = [
  [-8, -4, -4, -4, -4, -4, -4, -8],
  [-4, 4, 2, 2, 2, 2, 4, -4],
  [-2, 4, 6, 8, 8, 6, 4, -2],
  [-2, 2, 8, 10, 10, 8, 2, -2],
  [-2, 4, 8, 10, 10, 8, 4, -2],
  [-2, 4, 6, 8, 8, 6, 4, -2],
  [-4, 4, 2, 4, 4, 2, 4, -4],
  [-8, -4, -4, -4, -4, -4, -4, -8]
];
const ROOK_PST = [
  [0, 0, 2, 4, 4, 2, 0, 0],
  [8, 10, 10, 10, 10, 10, 10, 8],
  [-2, 0, 2, 4, 4, 2, 0, -2],
  [-2, 0, 2, 4, 4, 2, 0, -2],
  [-2, 0, 2, 4, 4, 2, 0, -2],
  [-2, 0, 2, 4, 4, 2, 0, -2],
  [-2, 0, 2, 2, 2, 2, 0, -2],
  [0, 0, 2, 4, 4, 2, 0, 0]
];
const QUEEN_PST = [
  [-12, -6, -4, -2, -2, -4, -6, -12],
  [-6, 0, 4, 4, 4, 4, 0, -6],
  [-4, 2, 6, 6, 6, 6, 2, -4],
  [-2, 2, 6, 8, 8, 6, 2, -2],
  [-2, 2, 6, 8, 8, 6, 2, -2],
  [-4, 2, 6, 6, 6, 6, 2, -4],
  [-6, 0, 4, 4, 4, 4, 0, -6],
  [-12, -6, -4, -2, -2, -4, -6, -12]
];
const KING_PST = [
  [22, 28, 12, 0, 0, 8, 30, 24],
  [16, 18, 2, -4, -4, 0, 20, 18],
  [-10, -10, -14, -18, -18, -14, -10, -10],
  [-18, -18, -22, -26, -26, -22, -18, -18],
  [-26, -26, -30, -34, -34, -30, -26, -26],
  [-30, -30, -34, -38, -38, -34, -30, -30],
  [-34, -34, -38, -42, -42, -38, -34, -34],
  [-38, -38, -42, -46, -46, -42, -38, -38]
];
const PST = { p: PAWN_PST, n: KNIGHT_PST, b: BISHOP_PST, r: ROOK_PST, q: QUEEN_PST, k: KING_PST };

const DIFFICULTY = {
  casual: { depth: 2, time: 280, noise: 45, blunder: 0.05 },
  club: { depth: 3, time: 760, noise: 6, blunder: 0.008 },
  master: { depth: 4, time: 1650, noise: 0, blunder: 0 }
};

function mirrored(r) { return 7 - r; }

function tableScore(t, r, f, white) {
  const table = PST[t];
  return white ? table[r][f] : table[mirrored(r)][f];
}

function attackPotential(s, by) {
  const enemy = by === 'w' ? 'b' : 'w';
  let king = null;
  for (let r = 0; r < 8 && !king; r++) for (let f = 0; f < 8; f++) {
    const p = s.b[r][f];
    if (p && p.c === enemy && p.t === 'k') { king = [r, f]; break; }
  }
  if (!king) return 0;
  let total = 0;
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = s.b[r][f];
    if (!p || p.c !== by || p.t === 'k' || p.t === 'p') continue;
    const dist = Math.max(Math.abs(r - king[0]), Math.abs(f - king[1]));
    const weight = { q: 1.5, r: 1.1, n: 0.85, b: 0.75 }[p.t] || 0;
    total += Math.max(0, 8 - dist) * weight;
  }
  return total;
}

function pawnInfo(s, c) {
  const files = Array(8).fill(0);
  const rows = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = s.b[r][f];
    if (p && p.c === c && p.t === 'p') { files[f]++; rows.push([r, f]); }
  }
  let doubled = 0, isolated = 0, passed = 0;
  for (let f = 0; f < 8; f++) {
    if (files[f] > 1) doubled += files[f] - 1;
    if (files[f] && !files[f - 1] && !files[f + 1]) isolated++;
  }
  for (const [r, f] of rows) {
    const dir = c === 'w' ? 1 : -1;
    let blocked = false;
    for (let rr = r + dir; rr >= 0 && rr < 8 && !blocked; rr += dir) {
      for (let ff = Math.max(0, f - 1); ff <= Math.min(7, f + 1); ff++) {
        const p = s.b[rr][ff];
        if (p && p.c !== c && p.t === 'p') { blocked = true; break; }
      }
    }
    if (!blocked) passed += c === 'w' ? 1 + r * 0.35 : 1 + (7 - r) * 0.35;
  }
  return { doubled, isolated, passed };
}

function kingShield(s, c) {
  const row = c === 'w' ? 0 : 7;
  const k = (() => {
    for (let f = 0; f < 8; f++) {
      const p = s.b[row][f];
      if (p && p.c === c && p.t === 'k') return f;
    }
    return -1;
  })();
  if (k < 0) return 0;
  let shield = 0;
  const ahead = c === 'w' ? 1 : -1;
  for (let df = -1; df <= 1; df++) {
    const f = k + df;
    if (f < 0 || f > 7) continue;
    for (let d = 1; d <= 2; d++) {
      const rr = row + ahead * d;
      const p = s.b[rr]?.[f];
      if (p && p.c === c && p.t === 'p') { shield += d === 1 ? 10 : 4; break; }
    }
  }
  return shield;
}

export function evaluateState(s, style = 'balanced', kingOfHill = false) {
  let score = 0;
  let whiteBishops = 0, blackBishops = 0;
  let whiteMaterial = 0, blackMaterial = 0;

  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = s.b[r][f];
    if (!p) continue;
    const white = p.c === 'w';
    const val = VALUES[p.t] + tableScore(p.t, r, f, white);
    score += white ? val : -val;
    if (p.t !== 'k') {
      if (white) whiteMaterial += VALUES[p.t];
      else blackMaterial += VALUES[p.t];
    }
    if (p.t === 'b') { if (white) whiteBishops++; else blackBishops++; }
    if ((p.t === 'n' || p.t === 'b') && ((white && r === 0) || (!white && r === 7))) {
      score += white ? -14 : 14;
    }
  }

  if (whiteBishops >= 2) score += 28;
  if (blackBishops >= 2) score -= 28;

  const wp = pawnInfo(s, 'w'), bp = pawnInfo(s, 'b');
  score += (-wp.doubled * 12 - wp.isolated * 9 + wp.passed * 10);
  score += (bp.doubled * 12 + bp.isolated * 9 - bp.passed * 10);

  const shieldW = kingShield(s, 'w'), shieldB = kingShield(s, 'b');
  score += shieldW * 1.15 - shieldB * 1.15;

  const phase = whiteMaterial + blackMaterial;
  if (phase > 2400) {
    // Keep the kings tucked away while the board is crowded.
    score += shieldW * 0.55 - shieldB * 0.55;
  }

  if (style === 'aggressive') {
    const enemyW = kingZone(s, 'w');
    const enemyB = kingZone(s, 'b');
    score += enemyW * 11 - enemyB * 11;
    // Aggressive play values initiative and advanced pawns over a perfect pawn shelter.
    score += wp.passed * 14 - bp.passed * 14;
    score -= (shieldW * 0.35 - shieldB * 0.35);
  } else if (style === 'defensive') {
    score += (-wp.isolated * 8 + wp.doubled * -7) * 1.2;
    score -= (-bp.isolated * 8 + bp.doubled * -7) * 1.2;
    score += shieldW * 1.45 - shieldB * 1.45;
  }

  if (kingOfHill) {
    for (const [r, f] of [[3, 3], [3, 4], [4, 3], [4, 4]]) {
      const p = s.b[r][f];
      if (p && p.t === 'k') score += p.c === 'w' ? 90 : -90;
    }
    // Guide the kings toward the hill if the endgame is close.
    for (const c of ['w', 'b']) {
      const sign = c === 'w' ? 1 : -1;
      for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
        const p = s.b[r][f];
        if (p && p.c === c && p.t === 'k') {
          const dist = Math.min(...[[3, 3], [3, 4], [4, 3], [4, 4]].map(([rr, ff]) => Math.abs(r - rr) + Math.abs(f - ff)));
          score += sign * (6 - dist) * 8;
        }
      }
    }
  }

  return s.turn === 'w' ? score : -score;
}

function moveScore(s, m) {
  const p = s.b[m.from[0]][m.from[1]];
  const victim = s.b[m.to[0]][m.to[1]];
  let score = 0;
  if (victim) score += 1000 + VALUES[victim.t] * 10 - VALUES[p.t];
  if (m.promotion) score += 900;
  if (m.castle) score += 35;
  if (m.ep) score += 500;
  // Small center bias helps the first order at shallow depths.
  score += (3.5 - Math.abs(m.to[1] - 3.5)) * 2;
  return score;
}

function orderMoves(s, moves) {
  for (const m of moves) m._score = moveScore(s, m);
  moves.sort((a, b) => b._score - a._score);
  return moves;
}

function quiesce(s, alpha, beta, ctx, qdepth, ply) {
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && performance.now() > ctx.deadline) { ctx.aborted = true; return 0; }
  const check = inCheck(s, s.turn);
  const stand = evaluateState(s, ctx.style, ctx.kingOfHill);
  if (!check) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qdepth >= 3) return alpha;
  } else if (qdepth >= 4) {
    return stand;
  }

  let moves = allMoves(s);
  if (!moves.length) return check ? -MATE + ply : alpha;
  if (!check) {
    moves = moves.filter(m => s.b[m.to[0]][m.to[1]] || m.promotion || m.ep);
  }
  orderMoves(s, moves);
  for (const m of moves) {
    const child = applyMove(s, m);
    const score = -quiesce(child, -beta, -alpha, ctx, qdepth + 1, ply + 1);
    if (ctx.aborted) return 0;
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(s, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && performance.now() > ctx.deadline) { ctx.aborted = true; return 0; }
  if (depth <= 0) return quiesce(s, alpha, beta, ctx, 0, ply);
  if (s.half >= 100) return 0;

  const moves = allMoves(s);
  if (!moves.length) return inCheck(s, s.turn) ? -MATE + ply : 0;
  orderMoves(s, moves);

  let best = -INF;
  for (const m of moves) {
    const child = applyMove(s, m);
    const score = -negamax(child, depth - 1, -beta, -alpha, ply + 1, ctx);
    if (ctx.aborted) return 0;
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

const REPLY_BOOK = {
  'e2e4': { aggressive: ['c7c5', 'e7e5', 'c7c6'], balanced: ['c7c5', 'e7e5', 'e7e6', 'c7c6', 'g8f6'], defensive: ['e7e6', 'c7c6', 'd7d5'] },
  'd2d4': { aggressive: ['c7c5', 'g8f6', 'd7d5'], balanced: ['d7d5', 'g8f6', 'e7e6', 'c7c5'], defensive: ['d7d5', 'e7e6', 'c7c6'] },
  'c2c4': { aggressive: ['e7e5', 'c7c5', 'g8f6'], balanced: ['e7e5', 'c7c5', 'g8f6', 'e7e6'], defensive: ['e7e6', 'c7c5', 'g8f6'] },
  'g1f3': { aggressive: ['c7c5', 'd7d5', 'g8f6'], balanced: ['d7d5', 'g8f6', 'c7c5', 'e7e6'], defensive: ['d7d5', 'e7e6', 'g8f6'] },
  'g2g3': { aggressive: ['d7d5', 'c7c5'], balanced: ['d7d5', 'g8f6', 'e7e6'], defensive: ['d7d5', 'e7e6'] }
};

function coordMove(coord, s) {
  const from = [Number(coord[1]) - 1, coord.charCodeAt(0) - 97];
  const to = [Number(coord[3]) - 1, coord.charCodeAt(2) - 97];
  return allMoves(s).find(m => same(m.from, from) && same(m.to, to)) || null;
}

function openingBookMove(s, style, historyMoves) {
  if (s.chess960) return null;
  if (s.full === 1 && s.turn === 'b' && Array.isArray(historyMoves) && historyMoves.length === 1) {
    const m = historyMoves[0];
    if (!m?.from || !m?.to) return null;
    const key = String.fromCharCode(97 + m.from[1]) + (m.from[0] + 1) + String.fromCharCode(97 + m.to[1]) + (m.to[0] + 1);
    const book = REPLY_BOOK[key]?.[style || 'balanced'];
    if (book?.length) {
      const candidates = book.map(c => coordMove(c, s)).filter(Boolean);
      if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
    }
    return null;
  }
  if (s.full !== 1 || s.turn !== 'w') return null;
  // Only use the book from the true starting position.
  const home = 'rnbqkbnr';
  for (let f = 0; f < 8; f++) {
    if (s.b[0][f]?.t !== home[f] || s.b[0][f]?.c !== 'w') return null;
    if (s.b[1][f]?.t !== 'p') return null;
    if (s.b[6][f]?.t !== 'p') return null;
    if (s.b[7][f]?.t !== home[f]) return null;
  }
  const choices = style === 'aggressive'
    ? ['e2e4', 'g1f3', 'd2d4']
    : style === 'defensive'
      ? ['d2d4', 'c2c4', 'g1f3']
      : ['e2e4', 'd2d4', 'g1f3', 'c2c4'];
  const coord = choices[Math.floor(Math.random() * choices.length)];
  return coordMove(coord, s);
}

export function findBestMove(state, opts = {}) {
  const moves = allMoves(state);
  if (!moves.length) return null;

  const base = DIFFICULTY[opts.difficulty] || DIFFICULTY.club;
  let depth = opts.depth ?? base.depth;
  let time = opts.timeMs ?? base.time;
  let noise = opts.noise ?? base.noise;
  let blunder = opts.blunder ?? base.blunder;

  const form = Number(opts.form) || 0;
  if (opts.adaptive && !opts.analysis) {
    if (form > 25) {
      time *= 1.25;
      noise *= 0.55;
      if (form > 55 && depth < 4) depth++;
    } else if (form < -25) {
      time *= 0.8;
      noise *= 1.65;
    }
  }

  if (!opts.analysis && !opts.noBook) {
    const book = openingBookMove(state, opts.style || 'balanced', opts.historyMoves);
    if (book) return { move: book, score: 0, depth: 0, nodes: 0, book: true };
  }

  if (!opts.analysis && blunder > 0 && Math.random() < blunder) {
    return { move: moves[Math.floor(Math.random() * moves.length)], score: 0, depth: 0, nodes: 0, blunder: true };
  }

  const ctx = {
    deadline: performance.now() + Math.max(60, time),
    style: opts.style || 'balanced',
    kingOfHill: !!opts.kingOfHill,
    aborted: false,
    nodes: 0
  };

  let ordered = orderMoves(state, moves.slice());
  let best = ordered[0], bestScore = -INF, reached = 0;

  for (let d = 1; d <= depth; d++) {
    let alpha = -INF;
    let localBest = null;
    let localScore = -INF;
    for (const m of ordered) {
      const child = applyMove(state, m);
      const raw = -negamax(child, d - 1, -INF, -alpha, 1, ctx);
      if (ctx.aborted) break;
      const adjusted = raw + (noise ? (Math.random() * 2 - 1) * noise : 0);
      if (adjusted > localScore) { localScore = adjusted; localBest = m; }
      if (raw > alpha) alpha = raw;
    }
    if (localBest && !ctx.aborted) {
      best = localBest;
      bestScore = localScore;
      reached = d;
      ordered = [localBest, ...ordered.filter(m => m !== localBest)];
    }
    if (ctx.aborted) break;
  }

  return { move: best, score: bestScore, depth: reached, nodes: ctx.nodes };
}

export function principalVariation(state, opts = {}) {
  const result = findBestMove(state, { ...opts, analysis: true, noise: 0, blunder: 0, noBook: true });
  if (!result) return null;
  const line = [];
  let s = state;
  for (let i = 0; i < (opts.plies || 4); i++) {
    const r = i === 0
      ? result
      : findBestMove(s, { ...opts, depth: 2, timeMs: 90, analysis: true, noise: 0, blunder: 0, noBook: true });
    if (!r?.move) break;
    line.push(r.move);
    s = applyMove(s, r.move);
  }
  return { ...result, line };
}

export function quickScore(state, opts = {}) {
  const result = findBestMove(state, {
    depth: opts.depth ?? 1,
    timeMs: opts.timeMs ?? 45,
    analysis: true,
    noise: 0,
    blunder: 0,
    noBook: true,
    style: opts.style || 'balanced',
    kingOfHill: opts.kingOfHill
  });
  return result ? result.score : 0;
}

export { MATE, VALUES };
