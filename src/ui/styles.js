// All UI CSS. Lives inside the shadow roots only.
// Design rules: flat solid colors, no gradients, no shadows or glows, no patterns,
// short fades only, all motion off under prefers-reduced-motion.

export const BASE_CSS = `
:host {
  all: initial;
  --bg: #0f1114;
  --surface: #161a1f;
  --surface-2: #1d2128;
  --surface-3: #252a32;
  --border: #272c34;
  --border-strong: #363c46;
  --text: #e6e8eb;
  --muted: #8d949e;
  --faint: #5f6670;
  --accent: #7ea6f6;
  --accent-ink: #0b0e13;
  --pos: #45c486;
  --neg: #ef6b6b;
  --warn: #d8a650;
  --radius: 8px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.root {
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.45;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  text-align: left;
  letter-spacing: normal;
}
button, input, select { font: inherit; color: inherit; letter-spacing: inherit; }
button { cursor: pointer; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pos { color: var(--pos); }
.neg { color: var(--neg); }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.iconbtn {
  width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--muted);
  transition: background-color 120ms ease, color 120ms ease; flex: none; padding: 0;
}
.iconbtn:hover { background: var(--surface-2); color: var(--text); }
.iconbtn svg { width: 16px; height: 16px; display: block; }
@keyframes cst-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes cst-slide { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

export const DASHBOARD_CSS = `
.launcher {
  position: fixed; left: 16px; bottom: 16px;
  display: inline-flex; align-items: center; gap: 8px;
  height: 36px; padding: 0 12px 0 10px;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  font-size: 12px; font-weight: 600; line-height: 1;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.launcher:hover { background: var(--surface-2); }
.launcher .mark { width: 8px; height: 8px; border-radius: 2px; background: var(--accent); flex: none; }
.launcher .label { font-weight: 550; }

.panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 520px; max-width: 100vw; height: 100vh; height: 100dvh;
  background: var(--bg); border-left: 1px solid var(--border);
  display: flex; flex-direction: column;
}
.panel:not([hidden]) { animation: cst-slide 140ms ease-out; }
@media (max-width: 640px) { .panel { width: 100vw; border-left: 0; } }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px 12px; }
.title { font-size: 15px; font-weight: 650; margin: 0; }
.sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.acct { margin-top: 8px; }
.acct[hidden] { display: none; }
.acct select { height: 28px; font-size: 12px; padding-left: 8px; max-width: 100%; }

.tabs {
  display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--border);
  overflow-x: auto; scrollbar-width: none; flex: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  padding: 10px 9px 9px; border: 0; background: transparent; color: var(--muted);
  font-weight: 550; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap;
  transition: color 120ms ease, border-color 120ms ease;
}
.tab:hover { color: var(--text); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.tab:focus-visible { outline-offset: -2px; }

.body {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 20px 20px 32px;
  scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent;
}
.body:focus-visible { outline-offset: -2px; }
.body > .view.enter { animation: cst-fade 120ms ease-out; }
@media (max-width: 640px) {
  .head { padding: 16px 16px 10px; }
  .tabs { padding: 0 6px; }
  .body { padding: 16px 16px 28px; }
}

section + section { margin-top: 28px; }
h3 {
  font-size: 11px; font-weight: 650; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.07em; margin: 0 0 10px;
}
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.section-head h3 { margin: 0; }
p { margin: 0; }
.hint { color: var(--muted); font-size: 12px; margin-top: 8px; }

.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.hero .big { font-size: 30px; font-weight: 650; line-height: 1.1; letter-spacing: -0.01em; }
.hero .cap { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.hero .roi { font-size: 15px; font-weight: 600; text-align: right; }
.hero > div:last-child:not(:first-child) { margin-left: auto; text-align: right; }

.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--border);
  border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-top: 16px; }
