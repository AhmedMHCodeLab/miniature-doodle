// Builds presentation/kit-room-final-demo.pptx (16:9, editable).
// Run from presentation/src:  NODE_PATH=<dir with pptxgenjs, sharp> node build-deck.js
// Every slide's speaker notes are in NOTES at the bottom of this file.

const path = require('path');
const fs = require('fs');
const pptxgen = require('pptxgenjs');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SHOT = (n) => path.join(ROOT, 'assets', 'screenshots', n + '.png');
const OUT = path.join(ROOT, 'kit-room-final-demo.pptx');

// ---------- Design tokens (taken from the Kit Room page, services/dashboard-api/static/index.html) ----------
const C = {
  ink: '242E46', ink2: '4A5470', ink3: '5B6480',
  paper: 'F4F2EE', paper2: 'ECE9E3', sheet: 'FBFAF7',
  rule: 'DBDADA', rule2: 'C2C3C5',
  plum: '160B35', onPlum: 'F3F2F8', onPlum2: 'B3A6DC',
  plumBox: '1F1346', plumLine: '4E4180', plumLine2: '7A6CB4',
  acc: '6C00FF', accInk: '5700D6', accWash: 'E8DCEF',
  lav: 'AE99F0', st2: '8E72E6', st3: '6E50D6', st4: '5235B5', st5: '37208A',
  fail: 'B42318', failWash: 'F8E3DF', ok: '2A7152', okWash: 'E1ECE4', warn: '8A5A00', warnWash: 'F4EAD3',
  white: 'FFFFFF',
};
const HEAD = 'Manrope', BODY = 'Inter', MONO = 'JetBrains Mono';
const THEME = {
  name: 'Kit Room',
  headFontFace: HEAD, bodyFontFace: BODY,
  colors: {
    dk1: C.ink, lt1: C.paper, dk2: C.plum, lt2: C.onPlum,
    accent1: C.acc, accent2: C.accInk, accent3: C.st2, accent4: C.onPlum2, accent5: C.fail, accent6: C.ok,
    hlink: C.accInk, folHlink: C.st5,
  },
};

const W = 13.333, H = 7.5, ML = 0.75, MR = 0.75, CW = W - ML - MR;

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.title = 'Kit Room: final demo';
pres.subject = 'CoderCo Production Engineering Simulation, Team Alpha final demo';
pres.author = 'Team Alpha';
pres.company = 'Team Alpha';
pres.theme = { headFontFace: HEAD, bodyFontFace: BODY };

// ---------- helpers ----------
function T(slide, text, o = {}) {
  const opts = Object.assign({ margin: 0, isTextBox: true, fontFace: BODY, fontSize: 14, color: C.ink, valign: 'top' }, o);
  if (opts.mono) { opts.fontFace = MONO; delete opts.mono; }
  if (opts.head) { opts.fontFace = HEAD; delete opts.head; }
  slide.addText(text, opts);
}
function R(slide, x, y, w, h, fill, line, o = {}) {
  slide.addShape(o.round ? pres.shapes.ROUNDED_RECTANGLE : pres.shapes.RECTANGLE, Object.assign({
    x, y, w, h,
    fill: fill ? { color: fill } : { type: 'none' },
    line: line ? { color: line, width: o.lw || 0.75, dashType: o.dash || 'solid' } : { type: 'none' },
  }, o.round ? { rectRadius: o.round } : {}, o.name ? { objectName: o.name } : {}));
}
function L(slide, x1, y1, x2, y2, color, o = {}) {
  const line = { color, width: o.lw || 1.25, dashType: o.dash || 'solid' };
  if (o.arrow !== false) line.endArrowType = 'triangle';
  if (o.both) line.beginArrowType = 'triangle';
  slide.addShape(pres.shapes.LINE, {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1, line,
  });
}
// Poly-line through points; arrow head only on the last segment.
function P(slide, pts, color, o = {}) {
  for (let i = 0; i < pts.length - 1; i++) {
    L(slide, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], color, Object.assign({}, o, { arrow: o.arrow !== false && i === pts.length - 2 }));
  }
}
function dot(slide, x, y, d, fill, line) {
  slide.addShape(pres.shapes.OVAL, { x: x - d / 2, y: y - d / 2, w: d, h: d, fill: fill ? { color: fill } : { type: 'none' }, line: line ? { color: line, width: 1 } : { type: 'none' } });
}
function badge(slide, x, y, n, o = {}) {
  const d = o.d || 0.34;
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: o.fill || C.acc }, line: { type: 'none' } });
  T(slide, String(n), { x, y, w: d, h: d, mono: true, bold: true, fontSize: o.size || 11, color: o.color || C.white, align: 'center', valign: 'middle' });
}
const CUR = { title: '', eyebrow: '' };
const NOTE_LOG = [];
function eyebrow(slide, text, dark) {
  CUR.eyebrow = text.replace(/\s+·\s+/g, ' · ');
  T(slide, text.toUpperCase(), { x: ML, y: 0.5, w: 9, h: 0.25, mono: true, fontSize: 11, color: dark ? C.onPlum2 : C.ink3, charSpacing: 1.5 });
}
function title(slide, text) { CUR.title = text; slide.addText(text, { placeholder: 'title' }); }
function label(slide, text, x, y, w, color, o = {}) {
  T(slide, text.toUpperCase(), Object.assign({ x, y, w, h: 0.24, mono: true, fontSize: 10, color: color || C.ink3, charSpacing: 1.2 }, o));
}
function img(slide, name, x, y, w, h, o = {}) {
  slide.addImage({ path: SHOT(name), x, y, w, h, altText: o.alt || name });
  R(slide, x, y, w, h, null, o.frame || C.rule2, { lw: 0.75 });
}
// Diagram node: mono name + optional body lines.
function node(slide, x, y, w, h, name, body, o = {}) {
  const dark = !!o.dark;
  R(slide, x, y, w, h, o.fill !== undefined ? o.fill : (dark ? C.plumBox : C.sheet), o.line || (dark ? C.plumLine2 : C.rule2), { lw: o.lw || 0.75, dash: o.dash });
  const pad = 0.12;
  T(slide, name, { x: x + pad, y: y + (o.nameTop || 0.09), w: w - 2 * pad, h: 0.26, mono: true, bold: true, fontSize: o.nameSize || 11, color: o.nameColor || (dark ? C.onPlum : C.ink) });
  if (body) T(slide, body, { x: x + pad, y: y + (o.bodyTop || 0.36), w: w - 2 * pad, h: h - (o.bodyTop || 0.36) - 0.06, fontSize: o.bodySize || 10.5, color: o.bodyColor || (dark ? C.onPlum2 : C.ink2), lineSpacingMultiple: 1.1 });
}
function notes(slide, key) { slide.addNotes(NOTES[key].trim()); NOTE_LOG.push({ key, title: CUR.title, eyebrow: CUR.eyebrow }); }

// ---------- backgrounds ----------
async function makeBackgrounds() {
  const pxPerIn = 150, Wp = Math.round(W * pxPerIn), Hp = Math.round(H * pxPerIn);
  let lines = '';
  for (let i = 0; i <= W * 4; i++) { const x = (i * pxPerIn) / 4; const major = i % 4 === 0; lines += `<line x1="${x}" y1="0" x2="${x}" y2="${Hp}" stroke="${major ? '#2A1F55' : '#1D1240'}" stroke-width="${major ? 1.4 : 1}"/>`; }
  for (let j = 0; j <= H * 4; j++) { const y = (j * pxPerIn) / 4; const major = j % 4 === 0; lines += `<line x1="0" y1="${y}" x2="${Wp}" y2="${y}" stroke="${major ? '#2A1F55' : '#1D1240'}" stroke-width="${major ? 1.4 : 1}"/>`; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wp}" height="${Hp}"><rect width="100%" height="100%" fill="#${C.plum}"/>${lines}</svg>`;
  const out = path.join(ROOT, 'assets', 'bg-plum-grid.png');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  return out;
}

function defineLayouts(gridPng) {
  const footer = (dark) => {
    const line = dark ? C.plumLine : C.rule2;
    const text = dark ? C.onPlum2 : C.ink3;
    return [
      { text: { text: 'KIT ROOM  ·  FINAL DEMO  ·  13 OCT 2026', options: { x: ML, y: 6.92, w: 6, h: 0.26, fontFace: MONO, fontSize: 10, color: text, charSpacing: 1.2, margin: 0, valign: 'middle' } } },
      { rect: { x: 10.58, y: 6.88, w: 2.0, h: 0.34, fill: { type: 'none' }, line: { color: line, width: 0.75 } } },
      { line: { x: 11.74, y: 6.88, w: 0, h: 0.34, line: { color: line, width: 0.75 } } },
      { text: { text: 'TEAM ALPHA', options: { x: 10.66, y: 6.88, w: 1.05, h: 0.34, fontFace: MONO, fontSize: 10, bold: true, color: dark ? C.onPlum : C.ink2, margin: 0, valign: 'middle' } } },
      { text: { text: 'SHEET', options: { x: 11.81, y: 6.88, w: 0.5, h: 0.34, fontFace: MONO, fontSize: 10, color: text, margin: 0, valign: 'middle' } } },
    ];
  };
  const titlePh = (dark, size) => ({ placeholder: { options: { name: 'title', type: 'title', x: ML, y: 0.82, w: CW, h: 0.9, fontFace: HEAD, fontSize: size || 30, bold: true, color: dark ? C.onPlum : C.ink, margin: 0, valign: 'top', align: 'left' }, text: '' } });
  const num = (dark) => ({ x: 12.18, y: 6.88, w: 0.34, h: 0.34, fontFace: MONO, fontSize: 10, bold: true, color: dark ? C.onPlum : C.ink, align: 'right', valign: 'middle', margin: 0 });

  pres.defineSlideMaster({ title: 'PAPER', background: { color: C.paper }, objects: [...footer(false), titlePh(false)], slideNumber: num(false) });
  pres.defineSlideMaster({ title: 'PLUM', background: { path: gridPng }, objects: [...footer(true), titlePh(true)], slideNumber: num(true) });
  pres.defineSlideMaster({ title: 'PLUM_BARE', background: { path: gridPng }, objects: [] });
  pres.defineSlideMaster({
    title: 'APPENDIX', background: { color: C.paper },
    objects: [
      { text: { text: 'APPENDIX  ·  QUESTIONS AND EVIDENCE', options: { x: ML, y: 6.92, w: 6, h: 0.26, fontFace: MONO, fontSize: 10, color: C.ink3, charSpacing: 1.2, margin: 0, valign: 'middle' } } },
      ...footer(false).slice(1), titlePh(false, 26),
    ],
    slideNumber: num(false),
  });
}

