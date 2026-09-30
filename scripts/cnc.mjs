// Renders the GitHub contribution calendar as an animated CNC machining job.
// The spindle follows a serpentine toolpath, plunges into every contribution
// cell and "machines" it into existence. Output: dist/cnc-dark.svg, dist/cnc-light.svg
//
// Usage: GITHUB_TOKEN=... LOGIN=m0Corut node scripts/cnc.mjs [--data calendar.json]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const LOGIN = process.env.LOGIN || "m0Corut";
const OUT_DIR = process.env.OUT_DIR || "dist";

// ---------- data ----------

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function fetchCalendar(login) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    totalContributions weeks{contributionDays{date weekday contributionCount contributionLevel}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "cnc-contrib" },
    body: JSON.stringify({ query, variables: { login } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors || json)}`);
  return json.data.user.contributionsCollection.contributionCalendar;
}

// ---------- geometry ----------

const PITCH = 15;
const CELL = 11;
const GX = 58; // grid origin
const GY = 96;

const cellCenter = (w, d) => [GX + w * PITCH + CELL / 2, GY + d * PITCH + CELL / 2];

// Serpentine (boustrophedon) facing pass over the whole sheet: down one week column,
// up the next, like a real CNC job. Contribution days are drilled, the rest only faced.
function toolpath(weeks) {
  const cells = [];
  weeks.forEach((week, w) => {
    const days = [...week.contributionDays];
    if (w % 2 === 1) days.reverse();
    for (const day of days) {
      cells.push({ w, d: day.weekday, level: day.contributionCount > 0 ? LEVELS[day.contributionLevel] || 1 : 0 });
    }
  });
  return cells;
}

// ---------- timeline ----------

function schedule(cells, home) {
  const SPEED = 240; // px/s
  const DWELL = 0.32;
  const SPIN_UP = 0.9;
  const HOLD = 3.5;
  const FADE = 1;

  const moves = [];
  let prev = home;
  let raw = 0;
  for (const c of cells) {
    const p = cellCenter(c.w, c.d);
    const move = Math.hypot(p[0] - prev[0], p[1] - prev[1]) / SPEED;
    moves.push({ c, p, move, dwell: c.level > 0 ? DWELL : 0 });
    raw += move + (c.level > 0 ? DWELL : 0);
    prev = p;
  }
  const back = Math.hypot(home[0] - prev[0], home[1] - prev[1]) / SPEED;
  raw += back;

  // Keep the job watchable regardless of how busy the year was.
  const scale = Math.min(Math.max(raw, 16), 34) / raw;

  let t = SPIN_UP;
  for (const m of moves) {
    t += m.move * scale;
    m.arrive = t;
    t += m.dwell * scale;
    m.leave = t;
  }
  t += back * scale;
  const done = t;
  const total = done + HOLD + FADE;
  return { moves, done, total, fadeAt: done + HOLD };
}

// ---------- svg helpers ----------

const f = (n) => (Math.round(n * 100) / 100).toString();
const kt = (t, total) => (Math.round((t / total) * 100000) / 100000).toString();

function anim(attr, frames, total, extra = "") {
  const keyTimes = frames.map(([t]) => kt(t, total)).join(";");
  const values = frames.map(([, v]) => v).join(";");
  return `<animate attributeName="${attr}" dur="${f(total)}s" repeatCount="indefinite" keyTimes="${keyTimes}" values="${values}" ${extra}/>`;
}

function translate(frames, total) {
  const keyTimes = frames.map(([t]) => kt(t, total)).join(";");
  const values = frames.map(([, x, y]) => `${f(x)} ${f(y)}`).join(";");
  return `<animateTransform attributeName="transform" type="translate" dur="${f(total)}s" repeatCount="indefinite" keyTimes="${keyTimes}" values="${values}"/>`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------- themes ----------

const THEMES = {
  dark: {
    bg: "#0d1117", sheet: "#161b22", sheetEdge: "#30363d", empty: "#1f2630", text: "#7d8590", strong: "#e6edf3",
    dim: "#3d4652", levels: ["", "#0e4a5c", "#137c93", "#22b8cf", "#7ee8fa"], hole: "#0d1117", faced: "#1b222b",
    accent: "#22b8cf", spark: "#ffb454", gantry: "#21262d", gantryEdge: "#484f58", spindle: "#0d1117",
  },
  light: {
    bg: "#ffffff", sheet: "#f6f8fa", sheetEdge: "#d0d7de", empty: "#e4e8ec", text: "#656d76", strong: "#1f2328",
    dim: "#b8c0c8", levels: ["", "#b6e3f0", "#5cc3dc", "#1a94b3", "#0b5f75"], hole: "#ffffff", faced: "#eceff2",
    accent: "#1a94b3", spark: "#e8890c", gantry: "#eaeef2", gantryEdge: "#8c959f", spindle: "#ffffff",
  },
};

// ---------- render ----------

function render(calendar, theme) {
  const T = THEMES[theme];
  const weeks = calendar.weeks;
  const cols = weeks.length;
  const gridW = cols * PITCH - (PITCH - CELL);
  const gridH = 7 * PITCH - (PITCH - CELL);

  const sheet = { x: GX - 36, y: GY - 24, w: gridW + 36 + 18, h: gridH + 24 + 16 };
  const W = sheet.x + sheet.w + 44;
  const tb = { x: sheet.x, y: sheet.y + sheet.h + 16, w: sheet.w, h: 34 };
  const H = tb.y + tb.h + 14;
  const home = [GX - 24, sheet.y - 2];

  const cells = toolpath(weeks);
  const { moves, done, total, fadeAt } = schedule(cells, home);
  const drilled = moves.filter((m) => m.c.level > 0);
  const N = drilled.length;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">`);
  out.push(`<title>${esc(LOGIN)}: contributions machined on a CNC</title>`);
  out.push(`<rect width="${W}" height="${H}" rx="8" fill="${T.bg}"/>`);

  // header
  out.push(`<text x="${sheet.x}" y="26" font-size="12" fill="${T.strong}" font-weight="700">CNC · ${esc(LOGIN)}/contributions.nc</text>`);
  out.push(`<text x="${sheet.x + sheet.w}" y="26" font-size="10" fill="${T.text}" text-anchor="end">G17 G21 G90 · F1200 · S18000 · T1 Ø3mm</text>`);

  // top dimension line
  const dy = 46;
  const x0 = GX;
  const x1 = GX + gridW;
  out.push(`<g stroke="${T.dim}" stroke-width="1" fill="none">`);
  out.push(`<line x1="${x0}" y1="${dy}" x2="${x1}" y2="${dy}"/><line x1="${x0}" y1="${dy - 5}" x2="${x0}" y2="${sheet.y - 2}"/><line x1="${x1}" y1="${dy - 5}" x2="${x1}" y2="${sheet.y - 2}"/>`);
  out.push(`<path d="M${x0} ${dy}l6 -3v6z M${x1} ${dy}l-6 -3v6z" fill="${T.dim}" stroke="none"/>`);
  out.push(`</g>`);
  const dimLabel = `${calendar.totalContributions} CONTRIBUTIONS · ${cols} WEEKS`;
  const dimW = dimLabel.length * 6.2 + 14;
  out.push(`<rect x="${(x0 + x1) / 2 - dimW / 2}" y="${dy - 7}" width="${dimW}" height="14" fill="${T.bg}"/>`);
  out.push(`<text x="${(x0 + x1) / 2}" y="${dy + 3.5}" font-size="10" fill="${T.text}" text-anchor="middle">${dimLabel}</text>`);

  // right dimension line
  const dx = sheet.x + sheet.w + 22;
  const y0 = GY;
  const y1 = GY + gridH;
  out.push(`<g stroke="${T.dim}" stroke-width="1" fill="none"><line x1="${dx}" y1="${y0}" x2="${dx}" y2="${y1}"/><line x1="${sheet.x + sheet.w + 2}" y1="${y0}" x2="${dx + 5}" y2="${y0}"/><line x1="${sheet.x + sheet.w + 2}" y1="${y1}" x2="${dx + 5}" y2="${y1}"/><path d="M${dx} ${y0}l-3 6h6z M${dx} ${y1}l-3 -6h6z" fill="${T.dim}" stroke="none"/></g>`);
  out.push(`<rect x="${dx - 7}" y="${(y0 + y1) / 2 - 16}" width="14" height="32" fill="${T.bg}"/>`);
  out.push(`<text transform="translate(${dx + 3.5} ${(y0 + y1) / 2}) rotate(-90)" font-size="10" fill="${T.text}" text-anchor="middle">7 D</text>`);

  // sheet
  out.push(`<rect x="${sheet.x}" y="${sheet.y}" width="${sheet.w}" height="${sheet.h}" rx="3" fill="${T.sheet}" stroke="${T.sheetEdge}"/>`);

  // month + day labels
  let lastMonth = -1;
  weeks.forEach((week, w) => {
    const first = week.contributionDays[0];
    const m = new Date(first.date + "T00:00:00Z").getUTCMonth();
    if (m !== lastMonth && w < cols - 2) {
      if (lastMonth !== -1 || new Date(first.date + "T00:00:00Z").getUTCDate() <= 7) {
        const name = new Date(first.date + "T00:00:00Z").toLocaleString("en", { month: "short", timeZone: "UTC" });
        out.push(`<text x="${GX + w * PITCH}" y="${GY - 8}" font-size="9" fill="${T.text}">${name}</text>`);
      }
      lastMonth = m;
    }
  });
  [["Mon", 1], ["Wed", 3], ["Fri", 5]].forEach(([n, d]) => {
    out.push(`<text x="${GX - 8}" y="${GY + d * PITCH + CELL - 2}" font-size="9" fill="${T.text}" text-anchor="end">${n}</text>`);
  });

  // empty grid (raw sheet)
  out.push(`<g fill="none" stroke="${T.empty}" stroke-width="1">`);
  weeks.forEach((week, w) => {
    for (const day of week.contributionDays) {
      out.push(`<rect x="${GX + w * PITCH + 0.5}" y="${GY + day.weekday * PITCH + 0.5}" width="${CELL - 1}" height="${CELL - 1}" rx="2"/>`);
    }
  });
  out.push(`</g>`);

  // faced surface: every cell the tool passes over
  for (const m of moves) {
    const x = GX + m.c.w * PITCH;
    const y = GY + m.c.d * PITCH;
    out.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${T.faced}" opacity="0">${anim("opacity", [[0, 0], [m.arrive, 0], [m.arrive + 0.05, 1], [fadeAt, 1], [total, 0]], total)}</rect>`);
  }

  // drilled cells: contribution days
  for (const m of drilled) {
    const { c } = m;
    const x = GX + c.w * PITCH;
    const y = GY + c.d * PITCH;
    const reveal = m.arrive + (m.leave - m.arrive) * 0.55;
    const r = 1.4 + c.level * 0.35;
    out.push(`<g opacity="0">`);
    out.push(anim("opacity", [[0, 0], [reveal, 0], [reveal + 0.08, 1], [fadeAt, 1], [total, 0]], total));
    out.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${T.levels[c.level]}"/>`);
    out.push(`<circle cx="${f(x + CELL / 2)}" cy="${f(y + CELL / 2)}" r="${f(r)}" fill="${T.hole}" opacity="0.85"/>`);
    out.push(`</g>`);
  }

  // title block
  out.push(`<g font-size="9" fill="${T.text}">`);
  out.push(`<rect x="${tb.x}" y="${tb.y}" width="${tb.w}" height="${tb.h}" rx="3" fill="none" stroke="${T.sheetEdge}"/>`);
  const barX = tb.x + 70;
  const barW = 180;
  out.push(`<text x="${tb.x + 10}" y="${tb.y + 21}" fill="${T.strong}" font-weight="700">PROGRESS</text>`);
  out.push(`<rect x="${barX}" y="${tb.y + 13}" width="${barW}" height="8" rx="2" fill="none" stroke="${T.sheetEdge}"/>`);
  if (moves.length > 0) {
    // one keyframe per week column keeps the file small
    const frames = [[0, 0], [moves[0].arrive, 0]];
    moves.forEach((m, i) => {
      if ((i + 1) % 7 === 0 || i === moves.length - 1) frames.push([m.leave, f(((i + 1) / moves.length) * barW)]);
    });
    frames.push([fadeAt, barW], [total, 0]);
    out.push(`<rect x="${barX}" y="${tb.y + 13}" width="0" height="8" rx="2" fill="${T.accent}">${anim("width", frames, total)}</rect>`);
  }
  out.push(`<text x="${barX + barW + 12}" y="${tb.y + 21}">HOLES ${N}</text>`);
  const fields = [
    ["PART", "contributions"],
    ["QTY", String(calendar.totalContributions)],
    ["MAT", "commits"],
    ["SCALE", "1:1"],
    ["DWG", `${LOGIN}-${new Date().getUTCFullYear()}`],
  ];
  let fx = tb.x + tb.w;
  for (const [k, v] of fields.reverse()) {
    const w = Math.max(k.length, v.length) * 6 + 18;
    fx -= w;
    out.push(`<line x1="${fx}" y1="${tb.y}" x2="${fx}" y2="${tb.y + tb.h}" stroke="${T.sheetEdge}"/>`);
    out.push(`<text x="${fx + 8}" y="${tb.y + 13}" font-size="7">${k}</text>`);
    out.push(`<text x="${fx + 8}" y="${tb.y + 26}" fill="${T.strong}">${esc(v)}</text>`);
  }
  out.push(`</g>`);

  // gantry (moves on X) and carriage + spindle (moves on X/Y)
  const headFrames = [[0, ...home], [0.9, ...home]];
  for (const m of moves) {
    headFrames.push([m.arrive, ...m.p]);
    if (m.leave > m.arrive) headFrames.push([m.leave, ...m.p]);
  }
  headFrames.push([done, ...home], [total, ...home]);

  const gTop = sheet.y - 44;
  const gBot = sheet.y + sheet.h + 6;
  out.push(`<g>${translate(headFrames.map(([t, x]) => [t, x, 0]), total)}`);
  out.push(`<rect x="-7" y="${gTop}" width="14" height="${gBot - gTop}" rx="2" fill="${T.gantry}" stroke="${T.gantryEdge}" opacity="0.6"/>`);
  out.push(`<line x1="-3" y1="${gTop + 4}" x2="-3" y2="${gBot - 4}" stroke="${T.gantryEdge}" opacity="0.6"/><line x1="3" y1="${gTop + 4}" x2="3" y2="${gBot - 4}" stroke="${T.gantryEdge}" opacity="0.6"/>`);
  out.push(`</g>`);

  const drill = [[0, 0], [0.9, 0]];
  const ring = [[0, 10], [0.9, 10]];
  for (const m of drilled) {
    const d = m.leave - m.arrive;
    drill.push([m.arrive, 0], [m.arrive + d * 0.15, 1], [m.leave - d * 0.15, 1], [m.leave, 0]);
    ring.push([m.arrive, 10], [m.arrive + d * 0.45, 6], [m.leave, 10]);
  }
  drill.push([total, 0]);
  ring.push([total, 10]);

  out.push(`<g>${translate(headFrames, total)}`);
  out.push(`<rect x="-13" y="-15" width="26" height="30" rx="4" fill="${T.gantry}" stroke="${T.gantryEdge}" opacity="0.9"/>`);
  // sparks
  out.push(`<g opacity="0">${anim("opacity", drill, total)}<g>`);
  out.push(`<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="0.35s" repeatCount="indefinite"/>`);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r0 = 10 + (i % 2) * 2;
    const r1 = r0 + 4 + (i % 3);
    out.push(`<line x1="${f(Math.cos(a) * r0)}" y1="${f(Math.sin(a) * r0)}" x2="${f(Math.cos(a) * r1)}" y2="${f(Math.sin(a) * r1)}" stroke="${T.spark}" stroke-width="1.4" stroke-linecap="round"/>`);
  }
  out.push(`</g></g>`);
  // spindle
  out.push(`<circle r="10" fill="none" stroke="${T.spark}" stroke-width="1.2">${anim("r", ring, total)}${anim("opacity", drill.map(([t, v]) => [t, v === 1 ? 1 : 0.25]), total)}</circle>`);
  out.push(`<circle r="7" fill="${T.spindle}" stroke="${T.accent}" stroke-width="1.5"/>`);
  out.push(`<g stroke="${T.accent}" stroke-width="1.2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="0.6s" repeatCount="indefinite"/><line x1="0" y1="0" x2="0" y2="-5"/><line x1="0" y1="0" x2="4.3" y2="2.5"/><line x1="0" y1="0" x2="-4.3" y2="2.5"/></g>`);
  out.push(`<circle r="1.2" fill="${T.accent}"/>`);
  out.push(`</g>`);

  out.push(`</svg>`);
  return out.join("\n");
}

// ---------- main ----------

const dataArg = process.argv.indexOf("--data");
const calendar = dataArg > -1 ? JSON.parse(readFileSync(process.argv[dataArg + 1], "utf8")) : await fetchCalendar(LOGIN);

mkdirSync(OUT_DIR, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  writeFileSync(`${OUT_DIR}/cnc-${theme}.svg`, render(calendar, theme));
}
console.log(`faced ${toolpath(calendar.weeks).length} cells, drilled ${toolpath(calendar.weeks).filter((c) => c.level > 0).length}, ${calendar.totalContributions} contributions`);