.kpi { background: var(--surface); padding: 10px 12px; min-width: 0; }
.kpi .k { color: var(--muted); font-size: 11px; }
.kpi .v { font-size: 14px; font-weight: 600; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpi .s, .split .box .s { color: var(--faint); font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 11.5px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend .sw { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.legend .sw.dash { width: 14px; height: 0; border-radius: 0; border-top: 1.5px dashed #6b7480; }
.legend .sw.hollow { border: 1.5px solid var(--muted); background: transparent; }
@media (max-width: 640px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

.split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.split .box { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
.split .box .k { color: var(--muted); font-size: 11px; }
.split .box .v { font-weight: 600; margin-top: 2px; }
@media (max-width: 400px) { .split { grid-template-columns: 1fr; } }

.chart { position: relative; }
.chart svg { display: block; overflow: visible; }
.chart .readout { min-height: 18px; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.chart text { font-family: var(--font); font-size: 10.5px; fill: var(--faint); font-variant-numeric: tabular-nums; }
.chart text.lbl { fill: var(--muted); font-size: 11.5px; }

.callout {
  background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: 6px; padding: 12px 14px;
}
.callout.good { border-left-color: var(--pos); }
.callout.bad { border-left-color: var(--neg); }
.callout.warn { border-left-color: var(--warn); }
.callout.neutral { border-left-color: var(--faint); }
.callout .headline { font-weight: 650; font-size: 14px; }
.callout .detail { color: var(--muted); font-size: 12px; margin-top: 4px; }

.tablewrap {
  overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius);
  scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent;
}
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 8px 10px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--border); vertical-align: top; }
th:first-child, td:first-child { text-align: left; }
tbody tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-weight: 600; font-size: 11px; background: var(--surface); position: sticky; top: 0; }
td { background: var(--bg); }
tbody tr:hover td { background: var(--surface); }
td .ci { display: block; color: var(--faint); font-size: 11px; margin-top: 1px; }
td .second { display: block; color: var(--muted); font-size: 11px; margin-top: 1px; }
td.name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.sticky-first th:first-child, .sticky-first td:first-child { position: sticky; left: 0; z-index: 1; border-right: 1px solid var(--border); }
.sticky-first th:first-child { z-index: 2; }
.sortbtn {
  border: 0; background: transparent; padding: 0; color: inherit; font-weight: inherit; font-size: inherit;
  display: inline-flex; align-items: center; gap: 4px;
}
.sortbtn:hover { color: var(--text); }
.sortbtn .arrow { width: 8px; color: var(--accent); }

.badge {
  display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600;
  background: var(--surface-2); color: var(--muted); border: 1px solid var(--border);
}
.badge.bad { color: var(--neg); border-color: #4a2a2c; background: #1f1517; }
.badge.good { color: var(--pos); border-color: #234635; background: #121d17; }

.list { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; border-bottom: 1px solid var(--border); background: var(--bg); }
.row:last-child { border-bottom: 0; }
.row .l { min-width: 0; }
.row .l .t { font-weight: 550; }
.row .l .d { color: var(--muted); font-size: 11.5px; }
.row .r { text-align: right; flex: none; }

.edges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.edges label { color: var(--muted); font-size: 12px; }
.edges input { flex: 1 1 180px; min-width: 0; }
.err { color: var(--neg); font-size: 12px; margin: -4px 0 10px; }

input[type="text"], select {
  height: 34px; background: var(--surface); border: 1px solid var(--border-strong); color: var(--text);
  border-radius: 6px; padding: 0 10px; transition: border-color 120ms ease;
}
input[type="text"]:hover, select:hover { border-color: #47505c; }
select { padding-right: 28px; }
option { background: var(--surface); color: var(--text); }

.btn {
  height: 34px; padding: 0 14px; border-radius: 6px; border: 1px solid var(--border-strong);
  background: var(--surface-2); color: var(--text); font-weight: 550; white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.btn:hover:not(:disabled) { background: var(--surface-3); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.primary:hover:not(:disabled) { background: #93b5f8; border-color: #93b5f8; }
.btn.ghost { background: transparent; }
.btn.danger { background: transparent; color: var(--neg); border-color: #52302f; }
.btn.danger:hover:not(:disabled) { background: #1f1517; }
.btn.danger-solid { background: var(--neg); border-color: var(--neg); color: #160b0b; }
.btn.danger-solid:hover:not(:disabled) { background: #f38383; border-color: #f38383; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btns { display: flex; gap: 8px; flex-wrap: wrap; }
.key-row { margin-top: 8px; }
.key-row .key-input { flex: 1 1 220px; min-width: 0; }
.key-text { word-break: break-all; }
.key-shown { width: 100%; font-family: ui-monospace, Consolas, monospace; user-select: text; -webkit-user-select: text; }

.controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
.controls select { flex: 1 1 200px; min-width: 0; }
.seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 6px; overflow: hidden; flex: none; }
.seg button { border: 0; background: transparent; color: var(--muted); padding: 0 12px; height: 32px; font-weight: 550; }
.seg button + button { border-left: 1px solid var(--border-strong); }
.seg button[aria-checked="true"] { background: var(--surface-3); color: var(--text); }
.seg button:focus-visible { outline-offset: -2px; }

.status { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.status dt { color: var(--muted); }
.status dd { margin: 0; text-align: right; }
.status dd.num { white-space: normal; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; background: var(--faint); }
.dot.on { background: var(--pos); }
.dot.off { background: var(--neg); }
.switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
.switch input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); cursor: pointer; }

.confirm { margin-top: 12px; background: var(--surface); border: 1px solid #52302f; border-radius: var(--radius); padding: 12px 14px; animation: cst-fade 120ms ease-out; }
.confirm p { margin-bottom: 10px; }
.msg { margin-top: 12px; font-size: 12px; min-height: 18px; }

.empty { text-align: center; padding: 48px 16px; }
.empty .et { font-size: 15px; font-weight: 600; }
.empty .ed { color: var(--muted); margin: 6px auto 16px; max-width: 340px; }
.error { color: var(--neg); background: #1f1517; border: 1px solid #4a2a2c; border-radius: 6px; padding: 10px 12px; font-size: 12px; }
`;

export const CASE_PANEL_CSS = `
.cpanel {
  position: fixed; top: 100px; right: 16px; width: 320px; max-width: calc(100vw - 32px);
  max-height: calc(100vh - 116px); max-height: calc(100dvh - 116px);
  display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden;
}
.cpanel:not([hidden]) { animation: cst-fade 120ms ease-out; }
.bar { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; background: var(--surface); border-bottom: 1px solid var(--border); flex: none; }
.cpanel.collapsed .bar { border-bottom: 0; }
.bar .ttl { flex: 1; min-width: 0; font-size: 12px; font-weight: 650; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar .iconbtn { width: 28px; height: 28px; }
.content { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.pad { padding: 12px 14px; font-size: 12px; }
.error { color: var(--neg); }
.sum { padding: 10px 12px 12px; border-bottom: 1px solid var(--border); flex: none; }
.meta { margin: 0 0 8px; color: var(--muted); font-size: 12px; }
.meta b { color: var(--text); font-weight: 600; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.box { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; min-width: 0; }
.box.wide { grid-column: 1 / -1; }
.box .k { color: var(--muted); font-size: 11px; }
.box .v { font-size: 14px; font-weight: 650; margin-top: 1px; }
.box .v.muted { font-size: 13px; font-weight: 550; }
.box .x { font-size: 11.5px; font-weight: 600; margin-left: 6px; }
.box .s { color: var(--faint); font-size: 11px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.box .s.wrap { white-space: normal; }
.lhead { display: flex; justify-content: space-between; gap: 8px; padding: 7px 12px; font-size: 11px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); flex: none; }
.items {
  list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 120px; flex: 1; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent;
}
.item { display: flex; align-items: center; gap: 9px; padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
.item:last-child { border-bottom: 0; }
.item:hover { background: var(--surface); }
.item img, .item .noimg { width: 40px; height: 30px; object-fit: contain; flex: none; display: block; }
.item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.item .r { display: flex; flex-direction: column; align-items: flex-end; flex: none; }
.item .price { font-weight: 600; }
.item .second { color: var(--muted); font-size: 11px; }
@media (max-width: 640px) { .cpanel { top: auto; bottom: 64px; right: 16px; max-height: 60vh; } }
`;

export const OVERLAY_CSS = `
.card {
  position: fixed; width: 300px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow-y: auto;
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius);
  scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent;
}
.card:not([hidden]) { animation: cst-fade 120ms ease-out; }
.card.dragging { user-select: none; }
.bar {
  display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px;
  background: var(--surface); border-bottom: 1px solid var(--border);
  cursor: grab; touch-action: none; user-select: none;
}
.card.dragging .bar { cursor: grabbing; }
.card.collapsed .bar { border-bottom: 0; }
.bar .ttl { flex: 1; font-size: 12px; font-weight: 650; color: var(--muted); letter-spacing: 0.02em; }
.bar .iconbtn { width: 28px; height: 28px; }
.content { padding: 12px 14px 14px; }
.verdict { font-size: 14px; font-weight: 600; line-height: 1.35; }
.verdict-sub { color: var(--muted); font-size: 11.5px; margin-top: 4px; }
.kv { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; text-align: right; font-weight: 550; }
.kv dd .ci { display: block; color: var(--faint); font-weight: 400; font-size: 11px; }
.longrun { margin-top: 12px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
.longrun .lt { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 650; margin-bottom: 4px; }
.longrun .line { display: flex; justify-content: space-between; gap: 10px; }
.longrun .line + .line { margin-top: 2px; }
.longrun .line span:first-child { color: var(--muted); }
.error { color: var(--neg); font-size: 12px; }
.outlook { padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); }
.outlook.pos { border-color: var(--pos); }
.outlook.neg { border-color: var(--neg); }
.outlook .ol-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.outlook .ol-verdict { font-size: 15px; font-weight: 700; color: var(--text); }
.outlook.pos .ol-verdict { color: var(--pos); }
.outlook.neg .ol-verdict { color: var(--neg); }
.outlook .ol-prob { font-size: 12px; color: var(--muted); white-space: nowrap; }
.outlook .ol-line { color: var(--muted); font-size: 11.5px; margin-top: 4px; line-height: 1.4; }
.outlook .ol-line b { color: var(--text); font-weight: 600; }
.ol-win { display: grid; grid-template-columns: 1fr auto auto; gap: 2px 10px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-size: 11.5px; }
.ol-win span { color: var(--muted); }
.ol-win span.num { text-align: right; }
.ol-win .cur { color: var(--text); font-weight: 600; }
.ol-kelly { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11.5px; }
.ol-kelly b { color: var(--text); font-weight: 600; }
`;

export const EXCHANGE_CSS = `
.xpanel {
  position: fixed; top: 100px; left: 16px; width: 440px; max-width: calc(100vw - 32px);
  max-height: calc(100vh - 164px); max-height: calc(100dvh - 164px);
  display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden;
}
.xpanel:not([hidden]) { animation: cst-fade 120ms ease-out; }
.bar { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; background: var(--surface); border-bottom: 1px solid var(--border); flex: none; }
.xpanel.collapsed .bar { border-bottom: 0; }
.bar .ttl { flex: 1; min-width: 0; font-size: 12px; font-weight: 650; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar .iconbtn { width: 28px; height: 28px; }
.content { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.pad { padding: 12px 14px; font-size: 12px; }
.error { color: var(--neg); }
.sum { padding: 10px 12px 10px; border-bottom: 1px solid var(--border); flex: none; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.box { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; min-width: 0; }
.box .k { color: var(--muted); font-size: 11px; }
.box .v { font-size: 14px; font-weight: 650; margin-top: 1px; }
.box .v .x { font-size: 11.5px; font-weight: 600; margin-left: 6px; }
.box .s { color: var(--faint); font-size: 11px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tools { display: flex; align-items: center; gap: 6px 12px; margin-top: 8px; font-size: 11.5px; color: var(--muted); flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.seg button { background: transparent; border: 0; padding: 3px 8px; font-size: 11.5px; color: var(--muted); }
.seg button[aria-pressed="true"] { background: var(--surface-3); color: var(--text); }
.tools select { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 2px 4px; font-size: 11.5px; }
.bar .status { color: var(--faint); font-size: 11px; flex: none; }
.tools .tg { display: inline-flex; align-items: center; gap: 6px; }
.lhead { display: flex; justify-content: space-between; gap: 8px; padding: 7px 12px; font-size: 11px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); flex: none; }
.items {
  list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; flex: 1; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent;
}
.item { display: flex; align-items: center; gap: 9px; padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 12px; cursor: pointer; }
.item:last-child { border-bottom: 0; }
.item:hover { background: var(--surface); }
.item.illiquid { opacity: 0.55; }
.item.sep { border-top: 1px solid var(--border-strong); }
.item img, .item .noimg { width: 40px; height: 30px; object-fit: contain; flex: none; display: block; }
.item .mid { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.item .sub { color: var(--faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .r { display: flex; flex-direction: column; align-items: flex-end; flex: none; }
.item .price { font-weight: 600; }
.item .price .flag { color: var(--warn); margin-left: 1px; }
.item .price .delta { font-size: 11px; font-weight: 600; margin-left: 5px; }
.item .second { color: var(--muted); font-size: 11px; }
.item .sp { width: 56px; height: 22px; flex: none; display: flex; align-items: center; }
.item .sp svg { display: block; }
.item.open { background: var(--surface); }
.item.open .name { font-weight: 600; }
.rank { width: 18px; flex: none; color: var(--faint); font-size: 11px; text-align: right; }
.note { padding: 8px 12px; color: var(--faint); font-size: 11px; border-top: 1px solid var(--border); flex: none; }
.box.clickable { display: block; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.box.clickable:hover:not(:disabled) { border-color: var(--border-strong); }
.box.clickable.open { border-color: var(--accent); }
.box.clickable:disabled { cursor: default; }
.dwrap { list-style: none; border-bottom: 1px solid var(--border-strong); background: var(--surface); cursor: default; }
.curdetail { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.detail { padding: 8px 12px 10px; animation: cst-fade 120ms ease-out; }
.detail .chart { position: relative; }
.detail .chart svg { display: block; overflow: visible; }
.detail .chart text { font-family: var(--font); font-size: 10px; fill: var(--faint); font-variant-numeric: tabular-nums; }
.detail .readout { min-height: 17px; font-size: 11.5px; color: var(--muted); margin-bottom: 4px; }
.detail .readout .strong { color: var(--text); font-weight: 600; }
.detail .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 11px; color: var(--muted); }
.detail .legend span { display: inline-flex; align-items: center; gap: 6px; }
.detail .legend .ln { display: inline-block; width: 14px; height: 0; border-top: 1.5px solid; }
.detail .legend .ln.dash { border-top-style: dashed; }
.detail .legend .ln.dot { border-top-style: dotted; }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 10px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
.st .k { color: var(--faint); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st .v { font-size: 12px; color: var(--text); font-weight: 600; }
.st .tag { margin-left: 5px; font-size: 9.5px; font-weight: 600; color: var(--accent); border: 1px solid var(--border-strong); border-radius: 4px; padding: 0 4px; vertical-align: 1px; }
.warnline { margin: 6px 0 0; font-size: 11px; color: var(--warn); line-height: 1.4; }
.dfoot { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-top: 8px; font-size: 10.5px; }
.dfoot a { color: var(--accent); text-decoration: none; white-space: nowrap; font-size: 11.5px; font-weight: 600; }
.dfoot a:hover { text-decoration: underline; }
@media (max-width: 640px) { .xpanel { top: auto; bottom: 64px; left: 16px; max-height: 50vh; } }
`;