// ---------- slides ----------
function sTitle() {
  const s = pres.addSlide({ masterName: 'PLUM_BARE', sectionTitle: 'Act I · Set the scene' });
  CUR.title = 'One order, followed all the way down'; CUR.eyebrow = 'Title';
  T(s, 'KIT ROOM  ·  FINAL DEMO', { x: ML, y: 0.72, w: 6, h: 0.3, mono: true, fontSize: 11, color: C.onPlum2, charSpacing: 2 });
  T(s, [
    { text: 'One order,', options: { breakLine: true } },
    { text: 'followed all', options: { breakLine: true } },
    { text: 'the way down.', options: { color: C.lav } },
  ], { x: ML, y: 1.3, w: 6.8, h: 2.95, head: true, bold: true, fontSize: 58, color: C.onPlum, lineSpacingMultiple: 0.92 });
  T(s, 'How Team Alpha took a nine-service order platform from provided source code to Amazon EKS in four weeks, on a $200 budget, and built it for the orders that go wrong.',
    { x: ML, y: 4.4, w: 5.9, h: 1.3, fontSize: 16, color: C.onPlum2, lineSpacingMultiple: 1.25 });
  T(s, 'TEAM ALPHA  ·  CODERCO PRODUCTION ENGINEERING SIMULATION  ·  13 OCTOBER 2026', { x: ML, y: 6.75, w: 8.5, h: 0.3, mono: true, fontSize: 10, color: C.onPlum2, charSpacing: 1.5 });

  // Plan drawing of the order route, in the style of the Kit Room plan view.
  const fx = 7.75, fy = 0.72, fw = 4.83, fh = 5.63;
  R(s, fx, fy, fw, fh, null, C.plumLine, { lw: 0.75 });
  T(s, 'PLAN  ·  ORDER ROUTE', { x: fx + 0.22, y: fy + 0.2, w: 3, h: 0.25, mono: true, bold: true, fontSize: 10, color: C.onPlum, charSpacing: 1.5 });
  const bw = 1.6, bh = 0.5, ax = 8.05, bx = 10.6;
  const nodes = [
    ['BROWSER', ax, 1.45], ['API GATEWAY', ax, 2.3], ['ORDER SERVICE', ax, 3.15], ['POSTGRES', ax, 4.0],
    ['SQS QUEUE', bx, 3.15], ['WORKER', bx, 4.0],
  ];
  for (const [n, x, y] of nodes) {
    R(s, x, y, bw, bh, null, n === 'ORDER SERVICE' ? C.lav : C.plumLine2, { dash: n === 'ORDER SERVICE' ? 'solid' : 'dash', lw: n === 'ORDER SERVICE' ? 1.25 : 0.75 });
    T(s, n, { x, y, w: bw, h: bh, mono: true, fontSize: 10, color: n === 'ORDER SERVICE' ? C.onPlum : C.onPlum2, align: 'center', valign: 'middle', charSpacing: 1 });
  }
  const cx = ax + bw / 2, cbx = bx + bw / 2;
  L(s, cx, 1.95, cx, 2.3, C.lav, { lw: 1.5 });
  L(s, cx, 2.8, cx, 3.15, C.lav, { lw: 1.5 });
  L(s, cx, 3.65, cx, 4.0, C.lav, { lw: 1.5, both: true });
  L(s, ax + bw, 3.4, bx, 3.4, C.lav, { lw: 1.5 });
  T(s, 'OUTBOX', { x: ax + bw + 0.3, y: 3.14, w: bx - ax - bw - 0.3, h: 0.22, mono: true, fontSize: 9, color: C.lav, align: 'center', charSpacing: 1 });
  T(s, 'ONE TX', { x: cx + 0.1, y: 3.7, w: 0.8, h: 0.22, mono: true, fontSize: 9, color: C.lav, charSpacing: 1 });
  L(s, cbx, 3.65, cbx, 4.0, C.lav, { lw: 1.5 });
  P(s, [[cbx, 4.5], [cbx, 4.82], [ax + 0.25, 4.82], [ax + 0.25, 5.1]], C.lav, { lw: 1.5 });
  // callout
  s.addShape(pres.shapes.OVAL, { x: ax + bw - 0.12, y: 2.98, w: 0.34, h: 0.34, fill: { color: C.plum }, line: { color: C.lav, width: 1 } });
  T(s, '#3', { x: ax + bw - 0.12, y: 2.98, w: 0.34, h: 0.34, mono: true, fontSize: 9, bold: true, color: C.lav, align: 'center', valign: 'middle' });
  // fulfilment pipeline
  const stages = ['PLACED', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
  const px0 = ax + 0.25, pstep = 0.92, py = 5.28;
  L(s, px0, py, px0 + pstep * 3, py, C.lav, { lw: 1.5, arrow: false });
  L(s, px0 + pstep * 3, py, px0 + pstep * 4, py, C.plumLine2, { lw: 1, arrow: false, dash: 'dash' });
  stages.forEach((st, i) => {
    const x = px0 + pstep * i;
    if (i < 3) dot(s, x, py, 0.17, C.lav, null);
    else if (i === 3) { dot(s, x, py, 0.26, C.plum, C.lav); dot(s, x, py, 0.15, C.lav, null); }
    else dot(s, x, py, 0.17, C.plum, C.plumLine2);
    T(s, st, { x: x - 0.5, y: py + 0.2, w: 1.0, h: 0.2, mono: true, fontSize: 8.5, color: i === 3 ? C.onPlum : C.onPlum2, align: 'center' });
  });
  // title block
  const tbx = 10.32, tby = 5.82;
  R(s, tbx, tby, 2.06, 0.44, null, C.plumLine2);
  L(s, tbx, tby + 0.22, tbx + 2.06, tby + 0.22, C.plumLine2, { arrow: false, lw: 0.75 });
  L(s, tbx + 1.22, tby, tbx + 1.22, tby + 0.22, C.plumLine2, { arrow: false, lw: 0.75 });
  T(s, 'TEAM ALPHA', { x: tbx + 0.08, y: tby, w: 1.1, h: 0.22, mono: true, bold: true, fontSize: 8.5, color: C.onPlum, valign: 'middle' });
  T(s, 'SHEET 01', { x: tbx + 1.28, y: tby, w: 0.74, h: 0.22, mono: true, fontSize: 8.5, color: C.onPlum2, valign: 'middle' });
  T(s, 'ORDER #3  ·  SHIPPED', { x: tbx + 0.08, y: tby + 0.22, w: 1.95, h: 0.22, mono: true, fontSize: 8.5, color: C.lav, valign: 'middle' });
  notes(s, 'title');
}

function sContext() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act I · Set the scene' });
  eyebrow(s, 'Act I  ·  Context');
  title(s, 'Kit Room equips new starters from one page');
  const lw = 4.2;
  T(s, 'An operations team picks the parts a new starter needs. Kit Room prices them from live stock, takes payment, ships them and keeps everyone told.',
    { x: ML, y: 1.95, w: lw, h: 1.35, fontSize: 14.5, color: C.ink2, lineSpacingMultiple: 1.2 });
  label(s, 'Who it serves', ML, 3.45, lw);
  const who = [['The person ordering', 'builds a kit, places the order, tracks it.'], ['Operators', 'manage stock, payments and shipping.']];
  who.forEach(([a, b], i) => {
    T(s, [{ text: a, options: { bold: true, color: C.ink, breakLine: true } }, { text: b, options: { color: C.ink2 } }], { x: ML, y: 3.75 + i * 0.66, w: lw, h: 0.6, fontSize: 13, lineSpacingMultiple: 1.1 });
  });
  label(s, 'One journey', ML, 5.3, lw);
  const steps = ['Build a kit', 'Place the order', 'Fulfilment runs by itself', 'Track it to delivery'];
  steps.forEach((t, i) => {
    const y = 5.58 + i * 0.3;
    T(s, String(i + 1).padStart(2, '0'), { x: ML, y, w: 0.45, h: 0.28, mono: true, bold: true, fontSize: 12, color: C.accInk });
    T(s, t, { x: ML + 0.5, y, w: lw - 0.5, h: 0.28, fontSize: 13, color: C.ink });
  });
  const iw = 7.3, ix = W - MR - iw;
  img(s, 'kit-hero', ix, 1.95, iw, iw / 1.778, { alt: 'Kit page with a monitor, keyboard and hub in the bill of materials' });
  T(s, 'THE KIT PAGE  ·  CURRENT BUILD, RUN LOCALLY, 13 OCT', { x: ix, y: 1.95 + iw / 1.778 + 0.14, w: iw, h: 0.25, mono: true, fontSize: 10, color: C.ink3, charSpacing: 1.2 });
  notes(s, 'context');
}

function sStartingLine() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act I · Set the scene' });
  eyebrow(s, 'Act I  ·  The starting line');
  title(s, 'Out of the box, no order got past pending');
  // code card
  const x = ML, y = 1.95, w = 6.2, h = 4.45;
  R(s, x, y, w, h, C.plum, null);
  label(s, 'As provided  ·  order-service/main.go', x + 0.3, y + 0.25, 5.6, C.onPlum2);
  T(s, [
    { text: 'data, _ := json.Marshal(event)', options: { breakLine: true } },
    { text: 'log.Printf("Event -> SQS: %s", string(data))', options: { breakLine: true } },
    { text: '// Students implement actual SQS SendMessage here', options: { color: C.lav } },
  ], { x: x + 0.3, y: y + 0.6, w: 5.7, h: 0.95, mono: true, fontSize: 11.5, color: C.onPlum, lineSpacingMultiple: 1.3 });
  L(s, x + 0.3, y + 1.75, x + w - 0.3, y + 1.75, C.plumLine, { arrow: false, lw: 0.75 });
  label(s, 'As provided  ·  worker/main.go', x + 0.3, y + 1.95, 5.6, C.onPlum2);
  T(s, [
    { text: 'func receiveSQSMessages(ctx context.Context,', options: { breakLine: true } },
    { text: '        queueURL string) []string {', options: { breakLine: true } },
    { text: '    // Students implement with AWS SDK SQS ReceiveMessage', options: { color: C.lav, breakLine: true } },
    { text: '    return nil', options: { breakLine: true } },
    { text: '}' },
  ], { x: x + 0.3, y: y + 2.3, w: 5.7, h: 1.5, mono: true, fontSize: 11.5, color: C.onPlum, lineSpacingMultiple: 1.3 });
  T(s, 'Publishing was a log line. Nothing read the queue. No tests.', { x: x + 0.3, y: y + 3.9, w: 5.7, h: 0.35, fontSize: 13, bold: true, color: C.onPlum });

  // right: what we built
  const rx = 7.35, rw = 5.23;
  T(s, '168', { x: rx, y: 1.85, w: 2.2, h: 1.0, head: true, bold: true, fontSize: 60, color: C.accInk });
  T(s, 'test functions in 20 files. The provided services had none.', { x: rx + 2.15, y: 2.12, w: 3.05, h: 0.7, fontSize: 13.5, color: C.ink2, lineSpacingMultiple: 1.15 });
  label(s, 'Built into the app', rx, 3.1, rw, C.accInk);
  const into = ['Transactional outbox and SQS publisher', 'The worker: reserve, charge, confirm, commit', 'Idempotency keys on orders and payments', 'A route allow-list at the gateway'];
  into.forEach((t, i) => T(s, t, { x: rx, y: 3.4 + i * 0.32, w: rw, h: 0.3, fontSize: 13, color: C.ink }));
  label(s, 'Built around it', rx, 4.85, rw, C.accInk);
  const around = ['9 multi-stage Dockerfiles, distroless, non-root', 'Terraform: 6 modules, 3 environments, a bootstrap', 'One Helm chart for 9 services, ArgoCD app-of-apps', '8 GitHub Actions workflows'];
  around.forEach((t, i) => T(s, t, { x: rx, y: 5.15 + i * 0.32, w: rw, h: 0.3, fontSize: 13, color: C.ink }));
  notes(s, 'starting');
}

function sGoals() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act I · Set the scene' });
  eyebrow(s, 'Act I  ·  Goals and constraints');
  title(s, 'Five aims, shaped by a $200 budget');
  // constraints card
  const x = ML, y = 1.95, w = 5.35, h = 4.6;
  R(s, x, y, w, h, C.sheet, C.rule2);
  label(s, 'Constraints', x + 0.3, y + 0.25, 4.5);
  T(s, '$200', { x: x + 0.3, y: y + 0.5, w: 2.4, h: 0.95, head: true, bold: true, fontSize: 54, color: C.accInk });
  T(s, 'AWS spend CoderCo reimburses per team. Every cost needs a reason.', { x: x + 2.55, y: y + 0.68, w: 2.55, h: 0.75, fontSize: 12.5, color: C.ink2, lineSpacingMultiple: 1.15 });
  label(s, 'Stakeholder priority order, 14 Sep', x + 0.3, y + 1.62, 4.7);
  const pr = ['Cost', 'Security', 'Uptime', 'Features'];
  pr.forEach((p, i) => {
    const bx = x + 0.3 + i * 1.19;
    R(s, bx, y + 1.92, 1.09, 0.5, i === 0 ? C.acc : C.paper, i === 0 ? null : C.rule2);
    T(s, `${i + 1}  ${p}`, { x: bx, y: y + 1.92, w: 1.09, h: 0.5, fontSize: 12, bold: i === 0, color: i === 0 ? C.white : C.ink, align: 'center', valign: 'middle' });
  });
  label(s, 'Fixed by the brief', x + 0.3, y + 2.7, 4.7);
  T(s, 'EKS across 3 AZs  ·  Karpenter  ·  Traefik behind an NLB  ·  cert-manager and ExternalDNS  ·  ArgoCD app-of-apps  ·  Postgres and Redis on StatefulSets  ·  GitHub OIDC  ·  image scanning',
    { x: x + 0.3, y: y + 3.0, w: 4.75, h: 1.0, fontSize: 12, color: C.ink2, lineSpacingMultiple: 1.25 });
  T(s, '4 weeks  ·  5 engineers  ·  1 AWS account', { x: x + 0.3, y: y + 4.1, w: 4.75, h: 0.3, mono: true, fontSize: 11, color: C.ink, bold: true });

  // aims
  const ax = 6.55, aw = 6.03;
  label(s, 'What we set out to do', ax, 1.95, aw, C.accInk);
  const aims = [
    ['Never lose an accepted order', 'even when a downstream service or AWS is briefly down.'],
    ['Never charge twice', 'a retry, a redelivery or a double click changes nothing.'],
    ['Hold no long-lived AWS keys', 'nothing in Git, CI or an image can reach AWS on its own.'],
    ['Change the platform only through Git', 'Terraform for AWS, ArgoCD for the cluster.'],
    ['Ship one service without touching eight', 'and roll it back the same way.'],
  ];
  aims.forEach(([a, b], i) => {
    const yy = 2.3 + i * 0.78;
    T(s, String(i + 1).padStart(2, '0'), { x: ax, y: yy, w: 0.5, h: 0.32, mono: true, bold: true, fontSize: 13, color: C.accInk });
    T(s, a, { x: ax + 0.55, y: yy - 0.02, w: aw - 0.55, h: 0.32, head: true, bold: true, fontSize: 16, color: C.ink });
    T(s, b, { x: ax + 0.55, y: yy + 0.3, w: aw - 0.55, h: 0.3, fontSize: 12.5, color: C.ink2 });
    if (i < aims.length - 1) L(s, ax, yy + 0.7, ax + aw, yy + 0.7, C.rule, { arrow: false, lw: 0.75 });
  });
  T(s, 'AIMS, NOT GUARANTEES. SLIDE 18 SAYS WHICH ARE PROVEN.', { x: ax, y: 6.2, w: aw, h: 0.25, mono: true, fontSize: 10, color: C.ink3, charSpacing: 1 });
  notes(s, 'goals');
}

function sDemoCue() {
  const s = pres.addSlide({ masterName: 'PLUM', sectionTitle: 'Act II · Show the product' });
  eyebrow(s, 'Act II  ·  Live demo', true);
  title(s, 'Watch one order travel');
  const steps = [
    ['Build a kit', 'Prices and stock come live from inventory. The browser never sets a price.'],
    ['Place the order', '"Placed" comes back at once: the order is saved and queued before any work begins.'],
    ['Wait a few seconds', 'It turns "Confirmed" by itself: a background worker reserved the stock and took the payment.'],
    ['Ship it', 'Shipment, tracking number and emails appear, and each is created once.'],
  ];
  const x0 = ML, colW = 2.83, gap = 0.17, y0 = 2.25;
  L(s, x0 + 0.17, y0 + 0.17, x0 + 3 * (colW + gap) + 0.17, y0 + 0.17, C.plumLine2, { arrow: false, lw: 1 });
  steps.forEach(([a, b], i) => {
    const x = x0 + i * (colW + gap);
    dot(s, x + 0.17, y0 + 0.17, 0.34, i === 3 ? C.lav : C.plum, C.lav);
    T(s, String(i + 1).padStart(2, '0'), { x, y: y0, w: 0.34, h: 0.34, mono: true, bold: true, fontSize: 10, color: i === 3 ? C.plum : C.lav, align: 'center', valign: 'middle' });
    T(s, a, { x, y: y0 + 0.6, w: colW, h: 0.45, head: true, bold: true, fontSize: 20, color: C.onPlum });
    T(s, 'NOTICE', { x, y: y0 + 1.2, w: colW, h: 0.24, mono: true, fontSize: 10, color: C.lav, charSpacing: 1.5 });
    T(s, b, { x, y: y0 + 1.5, w: colW - 0.15, h: 1.4, fontSize: 14, color: C.onPlum2, lineSpacingMultiple: 1.2 });
  });
  R(s, ML, 5.55, CW, 0.75, C.plumBox, C.plumLine);
  T(s, [
    { text: 'LIVE  ', options: { bold: true, color: C.lav } },
    { text: 'dashboard.dev.eksv2.naimaosmann.com', options: { color: C.onPlum } },
    { text: '      IF DEV IS DOWN  ', options: { bold: true, color: C.lav } },
    { text: 'slides 6 and 7 show the same journey from this build', options: { color: C.onPlum2 } },
  ], { x: ML + 0.3, y: 5.55, w: CW - 0.6, h: 0.75, mono: true, fontSize: 11, valign: 'middle' });
  notes(s, 'democue');
}

function sDemoConfirm() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act II · Show the product' });
  eyebrow(s, 'Act II  ·  The demo, frame by frame');
  title(s, 'Answered at once, confirmed seconds later');
  const iw = 3.8, ih = iw / 0.934;
  badge(s, ML, 1.86, 1, { d: 0.28, size: 9.5 });
  label(s, 'Moment of the click', ML + 0.38, 1.88, iw);
  img(s, 'docket-pending', ML, 2.25, iw, ih, { alt: 'Order 3 placed, status placed, queued for the fulfilment worker' });
  badge(s, ML + iw + 0.3, 1.86, 2, { d: 0.28, size: 9.5 });
  label(s, 'Seconds later, no click', ML + iw + 0.68, 1.88, iw);
  img(s, 'docket-confirmed', ML + iw + 0.3, 2.25, iw, ih, { alt: 'Order 3 confirmed: stock reserved and payment taken' });
  const nx = ML + 2 * iw + 0.75, nw = W - MR - nx;
  const pts = [
    ['1', 'Placed is the API\'s 201 reply.', 'The order, its history row and its event were saved together. Nothing has been processed yet.'],
    ['2', 'Nobody pressed confirm.', 'The worker read the event from SQS, reserved stock, charged the card and confirmed the order.'],
    ['3', 'Stock leaves the shelf last.', 'It is committed only after the charge succeeds, so a declined card never takes stock.'],
  ];
  pts.forEach(([n, a, b], i) => {
    const y = 2.25 + i * 1.38;
    if (i < 2) badge(s, nx, y, n, { d: 0.3, size: 10 }); else dot(s, nx + 0.15, y + 0.15, 0.14, C.ink, null);
    T(s, [{ text: a, options: { bold: true, color: C.ink, fontSize: 14, breakLine: true } }, { text: b, options: { color: C.ink2, fontSize: 12.5 } }],
      { x: nx + 0.45, y: y - 0.02, w: nw - 0.45, h: 1.25, lineSpacingMultiple: 1.15, paraSpaceAfter: 4 });
  });
  T(s, 'ORDER #3, CURRENT BUILD RUN LOCALLY ON 13 OCT. A LIVE ORDER WILL HAVE ANOTHER NUMBER.', { x: ML, y: 6.47, w: CW, h: 0.25, mono: true, fontSize: 10, color: C.ink3, charSpacing: 1 });
  notes(s, 'democonfirm');
}

function sDemoFulfil() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act II · Show the product' });
  eyebrow(s, 'Act II  ·  The demo, frame by frame');
  title(s, 'Every later step is visible, and happens once');
  const tw = 4.45, th = tw / 1.162;
  img(s, 'detail-timeline', ML, 1.95, tw, th, { alt: 'Order 3 timeline: placed, confirmed, processing, shipped' });
  const sx = ML + tw + 0.3, sw = 4.0;
  img(s, 'detail-shipment', sx, 1.95, sw, sw / 1.568, { alt: 'Shipment by Royal Mail, in transit, with tracking number' });
  img(s, 'detail-emails', sx, 1.95 + sw / 1.568 + 0.25, sw, sw / 3.92, { alt: 'Two emails sent for order 3: confirmed and shipped' });
  const nx = sx + sw + 0.35, nw = W - MR - nx;
  const pts = [
    ['Shipping follows the status.', 'Processing creates the shipment; shipped moves it in transit and emails the tracking number.'],
    ['Each email is sent once.', 'It carries a dedupe key, template plus order, so a replayed event sends nothing new.'],
    ['A gap we show, not hide.', 'There is no address model yet, and the page says so.'],
  ];
  pts.forEach(([a, b], i) => {
    const y = 1.95 + i * 1.3;
    T(s, [{ text: a, options: { bold: true, color: C.ink, fontSize: 13.5, breakLine: true } }, { text: b, options: { color: C.ink2, fontSize: 12 } }],
      { x: nx, y, w: nw, h: 1.2, lineSpacingMultiple: 1.12, paraSpaceAfter: 4 });
  });
  T(s, 'ORDER #3 MOVED TO PROCESSING AND SHIPPED FROM THE ORDERS PAGE.', { x: ML, y: 6.5, w: CW, h: 0.25, mono: true, fontSize: 10, color: C.ink3, charSpacing: 1 });
  notes(s, 'demofulfil');
}

function sOpsView() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act II · Show the product' });
  eyebrow(s, 'Act II  ·  The operator\'s view');
  title(s, 'The same page runs the platform');
  const iw = 5.79, ih = iw / 1.649;
  img(s, 'overview', ML, 1.95, iw, ih, { alt: 'Overview sheet: 7 orders today and where they are in fulfilment' });
  img(s, 'systems', ML + iw + 0.25, 1.95, iw, ih, { alt: 'Systems sheet: health of each service through the gateway' });
  label(s, 'Overview', ML, ih + 2.1, iw);
  T(s, 'Every figure comes from a service API through the gateway. Nothing is invented on the page.', { x: ML, y: ih + 2.37, w: iw - 0.2, h: 0.6, fontSize: 13, color: C.ink2, lineSpacingMultiple: 1.15 });
  label(s, 'Systems', ML + iw + 0.25, ih + 2.1, iw);
  T(s, 'Seven services answer the browser. The worker and scheduler have no route from outside, by design.', { x: ML + iw + 0.25, y: ih + 2.37, w: iw - 0.2, h: 0.6, fontSize: 13, color: C.ink2, lineSpacingMultiple: 1.15 });
  notes(s, 'ops');
}

function sArchitecture() {
  const s = pres.addSlide({ masterName: 'PLUM', sectionTitle: 'Act III · The engineering' });
  eyebrow(s, 'Act III  ·  Architecture', true);
  title(s, 'One entry point, nine services, one queue');
  const D = { dark: true };
  // region frame
  R(s, 2.05, 1.72, 10.53, 4.95, null, C.plumLine2, { dash: 'dash' });
  T(s, 'AWS EU-WEST-2  ·  ONE VPC PER ENVIRONMENT  ·  3 AZS  ·  EKS 1.35 ON PRIVATE SUBNETS', { x: 2.2, y: 1.8, w: 9, h: 0.22, mono: true, fontSize: 9.5, color: C.onPlum2, charSpacing: 1 });
  // browser
  node(s, ML, 2.32, 1.05, 0.95, 'Browser', 'Kit Room page', D);
  L(s, ML + 1.05, 2.8, 2.35, 2.8, C.lav);
  // edge
  node(s, 2.35, 2.2, 1.8, 1.2, 'Edge', 'Route 53, NLB, Traefik. TLS from cert-manager and Let\'s Encrypt.', D);
  L(s, 4.15, 2.8, 4.45, 2.8, C.lav);
  // gateway
  node(s, 4.45, 2.2, 1.75, 1.2, 'api-gateway', 'The only public service. JWT, rate limits, route allow-list.', Object.assign({}, D, { line: C.lav }));
  node(s, 4.45, 3.75, 1.75, 0.82, 'Redis', 'rate-limit counters, StatefulSet with AOF', D);
  L(s, 5.32, 3.4, 5.32, 3.75, C.plumLine2, { dash: 'dash', arrow: false });
  L(s, 6.2, 2.8, 6.33, 2.8, C.lav, { arrow: false });
  L(s, 6.33, 2.4, 6.33, 4.7, C.lav, { arrow: false });
  for (let i = 0; i < 6; i++) L(s, 6.33, 2.4 + i * 0.46, 6.5, 2.4 + i * 0.46, C.lav, { lw: 1 });
  // services
  const svcs = ['order-service', 'inventory-service', 'payment-service', 'shipping-service', 'notification-service', 'dashboard-api'];
  const sx = 6.5, sw = 2.3, rh = 0.4, rg = 0.06;
  svcs.forEach((n, i) => {
    const y = 2.2 + i * (rh + rg);
    R(s, sx, y, sw, rh, C.plumBox, i === 0 ? C.lav : C.plumLine2, { lw: i === 0 ? 1.25 : 0.75 });
    T(s, n, { x: sx + 0.12, y, w: sw - 0.2, h: rh, mono: true, fontSize: 10.5, bold: i === 0, color: i === 0 ? C.onPlum : C.onPlum2, valign: 'middle' });
  });
  const svcBottom = 2.2 + 6 * (rh + rg) - rg; // 4.90
  // postgres
  L(s, sx + sw / 2, svcBottom, sx + sw / 2, 5.18, C.lav, { both: true });
  T(s, 'seven services', { x: sx + sw / 2 + 0.1, y: 4.94, w: 1.2, h: 0.22, mono: true, fontSize: 9, color: C.onPlum2 });
  node(s, sx, 5.18, sw, 0.92, 'Postgres, one DB', 'dev: StatefulSet, 20 Gi gp3. staging and prod: RDS', D);
  // SQS + DLQ + worker
  L(s, sx + sw, 2.3, 9.2, 2.3, C.lav);
  node(s, 9.2, 2.2, 1.5, 0.82, 'SQS', 'order-events, fed by the outbox', D);
  L(s, 9.95, 3.02, 9.95, 3.2, C.plumLine2, { dash: 'dash' });
  node(s, 9.2, 3.2, 1.5, 0.58, 'DLQ', 'after 3 failures', Object.assign({}, D, { bodyTop: 0.31 }));
  L(s, 10.7, 2.6, 10.95, 2.6, C.lav);
  node(s, 10.95, 2.2, 1.45, 0.82, 'worker', 'long-polls SQS, drives fulfilment', Object.assign({}, D, { line: C.lav }));
  // worker calls order, inventory, payment, shipping and notification: a bus on the column's right side
  const bx2 = 9.0;
  P(s, [[11.67, 3.02], [11.67, 4.12], [bx2, 4.12]], C.lav, { arrow: false });
  L(s, bx2, 2.5, bx2, 4.24, C.lav, { arrow: false });
  for (let i = 0; i < 5; i++) L(s, bx2, i === 0 ? 2.5 : 2.4 + i * 0.46, sx + sw, i === 0 ? 2.5 : 2.4 + i * 0.46, C.lav, { lw: 1 });
  T(s, 'calls 5 services over HTTP', { x: 9.1, y: 3.86, w: 2.5, h: 0.22, mono: true, fontSize: 8.5, color: C.onPlum2 });
  node(s, 10.95, 4.55, 1.45, 1.12, 'scheduler', 'expires stock holds, cancels stale orders', D);
  L(s, 10.95, 5.5, sx + sw, 5.5, C.plumLine2);
  T(s, 'DB, and order-service API', { x: 9.0, y: 5.24, w: 1.9, h: 0.22, mono: true, fontSize: 8.5, color: C.onPlum2 });
  // platform band
  R(s, 2.2, 6.18, 10.23, 0.38, C.plumBox, null);
  T(s, [
    { text: 'PLATFORM   ', options: { bold: true, color: C.lav } },
    { text: 'ArgoCD from Git  ·  Karpenter  ·  External Secrets  ·  Pod Identity  ·  Prometheus, Grafana', options: { color: C.onPlum2 } },
  ], { x: 2.35, y: 6.18, w: 10.0, h: 0.38, mono: true, fontSize: 9.5, valign: 'middle' });
  notes(s, 'arch');
}

function sAccept() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act III · The engineering' });
  eyebrow(s, 'Act III  ·  End to end, part 1: accept');
  title(s, 'Accepting an order: all or nothing');
  const y = 2.05, h = 1.45;
  node(s, ML, y, 1.72, h, '1  Browser', 'POST /api/orders with an Idempotency-Key; a retry reuses the same key.', { bodySize: 11 });
  L(s, ML + 1.72, y + h / 2, ML + 2.0, y + h / 2, C.ink2);
  node(s, ML + 2.0, y, 1.72, h, '2  api-gateway', 'Valid JWT? Under the rate limit? A route the outside may call?', { bodySize: 11 });
  L(s, ML + 3.72, y + h / 2, ML + 4.0, y + h / 2, C.ink2);
  node(s, ML + 4.0, y, 1.75, h, '3  order-service', 'Seen this key? Replay the first answer. Otherwise price every line from inventory.', { bodySize: 10.5 });
  L(s, ML + 5.75, y + h / 2, 6.95, y + h / 2, C.accInk, { lw: 1.75 });
  // transaction box
  const tx = 6.95, tw = 3.75, th = 3.1;
  R(s, tx, 1.85, tw, th, C.sheet, C.acc, { lw: 1.75 });
  T(s, 'ONE POSTGRES TRANSACTION', { x: tx + 0.2, y: 1.98, w: tw - 0.4, h: 0.25, mono: true, bold: true, fontSize: 10.5, color: C.accInk, charSpacing: 1.2 });
  const rows = [
    ['idempotency_keys', 'claim (customer, key): the guard'],
    ['orders', 'order #3, status pending'],
    ['order_events', 'order_created, for history'],
    ['order_outbox', 'order.created, waiting to send'],
  ];
  rows.forEach(([a, b], i) => {
    const ry = 2.35 + i * 0.52;
    R(s, tx + 0.2, ry, tw - 0.4, 0.44, C.paper, C.rule);
    T(s, [{ text: 'INSERT ', options: { color: C.ink3 } }, { text: a, options: { bold: true, color: C.ink } }], { x: tx + 0.32, y: ry + 0.03, w: tw - 0.6, h: 0.2, mono: true, fontSize: 9.5 });
    T(s, b, { x: tx + 0.32, y: ry + 0.22, w: tw - 0.6, h: 0.2, fontSize: 9.5, color: C.ink2 });
  });
  T(s, 'COMMIT. All four rows exist, or none do.', { x: tx + 0.2, y: 4.45, w: tw - 0.4, h: 0.3, mono: true, bold: true, fontSize: 10, color: C.ink });
  L(s, tx + tw, y + h / 2, 11.0, y + h / 2, C.accInk, { lw: 1.75 });
  node(s, 11.0, y, 1.58, h, '4  Reply', '201 Created. Order #3, pending. The customer has an order number.', { bodySize: 11, line: C.acc });
  // relay band
  const by = 5.25;
  R(s, ML, by, CW, 1.3, C.plum, null);
  T(s, 'THEN, EVERY SECOND', { x: ML + 0.3, y: by + 0.18, w: 3.2, h: 0.24, mono: true, bold: true, fontSize: 10.5, color: C.lav, charSpacing: 1.2 });
  T(s, 'The outbox relay claims unsent rows (FOR UPDATE SKIP LOCKED, so replicas never collide), sends each to SQS and marks it sent.',
    { x: ML + 0.3, y: by + 0.48, w: 3.85, h: 0.75, fontSize: 11.5, color: C.onPlum, lineSpacingMultiple: 1.15 });
  T(s, 'IF SQS IS UNREACHABLE', { x: ML + 4.45, y: by + 0.18, w: 3.4, h: 0.24, mono: true, bold: true, fontSize: 10.5, color: C.lav, charSpacing: 1.2 });
  T(s, 'The row stays unsent, attempts + 1, and is retried next tick. New orders are still accepted.',
    { x: ML + 4.45, y: by + 0.48, w: 3.45, h: 0.75, fontSize: 11.5, color: C.onPlum, lineSpacingMultiple: 1.15 });
  T(s, 'THE PRICE WE PAY', { x: ML + 8.25, y: by + 0.18, w: 3.3, h: 0.24, mono: true, bold: true, fontSize: 10.5, color: C.lav, charSpacing: 1.2 });
  T(s, 'A crash after SQS accepts but before "sent" is saved sends the event twice, so consumers must be idempotent.',
    { x: ML + 8.25, y: by + 0.48, w: 3.35, h: 0.75, fontSize: 11.5, color: C.onPlum, lineSpacingMultiple: 1.15 });
  notes(s, 'accept');
}

function sProcess() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act III · The engineering' });
  eyebrow(s, 'Act III  ·  End to end, part 2: process');
  title(s, 'Processing: a worker that can safely run twice');
  // queue column
  node(s, ML, 2.0, 2.1, 1.35, 'SQS order-events', 'Long poll 20 s, up to 10 messages. A message is hidden for 60 s while it is worked on.', { bodySize: 10.5 });
  node(s, ML, 4.55, 2.1, 1.65, 'order-events-dlq', 'The third failed receive lands here. Kept 14 days. Redrive once the cause is fixed.', { bodySize: 10.5, line: C.fail });
  L(s, ML + 2.1, 2.68, 3.2, 2.68, C.ink2);
  // worker steps
  const wx = 3.2, ww = 4.7;
  R(s, wx, 1.9, ww, 4.3, C.sheet, C.acc, { lw: 1.25 });
  T(s, 'WORKER, FOR ORDER #3', { x: wx + 0.25, y: 2.02, w: 3, h: 0.24, mono: true, bold: true, fontSize: 10.5, color: C.accInk, charSpacing: 1.2 });
  const steps = [
    ['0', 'Check the order first', 'pending: run below. confirmed: only commit stock. cancelled: undo.'],
    ['1', 'Reserve stock', 'inventory /reserve. A repeat returns the same hold.'],
    ['2', 'Charge', 'payment /charge, key charge-order-3. A repeat replays the first answer.'],
    ['3', 'Confirm', 'order /status, compare-and-set: only if still pending.'],
    ['4', 'Commit stock, delete message', 'Stock leaves the shelf only now.'],
  ];
  steps.forEach(([n, a, b], i) => {
    const y = 2.4 + i * 0.74;
    badge(s, wx + 0.25, y + 0.02, n, { d: 0.3, size: 10, fill: i === 0 ? C.ink : C.acc });
    T(s, a, { x: wx + 0.7, y, w: ww - 0.9, h: 0.27, bold: true, fontSize: 12.5, color: C.ink });
    T(s, b, { x: wx + 0.7, y: y + 0.28, w: ww - 0.9, h: 0.4, fontSize: 10.5, color: C.ink2 });
    if (i < steps.length - 1) L(s, wx + 0.4, y + 0.36, wx + 0.4, y + 0.74, C.rule2, { arrow: false, lw: 1 });
  });
  // outcomes
  const ox = 8.25, ow = W - MR - ox;
  label(s, 'Three possible endings', ox, 1.95, ow);
  const outs = [
    [C.ok, C.okWash, 'Success', 'Message deleted. Status events follow: confirmation email, then shipment and tracking as the order moves on.'],
    [C.warn, C.warnWash, 'A final "no"', 'Out of stock or card declined: release stock, cancel, tell the customer, delete. Retrying would not change the answer.'],
    [C.fail, C.failWash, 'An error or timeout', 'Not deleted. SQS hands it out again after 60 s. On the third failure it moves to the DLQ.'],
  ];
  outs.forEach(([col, wash, a, b], i) => {
    const y = 2.25 + i * 1.33;
    R(s, ox, y, ow, 1.18, wash, null);
    T(s, a, { x: ox + 0.22, y: y + 0.12, w: ow - 0.4, h: 0.3, bold: true, fontSize: 13, color: col });
    T(s, b, { x: ox + 0.22, y: y + 0.42, w: ow - 0.4, h: 0.72, fontSize: 11, color: C.ink, lineSpacingMultiple: 1.12 });
  });
  L(s, wx + ww, 4.17, ox - 0.12, 4.17, C.rule2, { arrow: false, lw: 1 });
  L(s, ox - 0.12, 2.84, ox - 0.12, 5.5, C.rule2, { arrow: false, lw: 1 });
  L(s, ox - 0.12, 2.84, ox, 2.84, C.rule2, { arrow: false, lw: 1 });
  L(s, ox - 0.12, 4.17, ox, 4.17, C.rule2, { arrow: false, lw: 1 });
  L(s, ox - 0.12, 5.5, ox, 5.5, C.rule2, { arrow: false, lw: 1 });
  L(s, ML + 1.05, 3.35, ML + 1.05, 4.55, C.fail, { dash: 'dash' });
  T(s, 'third\nfailure', { x: ML + 1.15, y: 3.65, w: 0.9, h: 0.5, mono: true, fontSize: 9.5, color: C.fail });
  notes(s, 'process');
}

function sEvidence() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act III · The engineering' });
  eyebrow(s, 'Act III  ·  Why retries are safe');
  title(s, 'We broke it first, then made retries safe');
  // left table: layers
  const x = ML, w = 6.75;
  label(s, 'Where a repeat is absorbed', x, 1.95, w, C.accInk);
  const rows = [
    ['Request', 'double click, client retry', 'Idempotency-Key. Primary key on (customer, key) lets one request win.'],
    ['Worker', 'SQS redelivery', 'Check the order first. Status changes are compare-and-set.'],
    ['Payment', 'charge retried', 'Key charge-order-N, and a unique index: one completed charge per order.'],
    ['Email', 'event replayed', 'Dedupe key template:order, held by a unique index.'],
  ];
  T(s, 'LAYER', { x, y: 2.3, w: 1.1, h: 0.22, mono: true, fontSize: 9.5, color: C.ink3 });
  T(s, 'A REPEAT LOOKS LIKE', { x: x + 1.15, y: 2.3, w: 1.9, h: 0.22, mono: true, fontSize: 9.5, color: C.ink3 });
  T(s, 'WHAT ABSORBS IT', { x: x + 3.1, y: 2.3, w: 3.6, h: 0.22, mono: true, fontSize: 9.5, color: C.ink3 });
  L(s, x, 2.58, x + w, 2.58, C.ink, { arrow: false, lw: 1 });
  rows.forEach(([a, b, c], i) => {
    const y = 2.68 + i * 0.82;
    T(s, a, { x, y, w: 1.1, h: 0.3, bold: true, fontSize: 13, color: C.ink });
    T(s, b, { x: x + 1.15, y, w: 1.85, h: 0.65, fontSize: 12, color: C.ink2 });
    T(s, c, { x: x + 3.1, y, w: 3.6, h: 0.7, fontSize: 12, color: C.ink, lineSpacingMultiple: 1.12 });
    L(s, x, y + 0.75, x + w, y + 0.75, C.rule, { arrow: false, lw: 0.75 });
  });
  T(s, '168 test functions pass with the race detector on, re-run against Postgres, Redis and a local SQS on 13 Oct.', { x, y: 6.1, w: w, h: 0.5, fontSize: 12, color: C.ink3 });
  // right: measured bugs
  const rx = 7.95, rw = W - MR - rx;
  R(s, rx, 1.95, rw, 4.65, C.plum, null);
  T(s, 'REPRODUCED BEFORE THE FIX', { x: rx + 0.3, y: 2.15, w: rw - 0.6, h: 0.24, mono: true, bold: true, fontSize: 10.5, color: C.lav, charSpacing: 1.2 });
  const stats = [
    ['25 of 30', 'runs where a concurrent confirm and cancel both succeeded', 'now 0'],
    ['−57', 'stock "reserved" after 20 concurrent releases of a hold of 3', 'now 0'],
    ['6 rows', 'in payments after 6 retries of one charge', 'now 1'],
  ];
  stats.forEach(([a, b, c], i) => {
    const y = 2.55 + i * 1.22;
    T(s, a, { x: rx + 0.3, y, w: 2.8, h: 0.55, head: true, bold: true, fontSize: 30, color: C.onPlum });
    T(s, c.toUpperCase(), { x: rx + rw - 1.3, y: y + 0.12, w: 1.0, h: 0.3, mono: true, bold: true, fontSize: 11, color: C.lav, align: 'right' });
    T(s, b, { x: rx + 0.3, y: y + 0.58, w: rw - 0.6, h: 0.5, fontSize: 11.5, color: C.onPlum2, lineSpacingMultiple: 1.1 });
  });
  T(s, 'Team fix-evidence log, 23 to 24 Sep, against a Postgres 16 test database.', { x: rx + 0.3, y: 6.15, w: rw - 0.6, h: 0.35, fontSize: 10, color: C.onPlum2 });
  notes(s, 'evidence');
}

// Decision slide frame. visual(s) draws the "what we chose" area at x ML..7.65, y 2.75..5.35.
function decision(key, n, heading, problem, gained, gaveUp, alternatives, evidence, visual) {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act III · The engineering' });
  eyebrow(s, `Act III  ·  Decision ${n} of 5`);
  title(s, heading);
  label(s, 'The problem', ML, 1.85, 6.9);
  T(s, problem, { x: ML, y: 2.1, w: 6.9, h: 0.85, fontSize: 14, color: C.ink, lineSpacingMultiple: 1.12 });
  visual(s);
  const rx = 8.05, rw = W - MR - rx;
  const box = (y, h, col, wash, head, items) => {
    R(s, rx, y, rw, h, wash, null);
    T(s, head, { x: rx + 0.25, y: y + 0.15, w: rw - 0.5, h: 0.24, mono: true, bold: true, fontSize: 10.5, color: col, charSpacing: 1.2 });
    T(s, items.map((t, i) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: i < items.length - 1, paraSpaceAfter: 5 } })),
      { x: rx + 0.25, y: y + 0.45, w: rw - 0.45, h: h - 0.55, fontSize: 12, color: C.ink, lineSpacingMultiple: 1.08 });
  };
  box(1.85, 2.05, C.ok, C.okWash, 'WE GAINED', gained);
  box(4.05, 2.15, C.warn, C.warnWash, 'WE GAVE UP', gaveUp);
  label(s, 'Alternatives we weighed', ML, 5.42, 6.9);
  T(s, alternatives, { x: ML, y: 5.68, w: 6.9, h: 0.5, fontSize: 11.5, color: C.ink2, lineSpacingMultiple: 1.1 });
  L(s, ML, 6.3, W - MR, 6.3, C.rule, { arrow: false, lw: 0.75 });
  T(s, [{ text: 'EVIDENCE  ', options: { bold: true, color: C.accInk, fontFace: MONO } }, { text: evidence, options: { color: C.ink2 } }],
    { x: ML, y: 6.38, w: CW, h: 0.42, fontSize: 10.5, lineSpacingMultiple: 1.05 });
  notes(s, key);
  return s;
}

function sDecisions() {
  // 1. SQS + outbox
  decision('d1', 1, 'SQS behind a transactional outbox',
    'Saving an order (Postgres) and announcing it (SQS) are two systems. If the announcement is lost after the save, nothing ever reserves stock or takes payment.',
    ['SQS outage: orders still accepted, events wait', 'Retries, visibility timeout and DLQ built in', 'Managed and near free at our volume', 'The services were already written for SQS'],
    ['At-least-once: duplicates are possible, so every consumer step must be safe to repeat', 'No ordering, no replay once a message is deleted', 'Up to about 1 s extra before processing starts', 'Payment and shipment events are not on an outbox yet'],
    'Kafka on Strimzi: three brokers on volumes, producer rewrites. Publish after commit: a crash loses the event. SQS FIFO: ordering we do not need.',
    'outbox_test.go (relay retry, shutdown mid-batch); local drill 24 Sep: payment stopped, 3 receives, DLQ, redrive, order processed.',
    (s) => {
      const y = 3.12;
      const bw3 = 1.5, g3 = 0.3;
      [['order-service', 'writes the order and its event'], ['Postgres', 'orders and order_outbox, one commit'], ['relay', 'every 1 s, SKIP LOCKED'], ['SQS', 'then the worker']].forEach(([a, b], i) => {
        const x = ML + i * (bw3 + g3);
        node(s, x, y, bw3, 1.0, a, b, i === 1 ? { bodySize: 10, line: C.acc, lw: 1.25 } : { bodySize: 10 });
        if (i < 3) L(s, x + bw3, y + 0.5, x + bw3 + g3, y + 0.5, C.ink2);
      });
      R(s, ML, 4.3, 6.9, 0.92, C.accWash, null);
      T(s, [{ text: 'The order and its event share one commit. ', options: { bold: true } }, { text: 'If SQS or the NAT path is down, the event row waits and the relay retries every second. Lost becomes late.' }],
        { x: ML + 0.2, y: 4.33, w: 6.5, h: 0.86, fontSize: 12.5, color: C.ink, valign: 'middle', lineSpacingMultiple: 1.12 });
    });

  // 2. Data placement
  decision('d2', 2, 'Postgres in the cluster for dev, RDS beyond',
    'An order, its stock hold, its payment and its outbox row commit together, so one relational database. The brief wants a StatefulSet; production wants failover and backups we would rather not hand-run.',
    ['Dev meets the brief and costs only a volume', 'Prod gets managed failover and point-in-time restore', 'Services never know: External Secrets builds DATABASE_URL'],
    ['Dev Postgres is one pod on one AZ\'s disk: lose the AZ, writes stop until a restore', 'Two database setups to understand', 'RDS has never run live: staging and prod are not deployed'],
    'StatefulSet everywhere: we own failover and backups. RDS everywhere: skips the StatefulSet the brief grades, costs while idle. CloudNativePG: one more operator.',
    'dev StatefulSet and SnapScheduler (daily, keep 7) in Git and on EKS; snapshot class confirmed on dev 10 Oct. A restore with a data check is not recorded.',
    (s) => {
      const cols = [
        ['dev', 'StatefulSet postgres-0', '20 Gi encrypted gp3, daily EBS snapshot, 7 kept', 'RAN ON EKS', C.ok],
        ['staging', 'RDS db.t4g.medium', 'single AZ, smaller and cheaper', 'IN CODE ONLY', C.warn],
        ['prod', 'RDS db.m7g.large', 'Multi-AZ. Terraform refuses prod without deletion protection and 7+ days of backups', 'IN CODE ONLY', C.warn],
      ];
      cols.forEach(([env, a, b, st, col], i) => {
        const x = ML + i * 2.35, w = 2.2, y = 3.12;
        R(s, x, y, w, 2.1, C.sheet, C.rule2);
        T(s, env.toUpperCase(), { x: x + 0.18, y: y + 0.15, w: w - 0.3, h: 0.24, mono: true, bold: true, fontSize: 11, color: C.accInk, charSpacing: 1.2 });
        T(s, a, { x: x + 0.18, y: y + 0.45, w: w - 0.3, h: 0.3, bold: true, fontSize: 12, color: C.ink });
        T(s, b, { x: x + 0.18, y: y + 0.8, w: w - 0.3, h: 1.0, fontSize: 10.5, color: C.ink2, lineSpacingMultiple: 1.1 });
        T(s, st, { x: x + 0.18, y: y + 1.75, w: w - 0.3, h: 0.24, mono: true, bold: true, fontSize: 9.5, color: col, charSpacing: 1 });
      });
    });

  // 3. Delivery
  decision('d3', 3, 'CI builds, Git decides, ArgoCD deploys',
    'Nine services ship on their own schedules. A change to one must not redeploy or risk the other eight, and the pipeline should hold no keys to the cluster.',
    ['Rollback is one revert, for one service', 'CI has no cluster credentials at all', 'ArgoCD reverts hand edits (self-heal)', 'Only changed services are built'],
    ['A deploy waits for ArgoCD to notice the commit', 'A bot must be allowed to write to main', 'One chart bug reaches all nine (schema and kubeconform guard it)', 'Canary analysis passes when there is no traffic'],
    'CI runs helm upgrade: cluster keys in CI. Flux: equally valid, the team knew ArgoCD. Kustomize overlays: simpler patches, logic copied nine times.',
    'smoke test on EKS dev, 8 Oct: 8 failures before the hardening deploy, all steps passing after. Zero downtime is not proven (slide 18).',
    (s) => {
      const items = [['commit', 'one service'], ['CI', 'vet, tests, build, Trivy'], ['ECR', 'one image per commit'], ['Git', 'tag in dev values'], ['ArgoCD', 'one app per service'], ['canary', '50%, check, 100%']];
      const x0 = ML, y = 3.15, w = 1.0, g = 0.18;
      items.forEach(([a, b], i) => {
        const x = x0 + i * (w + g);
        node(s, x, y, w, 1.05, a, b, { bodySize: 9.5, nameSize: 10.5, line: i === 3 ? C.acc : C.rule2, lw: i === 3 ? 1.25 : 0.75 });
        if (i < items.length - 1) L(s, x + w, y + 0.52, x + w + g, y + 0.52, C.ink2);
      });
      T(s, 'Prod never auto-syncs: promotion copies a tested tag dev to staging to prod by pull request, and someone syncs prod in ArgoCD.',
        { x: ML, y: 4.42, w: 6.9, h: 0.75, fontSize: 12, color: C.ink2, lineSpacingMultiple: 1.12 });
    });

  // 4. NAT
  decision('d4', 4, 'One NAT gateway, on purpose',
    'Private nodes must reach the internet: GitHub for ArgoCD, Let\'s Encrypt for certificates, public image registries, and AWS APIs for the pods. The brief says avoid NAT if you can.',
    ['The cheapest design that still reaches GitHub and Let\'s Encrypt', 'S3 traffic, including image layers, skips the NAT through a free gateway endpoint'],
    ['One AZ outage cuts outbound traffic for all three AZs', 'Image pulls, certificate renewals, ArgoCD syncs and SQS calls fail until it returns', 'Traffic inside the cluster carries on'],
    'A NAT per AZ: survives an AZ loss at 3× the hourly cost. Interface endpoints: 6+ services × 3 AZs = 18 billed endpoints, and still no route to GitHub.',
    'modules/vpc: one aws_nat_gateway, one S3 gateway endpoint. The outbox keeps orders safe while SQS is unreachable.',
    (s) => {
      const y0 = 3.12, x = ML;
      const nat = { x: x + 2.45, y: y0 + 0.4, w: 1.6, h: 0.85 };
      ['a', 'b', 'c'].forEach((az, i) => {
        const y = y0 + i * 0.58;
        R(s, x, y, 1.75, 0.45, C.sheet, C.rule2);
        T(s, [{ text: 'AZ ' + az + '  ', options: { bold: true, color: C.ink } }, { text: 'private nodes', options: { color: C.ink2 } }], { x: x + 0.12, y, w: 1.6, h: 0.45, mono: true, fontSize: 9.5, valign: 'middle' });
        L(s, x + 1.75, y + 0.225, nat.x, nat.y + 0.2 + i * 0.225, C.accInk, { lw: 1 });
      });
      R(s, nat.x, nat.y, nat.w, nat.h, C.accWash, C.acc, { lw: 1.25 });
      T(s, 'NAT gateway', { x: nat.x, y: nat.y + 0.12, w: nat.w, h: 0.3, mono: true, bold: true, fontSize: 10.5, color: C.accInk, align: 'center' });
      T(s, 'one, in AZ a', { x: nat.x, y: nat.y + 0.45, w: nat.w, h: 0.3, fontSize: 10, color: C.ink2, align: 'center' });
      L(s, nat.x + nat.w, nat.y + nat.h / 2, x + 4.65, nat.y + nat.h / 2, C.accInk, { lw: 1.25 });
      R(s, x + 4.65, y0, 2.25, 1.61, C.paper2, null);
      T(s, 'OUT TO THE INTERNET', { x: x + 4.8, y: y0 + 0.1, w: 2.0, h: 0.25, mono: true, bold: true, fontSize: 9, color: C.accInk });
      T(s, 'GitHub, Let\'s Encrypt, quay, ghcr, and AWS APIs: SQS, STS, Secrets Manager, ECR', { x: x + 4.8, y: y0 + 0.4, w: 2.0, h: 1.2, fontSize: 10.5, color: C.ink, lineSpacingMultiple: 1.12 });
      R(s, x, y0 + 1.76, 6.9, 0.36, null, C.rule2, { dash: 'dash' });
      T(s, [{ text: 'S3 GATEWAY ENDPOINT  ', options: { bold: true, color: C.ok } }, { text: 'free: image layers in S3 skip the NAT', options: { color: C.ink2 } }], { x: x + 0.15, y: y0 + 1.76, w: 6.6, h: 0.36, mono: true, fontSize: 9.5, valign: 'middle' });
    });

  // 5. Identity
  decision('d5', 5, 'No long-lived AWS keys anywhere',
    'Pipelines and pods both call AWS. A static access key in a secret or an image works anywhere, for anyone who copies it, until someone rotates it.',
    ['Nothing in Git, CI or an image can reach AWS on its own', 'Each workload can do one job: order-service sends, the worker receives and deletes', 'The same role definitions work on every cluster'],
    ['We departed from the brief\'s wording (IRSA) while keeping its intent', 'Needs the Pod Identity agent on every node, and no Fargate', 'More roles to reason about'],
    'IRSA: an OIDC provider per cluster, named in every trust policy. Static keys in GitHub secrets: simple, and exactly what the brief rules out.',
    'bootstrap/github-actions-roles.tf (trust pinned to org, repo and Environment); modules/pod-identity; IMDSv2 hop limit 1, so pods cannot borrow the node role.',
    (s) => {
      const y1 = 3.25, y2 = 4.25, x = ML;
      label(s, 'Pipelines', x, y1 - 0.02, 1.2);
      node(s, x + 1.2, y1 - 0.08, 1.6, 0.8, 'GitHub job', 'runs as an Environment', { bodySize: 10 });
      L(s, x + 2.8, y1 + 0.32, x + 3.1, y1 + 0.32, C.ink2);
      node(s, x + 3.1, y1 - 0.08, 1.5, 0.8, 'OIDC token', 'short-lived, signed', { bodySize: 10 });
      L(s, x + 4.6, y1 + 0.32, x + 4.9, y1 + 0.32, C.ink2);
      node(s, x + 4.9, y1 - 0.08, 2.0, 0.8, 'role per env', 'PRs: read-only plan. Prod: a second approver', { bodySize: 10, line: C.acc, lw: 1.25 });
      label(s, 'Pods', x, y2 + 0.08, 1.2);
      node(s, x + 1.2, y2, 1.6, 1.02, 'pod', 'its own service account', { bodySize: 10 });
      L(s, x + 2.8, y2 + 0.45, x + 3.1, y2 + 0.45, C.ink2);
      node(s, x + 3.1, y2, 1.5, 1.02, 'Pod Identity', 'agent on the node', { bodySize: 10 });
      L(s, x + 4.6, y2 + 0.45, x + 4.9, y2 + 0.45, C.ink2);
      node(s, x + 4.9, y2, 2.0, 1.02, 'role per workload', 'order-service: SendMessage. worker: Receive, Delete', { bodySize: 10, line: C.acc, lw: 1.25 });
    });
}

function sStatus() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act IV · Engineering judgment' });
  eyebrow(s, 'Act IV  ·  Where we stand');
  title(s, 'What we have proven, and what we have not');
  const cols = [
    [C.ok, C.okWash, 'Demonstrated on EKS dev', [
      'All nine services healthy behind HTTPS at a real DNS name (Let\'s Encrypt staging certificate)',
      'The full order lifecycle, including cancel and refund: smoke test, 8 Oct, every step passing',
      'Internal routes refused at the gateway (404 from outside)',
      'Built from Git: Terraform pipelines, then ArgoCD bootstrapping the platform in sync waves',
      'Daily EBS snapshots of the dev database scheduled',
    ]],
    [C.accInk, C.accWash, 'Proven in tests, not under load', [
      '168 test functions, all passing with the race detector on (re-run 13 Oct)',
      'Duplicate and concurrent requests: one order, one charge, one email',
      'Payment outage: retries, DLQ, redrive, order processed (local drill)',
      'The whole journey on the current build, run locally on 13 Oct',
    ]],
    [C.warn, C.warnWash, 'Defined in code, not yet run', [
      'Staging and prod, including RDS and promotion between them',
      'k6 load tests: plan and scripts written, never executed',
      'A restore checked against known data; a chaos drill',
      'Argo Rollouts canary against a deliberately bad release',
    ]],
  ];
  const cw = (CW - 0.5) / 3;
  cols.forEach(([col, wash, head, items], i) => {
    const x = ML + i * (cw + 0.25), y = 1.95;
    R(s, x, y, cw, 4.25, wash, null);
    T(s, head.toUpperCase(), { x: x + 0.25, y: y + 0.2, w: cw - 0.5, h: 0.45, mono: true, bold: true, fontSize: 11, color: col, charSpacing: 1 });
    T(s, items.map((t, j) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: j < items.length - 1, paraSpaceAfter: 7 } })),
      { x: x + 0.25, y: y + 0.65, w: cw - 0.45, h: 3.5, fontSize: 12, color: C.ink, lineSpacingMultiple: 1.08 });
  });
  T(s, [{ text: 'Not claimed: ', options: { bold: true, color: C.ink } }, { text: 'zero downtime. A 30 to 60 second blip during an ArgoCD sync on 10 Oct still has no root cause.', options: { color: C.ink2 } }],
    { x: ML, y: 6.35, w: CW, h: 0.35, fontSize: 12.5 });
  notes(s, 'status');
}

function sLimits() {
  const s = pres.addSlide({ masterName: 'PAPER', sectionTitle: 'Act IV · Engineering judgment' });
  eyebrow(s, 'Act IV  ·  Limits and next steps');
  title(s, 'Limits that matter, and what we would do next');
  const lx = ML, lw = 6.3;
  label(s, 'Limits that matter', lx, 1.95, lw, C.fail);
  const lim = [
    ['Anyone can sign in.', 'Login accepts any email, and every signed-in user sees every order.'],
    ['Connections run out first.', 'Seven pools allow 115 connections against Postgres\'s default 100.'],
    ['Two event types bypass the outbox.', 'Payment and shipment events are only logged, and the DLQ alarm notifies nobody.'],
    ['Dev Postgres lives in one AZ.', 'Lose that AZ and writes stop until a snapshot is restored elsewhere.'],
  ];
  lim.forEach(([a, b], i) => {
    const y = 2.3 + i * 1.05;
    T(s, a, { x: lx, y, w: lw, h: 0.32, bold: true, fontSize: 14, color: C.ink });
    T(s, b, { x: lx, y: y + 0.33, w: lw, h: 0.6, fontSize: 12.5, color: C.ink2, lineSpacingMultiple: 1.12 });
    if (i < lim.length - 1) L(s, lx, y + 0.95, lx + lw, y + 0.95, C.rule, { arrow: false, lw: 0.75 });
  });
  const rx = 7.45, rw = W - MR - rx;
  R(s, rx, 1.95, rw, 4.6, C.plum, null);
  T(s, 'NEXT, IN THIS ORDER', { x: rx + 0.35, y: 2.15, w: rw - 0.7, h: 0.24, mono: true, bold: true, fontSize: 10.5, color: C.lav, charSpacing: 1.2 });
  const next = [
    ['Measure before tuning.', 'Run the k6 plan on dev, then size the pools or add PgBouncer from what it shows.'],
    ['Real identity.', 'Customer accounts and ownership checks at the gateway, before any real user.'],
    ['Rehearse the bad day.', 'Stand up staging, restore a snapshot against known data, roll back a bad release on purpose.'],
  ];
  next.forEach(([a, b], i) => {
    const y = 2.6 + i * 1.28;
    T(s, String(i + 1).padStart(2, '0'), { x: rx + 0.35, y, w: 0.7, h: 0.5, head: true, bold: true, fontSize: 26, color: C.lav });
    T(s, a, { x: rx + 1.05, y: y + 0.02, w: rw - 1.4, h: 0.32, bold: true, fontSize: 14, color: C.onPlum });
    T(s, b, { x: rx + 1.05, y: y + 0.36, w: rw - 1.4, h: 0.8, fontSize: 12, color: C.onPlum2, lineSpacingMultiple: 1.12 });
  });
  notes(s, 'limits');
}

function sClose() {
  const s = pres.addSlide({ masterName: 'PLUM_BARE', sectionTitle: 'Act IV · Engineering judgment' });
  CUR.title = 'Engineered for the order that goes wrong'; CUR.eyebrow = 'Act IV · Close';
  T(s, 'KIT ROOM  ·  TEAM ALPHA', { x: ML, y: 0.72, w: 6, h: 0.3, mono: true, fontSize: 11, color: C.onPlum2, charSpacing: 2 });
  T(s, [
    { text: 'Engineered for the', options: { breakLine: true } },
    { text: 'order that goes wrong.', options: { color: C.lav } },
  ], { x: ML, y: 1.45, w: 11.8, h: 2.0, head: true, bold: true, fontSize: 56, color: C.onPlum, lineSpacingMultiple: 0.95 });
  const proofs = [
    ['If SQS goes quiet', 'orders are still accepted. Their events wait in the outbox.'],
    ['If a request repeats', 'nothing doubles. Keys and state checks absorb it.'],
    ['If the repo leaks', 'it holds no AWS key. Pipelines and pods borrow short-lived roles.'],
  ];
  proofs.forEach(([a, b], i) => {
    const x = ML + i * 3.95;
    L(s, x, 4.15, x + 3.65, 4.15, C.plumLine2, { arrow: false, lw: 0.75 });
    T(s, a.toUpperCase(), { x, y: 4.3, w: 3.65, h: 0.26, mono: true, bold: true, fontSize: 10.5, color: C.lav, charSpacing: 1.2 });
    T(s, b, { x, y: 4.65, w: 3.55, h: 0.9, fontSize: 15, color: C.onPlum, lineSpacingMultiple: 1.15 });
  });
  T(s, 'Built for a $200 budget, by five engineers, in four weeks.', { x: ML, y: 5.9, w: 8, h: 0.35, fontSize: 15, color: C.onPlum2 });
  T(s, 'QUESTIONS WELCOME  ·  APPENDIX A1 TO A8 HOLDS THE DETAIL', { x: ML, y: 6.75, w: 9, h: 0.3, mono: true, fontSize: 10, color: C.onPlum2, charSpacing: 1.5 });
  notes(s, 'close');
}

// ---------- appendix ----------
function table(slide, x, y, colW, header, rows, o = {}) {
  const fs = o.fontSize || 12;
  const none = { type: 'none' };
  const bottom = (c) => [none, none, { type: 'solid', pt: 0.75, color: c }, none];
  const data = [header.map((h) => ({ text: h.toUpperCase(), options: { fontFace: MONO, fontSize: 9.5, color: C.ink3, bold: false, border: bottom(C.ink), margin: [4, 8, 6, 0] } }))];
  rows.forEach((r) => data.push(r.map((cell, j) => {
    const txt = typeof cell === 'string' ? cell : cell.text;
    const extra = typeof cell === 'string' ? {} : cell.options;
    return { text: txt, options: Object.assign({ fontFace: BODY, fontSize: fs, color: j === 0 ? C.ink : C.ink2, bold: j === 0, border: bottom(C.rule), margin: [7, 10, 7, 0], valign: 'top' }, extra) };
  })));
  slide.addTable(data, { x, y, w: colW.reduce((a, b) => a + b, 0), colW, fill: { color: C.paper } });
}
function appx(key, code, heading) {
  const s = pres.addSlide({ masterName: 'APPENDIX', sectionTitle: 'Appendix · Questions and evidence' });
  eyebrow(s, `Appendix ${code}`);
  title(s, heading);
  notes(s, key);
  return s;
}

function sAppendix() {
  // A1 delivery path
  let s = appx('a1', 'A1  ·  Deployment pipeline', 'A change to payment-service, from commit to traffic');
  const steps = [
    ['Pull request', 'Only payment-service changed, so only its job runs: go vet, go test with the race detector, docker build, Trivy (fails on HIGH or CRITICAL).'],
    ['Infra checks, if touched', 'helm lint and kubeconform on every rendered service; terraform fmt, validate, Checkov and a plan per environment.'],
    ['Merge to main', 'The image is built once, tagged with the service and commit, and pushed to ECR. No other service is rebuilt.'],
    ['Tag commit', 'A GitHub App commits the new tag to the dev values file for payment-service. Git now says what dev should run.'],
    ['ArgoCD sync', 'Only payment-service-dev changes. The other eight Applications see no diff.'],
    ['Canary', 'Argo Rollouts sends 50%, checks error rate (5% max) and p95 (500 ms max) in Prometheus, then 100%.'],
    ['Promote', 'The Promote workflow opens a PR copying the tested tag to staging, then prod. Prod needs approval and a manual sync.'],
    ['Roll back', 'Revert the tag commit. The old image is still in ECR, so it is one rollout.'],
  ];
  steps.forEach(([a, b], i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const x = ML + col * 2.98, y = 1.95 + row * 2.25, w = 2.78;
    badge(s, x, y, i + 1, { d: 0.32, size: 10, fill: i >= 6 ? C.ink : C.acc });
    T(s, a, { x: x + 0.45, y: y + 0.02, w: w - 0.45, h: 0.3, bold: true, fontSize: 13, color: C.ink });
    T(s, b, { x, y: y + 0.45, w, h: 1.7, fontSize: 12.5, color: C.ink2, lineSpacingMultiple: 1.12 });
  });
  T(s, 'The canary landed last, in the 13 Oct sync. Not yet tried against a bad release; with no traffic its checks pass by default.',
    { x: ML, y: 6.4, w: CW, h: 0.35, fontSize: 12, color: C.ink3 });

  // A2 secrets
  s = appx('a2', 'A2  ·  Secrets', 'From Secrets Manager to a pod, and what rotation does');
  const chain = [
    ['Terraform', 'generates the JWT secret, DB password and Grafana password, write-only'],
    ['Secrets Manager', 'encrypted with a customer-managed KMS key'],
    ['External Secrets', 'the only reader, through Pod Identity; refresh every 15 min'],
    ['Kubernetes Secret', 'one per service, only the keys it needs; KMS envelope encryption in etcd'],
    ['Pod', 'loads it as env vars; non-root, read-only filesystem, no SA token'],
  ];
  chain.forEach(([a, b], i) => {
    const x = ML + i * 2.41, w = 2.17;
    node(s, x, 2.0, w, 1.45, a, b, { bodySize: 10.5, line: i === 2 ? C.acc : C.rule2 });
    if (i < chain.length - 1) L(s, x + w, 2.72, x + 2.41, 2.72, C.ink2);
  });
  table(s, ML, 3.85, [2.6, 4.6, 4.63], ['Rotated', 'Who restarts', 'The gap'], [
    ['JWT secret', 'api-gateway only (Reloader watches its Secret)', 'Tokens signed with the old secret stop working; users sign in again.'],
    ['Database password', 'The seven services that use Postgres, one pod at a time', 'Until the refresh lands (up to 15 min), new connections from old pods fail; open ones keep working.'],
    ['Who never restarts', 'The worker: it holds no secret at all', 'It reaches SQS through Pod Identity, not a key.'],
  ], { fontSize: 12.5 });

  // A3 scaling
  s = appx('a3', 'A3  ·  Scaling', 'What scales, on what signal, and what breaks first');
  table(s, ML, 1.95, [2.7, 2.2, 3.0], ['Component', 'Scales on', 'Limits in dev'], [
    ['api-gateway', 'HPA, CPU 70%', '2 to 3 pods'],
    ['Six HTTP services', 'HPA, CPU 70%', '1 to 3 pods each'],
    ['worker', 'fixed', '1 pod. Queue depth (KEDA) is the better signal'],
    ['scheduler', 'never', '1 pod. Chart refuses more, uses Recreate'],
    ['Postgres, Redis', 'never', '1 pod each, StatefulSet'],
    ['Nodes', 'Karpenter, pending pods', '3 base t3.medium; on-demand only, 16 vCPU and 64 GiB cap'],
  ], { fontSize: 12.5 });
  const bx = 8.95, bw = W - MR - bx;
  R(s, bx, 1.95, bw, 4.6, C.plum, null);
  T(s, 'WHAT BREAKS FIRST', { x: bx + 0.25, y: 2.12, w: bw - 0.5, h: 0.3, mono: true, bold: true, fontSize: 10, color: C.lav, charSpacing: 1 });
  T(s, [
    { text: 'Reasoned from configuration, not measured.', options: { color: C.lav, breakLine: true } },
    { text: ' ', options: { breakLine: true } },
    { text: 'Connections. ', options: { bold: true, color: C.onPlum } }, { text: '115 allowed by the pools, 100 by Postgres. Each new pod adds up to 25.', options: { breakLine: true, color: C.onPlum2 } },
    { text: ' ', options: { breakLine: true } },
    { text: 'Postgres itself. ', options: { bold: true, color: C.onPlum } }, { text: 'One writer on one volume.', options: { breakLine: true, color: C.onPlum2 } },
    { text: ' ', options: { breakLine: true } },
    { text: 'Redis down. ', options: { bold: true, color: C.onPlum } }, { text: 'The gateway fails open: up, but unthrottled.', options: { breakLine: true, color: C.onPlum2 } },
    { text: ' ', options: { breakLine: true } },
    { text: 'Worker behind. ', options: { bold: true, color: C.onPlum } }, { text: 'SQS keeps the backlog for 4 days. Slower, not lost.', options: { color: C.onPlum2 } },
  ], { x: bx + 0.25, y: 2.5, w: bw - 0.5, h: 3.9, fontSize: 12, lineSpacingMultiple: 1.1 });

  // A4 failure scenarios
  s = appx('a4', 'A4  ·  Failure scenarios', 'What happens when things fail, and how we know');
  table(s, ML, 1.95, [2.55, 6.2, 3.08], ['Scenario', 'What happens', 'How we know'], [
    ['Worker fails 3 times', 'Not deleted, back after 60 s; third failure goes to the DLQ (kept 14 days). Redrive after the fix; steps are safe to repeat.', 'Local drill, 24 Sep'],
    ['payment-service down 2 min', 'Orders still accepted. Charges fail and the messages return; most succeed once it is back. Stock is held 15 min.', 'Code path and local drill'],
    ['SQS or the NAT unreachable', 'Orders accepted; outbox rows wait and the relay retries every second. The worker pauses.', 'outbox tests'],
    ['Same order sent twice', 'The same Idempotency-Key returns the first order.', 'Smoke test on EKS, 8 Oct'],
    ['Bad notification-service image', 'New pods fail readiness; old ones keep serving. Revert one tag commit; eight services untouched.', 'Design; not drilled'],
    ['Postgres pod deleted', 'StatefulSet recreates it on the same volume; services reconnect.', 'Expected; not drilled'],
    ['AZ holding the dev DB lost', 'Pod stays Pending. Restore the latest snapshot in another AZ, losing writes since.', 'Procedure only'],
  ], { fontSize: 12 });

  // A5 storage
  s = appx('a5', 'A5  ·  Storage and restore', 'Dev database: storage, snapshots and restore');
  table(s, ML, 1.95, [2.0, 3.65], ['Setting', 'Value'], [
    ['Volume', '20 Gi gp3, encrypted (StorageClass)'],
    ['Placement', 'WaitForFirstConsumer: disk in the pod\'s AZ'],
    ['Snapshots', 'SnapScheduler, daily 01:00 UTC, keep 7'],
    ['Snapshot class', 'ebs-csi, deletionPolicy Delete'],
    ['Redis', 'AOF on a 1 Gi gp3 volume (brief: 10 Gi)'],
    ['Migrations', 'CREATE TABLE IF NOT EXISTS on start-up'],
  ], { fontSize: 12 });
  const rx2 = 6.85, rw2 = W - MR - rx2;
  label(s, 'Restore: a new disk, never the old one', rx2, 1.95, rw2, C.accInk);
  const rs = ['Take a snapshot of data-postgres-0; wait for READY', 'Scale the Postgres StatefulSet to 0', 'Delete the PVC data-postgres-0', 'Create it again with the snapshot as dataSource', 'Scale back to 1, then check known orders are back'];
  rs.forEach((t, i) => {
    const y = 2.3 + i * 0.5;
    badge(s, rx2, y, i + 1, { d: 0.3, size: 10 });
    T(s, t, { x: rx2 + 0.45, y: y + 0.03, w: rw2 - 0.45, h: 0.3, fontSize: 12, color: C.ink });
  });
  R(s, rx2, 4.95, rw2, 1.55, C.warnWash, null);
  T(s, [{ text: 'Status. ', options: { bold: true, color: C.warn } }, { text: 'The snapshot class and schedule run on dev. A restore checked against known data is not in our records. Schema changes: the plan is golang-migrate as an ArgoCD PreSync Job, with changes that expand first and contract later. Not built yet.', options: { color: C.ink } }],
    { x: rx2 + 0.25, y: 5.05, w: rw2 - 0.5, h: 1.4, fontSize: 11.5, lineSpacingMultiple: 1.12, valign: 'middle' });

  // A6 environments
  s = appx('a6', 'A6  ·  Environments', 'Three environments in code, one that has run');
  table(s, ML, 1.95, [2.4, 3.15, 3.15, 3.13], ['', 'dev', 'staging', 'prod'], [
    ['Status', { text: 'The one that has run; torn down between sessions to save cost', options: { color: C.ok, bold: true } }, { text: 'Defined in code, never deployed', options: { color: C.warn, bold: true } }, { text: 'Defined in code, never deployed', options: { color: C.warn, bold: true } }],
    ['VPC', '10.6.0.0/16', '10.7.0.0/16', '10.8.0.0/16'],
    ['Database', 'Postgres StatefulSet', 'RDS db.t4g.medium, single AZ', 'RDS db.m7g.large, Multi-AZ'],
    ['Nodes (base)', '3 x t3.medium, max 4', '3 x t3.medium, max 5', '3 x t3.medium, max 6'],
    ['ArgoCD sync', 'Automatic', 'Automatic', 'Manual'],
    ['Terraform apply', 'Saved plan, manual run', 'Plan made on main only', 'Plan on main, plus a second approver'],
    ['Separation', { text: 'Each has its own VPC, cluster, Terraform state, GitHub Environment and IAM role, in one AWS account', options: { colspan: 3 } }],
  ], { fontSize: 12.5 });
  T(s, 'One account, not three: cross-account access for the shared ECR, Route 53 zone and state did not fit the time we had.', { x: ML, y: 6.25, w: CW, h: 0.4, fontSize: 12, color: C.ink3 });

  // A7 security gaps
  s = appx('a7', 'A7  ·  Security', 'Known gaps we would name before you do');
  table(s, ML, 1.95, [3.4, 5.0, 3.43], ['Gap', 'Why it matters', 'First fix'], [
    ['Open login', 'Any email and password gets a token; every user sees every order.', 'Accounts, ownership checks'],
    ['One shared database user', 'A bug in one service can read or change another\'s tables.', 'A role per service'],
    ['Redis', 'No password, no NetworkPolicy, no TLS.', 'AUTH and a NetworkPolicy'],
    ['Carrier webhook', 'Public and rate limited, but unsigned.', 'HMAC signature'],
    ['Browser headers', 'No CSP or HSTS yet.', 'Set them at Traefik'],
    ['Money as float', 'Totals are rounded to pence, but summed as floats in Go.', 'Integer pence'],
    ['Dev certificate', 'Let\'s Encrypt staging: browsers warn.', 'Production issuer'],
  ], { fontSize: 12.5 });

  // A8 cost
  s = appx('a8', 'A8  ·  Cost', 'Where the money goes, and what we did about it');
  const lv = [
    ['Tear down when idle', 'Environments are rebuilt from Git, so dev did not run around the clock.'],
    ['One NAT gateway', 'Not one per AZ, and no paid interface endpoints (slide 16).'],
    ['Capped autoscaling', 'Karpenter on-demand only, 16 vCPU and 64 GiB at most, consolidation after 5 min.'],
    ['In-cluster data in dev', 'Postgres and Redis share nodes we already pay for; only volumes cost extra.'],
    ['Small fixed footprint', 'One shared ECR repository keeping the newest 40 images; control-plane logs kept 30 days.'],
  ];
  lv.forEach(([a, b], i) => {
    const y = 1.95 + i * 0.86;
    T(s, a, { x: ML, y, w: 6.6, h: 0.3, bold: true, fontSize: 13.5, color: C.ink });
    T(s, b, { x: ML, y: y + 0.32, w: 6.6, h: 0.45, fontSize: 12, color: C.ink2 });
  });
  const cx = 7.75, cw2 = W - MR - cx;
  R(s, cx, 1.95, cw2, 4.6, C.plum, null);
  T(s, 'SPEND ON RECORD', { x: cx + 0.3, y: 2.12, w: cw2 - 0.6, h: 0.25, mono: true, bold: true, fontSize: 10.5, color: C.lav, charSpacing: 1.2 });
  T(s, 'about $50', { x: cx + 0.3, y: 2.5, w: cw2 - 0.6, h: 0.75, head: true, bold: true, fontSize: 40, color: C.onPlum });
  T(s, 'of AWS spend recorded by 10 Oct, mostly EC2, against the $200 cap.',
    { x: cx + 0.3, y: 3.35, w: cw2 - 0.6, h: 1.1, fontSize: 12, color: C.onPlum2, lineSpacingMultiple: 1.12 });
  T(s, 'Billed by the hour whenever dev is up: the EKS control plane, three base nodes, the NAT gateway and the NLB. That is why tear-down is the biggest lever.',
    { x: cx + 0.3, y: 4.6, w: cw2 - 0.6, h: 1.4, fontSize: 12, color: C.onPlum, lineSpacingMultiple: 1.12 });
}

// pptxgenjs writes Office's default palette into the theme. Replace it with the Kit Room palette,
// so colours picked from the theme in PowerPoint match the deck.
async function applyTheme(file, theme) {
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('pptxgenjs')] }));
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const part = 'ppt/theme/theme1.xml';
  const slots = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const scheme = `<a:clrScheme name="${theme.name}">` + slots.map((k) => `<a:${k}><a:srgbClr val="${theme.colors[k]}"/></a:${k}>`).join('') + '</a:clrScheme>';
  const xml = (await zip.file(part).async('string'))
    .replace(/<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/, () => scheme)
    .replace(/(<a:(?:theme|fontScheme)\b[^>]*?\bname=")[^"]*"/g, (_, head) => `${head}${theme.name}"`);
  zip.file(part, xml);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ---------- notes ----------
const NOTES = {
  title: `[0:30] TAKEAWAY: We will follow one real order from the click down to the infrastructure.
SAY: We are Team Alpha. In four weeks we took a nine-service order platform that CoderCo gave us as source code and ran it on Amazon EKS, on a $200 budget. Instead of touring every resource, we will follow one order, order number 3, from the browser all the way down, and stop at the decisions that mattered.
NEXT: First, what the product is.`,
  context: `[1:00] TAKEAWAY: Kit Room is an ordering tool for equipping new starters. The journey is build, place, fulfil, track.
SAY: The code we were given was a generic order platform. We kept its workflow and gave it one clear use: an operations team ordering monitors, keyboards and hubs for people starting next week. Two audiences use one page: whoever places the order, and the operators who run stock, payments, shipping and messages from the OPS pages.
IF ASKED: It is the same API flow the brief grades: create order, reserve inventory, take payment, ship, deliver. The page signs itself in as one admin user. That is a known limit, slide 19.
NEXT: Here is what we were actually handed.`,
  starting: `[0:45] TAKEAWAY: The provided code could not move an order past pending. The heart of the order flow, and everything around it, is ours.
SAY: Two stubs sat at the centre. Publishing an order event was a log line, and the worker that processes orders had no queue code. Out of the box every order stayed pending for ever, and there were no tests. So our job was not only Docker, Terraform and Kubernetes. We had to build the part that makes an order real, and prove it holds up under retries.
EVIDENCE: codercohq/eks-v2 at e19e419 (our import af985c9 is identical): order-service main.go "Students implement actual SQS SendMessage here"; worker main.go receiveSQSMessages returns nil. Ours: outbox.go, publisher.go, the worker, idempotency.go in order and payment, allowlist.go, pricing.go, retention.go, 20 test files with 168 Test functions.
CAREFUL: Do not claim graceful shutdown, /livez or waitForDB. Upstream added those in May.
NEXT: So what did done mean for us?`,
  goals: `[1:15] TAKEAWAY: Cost came first, so every choice had to earn its spend. The five aims are aims; slide 18 says which are proven.
SAY: Our stakeholder set the order on 14 September: cost, then security, then uptime, then features. CoderCo reimburses up to $200 of AWS per team and asked us to justify every cost. The brief also fixed many tools, so our real choices were how to use them. From that we set five aims. Read them as aims, not guarantees: at the end we will show which ones we have evidence for.
IF ASKED (currency): Saad said $200 at the 13 Sep orientation; some team notes say pounds. The deck uses dollars throughout.
IF ASKED (priority): One stakeholder nudge on 6 Oct put security first. The written order from 14 Sep is cost first.
NEXT: Let us see the product do its job.`,
  democue: `[3:00 including the live demo] TAKEAWAY: One coherent journey. What matters is what happens between the clicks.
DO (live, in the browser, full screen):
1. Kit page. Add 27 inch Monitor, Mechanical Keyboard, USB-C Hub. Press + once on the monitor. Point at the plan drawing and the line "Prices and stock come live from inventory".
2. Type a note: "New starter, Platform team". Press Place order. Point at "Placed" and "Queued for the fulfilment worker".
3. Wait about 5 seconds. Point at Confirmed, and at Units available dropping.
4. Track order. Start processing, then Mark shipped. Point at the shipment, tracking number and the two emails.
IF THE CARD IS DECLINED (the simulated provider declines about 1 in 10): say "That is the failure path, live: stock released, order cancelled, customer told." Then place the kit again.
IF DEV IS DOWN OR SLOW: stay in the deck and use slides 6 and 7. Say so plainly: "Dev is torn down when idle to save cost; these frames come from the same build."
NEXT: Here is what you just saw, frozen, so we can point at it.`,
  democonfirm: `[0:45, or skip if the live demo worked] TAKEAWAY: Accepting an order and processing it are separate on purpose.
SAY: On the left is the moment of the click: the API has replied 201 and the order is saved, but nothing is processed yet. On the right, seconds later, nobody clicked anything: the worker took the event from the queue, reserved the stock, charged the card and confirmed. Stock leaves the shelf only after the charge succeeds.
NEXT: The rest of the journey.`,
  demofulfil: `[0:30, or skip] TAKEAWAY: Every later step is visible and happens once.
SAY: Moving to processing creates the shipment. Shipped puts it in transit and emails the tracking number. Each email has a dedupe key, so if an event is replayed, no second email goes out. And there is no address model yet; the page says so rather than inventing one.
NEXT: The operators' side.`,
  ops: `[0:20] TAKEAWAY: Nine services sit behind this one page.
SAY: Operators see the same platform: today's orders and where they are, and the health of every service the browser can reach. The worker and scheduler do not show a latency because nothing from outside can reach them. That is deliberate. Let us lift the lid.
NEXT: Architecture.`,
  arch: `[2:00] TAKEAWAY: One public entry point, synchronous services for reads and writes, and one queue for the work that must not be lost.
SAY, left to right: Traffic enters through Route 53 and a Network Load Balancer to Traefik, which ends TLS with a certificate from cert-manager. The API gateway is the only public service. It checks the token, applies rate limits held in Redis and only forwards routes meant for the outside. Behind it, six HTTP services share one Postgres database. The interesting path is the queue: order-service hands events to SQS through an outbox, and the worker turns each event into reserve, charge, confirm, ship and email calls. Failed messages go to a dead-letter queue. A scheduler expires stock holds and cancels abandoned orders. Underneath, ArgoCD deploys everything from Git, Karpenter adds nodes, External Secrets brings in secrets, and every AWS caller gets its own role.
IF ASKED: Each environment has its own VPC across three AZs; nodes and pods are in private subnets; one NAT gateway (slide 16). Postgres runs as a StatefulSet in dev; staging and prod are written for RDS but have not been deployed.
NEXT: Now follow order 3 through it.`,
  accept: `[1:15] TAKEAWAY: Accepting an order is all or nothing, and it answers before any slow work.
SAY: The browser sends the order with an idempotency key. If the request gets no clear answer, a retry sends the same key. The gateway checks the token, the rate limit and the route. order-service first asks: have I seen this key? If yes, it replays the first answer. If not, it prices every line from inventory; a price from the browser is ignored. Then one database transaction claims the key, writes the order, its history and its outbox event. All four rows exist, or none do. Only then do we reply: 201, order 3, pending. Separately, a relay sends outbox rows to SQS every second. If SQS is unreachable, the row waits; the order is already safe.
DEPTH: The claim on (customer, key) is the guard. Two identical requests at once: the second INSERT waits on the first transaction, then replays its order. The price we pay: if the process dies after SQS accepts but before sent_at is saved, the event goes twice, so consumers must be idempotent.
NEXT: What the worker does with it.`,
  process: `[1:15] TAKEAWAY: The worker is written so that running it twice is harmless.
SAY: SQS delivers at least once, so the same message can arrive twice. The worker's first move is to read the order's status: if it is already confirmed it only makes sure stock is committed, if it is cancelled it undoes anything taken. Then reserve, charge with a fixed key per order, confirm with compare-and-set, and commit stock last. Three endings: success deletes the message; a final no, out of stock or declined, cancels and also deletes, because retrying would not change the answer; an error leaves the message, SQS hands it out again after 60 seconds, and the third failure goes to the dead-letter queue.
IF ASKED (why not FIFO): We do not need ordering; the worker reads current state instead of trusting message order.
IF ASKED (visibility): A batch of 10 slow messages could outrun 60 seconds. Known limit; every step is safe to repeat, so the cost is extra work, not double charges.
NEXT: How do we know this works?`,
  evidence: `[1:15] TAKEAWAY: Retries are safe because every layer absorbs a repeat, and we measured the failures before fixing them.
SAY: A repeat can enter at four layers, and each has its own guard: the request key, the worker's status check and compare-and-set, the payment key with a unique index, and the email dedupe key. We did not assume the bugs existed. We reproduced them: 25 of 30 runs where a concurrent confirm and cancel both won, stock driven to minus 57 by concurrent releases, six payment rows for one retried charge. Each is now a test, and all 168 test functions pass with the race detector on.
EVIDENCE: Claude outputs/fix-evidence-log.md (23 to 24 Sep, Postgres 16 test database). Re-run on 13 Oct: every service's go test -race passes against Postgres 16, Redis and floci.
NEXT: Five decisions behind this.`,
  d1: `[0:55] TAKEAWAY: We chose a boring queue and made it safe with an outbox, so an SQS outage makes orders late, not lost.
SAY: Two systems, one write: that is the problem. The outbox puts the event in the same commit as the order, and a relay delivers it. We gained a managed queue with retries and a dead-letter queue built in, at almost no cost. We gave up exactly-once delivery, which is why the last two slides mattered.
IF ASKED: Kafka would have meant three brokers on persistent volumes in a cluster already holding Postgres and Redis, and rewriting the producers. Payment and shipment events are still only logged; moving them onto an outbox is on our list.
NEXT: Where the data lives.`,
  d2: `[0:55] TAKEAWAY: The data model wants one relational database; where it runs is a cost and risk trade-off we made per environment.
SAY: An order, its stock hold, its payment and its outbox row must commit together, which is why it is one Postgres. Dev runs it as a StatefulSet on an encrypted 20 gig volume with daily snapshots: that meets the brief and costs only the disk. For staging and prod we wrote RDS: managed failover and point-in-time restore. Be clear: staging and prod were never deployed, so RDS has never run live.
IF ASKED (the brief says RDS is not an option): The brief's author said on 6 Oct that RDS is sensible but does not show the StatefulSet skill. That is why dev runs the StatefulSet. The RDS module enforces prod settings: Terraform refuses prod without Multi-AZ, deletion protection, a final snapshot and 7+ days of backups.
IF ASKED (restore): The snapshot class and schedule run on dev. A restore checked against known data is not in our records; it is next step 3.
NEXT: How changes reach the cluster.`,
  d3: `[0:55] TAKEAWAY: CI never touches the cluster. Git is the record of what runs, so one service rolls back with one revert.
SAY: The pipeline builds only what changed, tests it with the race detector, scans it with Trivy, pushes one image and commits its tag. ArgoCD sees the commit and syncs that one service. We gained a pipeline with no cluster keys and a rollback that is a git revert. We gave up a little speed, and we need a bot allowed to write to main.
CAREFUL: Do not claim zero downtime. A 30 to 60 second blip during an ArgoCD sync on 10 Oct still has no root cause. The Argo Rollouts canary (50%, then error-rate and p95 checks) landed last and has not been tried against a bad release.
NEXT: The cost decision.`,
  d4: `[0:55] TAKEAWAY: One NAT gateway is a deliberate single point of failure, accepted because cost is priority one, and softened by the outbox.
SAY: Private nodes need the internet for GitHub, Let's Encrypt and public images; endpoints cannot reach those at all. Doing AWS traffic through interface endpoints would mean at least six services across three AZs, eighteen billed endpoints running every hour. So we pay for one NAT and route S3 through a free gateway endpoint. If that AZ fails, all outbound traffic stops, including SQS calls, and that is where the outbox earns its place again: orders keep being accepted and wait.
IF ASKED: One teammate described two NATs in an earlier review; the code has one. The Terraform is the source of truth.
NEXT: Credentials.`,
  d5: `[0:55] TAKEAWAY: Nothing we ship holds an AWS key. Every caller borrows a short-lived role scoped to one job.
SAY: GitHub Actions signs in with OIDC to a role per environment. The trust is pinned to our organisation and repository IDs and to the GitHub Environment, so another repo or branch cannot assume it. Pull requests get a read-only plan role, and a prod apply waits for someone other than the person who started it. Inside the cluster, Pod Identity gives each workload its own role: order-service may only send to the queue, the worker may only receive and delete. IMDSv2 with a hop limit of one stops pods borrowing the node's role.
IF ASKED (brief asked for IRSA): Same intent, least privilege per workload. Pod Identity avoids an OIDC provider per cluster, so the role definitions work on every environment.
NEXT: What we can stand behind.`,
  status: `[1:00] TAKEAWAY: We separate what ran on EKS, what tests prove, and what exists only as code.
SAY: Left column: things we watched happen on EKS dev, with a smoke test from 8 October. Middle: things proven by tests and local drills, not by real load. Right: things that exist in code and have not run: staging, prod, RDS, load tests, a restore checked against data, and the canary against a bad release. And we do not claim zero downtime.
WHY: The panel can check all of this. Saying it first is stronger than being caught.
NEXT: The limits that matter.`,
  limits: `[0:45] TAKEAWAY: We know the limits, and the next steps are ordered by risk.
SAY: Four limits matter most. Anyone can sign in and see every order. Database connections are the first thing that will break: seven pools allow 115 against a default limit of 100. Payment and shipment events skip the outbox. And dev Postgres lives in one AZ. Next, in order: measure before tuning with the k6 plan we wrote, add real identity, then rehearse the bad day on staging.
NEXT: Close.`,
  close: `[0:30] TAKEAWAY: The happy path was never the hard part; we spent our time and budget on the orders that go wrong.
SAY: If SQS goes quiet, orders still land. If a request repeats, nothing doubles. If our repository leaked tomorrow, it would hold no AWS key. That is what five engineers built in four weeks on a $200 budget. Happy to take questions; the appendix has the detail.
THEN: Leave this slide up during Q&A, or jump to the appendix slide that matches the question.`,
  a1: `Use for: "A developer pushes a change to payment-service. Walk us through it." Point at steps 1 to 6, then promote and roll back. Caveat: the canary landed last and passes by default with no traffic.`,
  a2: `Use for: "How do secrets reach a pod? What happens when you rotate?" Key line: only the services that use a changed secret restart, one pod at a time. The gap is new connections from old pods, up to 15 minutes, for the DB password.`,
  a3: `Use for: "What scales, on what, and what breaks first?" Say plainly that the breaking order is reasoned from configuration; the k6 tests were not run.`,
  a4: `Use for any "what happens if" question. Read the "How we know" column honestly: drills and smoke tests versus design only.`,
  a5: `Use for storage, snapshot and migration questions. Note the snapshot class uses deletionPolicy Delete (an older doc said Retain), and that Redis runs on a 1 Gi volume, smaller than the brief's 10 Gi, to save cost.`,
  a6: `Use for "Is prod running?" Answer: no. Staging and prod are fully defined and planned, never deployed; dev is the environment that has run, and it is torn down when idle to save money.`,
  a7: `Use for security questions. Own each gap and give its first fix.`,
  a8: `Use for cost questions. Replace "about $50 by 10 Oct" with the final bill before presenting; the figure comes from the 10 Oct meeting record.`,
};

// ---------- build ----------
(async () => {
  const grid = await makeBackgrounds();
  defineLayouts(grid);
  pres.addSection({ title: 'Act I · Set the scene' });
  sTitle(); sContext(); sStartingLine(); sGoals();
  pres.addSection({ title: 'Act II · Show the product' });
  sDemoCue(); sDemoConfirm(); sDemoFulfil(); sOpsView();
  pres.addSection({ title: 'Act III · The engineering' });
  sArchitecture(); sAccept(); sProcess(); sEvidence(); sDecisions();
  pres.addSection({ title: 'Act IV · Engineering judgment' });
  sStatus(); sLimits(); sClose();
  pres.addSection({ title: 'Appendix · Questions and evidence' });
  sAppendix();
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  // presenter-notes.md is generated from the same NOTES, so the two never drift.
  const md = ['# Presenter notes', '', 'Generated from the speaker notes in the deck (src/build-deck.js). Times are for the main route; see run-of-show.md and short-path.md.', '',
    'Labels: TAKEAWAY is the one thing the audience should leave with. SAY is a suggested script, not a reading text. IF ASKED and DEPTH hold detail for questions. CAREFUL marks claims to avoid. NEXT is the transition.', ''];
  NOTE_LOG.forEach((n, i) => {
    md.push(`## Sheet ${i + 1} · ${n.title}`, '', `*${n.eyebrow}*`, '');
    NOTES[n.key].trim().split('\n').forEach((line) => {
      const m = line.match(/^(\[[^\]]+\]\s*)?([A-Z][A-Z ]*(?: \([^)]*\))?):\s?(.*)$/);
      if (m) md.push(`${m[1] ? '`' + m[1].trim() + '` ' : ''}**${m[2]}:** ${m[3]}`, '');
      else md.push(line, '');
    });
  });
  fs.writeFileSync(path.join(ROOT, 'presenter-notes.md'), md.join('\n').replace(/\n{3,}/g, '\n\n'));
  console.log('wrote', OUT);
})();
