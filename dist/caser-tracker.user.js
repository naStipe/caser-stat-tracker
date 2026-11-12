// ==UserScript==
// @name         Caser Stat Tracker
// @namespace    caser-stat-tracker
// @version      0.9.1
// @description  Records your case opens and upgrades on caser.gg / caser.one and shows ROI, upgrade odds and factor statistics. Data stays in your browser (shared between both domains); optional cloud sync between browsers; only item names go to CSFloat for prices.
// @match        https://caser.gg/*
// @match        https://www.caser.gg/*
// @match        https://caser.one/*
// @match        https://www.caser.one/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @connect      csfloat.com
// @connect      hafnhxumrqyaljmciqqq.supabase.co
// @noframes
// @homepageURL  https://github.com/naStipe/caser-stat-tracker
// @updateURL    https://raw.githubusercontent.com/naStipe/caser-stat-tracker/main/dist/caser-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/naStipe/caser-stat-tracker/main/dist/caser-tracker.user.js
// ==/UserScript==

(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/capture/hook.js
  function installHook(win, onExchange) {
    if (win.__caserTrackerHooked) return { origFetch: win.__caserTrackerHooked.origFetch };
    const emit = (ex) => {
      try {
        onExchange(ex);
      } catch (err) {
        console.warn("[caser-tracker] handler error", err);
      }
    };
    const origFetch2 = win.fetch.bind(win);
    win.__caserTrackerHooked = { origFetch: origFetch2 };
    win.fetch = async function(input, init) {
      const response = await origFetch2(input, init);
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
        const path = apiPath(url, win.location.origin);
        if (path) {
          const method = (init?.method || typeof input === "object" && input?.method || "GET").toUpperCase();
          const reqBody = parseJson(init?.body);
          const auth = headerValue(init?.headers, "authorization");
          const clone = response.clone();
          clone.text().then((text) => emit({ method, path, url, reqBody, auth, status: response.status, resBody: parseJson(text), serverTs: dateHeader(response.headers.get("date")) })).catch(() => {
          });
        }
      } catch {
      }
      return response;
    };
    const XHR = win.XMLHttpRequest;
    if (XHR) {
      const open = XHR.prototype.open;
      const send = XHR.prototype.send;
      XHR.prototype.open = function(method, url) {
        this.__ct = { method: String(method).toUpperCase(), url: String(url) };
        return open.apply(this, arguments);
      };
      XHR.prototype.send = function(body) {
        const meta = this.__ct;
        const path = meta && apiPath(meta.url, win.location.origin);
        if (path) {
          this.addEventListener("load", () => {
            try {
              const text = this.responseType === "" || this.responseType === "text" ? this.responseText : null;
              emit({ method: meta.method, path, url: meta.url, reqBody: parseJson(body), status: this.status, resBody: parseJson(text), serverTs: dateHeader(this.getResponseHeader("date")) });
            } catch {
            }
          });
        }
        return send.apply(this, arguments);
      };
    }
    return { origFetch: origFetch2 };
  }
  function apiPath(url, origin) {
    if (!url) return null;
    try {
      const u = new URL(url, origin);
      if (u.origin !== origin) return null;
      const m = u.pathname.match(/^\/api(\/.*)$/);
      return m ? m[1] + u.search : null;
    } catch {
      return null;
    }
  }
  function headerValue(headers, name) {
    if (!headers) return null;
    try {
      if (typeof headers.get === "function") return headers.get(name);
      if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
      for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k];
    } catch {
    }
    return null;
  }
  function parseJson(v) {
    if (typeof v !== "string" || v === "") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  function dateHeader(h2) {
    const t = h2 ? Date.parse(h2) : NaN;
    return Number.isFinite(t) ? t : Date.now();
  }

  // src/schema.js
  var SCHEMA_VERSION = 1;
  var SHOWN_CHANCE_FACTOR = 1.03;
  function num(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v.replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }
  function numOrNull(v) {
    if (v === null || v === void 0 || v === "") return null;
    const n = num(v);
    return n === 0 && !(v === 0 || v === "0" || /^0+(\.0+)?$/.test(String(v))) ? null : n;
  }
  function toItem(raw) {
    const o = raw && typeof raw === "object" ? raw : {};
    const inner = o.item && typeof o.item === "object" ? o.item : {};
    return {
      id: o.id != null ? String(o.id) : inner.id != null ? String(inner.id) : null,
      name: String(o.marketName ?? o.market_name ?? o.name ?? inner.marketName ?? inner.name ?? "Unknown item"),
      price: num(o.price ?? inner.price),
      rarity: o.rarity ?? inner.rarity ?? null,
      image: o.image ?? inner.image ?? null
    };
  }
  function shownChance(stake, targetPrice) {
    if (!(stake > 0) || !(targetPrice > 0)) return 0;
    return Math.min(Math.max(stake / targetPrice * 100 * SHOWN_CHANCE_FACTOR, 0), 100);
  }
  function hashId(str) {
    let h2 = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h2 ^= str.charCodeAt(i);
      h2 = Math.imul(h2, 16777619);
    }
    return (h2 >>> 0).toString(36);
  }

  // src/capture/parsers.js
  var obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
  var arr = (v) => Array.isArray(v) ? v : [];
  var unwrap = (body) => obj(body)?.data && typeof body.data === "object" ? body.data : body;
  var Context = class {
    constructor() {
      this.cases = /* @__PURE__ */ new Map();
      this.items = /* @__PURE__ */ new Map();
      this.userId = null;
      this.userName = null;
      this.balance = null;
      this.inventoryValue = null;
    }
    /** Feed every exchange here, before parsing events. */
    learn(ex) {
      const body = unwrap(ex.resBody);
      if (!body || ex.status >= 400) return;
      const p = ex.path.split("?")[0];
      if (p === "/game/cases" || p === "/game/custom-cases") {
        for (const c of arr(body.cases ?? body.items ?? body)) this.addCase(c);
      } else if (/^\/game\/cases\/[^/]+$/.test(p)) {
        this.addCase(obj(body.case) ?? body);
      } else if (p === "/users/me") {
        const u = obj(body.user) ?? body;
        if (u.id != null) {
          const id = String(u.id);
          if (this.userId != null && this.userId !== id) {
            this.items.clear();
            this.inventoryValue = null;
          }
          this.userId = id;
          const name = u.username ?? u.nickname ?? u.displayName ?? u.name ?? u.login ?? u.steamName ?? u.personaName ?? u.personaname ?? obj(u.steam)?.personaname ?? obj(u.profile)?.name;
          this.userName = typeof name === "string" && name.trim() ? name.trim().slice(0, 64) : null;
        }
        this.setBalance(u.balance);
      } else if (p === "/items/inventory/balance") {
        this.inventoryValue = numOrNull(body.amount);
      } else if (p === "/items/inventory" || /^\/users\/[^/]+\/inventory$/.test(p)) {
        for (const it of arr(body.items ?? body.inventory ?? body)) this.addInventoryItem(it);
      }
      if (obj(body) && "balance" in body && p !== "/users/me") this.setBalance(body.balance);
    }
    addCase(c) {
      const o = obj(c);
      if (!o || !o.slug) return;
      this.cases.set(String(o.slug), { id: o.id != null ? String(o.id) : null, slug: String(o.slug), name: String(o.title ?? o.name ?? o.slug), price: num(o.price) });
    }
    addInventoryItem(it) {
      const o = obj(it);
      if (!o || o.id == null) return;
      const item = toItem(o);
      item.id = String(o.id);
      this.items.set(item.id, item);
    }
    setBalance(v) {
      const b = numOrNull(obj(v)?.balance ?? v);
      if (b !== null) this.balance = b;
    }
  };
  function parseExchange(ex, ctx2, site2) {
    const p = ex.path.split("?")[0];
    if (ex.method === "POST" && /^\/game\/cases\/[^/]+\/open$/.test(p)) {
      return { events: parseCaseOpen(ex, ctx2, site2), recognized: true };
    }
    if (ex.method === "POST" && p === "/game/upgrade/bet") {
      const e = parseUpgradeBet(ex, ctx2, site2);
      return { events: e ? [e] : [], recognized: true };
    }
    if (ex.method === "POST" && p === "/withdrawals") {
      return { events: parseWithdrawalRequest(ex, ctx2, site2), recognized: true };
    }
    if (ex.method === "GET" && ex.status < 400 && (p === "/payments/history" || /^\/payments\/\d+$/.test(p))) {
      const body = unwrap(ex.resBody);
      const rows = p === "/payments/history" ? historyRows(body) : [obj(body?.payment) ?? body];
      return { events: rows.map((r) => depositFromPayment(r, ctx2, site2)).filter(Boolean), recognized: false };
    }
    return { events: [], recognized: false };
  }
  function depositFromPayment(row, ctx2, site2) {
    const r = obj(row);
    if (!r || r.id == null || r.amount == null) return null;
    const ts = Date.parse(r.createdAt ?? "");
    if (!ts) return null;
    const done = Date.parse(r.completedAt ?? "");
    return {
      id: `deposit:${r.id}`,
      kind: "deposit",
      ts,
      site: site2,
      userId: ctx2.userId,
      source: "import",
      balanceBefore: null,
      balanceAfter: null,
      amount: num(r.amount),
      method: String(r.methodName ?? r.method ?? ""),
      status: String(r.status ?? "unknown"),
      completedTs: Number.isFinite(done) ? done : null
    };
  }
  function withdrawalFromInventoryRecord(row, ctx2, site2) {
    const r = obj(row);
    if (!r || r.status !== "withdrawn" || r.id == null) return null;
    const ts = Date.parse(r.createdAt ?? "");
    if (!ts) return null;
    const item = toItem({ ...obj(r.item), price: r.price ?? obj(r.item)?.price });
    item.id = String(r.id);
    return { id: `withdrawal:${r.id}`, kind: "withdrawal", ts, site: site2, userId: ctx2.userId, source: "import", balanceBefore: null, balanceAfter: null, item, value: item.price, exactTime: false };
  }
  var WITHDRAWAL_TWIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1e3;
  var WITHDRAWAL_TWIN_SLACK_MS = 5 * 60 * 1e3;
  function withdrawalTwinIds(events) {
    const imported = /* @__PURE__ */ new Map();
    const live = [];
    for (const e of events) {
      if (!e || e.kind !== "withdrawal") continue;
      if (e.source === "live") live.push(e);
      else if (e.source === "import") {
        const name = e.item?.name;
        if (!imported.has(name)) imported.set(name, []);
        imported.get(name).push(e);
      }
    }
    for (const list of imported.values()) list.sort((a, b) => a.ts - b.ts);
    live.sort((a, b) => a.ts - b.ts);
    const twins = /* @__PURE__ */ new Set();
    for (const l of live) {
      const list = imported.get(l.item?.name);
      if (!list) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        const imp = list[i];
        if (imp.ts > l.ts + WITHDRAWAL_TWIN_SLACK_MS) continue;
        if (l.ts - imp.ts > WITHDRAWAL_TWIN_WINDOW_MS) break;
        twins.add(imp.id);
        list.splice(i, 1);
        break;
      }
    }
    return twins;
  }
  function parseWithdrawalRequest(ex, ctx2, site2) {
    if (ex.status >= 400) return [];
    const req2 = obj(ex.reqBody) ?? {};
    const ids = [];
    for (const [k, v] of Object.entries(req2)) {
      if (!/item/i.test(k)) continue;
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" || typeof x === "number") ids.push(x);
    }
    const ts = Date.now();
    return ids.map(String).filter((id) => ctx2.items.has(id)).map((id) => {
      const item = ctx2.items.get(id);
      return { id: `withdrawal:${id}`, kind: "withdrawal", ts, site: site2, userId: ctx2.userId, source: "live", balanceBefore: ctx2.balance, balanceAfter: null, item, value: item.price, exactTime: true };
    });
  }
  var caseMatchKey = (slug, name) => `${slug}|${name}`;
  function dropLiveTwins(imported, stored, onMatch) {
    const live = /* @__PURE__ */ new Map();
    for (const e of stored) {
      if (e.kind !== "case" || e.source !== "live" || !e.matchKey) continue;
      if (!live.has(e.matchKey)) live.set(e.matchKey, []);
      live.get(e.matchKey).push(e);
    }
    return imported.filter((e) => {
      const drops = live.get(caseMatchKey(e.caseSlug, e.item.name));
      if (!drops) return true;
      const i = drops.findIndex((l) => Math.abs(l.ts - e.ts) < 6e4);
      if (i < 0) return true;
      onMatch?.(drops[i], e);
      drops.splice(i, 1);
      return false;
    });
  }
  function caseTwinIds(events) {
    const imported = events.filter((e) => e && e.kind === "case" && e.source === "import" && e.item);
    if (!imported.length) return /* @__PURE__ */ new Set();
    const kept = new Set(dropLiveTwins(imported, events));
    return new Set(imported.filter((e) => !kept.has(e)).map((e) => e.id));
  }
  function parseCaseOpen(ex, ctx2, site2) {
    if (ex.status >= 400) return [];
    const body = unwrap(ex.resBody);
    const items = arr(body?.items ?? body?.drops ?? body?.results);
    if (!items.length) return [];
    const slug = decodeURIComponent(ex.path.split("?")[0].split("/")[3]);
    const known = ctx2.cases.get(slug);
    const resCase = obj(body.case);
    const count = Math.max(1, num(ex.reqBody?.count) || items.length);
    const listPrice = num(resCase?.price) || known?.price || 0;
    const balanceAfter = numOrNull(body.user_balance ?? body.balance ?? body.user?.balance);
    const balanceBefore = ctx2.balance;
    if (balanceAfter !== null) ctx2.balance = balanceAfter;
    const ts = Date.now();
    const batchSeed = items.map((i) => obj(i)?.id ?? "").join(",");
    const batchId = String(body.id ?? body.openId ?? body.open_id ?? hashId(`${slug}|${ts}|${batchSeed}`));
    return items.map((raw, i) => {
      const r = obj(raw) ?? {};
      const item = toItem(raw);
      const free = !!(r.is_free ?? r.isFree ?? body.is_free ?? body.free ?? false);
      const paid = numOrNull(r.price_paid ?? r.pricePaid);
      const casePrice = free ? 0 : paid ?? listPrice;
      return {
        // The item id in this response is the catalog skin id, shared by every drop of that skin,
        // so the event id is built from the open itself.
        id: `case:live:${batchId}:${i}`,
        kind: "case",
        ts,
        site: site2,
        userId: ctx2.userId,
        source: "live",
        balanceBefore,
        balanceAfter,
        caseSlug: slug,
        caseId: resCase?.id != null ? String(resCase.id) : known?.id ?? null,
        caseName: String(resCase?.title ?? resCase?.name ?? known?.name ?? slug),
        casePrice,
        free,
        batchId,
        // Lets the history import recognise this drop later (it has its own inventory id there).
        matchKey: caseMatchKey(slug, item.name),
        batchSize: count,
        gameMode: String(ex.reqBody?.gameMode ?? "normal"),
        item
      };
    });
  }
  function parseUpgradeBet(ex, ctx2, site2) {
    if (ex.status >= 400) return null;
    const body = unwrap(ex.resBody);
    if (!obj(body)) return null;
    const req2 = obj(ex.reqBody) ?? {};
    const ev = upgradeFromRecord(body, ctx2, site2, {
      betItemIds: arr(req2.betInventoryItemIds).map(String),
      addedBalance: req2.addedBalance,
      targetItemId: req2.targetItemId,
      mystery: req2.isMystery,
      gameMode: req2.gameMode
    });
    if (!ev) return null;
    ev.ts = Date.now();
    ev.source = "live";
    ev.balanceBefore = ctx2.balance;
    const after = numOrNull(body.balance ?? obj(body.user)?.balance);
    if (after !== null) {
      ev.balanceAfter = after;
      ctx2.balance = after;
    }
    return ev;
  }
  function upgradeFromRecord(record, ctx2, site2, hint = {}) {
    const r = obj(record);
    if (!r) return null;
    const b = obj(r.bet) ?? r;
    let betItems = arr(b.betItems ?? b.fromItems ?? b.items).map(toItem);
    if (!betItems.length && hint.betItemIds?.length) {
      betItems = hint.betItemIds.map((id2) => ctx2.items.get(id2) ?? { id: id2, name: "Unknown item", price: 0, rarity: null, image: null });
    }
    const addedBalance = num(b.addedBalance ?? b.added_balance ?? b.balanceAdded ?? hint.addedBalance);
    const stake = num(b.stake ?? b.betAmount ?? b.amount) || betItems.reduce((s2, i) => s2 + i.price, 0) + addedBalance;
    const targetRaw = obj(b.targetItem ?? b.desiredItem ?? b.toItem);
    const target = targetRaw ? toItem(targetRaw) : null;
    const wonRaw = obj(b.wonItem ?? b.resultItem);
    const statusRaw = String(b.status ?? r.status ?? "pending").toLowerCase();
    const status = statusRaw === "won" || statusRaw === "win" ? "won" : statusRaw === "lost" || statusRaw === "lose" || statusRaw === "loss" ? "lost" : "pending";
    const won = status === "won";
    const mystery = !!(b.isMystery ?? r.isMystery ?? hint.mystery);
    const chanceRaw = mystery ? null : numOrNull(b.chance ?? b.winChance ?? b.probability);
    const chanceServer = chanceRaw === null || chanceRaw === 0 ? null : chanceRaw <= 1 ? chanceRaw * 100 : chanceRaw;
    const chanceShown = mystery ? null : chanceServer ?? (target ? shownChance(stake, target.price) : 0);
    const sd = obj(b.superDrop ?? r.superDrop);
    const superDrop = sd ? { shown: !!(sd.shown ?? sd.display ?? sd.active ?? sd.visible ?? true), won: !!(sd.won ?? sd.win ?? sd.isWon ?? sd.success), item: obj(sd.item) ? toItem(sd.item) : null } : null;
    const compensation = arr(r.compensationItems ?? b.compensationItems).map(toItem);
    let returned = 0;
    if (wonRaw) returned += toItem(wonRaw).price;
    else if (won) returned += (superDrop?.won && superDrop.item ? superDrop.item.price : 0) || target?.price || 0;
    returned += compensation.reduce((s2, i) => s2 + i.price, 0);
    const mm = numOrNull(b.mysteryMultiplier ?? r.mysteryMultiplier);
    const id = b.id ?? r.id;
    return {
      id: `upgrade:${id ?? hashId(JSON.stringify([betItems.map((i) => i.id), target?.id, stake, b.createdAt]))}`,
      kind: "upgrade",
      ts: Date.parse(b.createdAt ?? r.createdAt ?? "") || Date.now(),
      site: site2,
      userId: ctx2.userId,
      source: "import",
      balanceBefore: null,
      balanceAfter: null,
      stake,
      betItems,
      addedBalance,
      target: target ?? (won && wonRaw ? toItem(wonRaw) : null),
      mystery,
      mysteryMultiplier: mystery ? mm ?? (stake > 0 ? returned / stake : null) : null,
      gameMode: String(b.gameMode ?? hint.gameMode ?? "normal"),
      chanceShown,
      chanceServer,
      status,
      won,
      superDrop,
      compensation,
      returned,
      net: returned - stake
    };
  }
  function upgradeHistoryRows(body) {
    const d = unwrap(body);
    const featured = arr(obj(d)?.featured ?? obj(obj(d)?.data)?.featured);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const r of [...historyRows(body), ...featured]) {
      const id = obj(r)?.id ?? obj(obj(r)?.bet)?.id;
      if (id != null && seen.has(String(id))) continue;
      if (id != null) seen.add(String(id));
      out.push(r);
    }
    return out;
  }
  function caseFromInventoryRecord(row, ctx2, site2) {
    const r = obj(row);
    if (!r || r.action !== "won_case" || obj(r.source)?.type !== "case") return null;
    const c = obj(r.source.case) ?? obj(r.caseInfo);
    const slug = c?.slug ? String(c.slug) : null;
    if (!slug) return null;
    const known = ctx2.cases.get(slug);
    if (!known || !(known.price > 0)) return null;
    const item = toItem({ ...obj(r.item), price: r.price ?? obj(r.item)?.price });
    item.id = r.id != null ? String(r.id) : item.id;
    const ts = Date.parse(r.createdAt ?? "") || 0;
    if (!ts) return null;
    return {
      id: `case:${r.id ?? hashId(`${slug}|${ts}|${item.name}`)}`,
      kind: "case",
      ts,
      site: site2,
      userId: ctx2.userId,
      source: "import",
      balanceBefore: null,
      balanceAfter: null,
      caseSlug: slug,
      caseId: known.id,
      caseName: String(c.title ?? known.name),
      casePrice: known.price,
      free: false,
      // Drops of one multi-open share a timestamp to the second.
      batchId: `${slug}|${ts}`,
      batchSize: 1,
      gameMode: "normal",
      item
    };
  }
  function historyRows(body) {
    const d = unwrap(body);
    if (Array.isArray(d)) return d;
    const o = obj(d);
    if (!o) return [];
    for (const k of ["items", "results", "upgrades", "bets", "history", "data"]) if (Array.isArray(o[k])) return o[k];
    const inner = obj(o.data);
    if (inner) {
      for (const k of ["items", "results", "upgrades", "bets", "history"]) if (Array.isArray(inner[k])) return inner[k];
    }
    return [];
  }

  // src/capture/history.js
  var PAGE = 50;
  var MAX_PAGES = 4e3;
  var KNOWN_PAGES_STOP = 2;
  var PAUSE_MS = 500;
  var RETRY_MS = 4e3;
  var MAX_RETRIES = 6;
  async function importHistory({ fetch, ctx: ctx2, site: site2, getAuth: getAuth2, save, getStored, onProgress, progressStore }) {
    const get = (path) => getJson(fetch, path, getAuth2);
    const progressFor = (name) => progressStore && { load: () => progressStore.load(name), save: (v) => progressStore.save(name, v) };
    const userId = ctx2.userId ?? await fetchMe(get, ctx2);
    if (!userId) throw new Error("Sign in first: the tracker does not know your user id yet.");
    const uid = encodeURIComponent(userId);
    const stored = getStored ? await getStored() : [];
    const countOf = (...kinds) => stored.filter((e) => kinds.includes(e.kind) && e.source === "import").length;
    let upgrades = 0;
    await paginate(get, `/api/game/upgrade/public-history/${uid}`, async (body, page) => {
      onProgress?.(`Upgrades: page ${page}`);
      const events = upgradeHistoryRows(body).map((r) => upgradeFromRecord(r, ctx2, site2)).filter((e) => e && e.status !== "pending");
      const added = await save(events);
      upgrades += added;
      return { count: Array.isArray(body?.items) ? body.items.length : 0, added };
    }, progressFor("upgrades"), countOf("upgrade"));
    if (!ctx2.cases.size) {
      for (const p of ["/api/game/cases", "/api/game/custom-cases"]) {
        try {
          ctx2.learn({ method: "GET", path: p.slice(4), status: 200, resBody: await get(p) });
        } catch {
        }
      }
    }
    const triedSlugs = /* @__PURE__ */ new Set();
    let cases = 0;
    let withdrawn = 0;
    const knownWithdrawals = new Map(stored.filter((e) => e.kind === "withdrawal").map((e) => [e.id, e]));
    let skipped = 0;
    await paginate(get, `/api/users/${uid}/inventory/history`, async (body, page) => {
      onProgress?.(`Case drops: page ${page}`);
      const items = Array.isArray(body?.items) ? body.items : [];
      const drops = items.filter((r) => r?.action === "won_case");
      for (const r of drops) {
        const slug = r?.source?.case?.slug;
        if (!slug || ctx2.cases.has(slug) || triedSlugs.has(slug)) continue;
        triedSlugs.add(slug);
        try {
          ctx2.learn({ method: "GET", path: `/game/cases/${slug}`, status: 200, resBody: await get(`/api/game/cases/${encodeURIComponent(slug)}`) });
        } catch {
        }
        await sleep(PAUSE_MS);
      }
      const parsed = drops.map((r) => caseFromInventoryRecord(r, ctx2, site2)).filter(Boolean);
      skipped += drops.length - parsed.length;
      const owned = [];
      const events = dropLiveTwins(parsed, stored, (live, imp) => {
        if (live.userId == null && imp.userId != null) owned.push({ ...live, userId: imp.userId });
      });
      if (owned.length) await save(owned);
      const parsedWithdrawals = items.map((r) => withdrawalFromInventoryRecord(r, ctx2, site2)).filter((w) => w && !knownWithdrawals.has(w.id));
      const twins = withdrawalTwinIds([...knownWithdrawals.values(), ...parsedWithdrawals]);
      const withdrawals = parsedWithdrawals.filter((w) => !twins.has(w.id));
      for (const w of withdrawals) knownWithdrawals.set(w.id, w);
      const added = await save(events);
      cases += added;
      withdrawn += await save(withdrawals);
      return { count: items.length, added, considered: events.length };
    }, progressFor("inventory"), countOf("case", "withdrawal"));
    let deposits = 0;
    await paginate(get, "/api/payments/history", async (body, page) => {
      onProgress?.(`Deposits: page ${page}`);
      const items = Array.isArray(body?.items) ? body.items : [];
      const events = items.map((r) => depositFromPayment(r, ctx2, site2)).filter(Boolean);
      const added = await save(events);
      deposits += added;
      return { count: items.length, added, considered: events.length };
    }, progressFor("payments"), countOf("deposit"));
    return { added: upgrades + cases + withdrawn + deposits, upgrades, cases, withdrawn, deposits, skipped };
  }
  async function paginate(get, path, onPage, progress, storedCount = 0) {
    const saved = { complete: false, offset: 0, ...await progress?.load() ?? {} };
    if (!saved.complete && storedCount > saved.offset) saved.offset = storedCount;
    let newRows = 0;
    let knownStreak = 0;
    let page = 0;
    let reachedEnd = false;
    for (; page < MAX_PAGES; page++) {
      const body = await get(`${path}?limit=${PAGE}&offset=${page * PAGE}`);
      const { count, added, considered = count } = await onPage(body, page + 1);
      newRows += added;
      if (considered > 0) knownStreak = added === 0 ? knownStreak + 1 : 0;
      if (count < PAGE || body?.hasMore === false || body?.data?.hasMore === false) {
        reachedEnd = true;
        break;
      }
      if (knownStreak >= KNOWN_PAGES_STOP) break;
      if (!saved.complete) await progress?.save({ complete: false, offset: Math.max(saved.offset + newRows, (page + 1) * PAGE) });
      await sleep(PAUSE_MS);
    }
    if (!reachedEnd && !saved.complete && saved.offset > (page + 1) * PAGE) {
      let offset = Math.max(0, saved.offset + newRows - PAGE);
      for (let i = 0; i < MAX_PAGES; i++, offset += PAGE) {
        await sleep(PAUSE_MS);
        const body = await get(`${path}?limit=${PAGE}&offset=${offset}`);
        const { count } = await onPage(body, Math.floor(offset / PAGE) + 1);
        await progress?.save({ complete: false, offset: offset + PAGE });
        if (count < PAGE || body?.hasMore === false || body?.data?.hasMore === false) {
          reachedEnd = true;
          break;
        }
      }
    }
    if (reachedEnd) await progress?.save({ complete: true, offset: 0 });
  }
  async function fetchMe(get, ctx2) {
    const body = await get("/api/users/me");
    ctx2.learn({ method: "GET", path: "/users/me", status: 200, resBody: body });
    const u = body?.user ?? body?.data ?? body;
    if (u?.id != null) ctx2.userId = String(u.id);
    return ctx2.userId;
  }
  async function getJson(fetch, path, getAuth2) {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const auth = getAuth2();
      const res = await fetch(path, { headers: { Accept: "application/json", ...auth ? { Authorization: auth } : {} } });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1e3 : RETRY_MS);
        continue;
      }
      if (res.status === 401 && !renewed) {
        renewed = await waitForNewToken(getAuth2, auth);
        if (renewed) continue;
        throw new Error("Your login expired. Reload the page and press Sync again; it continues where it stopped.");
      }
      if (!res.ok) throw new Error(`Site answered ${res.status} for ${path.split("?")[0]}`);
      return res.json();
    }
  }
  var TOKEN_WAIT_MS = 12e4;
  async function waitForNewToken(getAuth2, oldAuth) {
    for (let waited = 0; waited < TOKEN_WAIT_MS; waited += 2e3) {
      await sleep(2e3);
      const now = getAuth2();
      if (now && now !== oldAuth) return true;
    }
    return false;
  }
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // src/capture/selection.js
  var PRICE_RE = /^\d[\d\s  ]*(?:[.,]\d+)?$/;
  function parsePrice(text) {
    const t = String(text).replace(/[\s  ]/g, "").replace(",", ".");
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  function firstPrice(card) {
    if (!card) return null;
    for (const el of card.querySelectorAll("span, div")) {
      if (el.children.length) continue;
      const t = el.textContent.trim();
      if (PRICE_RE.test(t)) return parsePrice(t);
    }
    return null;
  }
  var OWN_SELECTORS = [
    '[data-testid="upgrade-user-single-item-card"]',
    '[data-testid="upgrade-user-items-card"]',
    '[data-testid$="own-item-card"]',
    '[data-testid$="own-multi-card"]'
  ];
  var TARGET_SELECTORS = [
    '[data-testid="upgrade-desired-target-card"]',
    '[data-testid="upgrade-desired-card"]',
    '[data-testid$="target-item-card"]'
  ];
  function findCard(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
  function readUpgradeSelection(doc) {
    if (!/\/upgrade(\/|$)/.test(doc.location.pathname)) return null;
    const own = findCard(doc, OWN_SELECTORS);
    const target = findCard(doc, TARGET_SELECTORS);
    if (!own || !target) return null;
    const targetPrice = firstPrice(target);
    if (!(targetPrice > 0)) return null;
    const ownPrice = firstPrice(own);
    if (!(ownPrice > 0)) return null;
    const chanceText = doc.querySelector('[data-testid="upgrade-spinner-chance-value"]')?.textContent ?? "";
    const chanceShown = parsePrice(chanceText.replace("%", ""));
    let stake = null;
    if (chanceShown !== null && chanceShown > 0 && chanceShown < 100) stake = chanceShown / 103 * targetPrice;
    else stake = ownPrice;
    if (!(stake > 0)) return null;
    return { stake, targetPrice, chanceShown };
  }

  // src/capture/caseinfo.js
  var obj2 = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
  var arr2 = (v) => Array.isArray(v) ? v : [];
  var unwrap2 = (body) => obj2(body)?.data && typeof body.data === "object" ? body.data : body;
  function caseSlugFromPath(pathname) {
    const m = String(pathname || "").match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cases\/([^/?#]+)\/?$/i);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function caseDetailPath(path) {
    const m = String(path || "").split("?")[0].match(/^\/game\/(custom-)?cases\/([^/]+)$/);
    return m ? { slug: decodeURIComponent(m[2]), custom: !!m[1] } : null;
  }
  function toCaseItem(raw) {
    const o = obj2(raw) ?? {};
    const it = obj2(o.item) ?? o;
    return {
      id: it.id != null ? String(it.id) : null,
      name: String(it.marketName ?? it.market_name ?? it.name ?? "Unknown item"),
      price: num(it.price),
      image: typeof it.image === "string" ? it.image : null,
      rarity: it.rarity != null ? String(it.rarity) : null,
      chance: numOrNull(o.chancePercent ?? o.chance ?? it.chance ?? null)
    };
  }
  function caseInfoFromResponse(body, hint = {}) {
    const d = obj2(unwrap2(body));
    if (!d) return null;
    const c = obj2(d.case) ?? d;
    const items = arr2(d.items ?? c.items).map(toCaseItem).filter((i) => i.price > 0 || i.chance !== null);
    if (!items.length) return null;
    const slug = String(c.slug ?? hint.slug ?? "");
    if (!slug) return null;
    return {
      slug,
      title: String(c.title ?? c.name ?? slug),
      price: num(c.price),
      custom: !!hint.custom || !obj2(d.case),
      items
    };
  }
  async function fetchCaseInfo(fetchFn, slug) {
    const enc = encodeURIComponent(slug);
    for (const [path, custom] of [[`/api/game/cases/${enc}`, false], [`/api/game/custom-cases/${enc}`, true]]) {
      const res = await fetchFn(path, { credentials: "include", headers: { accept: "application/json" } });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`case info: HTTP ${res.status}`);
      const info = caseInfoFromResponse(await res.json(), { slug, custom });
      if (info) return info;
    }
    return null;
  }

  // src/capture/replacements.js
  var obj3 = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
  var unwrap3 = (body) => obj3(body)?.data && typeof body.data === "object" ? body.data : body;
  var numOrNull2 = (v) => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  function replacementItemId(path) {
    const m = String(path || "").split("?")[0].match(/^\/inventory\/items\/([^/]+)\/replacements$/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function candidatesFromResponse(body) {
    const d = unwrap3(body);
    const list = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.candidates) ? d.candidates : [];
    const out = [];
    list.forEach((raw, i) => {
      const e = obj3(raw);
      if (!e) return;
      const it = obj3(e.item) ?? {};
      const name = String(it.marketName ?? e.marketName ?? e.market_name ?? "").trim();
      const price = numOrNull2(e.price ?? it.price);
      if (!name || price === null) return;
      out.push({
        id: String(e.id ?? it.id ?? i),
        itemId: String(it.id ?? e.id ?? ""),
        name,
        price,
        refund: numOrNull2(e.refund),
        image: typeof (it.image ?? e.image) === "string" ? it.image ?? e.image : null
      });
    });
    return out;
  }

  // src/prices/csfloat.js
  var CSFLOAT_ORIGIN = "https://csfloat.com";
  var CSFLOAT_SELLER_FEE = 0.02;
  var DAY = 864e5;
  function salesUrl(name) {
    return `${CSFLOAT_ORIGIN}/api/v1/history/${encodeURIComponent(name)}/sales`;
  }
  function marketUrl(name) {
    return `${CSFLOAT_ORIGIN}/search?market_hash_name=${encodeURIComponent(name)}&sort_by=lowest_price`;
  }
  var ok = (v) => typeof v === "number" && Number.isFinite(v);
  var cents = (v) => ok(Number(v)) && Number(v) > 0 ? Number(v) / 100 : null;
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  var median = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);
  function expandPoints(pts) {
    return (Array.isArray(pts) ? pts : []).map((p) => ({ ts: p[0] * 6e4, price: p[1] / 100, float: p[2] === null || p[2] === void 0 ? null : p[2] / 1e4 }));
  }
  var HISTORY_PAGE = 40;
  function findSplit(prices2) {
    const p = [...prices2].sort((a, b) => a - b);
    const n = p.length;
    if (n < 8) return null;
    const m = quantile(p, 0.5);
    const side = Math.max(3, Math.ceil(n * 0.2));
    let best = -1;
    let at = -1;
    for (let i = side; i <= n - side; i++) {
      const gap = p[i] - p[i - 1];
      if (gap > best) [best, at] = [gap, i];
    }
    if (at < 0 || best < m * 0.08) return null;
    const high = p.slice(at);
    return { cut: (p[at - 1] + p[at]) / 2, lowMin: p[0], lowMax: p[at - 1], highMin: p[at], highMax: p[n - 1], upper: quantile(high, 0.5), lowShare: at / n };
  }
  function summarizeSales(rows, now = Date.now()) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object" && (r.state === void 0 || r.state === "sold")).map((r) => {
      const raw = r.item?.float_value;
      const fv = raw === null || raw === void 0 ? NaN : Number(raw);
      return {
        ts: Date.parse(r.sold_at ?? r.created_at ?? ""),
        price: cents(r.price),
        float: ok(fv) ? fv : null,
        ref: r.reference && typeof r.reference === "object" ? r.reference : null
      };
    }).filter((r) => ok(r.ts) && r.price !== null).sort((a, b) => b.ts - a.ts);
    const within = (ms) => list.filter((r) => now - r.ts <= ms);
    const recent = within(30 * DAY);
    const ref = list.find((r) => r.ref)?.ref ?? null;
    const basePrice = ref ? cents(ref.base_price) : null;
    const listings = ref && ok(Number(ref.quantity)) ? Number(ref.quantity) : null;
    const lastPrice = list.length ? list[0].price : null;
    let windowDays = 30;
    let win = recent.slice(0, 20);
    if (win.length < 3) [windowDays, win] = [90, within(90 * DAY).slice(0, 10)];
    const m0 = median(win.map((r) => r.price));
    const clean = (p) => p >= m0 * 0.5 && p <= m0 * 1.5;
    let kept = win.length >= 3 ? win.map((r) => r.price).filter(clean).sort((a, b) => a - b) : [];
    const split = kept.length >= 3 ? findSplit(within(windowDays * DAY).map((r) => r.price).filter(clean)) : null;
    if (split) {
      const lower = kept.filter((p) => p < split.cut);
      if (lower.length >= 3) kept = lower;
    }
    let value = null;
    let quick = null;
    let source = null;
    let spread = null;
    if (kept.length >= 3) {
      value = quantile(kept, 0.5);
      quick = quantile(kept, 0.25);
      spread = (quantile(kept, 0.75) - quick) / value;
      source = "sales";
    } else if (basePrice !== null) [value, quick, source] = [basePrice, basePrice, "reference"];
    else if (lastPrice !== null) [value, quick, source] = [lastPrice, lastPrice, "last"];
    if (source !== "sales") windowDays = null;
    const newer = list.filter((r) => now - r.ts <= 14 * DAY).map((r) => r.price);
    const older = list.filter((r) => now - r.ts > 14 * DAY && now - r.ts <= 90 * DAY).map((r) => r.price);
    const trend = newer.length >= 3 && older.length >= 3 ? median(newer) / median(older) - 1 : null;
    const fee = (v) => v === null ? null : v * (1 - CSFLOAT_SELLER_FEE);
    return {
      value,
      quick,
      net: fee(value),
      quickNet: fee(quick),
      source,
      windowDays,
      used: source === "sales" ? kept.length : 0,
      low: source === "sales" ? kept[0] : null,
      high: source === "sales" ? kept[kept.length - 1] : null,
      spread,
      trend,
      basePrice,
      lastPrice,
      lastSaleTs: list.length ? list[0].ts : null,
      split: source === "sales" && split && kept[kept.length - 1] < split.cut ? split : null,
      sales7d: within(7 * DAY).length,
      sales30d: recent.length,
      // CSFloat returns at most ~40 sales. When all of them are inside 30 days, the real count is higher.
      salesCapped: list.length >= HISTORY_PAGE && recent.length === list.length,
      listings,
      n: list.length,
      pts: list.map((r) => [Math.round(r.ts / 6e4), Math.round(r.price * 100), r.float === null ? null : Math.round(r.float * 1e4)])
    };
  }
  function createPriceClient(o) {
    const now = o.now ?? (() => Date.now());
    const ttlMs = o.ttlMs ?? 6 * 36e5;
    const gapMs = o.gapMs ?? 350;
    const maxEntries = o.maxEntries ?? 300;
    const KEY = "cst.csfloat.v3";
    let cache = {};
    try {
      const c = o.storage?.get(KEY, {});
      if (c && typeof c === "object") cache = c;
    } catch {
    }
    try {
      for (const old of ["cst.csfloat.v1", "cst.csfloat.v2"]) o.storage?.remove?.(old);
    } catch {
    }
    const inflight = /* @__PURE__ */ new Map();
    let queue = Promise.resolve();
    let pausedUntil = 0;
    function save() {
      const keys = Object.keys(cache);
      if (keys.length > maxEntries) {
        keys.sort((a, b) => cache[a].ts - cache[b].ts);
        for (const k of keys.slice(0, keys.length - maxEntries)) delete cache[k];
      }
      try {
        o.storage?.set(KEY, cache);
      } catch {
      }
    }
    function cached(name) {
      const c = cache[name];
      return c && now() - c.ts < ttlMs ? c.s : null;
    }
    function get(name) {
      const hit = cached(name);
      if (hit) return Promise.resolve(hit);
      if (inflight.has(name)) return inflight.get(name);
      const p = queue = queue.catch(() => {
      }).then(async () => {
        const again = cached(name);
        if (again) return again;
        const wait = Math.max(0, pausedUntil - now());
        if (wait) await sleep2(wait);
        const res = await o.request(salesUrl(name));
        if (res.status === 429) {
          pausedUntil = now() + 3e4;
          throw new Error("CSFloat rate limit, retry in 30 s");
        }
        if (res.status === 404) {
          const s3 = summarizeSales([], now());
          cache[name] = { ts: now(), s: s3 };
          save();
          return s3;
        }
        if (res.status < 200 || res.status >= 300) throw new Error(`CSFloat HTTP ${res.status}`);
        const s2 = summarizeSales(res.json, now());
        cache[name] = { ts: now(), s: s2 };
        save();
        await sleep2(gapMs);
        return s2;
      });
      inflight.set(name, p);
      p.finally(() => inflight.delete(name)).catch(() => {
      });
      return p;
    }
    return { get, cached };
  }
  function sleep2(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // src/store/db.js
  var DB_NAME = "caser-tracker";
  var DB_VERSION = 1;
  var RAW_LIMIT = 300;
  var Store = class {
    /** @param {IDBFactory} idb */
    constructor(idb) {
      this.idb = idb;
      this.dbPromise = null;
    }
    open() {
      if (!this.dbPromise) {
        this.dbPromise = new Promise((resolve, reject) => {
          const req2 = this.idb.open(DB_NAME, DB_VERSION);
          req2.onupgradeneeded = () => {
            const db = req2.result;
            if (!db.objectStoreNames.contains("events")) {
              const s2 = db.createObjectStore("events", { keyPath: "id" });
              s2.createIndex("ts", "ts");
            }
            if (!db.objectStoreNames.contains("raw")) db.createObjectStore("raw", { autoIncrement: true });
            if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
          };
          req2.onsuccess = () => resolve(req2.result);
          req2.onerror = () => reject(req2.error);
        });
      }
      return this.dbPromise;
    }
    async tx(stores, mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result;
        Promise.resolve(fn(t)).then((r) => result = r, reject);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    }
    /**
     * Insert or merge events. Returns how many were new.
     * A stored event is only replaced when the incoming one is better:
     * a resolved upgrade replaces a pending one, and live data wins over imported data.
     */
    async putEvents(events) {
      if (!events.length) return 0;
      return this.tx(["events"], "readwrite", async (t) => {
        const s2 = t.objectStore("events");
        let added = 0;
        for (const ev of events) {
          const old = await req(s2.get(ev.id));
          if (!old) {
            s2.put(ev);
            added++;
          } else if (shouldReplace(old, ev)) {
            s2.put(mergeEvent(old, ev));
          }
        }
        return added;
      });
    }
    async allEvents() {
      const list = await this.tx(["events"], "readonly", (t) => req(t.objectStore("events").getAll()));
      return list.sort((a, b) => a.ts - b.ts);
    }
    /** Delete events by id. */
    async deleteEvents(ids) {
      if (!ids.length) return;
      await this.tx(["events"], "readwrite", (t) => {
        const s2 = t.objectStore("events");
        for (const id of ids) s2.delete(id);
      });
    }
    async clearEvents() {
      await this.tx(["events", "raw"], "readwrite", (t) => {
        t.objectStore("events").clear();
        t.objectStore("raw").clear();
      });
    }
    async addRaw(entry) {
      await this.tx(["raw"], "readwrite", async (t) => {
        const s2 = t.objectStore("raw");
        s2.add({ ...entry, savedAt: Date.now() });
        const count = await req(s2.count());
        if (count > RAW_LIMIT) {
          const keys = await req(s2.getAllKeys(null, count - RAW_LIMIT));
          for (const k of keys) s2.delete(k);
        }
      });
    }
    async allRaw() {
      return this.tx(["raw"], "readonly", (t) => req(t.objectStore("raw").getAll()));
    }
    async getMeta(key) {
      return this.tx(["meta"], "readonly", (t) => req(t.objectStore("meta").get(key)));
    }
    async setMeta(key, value) {
      await this.tx(["meta"], "readwrite", (t) => {
        t.objectStore("meta").put(value, key);
      });
    }
  };
  function shouldReplace(old, incoming) {
    if (old.kind === "upgrade" && old.status === "pending" && incoming.status !== "pending") return true;
    if (old.kind === "deposit" && incoming.kind === "deposit") {
      if (old.status !== "completed" && incoming.status === "completed") return true;
      if (old.completedTs == null && incoming.completedTs != null) return true;
    }
    if (old.source === "import" && incoming.source === "live") return true;
    if (old.userId == null && incoming.userId != null) return true;
    return false;
  }
  function mergeEvent(old, incoming) {
    const live = old.source === "live" ? old : incoming;
    return {
      ...old,
      ...incoming,
      ts: live.ts,
      source: live.source,
      userId: incoming.userId ?? old.userId ?? null,
      balanceBefore: live.balanceBefore ?? old.balanceBefore ?? incoming.balanceBefore,
      balanceAfter: live.balanceAfter ?? old.balanceAfter ?? incoming.balanceAfter
    };
  }
  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  // src/store/export.js
  function toJson(events) {
    return JSON.stringify({ app: "caser-stat-tracker", schema: SCHEMA_VERSION, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), events }, null, 2);
  }
  var CSV_COLUMNS = [
    ["id", (e) => e.id],
    ["kind", (e) => e.kind],
    ["time", (e) => new Date(e.ts).toISOString()],
    ["site", (e) => e.site],
    ["source", (e) => e.source],
    ["cost", (e) => e.kind === "case" ? e.casePrice : e.stake],
    ["returned", (e) => e.kind === "case" ? e.item.price : e.returned],
    ["net", (e) => e.kind === "case" ? e.item.price - e.casePrice : e.net],
    ["case", (e) => e.kind === "case" ? e.caseName : ""],
    ["drop", (e) => e.kind === "case" ? e.item.name : ""],
    ["free", (e) => e.kind === "case" ? e.free : ""],
    ["bet_items", (e) => e.kind === "upgrade" ? e.betItems.map((i) => i.name).join(" + ") : ""],
    ["added_balance", (e) => e.kind === "upgrade" ? e.addedBalance : ""],
    ["target", (e) => e.kind === "upgrade" ? e.target?.name ?? "" : ""],
    ["target_price", (e) => e.kind === "upgrade" ? e.target?.price ?? "" : ""],
    ["chance_shown", (e) => e.kind === "upgrade" ? e.chanceShown : ""],
    ["status", (e) => e.kind === "upgrade" || e.kind === "deposit" ? e.status : ""],
    ["mystery", (e) => e.kind === "upgrade" ? e.mystery : ""],
    ["game_mode", (e) => e.gameMode],
    ["balance_before", (e) => e.balanceBefore ?? ""],
    ["balance_after", (e) => e.balanceAfter ?? ""],
    // Money flow: deposit amount or withdrawn item value, and the withdrawn item.
    ["amount", (e) => e.kind === "deposit" ? e.amount : e.kind === "withdrawal" ? e.value : ""],
    ["item", (e) => e.kind === "withdrawal" ? e.item?.name ?? "" : ""]
  ];
  function toCsv(events) {
    const esc = (v) => {
      const s2 = String(v ?? "");
      return /[",\n;]/.test(s2) ? `"${s2.replace(/"/g, '""')}"` : s2;
    };
    const lines = [CSV_COLUMNS.map(([h2]) => h2).join(",")];
    for (const e of events) lines.push(CSV_COLUMNS.map(([, f]) => esc(f(e))).join(","));
    return lines.join("\n");
  }
  function fromJson(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("File is not valid JSON.");
    }
    const events = Array.isArray(data) ? data : data?.events;
    if (!Array.isArray(events)) throw new Error("File has no events list.");
    const valid = events.filter((e) => e && typeof e.id === "string" && ["case", "upgrade", "withdrawal", "deposit"].includes(e.kind) && Number.isFinite(e.ts));
    if (!valid.length && events.length) throw new Error("No valid events in file.");
    return valid;
  }

  // src/store/shared.js
  var DAY_PREFIX = "ev:d:";
  var REV_KEY = "ev:rev";
  var CLEARED_KEY = "ev:clearedAt";
  function dayKey(ts) {
    const d = new Date(Number.isFinite(ts) ? ts : 0);
    return DAY_PREFIX + (Number.isNaN(d.getTime()) ? "1970-01-01" : d.toISOString().slice(0, 10));
  }
  function createSharedStore(gm) {
    const readDay = (key) => {
      const v = gm.get(key, null);
      return Array.isArray(v) ? v : [];
    };
    const dayKeys = () => gm.list().filter((k) => k.startsWith(DAY_PREFIX));
    function bumpRev(days) {
      gm.set(REV_KEY, { at: Date.now(), days, nonce: Math.random().toString(36).slice(2) });
    }
    return {
      /** Every shared event, oldest first. */
      readAll() {
        const out = [];
        for (const k of dayKeys()) out.push(...readDay(k));
        return out.sort((a, b) => a.ts - b.ts);
      },
      /** Events of the given day keys (as sent in a rev change). */
      readDays(keys) {
        const out = [];
        for (const k of keys ?? []) if (typeof k === "string" && k.startsWith(DAY_PREFIX)) out.push(...readDay(k));
        return out;
      },
      /**
       * Merge events into the shared copy with the same rules as the local store.
       * Only days that actually change are written. Returns the changed day keys.
       */
      merge(events) {
        const byDay = /* @__PURE__ */ new Map();
        for (const ev of events) {
          if (!ev || typeof ev.id !== "string") continue;
          const k = dayKey(ev.ts);
          if (!byDay.has(k)) byDay.set(k, []);
          byDay.get(k).push(ev);
        }
        const changed = [];
        for (const [k, incoming] of byDay) {
          const list = readDay(k);
          const index = new Map(list.map((e, i) => [e.id, i]));
          let dirty = false;
          for (const ev of incoming) {
            const i = index.get(ev.id);
            if (i === void 0) {
              index.set(ev.id, list.length);
              list.push(ev);
              dirty = true;
            } else if (shouldReplace(list[i], ev)) {
              list[i] = mergeEvent(list[i], ev);
              dirty = true;
            }
          }
          if (dirty) {
            gm.set(k, list);
            changed.push(k);
          }
        }
        if (changed.length) bumpRev(changed);
        return changed;
      },
      /** Remove events by id from every day. */
      remove(ids) {
        const drop = new Set(ids);
        if (!drop.size) return;
        const changed = [];
        for (const k of dayKeys()) {
          const list = readDay(k);
          const kept = list.filter((e) => !drop.has(e.id));
          if (kept.length === list.length) continue;
          if (kept.length) gm.set(k, kept);
          else gm.del(k);
          changed.push(k);
        }
        if (changed.length) bumpRev(changed);
      },
      /** Delete every shared event and tell the other domains to drop theirs. Returns the clear time. */
      clear() {
        for (const k of dayKeys()) gm.del(k);
        const at = Date.now();
        gm.set(CLEARED_KEY, at);
        bumpRev([]);
        return at;
      },
      clearedAt() {
        const v = gm.get(CLEARED_KEY, null);
        return Number.isFinite(v) ? v : null;
      },
      /** Calls back with the changed events when another tab (any domain) writes. */
      onRemoteChange(cb) {
        gm.listen?.(REV_KEY, (value, remote) => {
          if (remote) cb(value);
        });
      }
    };
  }
  function gmStorage() {
    if (typeof GM_getValue !== "function" || typeof GM_setValue !== "function" || typeof GM_listValues !== "function") return null;
    return {
      get: (k, d) => GM_getValue(k, d),
      set: (k, v) => GM_setValue(k, v),
      del: (k) => typeof GM_deleteValue === "function" ? GM_deleteValue(k) : GM_setValue(k, null),
      list: () => GM_listValues(),
      listen: typeof GM_addValueChangeListener === "function" ? (k, cb) => GM_addValueChangeListener(k, (_name, _old, value, remote) => cb(value, remote)) : void 0
    };
  }

  // src/store/cloud-config.js
  var CLOUD_URL = "https://hafnhxumrqyaljmciqqq.supabase.co";
  var CLOUD_KEY = "sb_publishable_YufMC_UuweoYKj6PG-vAZA_9ZkYR6nD";

  // src/store/cloud.js
  var PUSH_BATCH = 500;
  var PULL_PAGE = 1e3;
  var PULL_OVERLAP_MS = 15e3;
  function eventRank(e) {
    let r = 0;
    if (e.source === "live") r += 1;
    if (e.kind === "upgrade" && e.status && e.status !== "pending") r += 2;
    if (e.kind === "deposit" && e.status === "completed") r += 2;
    if (e.kind === "deposit" && e.completedTs != null) r += 4;
    if (e.userId != null) r += 8;
    return r;
  }
  var KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
  function isSyncKey(k) {
    return typeof k === "string" && KEY_RE.test(k);
  }
  function newSyncKey() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
  }
  function createCloud({ request, getKey, url = CLOUD_URL, apiKey = CLOUD_KEY }) {
    async function call(method, path, body) {
      const key = getKey();
      if (!isSyncKey(key)) throw new Error("Cloud sync is off");
      const res = await request({
        method,
        url: url + path,
        headers: { apikey: apiKey, "x-sync-key": key, "content-type": "application/json", accept: "application/json" },
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
      if (res.status < 200 || res.status >= 300) {
        const msg = res.json && (res.json.message || res.json.error);
        throw new Error(`Cloud answered ${res.status}${msg ? `: ${msg}` : ""}`);
      }
      return res.json;
    }
    return {
      /** Send events; the database keeps whichever copy ranks higher. Returns rows changed. */
      async push(events, onProgress) {
        let changed = 0;
        for (let i = 0; i < events.length; i += PUSH_BATCH) {
          const rows = events.slice(i, i + PUSH_BATCH).map((e) => ({ id: e.id, rank: eventRank(e), data: e }));
          changed += Number(await call("POST", "/rest/v1/rpc/sync_push", { rows })) || 0;
          onProgress?.(Math.min(i + PUSH_BATCH, events.length), events.length);
        }
        return changed;
      },
      /**
       * Everything changed since the cursor ({at, id} or null for all), oldest change first.
       * Returns {events, deletedIds, cursor}; pass the cursor to the next pull.
       */
      async pull(cursor) {
        const events = [];
        const deletedIds = [];
        let at = cursor?.at ? new Date(Date.parse(cursor.at) - PULL_OVERLAP_MS).toISOString() : null;
        let id = "";
        let last = cursor ?? null;
        for (; ; ) {
          let filter = "";
          if (at) {
            const a = encodeURIComponent(at);
            filter = id ? `&or=(updated_at.gt.${a},and(updated_at.eq.${a},id.gt.${encodeURIComponent(JSON.stringify(id))}))` : `&updated_at=gte.${a}`;
          }
          const rows = await call("GET", `/rest/v1/sync_events?select=id,deleted,data,updated_at${filter}&order=updated_at.asc,id.asc&limit=${PULL_PAGE}`);
          if (!Array.isArray(rows)) throw new Error("Cloud answered with no rows list");
          for (const r of rows) {
            if (r.deleted) deletedIds.push(r.id);
            else if (r.data && typeof r.data.id === "string") events.push(r.data);
          }
          if (rows.length) {
            const tail = rows[rows.length - 1];
            at = tail.updated_at;
            id = tail.id;
            last = { at, id };
          }
          if (rows.length < PULL_PAGE) break;
        }
        return { events, deletedIds, cursor: last };
      },
      async remove(ids) {
        if (!ids.length) return 0;
        return Number(await call("POST", "/rest/v1/rpc/sync_delete", { ids })) || 0;
      },
      /** Deletes every event under this key. Returns the clear time (ms). */
      async clear() {
        return Date.parse(await call("POST", "/rest/v1/rpc/sync_clear", {}));
      },
      /**
       * Facts about the whole history under this key: when "clear all" last ran (ms or null) and
       * which site-history streams some browser has read to the end.
       */
      async account() {
        const rows = await call("GET", "/rest/v1/sync_accounts?select=cleared_at,history_complete");
        const row = Array.isArray(rows) && rows[0] ? rows[0] : {};
        const at = row.cleared_at ? Date.parse(row.cleared_at) : NaN;
        return {
          clearedAt: Number.isFinite(at) ? at : null,
          complete: Array.isArray(row.history_complete) ? row.history_complete.filter((s2) => typeof s2 === "string") : []
        };
      },
      /** Record that a site-history stream was read to the end. */
      async markComplete(stream) {
        return call("POST", "/rest/v1/rpc/sync_mark_complete", { stream });
      }
    };
  }

  // src/store/accounts.js
  function accountOf(e, legacy) {
    return e?.userId != null && e.userId !== "" ? String(e.userId) : legacy ?? null;
  }
  function pickLegacyOwner(events) {
    const counts = /* @__PURE__ */ new Map();
    for (const e of events) {
      if (e?.userId == null || e.userId === "") continue;
      const id = String(e.userId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [id, n] of counts) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    return best;
  }
  function filterByAccount(events, id, legacy) {
    if (id == null || id === "all") return events;
    return events.filter((e) => accountOf(e, legacy) === id);
  }
  function resolveSelection(selection, currentId, legacy) {
    if (selection === "all") return "all";
    if (selection && selection !== "current") return String(selection);
    return currentId ?? legacy ?? null;
  }
  function listAccounts(events, known, legacy, currentId) {
    const counts = /* @__PURE__ */ new Map();
    for (const e of events) {
      const id = accountOf(e, legacy);
      if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (currentId != null && !counts.has(currentId)) counts.set(currentId, 0);
    const list = [...counts].map(([id, n]) => ({
      id,
      name: accountName(id, known),
      events: n,
      current: id === currentId
    }));
    return list.sort((a, b) => b.current - a.current || b.events - a.events || a.id.localeCompare(b.id));
  }
  function accountName(id, known) {
    const name = known?.[id]?.name;
    return typeof name === "string" && name.trim() ? name.trim() : `Account ${id}`;
  }
  function streamFlag(stream, userId) {
    return `${stream}:${userId}`;
  }
  function flagComplete(flags, stream, userId, legacy) {
    if (!Array.isArray(flags) || userId == null) return false;
    return flags.includes(streamFlag(stream, userId)) || userId === legacy && flags.includes(stream);
  }
  function progressKey(stream, userId) {
    return `sync:${userId}:${stream}`;
  }
  function isStreamFlag(s2, streams) {
    if (typeof s2 !== "string") return false;
    const i = s2.indexOf(":");
    const stream = i < 0 ? s2 : s2.slice(0, i);
    return streams.includes(stream) && (i < 0 || /^[A-Za-z0-9_-]{1,64}$/.test(s2.slice(i + 1)));
  }

  // src/stats/index.js
  var stats_exports = {};
  __export(stats_exports, {
    OUTLOOK_CHANCE_EDGES: () => OUTLOOK_CHANCE_EDGES,
    OUTLOOK_WINDOWS: () => OUTLOOK_WINDOWS,
    calibration: () => calibration,
    calibrationCurve: () => calibrationCurve,
    caseOdds: () => caseOdds,
    caseRoi: () => caseRoi,
    chiSquareSf: () => chiSquareSf,
    edgeMap: () => edgeMap,
    fSf: () => fSf,
    factor: () => factor,
    holm: () => holm,
    moneyFlow: () => moneyFlow,
    mysteryStats: () => mysteryStats,
    normalCdf: () => normalCdf,
    outlookModel: () => outlookModel,
    rankCandidates: () => rankCandidates,
    sellValue: () => sellValue,
    sessions: () => sessions,
    summarize: () => summarize,
    superDropStats: () => superDropStats,
    upgradeByChance: () => upgradeByChance,
    upgradeByStake: () => upgradeByStake,
    upgradeOutlook: () => upgradeOutlook,
    upgradeQuote: () => upgradeQuote,
    wilson: () => wilson
  });

  // src/stats/math.js
  var LANCZOS = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9984369578019572e-21,
    15056327351493116e-23
  ];
  var EPS = 1e-15;
  var TINY = 1e-300;
  var MAX_ITER = 500;
  function lnGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
    const z = x - 1;
    let a = LANCZOS[0];
    for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function gammaSeries(a, x) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < MAX_ITER; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  function gammaContinuedFraction(a, x) {
    let b = x + 1 - a;
    let c = 1 / TINY;
    let d = 1 / b;
    let h2 = d;
    for (let i = 1; i < MAX_ITER; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < TINY) d = TINY;
      c = b + an / c;
      if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      const delta = d * c;
      h2 *= delta;
      if (Math.abs(delta - 1) < EPS) break;
    }
    return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h2;
  }
  function gammaQ(a, x) {
    if (!(x > 0)) return 1;
    if (!Number.isFinite(x)) return 0;
    return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
  }
  function chiSquareSf(x, df) {
    if (!(df > 0) || Number.isNaN(x)) return NaN;
    return gammaQ(df / 2, x / 2);
  }
  function betaContinuedFraction(a, b, x) {
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - qab * x / qap;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;
    let h2 = d;
    for (let m = 1; m < MAX_ITER; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c;
      if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      h2 *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c;
      if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      const delta = d * c;
      h2 *= delta;
      if (Math.abs(delta - 1) < EPS) break;
    }
    return h2;
  }
  function betaI(x, a, b) {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(a, b, x) / a;
    return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
  }
  function fSf(f, d1, d2) {
    if (!(d1 > 0) || !(d2 > 0) || Number.isNaN(f)) return NaN;
    if (f <= 0) return 1;
    if (!Number.isFinite(f)) return 0;
    return betaI(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
  }
  function normalCdf(x) {
    if (Number.isNaN(x)) return NaN;
    if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
    const tail = 0.5 * gammaQ(0.5, x * x / 2);
    return x < 0 ? tail : 1 - tail;
  }
  function normalTwoSidedP(z) {
    if (Number.isNaN(z)) return NaN;
    return gammaQ(0.5, z * z / 2);
  }
  function wilson(k, n, z = 1.96) {
    if (!(n > 0)) return [0, 1];
    const p = Math.min(Math.max(k / n, 0), 1);
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
    return [Math.max(0, center - half), Math.min(1, center + half)];
  }
  function holm(pValues, alpha = 0.05) {
    const out = pValues.map(() => false);
    const order = pValues.map((p, i) => ({ p, i })).filter((x) => Number.isFinite(x.p)).sort((a, b) => a.p - b.p);
    const m = order.length;
    for (let rank = 0; rank < m; rank++) {
      if (order[rank].p > alpha / (m - rank)) break;
      out[order[rank].i] = true;
    }
    return out;
  }
  function poissonBinomialZ(wins, sumP, sumVar) {
    if (!(sumVar > 1e-12)) return { z: null, p: null };
    const z = (wins - sumP) / Math.sqrt(sumVar);
    return { z, p: normalTwoSidedP(z) };
  }
  function binomialPmf(n, p) {
    const pmf = new Array(n + 1).fill(0);
    if (p <= 0) {
      pmf[0] = 1;
      return pmf;
    }
    if (p >= 1) {
      pmf[n] = 1;
      return pmf;
    }
    const lnFactN = lnGamma(n + 1);
    const lp = Math.log(p);
    const lq = Math.log(1 - p);
    for (let k = 0; k <= n; k++) {
      const logC = lnFactN - lnGamma(k + 1) - lnGamma(n - k + 1);
      pmf[k] = Math.exp(logC + k * lp + (n - k) * lq);
    }
    return pmf;
  }
  function pmfQuantile(pmf, q) {
    let cum = 0;
    for (let k = 0; k < pmf.length; k++) {
      cum += pmf[k];
      if (cum >= q - 1e-12) return k;
    }
    return pmf.length - 1;
  }
  function mean(xs) {
    return xs.length ? xs.reduce((s2, x) => s2 + x, 0) / xs.length : null;
  }
  function sampleSd(xs) {
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((s2, x) => s2 + (x - m) ** 2, 0) / (xs.length - 1));
  }
  function median2(xs) {
    if (!xs.length) return 0;
    const s2 = [...xs].sort((a, b) => a - b);
    const mid = s2.length >> 1;
    return s2.length % 2 ? s2[mid] : (s2[mid - 1] + s2[mid]) / 2;
  }
  function oneWayAnova(groups) {
    const gs = groups.filter((g) => g.length > 0);
    const k = gs.length;
    const total = gs.reduce((s2, g) => s2 + g.length, 0);
    if (k < 2 || total - k < 1) return { statistic: null, df: 0, dfWithin: 0, p: null };
    const grand = mean(gs.flat());
    let ssBetween = 0;
    let ssWithin = 0;
    for (const g of gs) {
      const m = mean(g);
      ssBetween += g.length * (m - grand) ** 2;
      ssWithin += g.reduce((s2, x) => s2 + (x - m) ** 2, 0);
    }
    const df = k - 1;
    const dfWithin = total - k;
    if (!(ssWithin > 0)) return { statistic: null, df, dfWithin, p: null };
    const statistic = ssBetween / df / (ssWithin / dfWithin);
    return { statistic, df, dfWithin, p: fSf(statistic, df, dfWithin) };
  }

  // src/stats/core.js
  var ALPHA = 0.05;
  var MIN_N = 10;
  var DEFAULT_CHANCE_EDGES = [0, 2, 5, 10, 20, 30, 50, 75, 100];
  var DEFAULT_STAKE_EDGES = [0, 100, 500, 1e3, 5e3, 2e4, Infinity];
  var DEFAULT_CURVE_EDGES = [0, 10, 15, 20, 30, 50, 75, 100];
  var Z95 = 1.96;
  function asList(events) {
    return Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
  }
  function caseEvents(events) {
    return asList(events).filter((e) => e.kind === "case");
  }
  function upgradeEvents(events) {
    return asList(events).filter((e) => e.kind === "upgrade" && e.status !== "pending");
  }
  function validEvents(events) {
    return asList(events).filter((e) => e.kind === "case" || e.kind === "upgrade" && e.status !== "pending");
  }
  function sortByTime(events) {
    return [...events].sort((a, b) => num(a.ts) - num(b.ts));
  }
  var costOf = (e) => e.kind === "case" ? num(e.casePrice) : num(e.stake);
  var returnedOf = (e) => e.kind === "case" ? num(e.item && e.item.price) : num(e.returned);
  var isWin = (e) => e.status === "won" || e.status == null && e.won === true;
  var chanceOf = (e) => Math.min(Math.max(num(e.chanceShown) / 100, 0), 1);
  var targetPriceOf = (e) => num(e.target && e.target.price);
  var isMystery = (e) => e.mystery === true;
  var superShown = (e) => !!(e.superDrop && e.superDrop.shown);
  var hasChance = (e) => typeof e.chanceShown === "number" && Number.isFinite(e.chanceShown);
  function isOdds(e, opts) {
    return !isMystery(e) && hasChance(e) && (!!(opts && opts.includeSuperDrop) || !superShown(e));
  }
  function oddsEvents(events, opts) {
    return upgradeEvents(events).filter((e) => isOdds(e, opts));
  }
  function baseMetrics(events) {
    let cost = 0;
    let returned = 0;
    const ratios = [];
    for (const e of events) {
      const c = costOf(e);
      const r = returnedOf(e);
      cost += c;
      returned += r;
      if (c > 0) ratios.push(r / c);
    }
    return {
      n: events.length,
      cost,
      returned,
      net: returned - cost,
      roi: cost > 0 ? (returned - cost) / cost : null,
      roiCI: cost > 0 ? ratioInterval(ratios) : null
    };
  }
  function ratioInterval(ratios) {
    if (ratios.length < 2) return null;
    const half = Z95 * sampleSd(ratios) / Math.sqrt(ratios.length);
    const m = mean(ratios);
    return [m - half - 1, m + half - 1];
  }
  function winMetrics(ups) {
    const n = ups.length;
    let wins = 0;
    let sumP = 0;
    let sumVar = 0;
    for (const e of ups) {
      const p2 = chanceOf(e);
      if (isWin(e)) wins++;
      sumP += p2;
      sumVar += p2 * (1 - p2);
    }
    const { z, p } = poissonBinomialZ(wins, sumP, sumVar);
    return {
      wins,
      winRate: n ? wins / n : null,
      winRateCI: n ? wilson(wins, n) : null,
      expectedRate: n ? sumP / n : null,
      z,
      p,
      significant: false
    };
  }
  function winFields(ups, opts) {
    const odds = ups.filter((e) => isOdds(e, opts));
    return { ...winMetrics(odds), oddsN: odds.length };
  }
  function adjustedWinFields(odds, expectedOf) {
    let wins = 0;
    let sumP = 0;
    let sumVar = 0;
    for (const e of odds) {
      const p2 = Math.min(Math.max(expectedOf(e), 0), 1);
      if (isWin(e)) wins++;
      sumP += p2;
      sumVar += p2 * (1 - p2);
    }
    const { z, p } = poissonBinomialZ(wins, sumP, sumVar);
    return { expectedRateAdj: odds.length ? sumP / odds.length : null, zAdj: z, pAdj: p, significantAdj: false };
  }
  function upgradeMetrics(ups, opts) {
    return { ...baseMetrics(ups), ...winFields(ups, opts) };
  }
  function markSignificant(rows, alpha = ALPHA, pKey = "p", flagKey = "significant") {
    const eligible = rows.filter((r) => (r.oddsN ?? r.n) >= MIN_N && Number.isFinite(r[pKey]));
    const flags = holm(eligible.map((r) => r[pKey]), alpha);
    rows.forEach((r) => {
      if (flagKey in r) r[flagKey] = false;
    });
    eligible.forEach((r, i) => {
      r[flagKey] = flags[i];
    });
    return rows;
  }
  function bucketIndex(x, edges) {
    const last = edges.length - 1;
    if (!(x >= edges[0]) || x > edges[last]) return -1;
    for (let i = 0; i < last; i++) {
      if (x < edges[i + 1]) return i;
    }
    return last - 1;
  }
  function edgeText(v) {
    return Number.isFinite(v) ? String(v) : "\u221E";
  }
  function makeBuckets(edges, suffix = "") {
    const out = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const lo = edges[i];
      const hi = edges[i + 1];
      const label = Number.isFinite(hi) ? `${edgeText(lo)}-${edgeText(hi)}${suffix}` : `${edgeText(lo)}+${suffix}`;
      out.push({ label, lo, hi });
    }
    return out;
  }
  function groupByBucket(items, edges, valueOf) {
    const groups = makeBuckets(edges).map(() => []);
    for (const item of items) {
      const i = bucketIndex(valueOf(item), edges);
      if (i >= 0) groups[i].push(item);
    }
    return groups;
  }

  // src/stats/tables.js
  function summarize(events) {
    const all = sortByTime(validEvents(events));
    return {
      cases: baseMetrics(caseEvents(events)),
      upgrades: upgradeMetrics(upgradeEvents(events)),
      total: baseMetrics(all),
      firstTs: all.length ? num(all[0].ts) : null,
      lastTs: all.length ? num(all[all.length - 1].ts) : null
    };
  }
  function bestDrop(evs) {
    let best = null;
    for (const e of evs) {
      if (e.item && (best === null || num(e.item.price) > num(best.price))) best = e.item;
    }
    return best;
  }
  function caseRoi(events) {
    const groups = /* @__PURE__ */ new Map();
    for (const e of sortByTime(caseEvents(events))) {
      if (!groups.has(e.caseSlug)) groups.set(e.caseSlug, []);
      groups.get(e.caseSlug).push(e);
    }
    const rows = [];
    for (const [caseSlug, evs] of groups) {
      const latest = evs[evs.length - 1];
      const prices2 = evs.map((e) => num(e.item && e.item.price));
      rows.push({
        ...baseMetrics(evs),
        caseSlug,
        caseName: latest.caseName,
        casePrice: num(latest.casePrice),
        best: bestDrop(evs),
        median: median2(prices2),
        hitRate: evs.filter((e) => num(e.item && e.item.price) >= num(e.casePrice)).length / evs.length
      });
    }
    return rows.sort((a, b) => b.n - a.n);
  }
  function bucketTable(events, edges, valueOf, suffix, opts) {
    const ups = oddsEvents(events, opts);
    const groups = groupByBucket(ups, edges, valueOf);
    const rows = makeBuckets(edges, suffix).map((b, i) => ({ label: b.label, lo: b.lo, hi: b.hi, ...upgradeMetrics(groups[i], opts) }));
    return markSignificant(rows);
  }
  function upgradeByChance(events, edges = DEFAULT_CHANCE_EDGES, opts = {}) {
    return bucketTable(events, edges, (e) => num(e.chanceShown), "%", opts);
  }
  function upgradeByStake(events, edges = DEFAULT_STAKE_EDGES, opts = {}) {
    return bucketTable(events, edges, (e) => num(e.stake), "", opts);
  }

  // src/stats/calibration.js
  var MIN_N_FOR_EDGE = 30;
  var LONG_RUN_TRIES = 100;
  function calibration(events, opts = {}) {
    const ups = oddsEvents(events, opts);
    const w = winMetrics(ups);
    const base = baseMetrics(ups);
    let verdict = "consistent";
    if (w.p !== null && w.p < ALPHA) verdict = w.z < 0 ? "below" : "above";
    return {
      n: ups.length,
      wins: w.wins,
      expectedWins: ups.reduce((s2, e) => s2 + chanceOf(e), 0),
      winRate: w.winRate,
      expectedRate: w.expectedRate,
      z: w.z,
      p: w.p,
      verdict,
      impliedRtp: base.cost > 0 ? base.returned / base.cost : null
    };
  }
  function shownRtpOf(ups) {
    const vals = ups.filter((e) => targetPriceOf(e) > 0 && num(e.stake) > 0).map((e) => chanceOf(e) * targetPriceOf(e) / num(e.stake));
    return mean(vals);
  }
  function edgeMap(events, edges = DEFAULT_CHANCE_EDGES, opts = {}) {
    const ups = oddsEvents(events, opts);
    const rows = [];
    const groups = groupByBucket(ups, edges, (e) => num(e.chanceShown));
    for (const [i, b] of makeBuckets(edges, "%").entries()) {
      const inBucket = groups[i];
      for (const mode of ["normal"]) {
        const evs = inBucket;
        if (!evs.length) continue;
        const m = baseMetrics(evs);
        rows.push({
          label: b.label,
          lo: b.lo,
          hi: b.hi,
          n: m.n,
          shownRtp: shownRtpOf(evs),
          realRtp: m.cost > 0 ? m.returned / m.cost : null,
          realRtpCI: m.roiCI ? [m.roiCI[0] + 1, m.roiCI[1] + 1] : null,
          mode
        });
      }
    }
    return rows;
  }
  function longRun(stake, targetPrice, chance) {
    const empty = { tries: LONG_RUN_TRIES, mean: null, p05: null, p95: null, probProfit: null };
    if (!(stake > 0) || !(targetPrice > 0)) return empty;
    const pmf = binomialPmf(LONG_RUN_TRIES, Math.min(Math.max(chance / 100, 0), 1));
    const net = (k) => k * targetPrice - LONG_RUN_TRIES * stake;
    const tol = 1e-9 * Math.max(1, LONG_RUN_TRIES * stake);
    let probProfit = 0;
    pmf.forEach((pk, k) => {
      if (net(k) > tol) probProfit += pk;
    });
    const meanNet = pmf.reduce((s2, pk, k) => s2 + pk * net(k), 0);
    return {
      tries: LONG_RUN_TRIES,
      mean: meanNet,
      p05: net(pmfQuantile(pmf, 0.05)),
      p95: net(pmfQuantile(pmf, 0.95)),
      probProfit: Math.min(probProfit, 1)
    };
  }
  function upgradeQuote(sel, events, opts = {}) {
    const stake = num(sel && sel.stake);
    const targetPrice = num(sel && sel.targetPrice);
    const given = sel && sel.chanceShown != null ? num(sel.chanceShown) : null;
    const chanceShown = given !== null ? given : shownChance(stake, targetPrice);
    const ev = chanceShown / 100 * targetPrice - stake;
    const ups = oddsEvents(events, opts);
    const chanceBucket = bucketIndex(chanceShown, DEFAULT_CHANCE_EDGES);
    const sameChance = chanceBucket < 0 ? [] : ups.filter((e) => bucketIndex(num(e.chanceShown), DEFAULT_CHANCE_EDGES) === chanceBucket);
    const stakeBucket = bucketIndex(stake, DEFAULT_STAKE_EDGES);
    const similar = stakeBucket < 0 ? [] : sameChance.filter((e) => bucketIndex(num(e.stake), DEFAULT_STAKE_EDGES) === stakeBucket);
    const edgeBase = baseMetrics(sameChance);
    const wins = similar.filter(isWin).length;
    const realEdge = sameChance.length >= MIN_N_FOR_EDGE && edgeBase.cost > 0 ? edgeBase.returned / edgeBase.cost - 1 : null;
    const longRunChance = realEdge !== null && targetPrice > 0 ? (1 + realEdge) * (stake / targetPrice) * 100 : chanceShown;
    return {
      chanceShown,
      chanceFair: stake > 0 && targetPrice > 0 ? stake / targetPrice * 100 : 0,
      multiplier: stake > 0 ? targetPrice / stake : 0,
      ev,
      evPct: stake > 0 ? ev / stake : null,
      realEdge,
      similar: {
        n: similar.length,
        wins,
        winRate: similar.length ? wins / similar.length : null,
        winRateCI: similar.length ? wilson(wins, similar.length) : null
      },
      longRun: { ...longRun(stake, targetPrice, longRunChance), basis: realEdge !== null ? "history" : "shown" }
    };
  }
  function calibrationCurve(events, edges = DEFAULT_CURVE_EDGES, opts = {}) {
    const groups = groupByBucket(oddsEvents(events, opts), edges, (e) => num(e.chanceShown));
    const rows = makeBuckets(edges, "%").map((b, i) => {
      const evs = groups[i];
      const m = baseMetrics(evs);
      const w = winMetrics(evs);
      return {
        label: b.label,
        lo: b.lo,
        hi: b.hi,
        n: evs.length,
        wins: w.wins,
        expectedRate: w.expectedRate,
        winRate: w.winRate,
        winRateCI: w.winRateCI,
        z: w.z,
        p: w.p,
        significant: false,
        realRtp: m.cost > 0 ? m.returned / m.cost : null
      };
    });
    return markSignificant(rows);
  }
  var MIN_CURVE_N = 30;
  function curveLookup(curve, edges = DEFAULT_CURVE_EDGES) {
    return (e) => {
      const i = bucketIndex(num(e.chanceShown), edges);
      const row = i >= 0 ? curve[i] : null;
      return row && row.n >= MIN_CURVE_N && row.winRate !== null ? row.winRate : chanceOf(e);
    };
  }

  // src/stats/sessions.js
  function sessionize(sorted, gapMinutes = 30) {
    const gapMs = gapMinutes * 6e4;
    const out = [];
    let prevTs = null;
    for (const e of sorted) {
      const ts = num(e.ts);
      if (prevTs === null || ts - prevTs > gapMs) out.push([]);
      out[out.length - 1].push(e);
      prevTs = ts;
    }
    return out;
  }
  function sessions(events, gapMinutes = 30) {
    return sessionize(sortByTime(validEvents(events)), gapMinutes).map((evs) => {
      let cost = 0;
      let returned = 0;
      const kinds = { case: 0, upgrade: 0 };
      for (const e of evs) {
        cost += costOf(e);
        returned += returnedOf(e);
        kinds[e.kind]++;
      }
      return { start: num(evs[0].ts), end: num(evs[evs.length - 1].ts), n: evs.length, cost, returned, net: returned - cost, kinds };
    });
  }

  // src/stats/factor.js
  var HOUR_MS = 36e5;
  var MIN_MS = 6e4;
  var pad2 = (n) => String(n).padStart(2, "0");
  var range = (n) => Array.from({ length: n }, (_, i) => i);
  var cat = (value, label = String(value)) => ({ value, label });
  var hourOf = (e) => new Date(num(e.ts)).getHours();
  var WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MULTIPLIER_EDGES = [0, 2, 5, 10, Infinity];
  var MULTIPLIER_LABELS = ["x<2", "x2-5", "x5-10", "x10+"];
  function bucketFactor(edgesOf, labelsOf, valueOf, scope = "both") {
    return {
      scope,
      cats: (opts) => labelsOf(edgesOf(opts)).map((l) => cat(l)),
      assign: (e, ctx2, opts) => {
        const v = valueOf(e);
        if (v === null || v === void 0 || Number.isNaN(v)) return void 0;
        const edges = edgesOf(opts);
        const i = bucketIndex(v, edges);
        return i < 0 ? void 0 : labelsOf(edges)[i];
      }
    };
  }
  var FACTORS = {
    hour: { scope: "both", cats: () => range(24).map((h2) => cat(h2, `${pad2(h2)}:00`)), assign: hourOf },
    weekday: {
      scope: "both",
      cats: () => WEEKDAYS.map((d, i) => cat(i, d)),
      assign: (e) => (new Date(num(e.ts)).getDay() + 6) % 7
    },
    daypart: {
      scope: "both",
      cats: () => [cat("night", "Night 00-06"), cat("morning", "Morning 06-12"), cat("afternoon", "Afternoon 12-18"), cat("evening", "Evening 18-24")],
      assign: (e) => {
        const h2 = hourOf(e);
        return h2 < 6 ? "night" : h2 < 12 ? "morning" : h2 < 18 ? "afternoon" : "evening";
      }
    },
    sessionPosition: {
      scope: "both",
      needs: "session",
      cats: () => [cat("1st-5th"), cat("6th-20th"), cat("21st+")],
      assign: (e, ctx2) => {
        const p = ctx2.session.get(e).position;
        return p <= 5 ? "1st-5th" : p <= 20 ? "6th-20th" : "21st+";
      }
    },
    sessionMinute: {
      scope: "both",
      needs: "session",
      cats: () => [cat("0-15 min"), cat("15-60 min"), cat("60+ min")],
      assign: (e, ctx2) => {
        const m = ctx2.session.get(e).minutes;
        return m < 15 ? "0-15 min" : m < 60 ? "15-60 min" : "60+ min";
      }
    },
    afterLossStreak: {
      scope: "upgrade",
      needs: "streak",
      cats: () => [cat(0), cat(1), cat(2), cat("3-4"), cat("5+")],
      assign: (e, ctx2) => {
        const s2 = ctx2.streak.get(e).streak;
        return s2 <= 2 ? s2 : s2 <= 4 ? "3-4" : "5+";
      }
    },
    afterWin: {
      scope: "upgrade",
      needs: "streak",
      cats: () => [cat("won", "Previous won"), cat("lost", "Previous lost"), cat("none", "First upgrade")],
      assign: (e, ctx2) => ctx2.streak.get(e).prev
    },
    mode: {
      scope: "upgrade",
      pool: "anyUpgrade",
      cats: () => [cat("normal"), cat("mystery")],
      assign: (e) => e.mystery ? "mystery" : "normal"
    },
    gameMode: { scope: "both", cats: () => null, assign: (e) => String(e.gameMode ?? "unknown") },
    site: { scope: "both", cats: () => null, assign: (e) => String(e.site ?? "unknown") },
    free: {
      scope: "case",
      cats: () => [cat("paid"), cat("free")],
      assign: (e) => e.free ? "free" : "paid"
    },
    itemCount: {
      scope: "upgrade",
      cats: () => [1, 2, 3, 4, 5, 6].map((n) => cat(n, n === 6 ? "6+" : String(n))),
      assign: (e) => Math.min(6, Math.max(1, Array.isArray(e.betItems) ? e.betItems.length : 1))
    },
    addedBalance: {
      scope: "upgrade",
      cats: () => [cat("none"), cat("some")],
      assign: (e) => num(e.addedBalance) > 0 ? "some" : "none"
    },
    balanceBand: bucketFactor(
      (opts) => opts.edges ?? DEFAULT_STAKE_EDGES,
      (edges) => makeBuckets(edges).map((b) => b.label),
      (e) => e.balanceBefore === null || e.balanceBefore === void 0 ? null : num(e.balanceBefore)
    ),
    sinceDeposit: {
      scope: "both",
      needs: "deposit",
      cats: () => ["0-5m", "5-15m", "15-60m", "1-6h", "6h+", "no deposit yet"].map((l) => cat(l)),
      assign: (e, ctx2) => {
        const t = ctx2.sinceDeposit.get(e);
        if (t === null) return "no deposit yet";
        return t < 5 * MIN_MS ? "0-5m" : t < 15 * MIN_MS ? "5-15m" : t < HOUR_MS ? "15-60m" : t < 6 * HOUR_MS ? "1-6h" : "6h+";
      }
    },
    afterDepositOrder: {
      scope: "upgrade",
      needs: "deposit",
      cats: () => ["1st", "2nd-5th", "6th-20th", "21st+"].map((l) => cat(l)),
      assign: (e, ctx2) => {
        const k = ctx2.depositOrder.get(e);
        if (!k) return void 0;
        return k === 1 ? "1st" : k <= 5 ? "2nd-5th" : k <= 20 ? "6th-20th" : "21st+";
      }
    },
    sinceWithdrawal: {
      scope: "both",
      needs: "withdrawal",
      cats: () => ["<1h", "1-24h", "24h+ / none"].map((l) => cat(l)),
      assign: (e, ctx2) => {
        const t = ctx2.sinceWithdrawal.get(e);
        return t !== null && t < HOUR_MS ? "<1h" : t !== null && t < 24 * HOUR_MS ? "1-24h" : "24h+ / none";
      }
    },
    superDrop: {
      scope: "upgrade",
      pool: "super",
      cats: () => [cat("shown"), cat("not shown")],
      assign: (e) => superShown(e) ? "shown" : "not shown"
    },
    multiplier: bucketFactor(
      () => MULTIPLIER_EDGES,
      () => MULTIPLIER_LABELS,
      (e) => targetPriceOf(e) > 0 && num(e.stake) > 0 ? targetPriceOf(e) / num(e.stake) : null,
      "upgrade"
    )
  };
  function ageSince(sorted, times) {
    const out = /* @__PURE__ */ new Map();
    let i = 0;
    for (const e of sorted) {
      const ts = num(e.ts);
      while (i < times.length && times[i] <= ts) i++;
      out.set(e, i > 0 ? ts - times[i - 1] : null);
    }
    return out;
  }
  var timesOf = (events, pred) => events.filter(pred).map((e) => num(e.ts)).sort((a, b) => a - b);
  function buildContext(sorted, needs, gapMinutes, events) {
    const ctx2 = {};
    if (needs === "session") {
      ctx2.session = /* @__PURE__ */ new Map();
      for (const s2 of sessionize(sorted, gapMinutes)) {
        const t0 = num(s2[0].ts);
        s2.forEach((e, i) => ctx2.session.set(e, { position: i + 1, minutes: (num(e.ts) - t0) / 6e4 }));
      }
    }
    if (needs === "streak") {
      ctx2.streak = /* @__PURE__ */ new Map();
      let streak = 0;
      let prev = "none";
      for (const e of sortByTime(upgradeEvents(events))) {
        ctx2.streak.set(e, { streak, prev });
        if (isWin(e)) {
          streak = 0;
          prev = "won";
        } else {
          streak++;
          prev = "lost";
        }
      }
    }
    if (needs === "deposit") {
      const deposits = timesOf(events, (e) => e && e.kind === "deposit" && e.status === "completed");
      ctx2.sinceDeposit = ageSince(sorted, deposits);
      ctx2.depositOrder = /* @__PURE__ */ new Map();
      let i = 0;
      let count = 0;
      let seen = false;
      for (const e of sortByTime(upgradeEvents(events))) {
        const ts = num(e.ts);
        while (i < deposits.length && deposits[i] <= ts) {
          i++;
          count = 0;
          seen = true;
        }
        count++;
        ctx2.depositOrder.set(e, seen ? count : 0);
      }
    }
    if (needs === "withdrawal") {
      ctx2.sinceWithdrawal = ageSince(sorted, timesOf(events, (e) => e && e.kind === "withdrawal"));
    }
    return ctx2;
  }
  var rowOptsOf = (def, opts) => def.pool === "super" ? { includeSuperDrop: true } : opts;
  function selectEvents(events, def, opts) {
    const scope = def.scope;
    if (scope !== "both" && opts.kind && opts.kind !== scope) return { mode: scope, evs: [] };
    const mode = scope === "both" ? opts.kind ?? "both" : scope;
    const cases = mode === "upgrade" ? [] : caseEvents(events);
    let ups = [];
    if (mode !== "case") {
      ups = upgradeEvents(events);
      if (def.pool === "anyUpgrade") ups = ups.filter((e) => opts.includeSuperDrop || !superShown(e));
      else ups = ups.filter((e) => isOdds(e, rowOptsOf(def, opts)));
    }
    return { mode, evs: [...cases, ...ups] };
  }
  function rowMetrics(evs, mode, rowOpts, expectedOf) {
    if (mode === "case") return baseMetrics(evs);
    const ups = mode === "upgrade" ? evs : evs.filter((e) => e.kind === "upgrade");
    const adj = adjustedWinFields(ups.filter((e) => isOdds(e, rowOpts)), expectedOf);
    if (mode === "upgrade") return { ...upgradeMetrics(evs, rowOpts), ...adj };
    const up = upgradeMetrics(ups, rowOpts);
    return {
      ...baseMetrics(evs),
      wins: up.wins,
      winRate: up.winRate,
      winRateCI: up.winRateCI,
      expectedRate: up.expectedRate,
      z: up.z,
      p: up.p,
      significant: false,
      oddsN: up.oddsN,
      upgradeN: ups.length,
      ...adj
    };
  }
  function dynamicCats(groups) {
    return [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || String(a).localeCompare(String(b))).map((v) => cat(v));
  }
  var noTest = (method) => ({ method, statistic: null, df: 0, p: null, significant: false });
  function chiSquare(rows, expectedOf) {
    let statistic = 0;
    let used = 0;
    for (const r of rows) {
      const n = r.oddsN;
      if (!n) continue;
      const expWins = expectedOf(r);
      const expLosses = n - expWins;
      if (!(expWins >= 1) || !(expLosses >= 1)) continue;
      used++;
      statistic += (r.wins - expWins) ** 2 / expWins + (n - r.wins - expLosses) ** 2 / expLosses;
    }
    if (used === 0) return { statistic: null, df: 0, p: null };
    const df = used - 1;
    return { statistic, df, p: df >= 1 ? chiSquareSf(statistic, df) : null };
  }
  function chiSquareTest(rows) {
    const shown = chiSquare(rows, (r) => r.expectedRate * r.oddsN);
    const adj = chiSquare(rows, (r) => r.expectedRateAdj * r.oddsN);
    return {
      method: "chi-square",
      statistic: shown.statistic,
      df: shown.df,
      p: shown.p,
      significant: shown.p !== null && shown.p < ALPHA,
      statisticAdj: adj.statistic,
      dfAdj: adj.df,
      pAdj: adj.p,
      significantAdj: adj.p !== null && adj.p < ALPHA
    };
  }
  function anovaTest(groupEvents) {
    const ratios = groupEvents.map((evs) => evs.filter((e) => costOf(e) > 0).map((e) => returnedOf(e) / costOf(e)));
    const r = oneWayAnova(ratios);
    return { ...noTest("anova"), ...r, significant: r.p !== null && r.p < ALPHA };
  }
  function factor(events, key, opts = {}) {
    const def = Object.hasOwn(FACTORS, key) ? FACTORS[key] : null;
    if (!def) throw new Error(`Unknown factor: ${key}`);
    const all = Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
    const { mode, evs } = selectEvents(all, def, opts);
    const sorted = sortByTime(evs);
    const ctx2 = buildContext(sorted, def.needs, opts.gapMinutes ?? 30, all);
    const groups = /* @__PURE__ */ new Map();
    for (const e of sorted) {
      const v = def.assign(e, ctx2, opts);
      if (v === void 0) continue;
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(e);
    }
    const rowOpts = rowOptsOf(def, opts);
    const curve = calibrationCurve(all, void 0, { includeSuperDrop: !!opts.includeSuperDrop });
    const expectedOf = curveLookup(curve);
    const cats = def.cats(opts) ?? dynamicCats(groups);
    const rows = cats.map((c) => ({ value: c.value, label: c.label, ...rowMetrics(groups.get(c.value) ?? [], mode, rowOpts, expectedOf) }));
    const tested = mode !== "case" && rows.some((r) => r.oddsN > 0);
    if (tested) {
      markSignificant(rows);
      markSignificant(rows, ALPHA, "pAdj", "significantAdj");
    }
    const test = tested ? chiSquareTest(rows) : anovaTest(cats.map((c) => groups.get(c.value) ?? []));
    return { key, rows, test };
  }

  // src/stats/outlook.js
  var OUTLOOK_CHANCE_EDGES = [0, 15, 30, 50, 75, 100];
  var OUTLOOK_WINDOWS = [
    { key: "hot", label: "0-5 min after deposit", lo: 0, hi: 5 },
    { key: "warm", label: "5-15 min after deposit", lo: 5, hi: 15 },
    { key: "cold", label: "15+ min after deposit", lo: 15, hi: Infinity }
  ];
  var PRIOR = 20;
  var MIN_BAND_N = 30;
  var LIKELY = 0.8;
  function bandOf(chance) {
    const e = OUTLOOK_CHANCE_EDGES;
    if (!(chance >= 0)) return -1;
    for (let i = 0; i < e.length - 1; i++) if (chance < e[i + 1]) return i;
    return chance <= e[e.length - 1] ? e.length - 2 : -1;
  }
  function windowOf(minutes) {
    if (minutes === null) return 2;
    for (let i = 0; i < OUTLOOK_WINDOWS.length; i++) if (minutes < OUTLOOK_WINDOWS[i].hi) return i;
    return OUTLOOK_WINDOWS.length - 1;
  }
  var bandLabel = (i) => `${OUTLOOK_CHANCE_EDGES[i]}-${OUTLOOK_CHANCE_EDGES[i + 1]}%`;
  function outlookModel(events) {
    const list = Array.isArray(events) ? events.filter(Boolean) : [];
    const deposits = list.filter((e) => e.kind === "deposit" && e.status === "completed").map((e) => num(e.completedTs) || num(e.ts)).filter((t) => t > 0).sort((a, b) => a - b);
    const cells = OUTLOOK_CHANCE_EDGES.slice(0, -1).map(() => OUTLOOK_WINDOWS.map(() => ({ n: 0, wins: 0, expected: 0, variance: 0 })));
    let di = 0;
    for (const e of sortByTime(oddsEvents(list))) {
      const ts = num(e.ts);
      while (di < deposits.length && deposits[di] <= ts) di++;
      const b = bandOf(num(e.chanceShown));
      if (b < 0) continue;
      const w = windowOf(di > 0 ? (ts - deposits[di - 1]) / 6e4 : null);
      const c = cells[b][w];
      c.n++;
      const pe = chanceOf(e);
      c.expected += pe;
      c.variance += pe * (1 - pe);
      if (isWin(e)) c.wins++;
    }
    const flows = [];
    for (const e of list) {
      if (e.kind === "upgrade" && e.status !== "pending") flows.push({ ts: num(e.ts), upgrade: true, net: num(e.returned) - num(e.stake) });
      else if (e.kind === "case") flows.push({ ts: num(e.ts), upgrade: false, net: num(e.item && e.item.price) - num(e.casePrice) });
    }
    flows.sort((a, b) => a.ts - b.ts);
    return { deposits, cells, flows };
  }
  function upgradeOutlook(sel, events, opts = {}) {
    const stake = num(sel && sel.stake);
    const targetPrice = num(sel && sel.targetPrice);
    if (!(stake > 0) || !(targetPrice > 0)) return null;
    const given = sel && sel.chanceShown != null ? num(sel.chanceShown) : null;
    const chanceShown = given !== null && given > 0 ? given : shownChance(stake, targetPrice);
    const p = Math.min(Math.max(chanceShown / 100, 0), 1);
    const band = bandOf(chanceShown);
    if (band < 0 || !(p > 0)) return null;
    const now = opts.now != null ? num(opts.now) : Date.now();
    const model = opts.model || outlookModel(events);
    const { deposits, cells, flows } = model;
    let last = null;
    for (let i = deposits.length - 1; i >= 0; i--) if (deposits[i] <= now) {
      last = deposits[i];
      break;
    }
    const minutesSinceDeposit = last === null ? null : (now - last) / 6e4;
    let upgradesSinceDeposit = null;
    let netSinceDeposit = null;
    if (last !== null) {
      upgradesSinceDeposit = 0;
      netSinceDeposit = 0;
      let lo = 0;
      let hi = flows.length;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if (flows[mid].ts < last) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < flows.length && flows[i].ts <= now; i++) {
        if (flows[i].upgrade) upgradesSinceDeposit++;
        netSinceDeposit += flows[i].net;
      }
    }
    const bandSum = cells[band].reduce((s2, c) => ({ n: s2.n + c.n, wins: s2.wins + c.wins, expected: s2.expected + c.expected, variance: s2.variance + c.variance }), { n: 0, wins: 0, expected: 0, variance: 0 });
    const bandRatio = (bandSum.wins + PRIOR) / (bandSum.expected + PRIOR);
    const posterior = (c) => {
      const f = c.variance > 0 ? c.expected / c.variance : 1 / (1 - p);
      return { a: (c.wins + PRIOR * bandRatio) * f, b: (c.expected + PRIOR) * f };
    };
    const win = windowOf(minutesSinceDeposit);
    const cell = cells[band][win];
    const { a, b } = posterior(cell);
    const ratio = a / b;
    const realChance = Math.min(1, p * ratio);
    const ev = realChance * targetPrice - stake;
    const breakEvenRatio = stake / (p * targetPrice);
    const known = bandSum.n >= MIN_BAND_N;
    const probProfitable = known ? gammaQ(a, b * breakEvenRatio) : null;
    let verdict = "unknown";
    if (probProfitable !== null) verdict = probProfitable >= LIKELY ? "likely-profit" : probProfitable <= 1 - LIKELY ? "likely-loss" : "unclear";
    const mult = stake > 0 ? targetPrice / stake : 0;
    const b2 = mult - 1;
    const kellyFull = known && b2 > 0 ? Math.max(0, Math.min(1, realChance - (1 - realChance) / b2)) : 0;
    const kelly = known ? { full: kellyFull, half: kellyFull / 2 } : null;
    return {
      chanceShown,
      band: bandLabel(band),
      window: { key: OUTLOOK_WINDOWS[win].key, label: OUTLOOK_WINDOWS[win].label },
      context: { minutesSinceDeposit, upgradesSinceDeposit, netSinceDeposit },
      ratio,
      realChance,
      ev,
      evPct: ev / stake,
      breakEvenRatio,
      probProfitable,
      verdict,
      kelly,
      cell: { ...cell },
      bandStats: bandSum,
      windows: OUTLOOK_WINDOWS.map((w, i) => {
        const c = cells[band][i];
        const q = posterior(c);
        return { key: w.key, label: w.label, n: c.n, ratio: c.n ? q.a / q.b : null, realChance: Math.min(1, p * (q.a / q.b)) };
      })
    };
  }

  // src/stats/superdrop.js
  function part(evs) {
    const w = winMetrics(evs);
    const m = baseMetrics(evs);
    return {
      n: evs.length,
      wins: w.wins,
      winRate: w.winRate,
      expectedRate: w.expectedRate,
      z: w.z,
      p: w.p,
      rtp: m.cost > 0 ? m.returned / m.cost : null
    };
  }
  function superDropStats(events) {
    const ups = upgradeEvents(events).filter((e) => isOdds(e, { includeSuperDrop: true }));
    const shown = ups.filter(superShown);
    const notShown = ups.filter((e) => !superShown(e));
    const mults = shown.filter((e) => e.superDrop.won === true && targetPriceOf(e) > 0).map((e) => returnedOf(e) / targetPriceOf(e));
    return {
      n: ups.length,
      shownN: shown.length,
      shownRate: ups.length ? shown.length / ups.length : null,
      shown: part(shown),
      notShown: part(notShown),
      hits: {
        n: mults.length,
        avgMultiplier: mean(mults),
        minMultiplier: mults.length ? Math.min(...mults) : null,
        maxMultiplier: mults.length ? Math.max(...mults) : null
      }
    };
  }

  // src/stats/mystery.js
  var DEFAULT_MYSTERY_STAKE_EDGES = [0, 100, 500, 1e3, 3e3, Infinity];
  var MULTIPLIER_BINS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, Infinity];
  function multiplierOf(e) {
    if (e.mysteryMultiplier !== null && e.mysteryMultiplier !== void 0 && Number.isFinite(num(e.mysteryMultiplier))) {
      return num(e.mysteryMultiplier);
    }
    return num(e.stake) > 0 ? returnedOf(e) / num(e.stake) : null;
  }
  var multipliersOf = (evs) => evs.map(multiplierOf).filter((m) => m !== null);
  function hitFields(mults) {
    const hits = mults.filter((m) => m >= 1).length;
    return {
      hitRate: mults.length ? hits / mults.length : null,
      hitRateCI: mults.length ? wilson(hits, mults.length) : null,
      meanMultiplier: mean(mults),
      medianMultiplier: mults.length ? median2(mults) : null
    };
  }
  function mysteryStats(events, stakeEdges = DEFAULT_MYSTERY_STAKE_EDGES) {
    const mys = upgradeEvents(events).filter(isMystery);
    const mults = multipliersOf(mys);
    const binned = groupByBucket(mults, MULTIPLIER_BINS, (m) => m);
    const histogram = makeBuckets(MULTIPLIER_BINS).map((b, i) => ({
      label: `x${b.label}`,
      lo: b.lo,
      hi: b.hi,
      n: binned[i].length
    }));
    const groups = groupByBucket(mys, stakeEdges, (e) => num(e.stake));
    const byStake = makeBuckets(stakeEdges).map((b, i) => {
      const h2 = hitFields(multipliersOf(groups[i]));
      return { label: b.label, lo: b.lo, hi: b.hi, ...baseMetrics(groups[i]), hitRate: h2.hitRate, meanMultiplier: h2.meanMultiplier };
    });
    const a = oneWayAnova(groups.map(multipliersOf));
    return {
      ...baseMetrics(mys),
      ...hitFields(mults),
      histogram,
      byStake,
      test: { method: "anova", statistic: a.statistic, df: a.df, dfWithin: a.dfWithin, p: a.p }
    };
  }

  // src/stats/money.js
  var DAY_MS = 864e5;
  var pad22 = (n) => String(n).padStart(2, "0");
  var dayKey2 = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad22(d.getMonth() + 1)}-${pad22(d.getDate())}`;
  };
  function moneyFlow(events, { balance = null, inventoryValue = null } = {}) {
    const list = Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
    const deposits = list.filter((e) => e.kind === "deposit");
    const done = deposits.filter((e) => e.status === "completed");
    const failed = deposits.filter((e) => e.status !== "completed");
    const withdrawals = list.filter((e) => e.kind === "withdrawal");
    const valueOf = (w) => num(w.value ?? (w.item && w.item.price));
    const sum = done.reduce((s2, e) => s2 + num(e.amount), 0);
    const doneTs = done.map((e) => num(e.ts));
    const firstTs = doneTs.length ? Math.min(...doneTs) : null;
    const lastTs = doneTs.length ? Math.max(...doneTs) : null;
    const withdrawn = withdrawals.reduce((s2, w) => s2 + valueOf(w), 0);
    const known = balance !== null && balance !== void 0 || inventoryValue !== null && inventoryValue !== void 0;
    const holdings2 = known ? num(balance) + num(inventoryValue) : null;
    const moves = [
      ...done.map((e) => ({ ts: num(e.ts), kind: "deposit", amount: num(e.amount) })),
      ...withdrawals.map((w) => ({ ts: num(w.ts), kind: "withdrawal", amount: valueOf(w) }))
    ].sort((a, b) => a.ts - b.ts);
    let cumulativeNet = 0;
    const series = moves.map((m) => {
      cumulativeNet += m.kind === "deposit" ? -m.amount : m.amount;
      return { ...m, cumulativeNet };
    });
    const days = /* @__PURE__ */ new Map();
    for (const m of moves) {
      const key = dayKey2(m.ts);
      const row = days.get(key) ?? { day: key, deposited: 0, withdrawn: 0 };
      if (m.kind === "deposit") row.deposited += m.amount;
      else row.withdrawn += m.amount;
      days.set(key, row);
    }
    return {
      deposits: {
        n: done.length,
        sum,
        failedN: failed.length,
        failedSum: failed.reduce((s2, e) => s2 + num(e.amount), 0),
        firstTs,
        lastTs,
        perDay: done.length ? sum / Math.max(1, (lastTs - firstTs) / DAY_MS) : null
      },
      withdrawals: { n: withdrawals.length, value: withdrawn, exactTimeN: withdrawals.filter((w) => w.exactTime === true).length },
      holdings: holdings2,
      net: withdrawn + (holdings2 ?? 0) - sum,
      series,
      daily: [...days.values()].sort((a, b) => a.day < b.day ? -1 : 1)
    };
  }

  // src/stats/caseodds.js
  function caseOdds(info) {
    const items = Array.isArray(info?.items) ? info.items : [];
    const casePrice = Number(info?.price) > 0 ? Number(info.price) : 0;
    const sorted = items.map((i) => ({ ...i, mult: casePrice > 0 ? i.price / casePrice : null })).sort((a, b) => b.price - a.price || String(a.name).localeCompare(String(b.name)));
    const withChance = sorted.filter((i) => typeof i.chance === "number" && Number.isFinite(i.chance));
    const chanceSum = withChance.length ? withChance.reduce((s2, i) => s2 + i.chance, 0) : null;
    const hasChances = sorted.length > 0 && withChance.length === sorted.length && Math.abs(chanceSum - 100) < 0.5;
    const ev = hasChances ? sorted.reduce((s2, i) => s2 + i.price * (i.chance / chanceSum), 0) : null;
    const pick = (i) => i ? { name: i.name, price: i.price } : null;
    return {
      n: sorted.length,
      casePrice,
      min: pick(sorted[sorted.length - 1]),
      max: pick(sorted[0]),
      hasChances,
      chanceSum,
      ev,
      evRatio: ev !== null && casePrice > 0 ? ev / casePrice : null,
      items: sorted
    };
  }

  // src/stats/exchange.js
  function sellValue(m, basis = "typical") {
    if (!m) return null;
    const v = basis === "fast" ? m.quickNet : m.net;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  function rankCandidates(candidates, lookup, opts = {}) {
    const minSales = opts.minSales ?? 3;
    const sort = opts.sort ?? "value";
    const basis = opts.basis === "fast" ? "fast" : "typical";
    const cur = typeof opts.currentValue === "number" && Number.isFinite(opts.currentValue) ? opts.currentValue : null;
    const rows = (Array.isArray(candidates) ? candidates : []).map((c) => {
      const l = lookup(c.name) || {};
      const market = l.summary ?? null;
      const sell = sellValue(market, basis);
      return {
        ...c,
        market,
        error: l.error ?? null,
        sell,
        liquid: !!market && sell !== null && market.sales30d >= minSales,
        delta: sell !== null && cur !== null ? sell - cur : null,
        // USD received per 1000 site coins: how much real money the site price buys.
        perK: sell !== null && c.price > 0 ? sell / c.price * 1e3 : null
      };
    });
    const v = (r) => r.sell ?? -Infinity;
    const sales = (r) => r.market?.sales30d ?? -1;
    rows.sort((a, b) => {
      if (a.liquid !== b.liquid) return a.liquid ? -1 : 1;
      const d = sort === "sales" ? sales(b) - sales(a) || v(b) - v(a) : v(b) - v(a) || sales(b) - sales(a);
      return d || b.price - a.price;
    });
    return rows;
  }

  // src/ui/dom.js
  var SVG_NS = "http://www.w3.org/2000/svg";
  var PROPS = /* @__PURE__ */ new Set(["value", "checked", "disabled", "selected", "hidden", "tabIndex"]);
  function apply(el, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === void 0 || v === null || v === false) continue;
      if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
      else if (k === "text") el.textContent = String(v);
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === void 0 || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    apply(el, attrs);
    append(el, children);
    return el;
  }
  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    apply(el, attrs);
    append(el, children);
    return el;
  }
  function createHost(id, zIndex = 2147483e3) {
    const old = document.getElementById(id);
    if (old) old.remove();
    const host = document.createElement("caser-tracker-root");
    host.id = id;
    host.setAttribute("style", "position:fixed;top:0;left:0;width:0;height:0;z-index:" + zIndex + ";display:block;");
    const root = host.attachShadow({ mode: "open" });
    attach(host);
    return { host, root };
  }
  function attach(host) {
    const parent = document.documentElement || document.body;
    if (parent && !host.isConnected) parent.appendChild(host);
  }
  var store = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
      }
    }
  };
  function debounce(fn, ms) {
    let t = null;
    const d = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn(...args);
      }, ms);
    };
    d.cancel = () => clearTimeout(t);
    return d;
  }
  function safe(fn) {
    try {
      return { value: fn(), error: null };
    } catch (error) {
      console.warn("[caser-tracker] stats call failed", error);
      return { value: null, error };
    }
  }

  // src/ui/styles.js
  var BASE_CSS = `
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
  var DASHBOARD_CSS = `
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
  var CASE_PANEL_CSS = `
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
  var OVERLAY_CSS = `
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
  var EXCHANGE_CSS = `
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

  // src/ui/format.js
  var THIN = "\u2009";
  var NBSP = "\xA0";
  var MINUS = "\u2212";
  var DASH = "\u2013";
  var ok2 = (v) => typeof v === "number" && Number.isFinite(v);
  function group(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  }
  function fmtNumber(v, decimals = 2, opts = {}) {
    if (!ok2(v)) return DASH;
    const fixed = Math.abs(v).toFixed(decimals);
    const [i, f] = fixed.split(".");
    const body = group(i) + (f ? "." + f : "");
    const zero = Number(fixed) === 0;
    if (v < 0 && !zero) return MINUS + body;
    if (opts.sign && !zero) return "+" + body;
    return body;
  }
  function fmtInt(v) {
    return fmtNumber(v, 0);
  }
  function fmtMoney(v, currency = "", opts = {}) {
    const n = fmtNumber(v, 2, opts);
    if (n === DASH || !currency) return n;
    return n + NBSP + currency;
  }
  function fmtPct(fraction, decimals = 1, opts = {}) {
    if (!ok2(fraction)) return DASH;
    return fmtNumber(fraction * 100, decimals, opts) + "%";
  }
  function fmtChance(pct, decimals = 2) {
    if (!ok2(pct)) return DASH;
    return fmtNumber(pct, decimals) + "%";
  }
  function fmtCI(ci, decimals = 1) {
    if (!Array.isArray(ci) || !ok2(ci[0]) || !ok2(ci[1])) return "";
    return `${fmtNumber(ci[0] * 100, decimals)} ${DASH} ${fmtNumber(ci[1] * 100, decimals)}%`;
  }
  function fmtMult(v) {
    return ok2(v) ? "x" + fmtNumber(v, 2) : DASH;
  }
  function fmtPEq(p) {
    if (!ok2(p)) return "p = " + DASH;
    return p < 1e-3 ? "p < 0.001" : "p = " + p.toFixed(3);
  }
  function fmtZ(z) {
    return ok2(z) ? fmtNumber(z, 2) : DASH;
  }
  function signClass(v) {
    if (!ok2(v) || Math.abs(v) < 1e-9) return "";
    return v > 0 ? "pos" : "neg";
  }
  var pad = (n) => String(n).padStart(2, "0");
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(ts) {
    if (!ok2(ts)) return DASH;
    const d = new Date(ts);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  function fmtDateShort(ts) {
    if (!ok2(ts)) return DASH;
    const d = new Date(ts);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  function fmtTime(ts) {
    if (!ok2(ts)) return DASH;
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDateTime(ts) {
    if (!ok2(ts)) return DASH;
    return `${fmtDateShort(ts)} ${fmtTime(ts)}`;
  }
  function fmtDuration(ms) {
    if (!ok2(ms) || ms < 0) return DASH;
    const min = Math.round(ms / 6e4);
    if (min < 1) return "<" + NBSP + "1 min";
    if (min < 60) return `${min} min`;
    const hours = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  function fmtAgo(ts, now = Date.now()) {
    if (!ok2(ts)) return "never";
    const sec = Math.max(0, Math.round((now - ts) / 1e3));
    if (sec < 60) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hours = Math.round(min / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  // src/ui/charts.js
  var COLORS = {
    line: "#7ea6f6",
    grid: "#22272e",
    zero: "#3a414b",
    pos: "#45c486",
    neg: "#ef6b6b",
    whisker: "#c3c8cf",
    marker: "#e6e8eb",
    band: "#181c22",
    diag: "#6b7480",
    deposit: "#ef6b6b",
    withdrawal: "#45c486",
    fast: "#d8a650"
  };
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  function niceTicks(min, max, count = 4) {
    if (min === max) {
      const d = Math.abs(min) || 1;
      min -= d;
      max += d;
    }
    const step = niceStep((max - min) / count);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return { lo, hi, ticks };
  }
  function compact(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return fmtNumber(v / 1e6, a >= 1e7 ? 0 : 1) + "M";
    if (a >= 1e4) return fmtNumber(v / 1e3, 0) + "k";
    if (a >= 1e3) return fmtNumber(v / 1e3, 1) + "k";
    if (a === 0) return "0";
    return fmtNumber(v, a >= 100 ? 0 : a >= 10 ? 1 : 2);
  }
  function lineChart({ points, width, height = 170, currency = "" }) {
    const W = Math.max(200, Math.floor(width));
    const H = height;
    const padL = 44;
    const padR = 10;
    const padT = 8;
    const padB = 22;
    const iw = W - padL - padR;
    const ih = H - padT - padB;
    let pts = points;
    if (pts.length > iw) {
      const stride = pts.length / iw;
      const out = [];
      for (let i = 0; i < iw; i++) out.push(pts[Math.floor(i * stride)]);
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    const all = [0, ...pts.map((p) => p.v)];
    const { lo, hi, ticks } = niceTicks(Math.min(...all), Math.max(...all), 4);
    const n = pts.length;
    const x = (i) => padL + (n <= 1 ? iw / 2 : i / (n - 1) * iw);
    const y = (v) => padT + ih - (v - lo) / (hi - lo || 1) * ih;
    const readout = h("div", { class: "readout", "aria-live": "off" });
    const last = pts[n - 1];
    const setIdle = () => {
      readout.replaceChildren(
        "Now ",
        h("span", { class: ["num", signClass(last.v)], text: fmtMoney(last.v, currency, { sign: true }) }),
        h("span", { class: "faint", text: `  after ${fmtNumber(points.length, 0)} events` })
      );
    };
    const svg = s("svg", {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": `Cumulative net over ${points.length} events, now ${fmtMoney(last.v, currency, { sign: true })}`
    });
    for (const t of ticks) {
      const yy = Math.round(y(t)) + 0.5;
      svg.append(
        s("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: t === 0 ? COLORS.zero : COLORS.grid, "stroke-width": 1 }),
        s("text", { x: padL - 6, y: yy + 3.5, "text-anchor": "end", text: compact(t) })
      );
    }
    svg.append(
      s("text", { x: padL, y: H - 6, "text-anchor": "start", text: fmtDateShort(pts[0].ts) }),
      s("text", { x: W - padR, y: H - 6, "text-anchor": "end", text: fmtDateShort(last.ts) })
    );
    let d = "";
    pts.forEach((p, i) => {
      d += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
    });
    svg.append(
      s("path", { d, fill: "none", stroke: COLORS.line, "stroke-width": 1.75, "stroke-linejoin": "round", "stroke-linecap": "round" }),
      s("circle", { cx: x(n - 1), cy: y(last.v), r: 3, fill: last.v >= 0 ? COLORS.pos : COLORS.neg })
    );
    const guide = s("line", { y1: padT, y2: padT + ih, stroke: COLORS.zero, "stroke-width": 1, visibility: "hidden" });
    const dot = s("circle", { r: 3.5, fill: COLORS.marker, visibility: "hidden" });
    const hit = s("rect", { x: padL, y: padT, width: iw, height: ih, fill: "transparent" });
    svg.append(guide, dot, hit);
    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = (clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(n - 1, Math.round((px - padL) / iw * (n - 1))));
      const p = pts[i];
      const xx = x(i);
      guide.setAttribute("x1", xx);
      guide.setAttribute("x2", xx);
      dot.setAttribute("cx", xx);
      dot.setAttribute("cy", y(p.v));
      guide.setAttribute("visibility", "visible");
      dot.setAttribute("visibility", "visible");
      readout.replaceChildren(
        h("span", { class: "num", text: fmtDateTime(p.ts) }),
        "  ",
        h("span", { class: ["num", signClass(p.v)], text: fmtMoney(p.v, currency, { sign: true }) })
      );
    };
    const hide = () => {
      guide.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
      setIdle();
    };
    hit.addEventListener("pointermove", (e) => show(e.clientX));
    hit.addEventListener("pointerdown", (e) => show(e.clientX));
    hit.addEventListener("pointerleave", hide);
    setIdle();
    return h("div", { class: "chart" }, readout, svg);
  }
  function diffBars({
    rows,
    width,
    clamp = [-1, 2],
    caption,
    fmt = (v) => fmtPct(v, 0, { sign: true }),
    minSpan = 0.1,
    band = null
  }) {
    const W = Math.max(200, Math.floor(width));
    const rowH = 26;
    const labelW = Math.min(118, Math.round(W * 0.28));
    const valueW = 58;
    const padT = 18;
    const x0 = labelW + 8;
    const x1 = W - valueW;
    const H = padT + rows.length * rowH + 4;
    const ok6 = (v) => typeof v === "number" && Number.isFinite(v);
    const vals = [0];
    if (band) vals.push(band[0], band[1]);
    for (const r of rows) for (const v of [r.value, r.lo, r.hi]) if (ok6(v)) vals.push(v);
    let lo = Math.max(clamp[0], Math.min(...vals));
    let hi = Math.min(clamp[1], Math.max(...vals));
    if (hi - lo < minSpan) {
      lo -= minSpan / 2;
      hi += minSpan / 2;
    }
    const edgeLo = lo;
    const edgeHi = hi;
    const pad3 = (hi - lo) * 0.04;
    lo -= pad3;
    hi += pad3;
    const x = (v) => x0 + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (x1 - x0);
    const svg = s("svg", {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": caption || "Bar chart"
    });
    const zx = Math.round(x(0)) + 0.5;
    if (band) {
      svg.append(s("rect", { x: x(band[0]), y: padT - 2, width: Math.max(0, x(band[1]) - x(band[0])), height: H - padT, fill: COLORS.band }));
    }
    svg.append(s("text", { x: zx, y: 11, "text-anchor": "middle", text: "0" }));
    if (x(0) - x(edgeLo) > 40) svg.append(s("text", { x: x(edgeLo), y: 11, "text-anchor": "middle", text: fmt(edgeLo) }));
    if (x(edgeHi) - x(0) > 40) svg.append(s("text", { x: x(edgeHi), y: 11, "text-anchor": "middle", text: fmt(edgeHi) }));
    rows.forEach((r, i) => {
      const cy = padT + i * rowH + rowH / 2;
      const label = String(r.label ?? "");
      svg.append(
        s("text", { class: "lbl", x: 0, y: cy + 4, "text-anchor": "start", text: label.length > 16 ? label.slice(0, 15) + "\u2026" : label })
      );
      if (!ok6(r.value) || !r.n) {
        svg.append(s("text", { x: x1 + valueW, y: cy + 4, "text-anchor": "end", text: "no data" }));
        return;
      }
      const bx = x(Math.min(0, r.value));
      const bw = Math.max(1, Math.abs(x(r.value) - x(0)));
      svg.append(
        s("rect", {
          x: bx,
          y: cy - 6,
          width: bw,
          height: 12,
          rx: 2,
          fill: r.value >= 0 ? COLORS.pos : COLORS.neg,
          "fill-opacity": r.significant ? 0.95 : 0.45
        })
      );
      if (ok6(r.lo) && ok6(r.hi)) {
        const wl = x(r.lo);
        const wh = x(r.hi);
        svg.append(
          s("line", { x1: wl, x2: wh, y1: cy, y2: cy, stroke: COLORS.whisker, "stroke-width": 1 }),
          s("line", { x1: wl, x2: wl, y1: cy - 4, y2: cy + 4, stroke: COLORS.whisker, "stroke-width": 1 }),
          s("line", { x1: wh, x2: wh, y1: cy - 4, y2: cy + 4, stroke: COLORS.whisker, "stroke-width": 1 })
        );
      }
      svg.append(s("text", { x: W, y: cy + 4, "text-anchor": "end", text: fmt(r.value) }));
    });
    svg.insertBefore(s("line", { x1: zx, x2: zx, y1: padT - 2, y2: H - 2, stroke: COLORS.zero, "stroke-width": 1 }), band ? svg.childNodes[1] : svg.firstChild);
    return h("div", { class: "chart" }, svg);
  }
  function hoverLayer(svg, { x0, y0, w, h: hh, onMove, onLeave }) {
    const hit = s("rect", { x: x0, y: y0, width: w, height: hh, fill: "transparent" });
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) / (r.width || 1) * Number(svg.getAttribute("width"));
      const py = (e.clientY - r.top) / (r.height || 1) * Number(svg.getAttribute("height"));
      onMove(px, py);
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", onLeave);
    svg.append(hit);
  }
  var okNum = (v) => typeof v === "number" && Number.isFinite(v);
  function calibrationChart({ rows, width }) {
    const pts = rows.filter((r) => r && r.n > 0 && okNum(r.winRate) && okNum(r.expectedRate));
    const W = Math.max(200, Math.floor(width));
    const H = Math.round(Math.min(340, Math.max(220, W * 0.66)));
    const padL = 42;
    const padR = 14;
    const padT = 10;
    const padB = 34;
    const iw = W - padL - padR;
    const ih = H - padT - padB;
    let top = 0.1;
    for (const r of pts) {
      top = Math.max(top, r.expectedRate, r.winRate, okNum(r.hi) ? r.hi / 100 : 0);
      if (Array.isArray(r.winRateCI) && okNum(r.winRateCI[1])) top = Math.max(top, r.winRateCI[1]);
    }
    const step = top > 0.5 ? 0.25 : top > 0.2 ? 0.1 : 0.05;
    const D = Math.min(1, Math.ceil(top / step - 1e-9) * step);
    const x = (v) => padL + Math.max(0, Math.min(D, v)) / D * iw;
    const y = (v) => padT + ih - Math.max(0, Math.min(D, v)) / D * ih;
    const svg = s("svg", {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": "Real win rate against shown chance per bucket. Points above the dashed diagonal win more often than shown."
    });
    for (let i = 0; i * step <= D + 1e-9; i++) {
      const t = i * step;
      const yy = Math.round(y(t)) + 0.5;
      const xx = Math.round(x(t)) + 0.5;
      svg.append(
        s("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: COLORS.grid, "stroke-width": 1 }),
        s("line", { x1: xx, x2: xx, y1: padT, y2: padT + ih, stroke: COLORS.grid, "stroke-width": 1 }),
        s("text", { x: padL - 6, y: yy + 3.5, "text-anchor": "end", text: fmtPct(t, 0) }),
        s("text", { x: xx, y: padT + ih + 14, "text-anchor": i === 0 ? "start" : t >= D - 1e-9 ? "end" : "middle", text: fmtPct(t, 0) })
      );
    }
    svg.append(
      s("text", { x: padL + iw / 2, y: H - 3, "text-anchor": "middle", text: "Shown chance" }),
      s("text", { x: 10, y: padT + ih / 2, "text-anchor": "middle", transform: `rotate(-90 10 ${padT + ih / 2})`, text: "Real win rate" }),
      s("line", { x1: x(0), y1: y(0), x2: x(D), y2: y(D), stroke: COLORS.diag, "stroke-width": 1.25, "stroke-dasharray": "5 4" })
    );
    const marks = pts.map((r) => {
      const color = r.winRate >= r.expectedRate ? COLORS.pos : COLORS.neg;
      const cx = x(r.expectedRate);
      const ci = Array.isArray(r.winRateCI) ? r.winRateCI : [];
      if (okNum(ci[0]) && okNum(ci[1])) {
        svg.append(
          s("line", { x1: cx, x2: cx, y1: y(ci[0]), y2: y(ci[1]), stroke: COLORS.whisker, "stroke-width": 1 }),
          s("line", { x1: cx - 4, x2: cx + 4, y1: y(ci[0]), y2: y(ci[0]), stroke: COLORS.whisker, "stroke-width": 1 }),
          s("line", { x1: cx - 4, x2: cx + 4, y1: y(ci[1]), y2: y(ci[1]), stroke: COLORS.whisker, "stroke-width": 1 })
        );
      }
      svg.append(s("circle", { cx, cy: y(r.winRate), r: 4.5, fill: r.significant ? color : "#0f1114", stroke: color, "stroke-width": 1.75 }));
      return { r, cx };
    });
    const readout = h("div", { class: "readout" });
    const idle = () => readout.replaceChildren(h("span", { class: "faint", text: "Hover or tap a dot for details." }));
    idle();
    const ring = s("circle", { r: 8, fill: "none", stroke: COLORS.marker, "stroke-width": 1, visibility: "hidden" });
    svg.append(ring);
    if (marks.length) {
      hoverLayer(svg, {
        x0: padL,
        y0: padT,
        w: iw,
        h: ih,
        onMove: (px) => {
          let best = marks[0];
          for (const m of marks) if (Math.abs(m.cx - px) < Math.abs(best.cx - px)) best = m;
          const r = best.r;
          ring.setAttribute("cx", best.cx);
          ring.setAttribute("cy", y(r.winRate));
          ring.setAttribute("visibility", "visible");
          readout.replaceChildren(
            h("span", { class: "num", text: `${r.label ?? ""}: shown ${fmtPct(r.expectedRate, 1)}, real ` }),
            h("span", { class: ["num", r.winRate >= r.expectedRate ? "pos" : "neg"], text: fmtPct(r.winRate, 1) }),
            h("span", { class: "num faint", text: `  n = ${fmtNumber(r.n, 0)}` })
          );
        },
        onLeave: () => {
          ring.setAttribute("visibility", "hidden");
          idle();
        }
      });
    }
    const legend = h(
      "div",
      { class: "legend" },
      h("span", null, h("i", { class: "sw dash", "aria-hidden": "true" }), "Shown odds"),
      h("span", null, h("i", { class: "sw", style: { background: COLORS.pos }, "aria-hidden": "true" }), "Beyond noise"),
      h("span", null, h("i", { class: "sw hollow", "aria-hidden": "true" }), "Within noise")
    );
    return h("div", { class: "chart" }, readout, svg, legend);
  }
  function histogramChart({ bins, width }) {
    const W = Math.max(200, Math.floor(width));
    const H = 170;
    const padT = 18;
    const padB = 22;
    const ih = H - padT - padB;
    const total = bins.reduce((a, b) => a + (b.n || 0), 0) || 1;
    const maxN = Math.max(1, ...bins.map((b) => b.n || 0));
    const gap = 4;
    const bw = (W - gap * (bins.length - 1)) / Math.max(1, bins.length);
    const svg = s("svg", {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": "Histogram of mystery multipliers. " + bins.map((b) => `${b.label}: ${b.n}`).join(", ")
    });
    svg.append(s("line", { x1: 0, x2: W, y1: padT + ih + 0.5, y2: padT + ih + 0.5, stroke: COLORS.zero, "stroke-width": 1 }));
    const tick = (v) => okNum(v) ? fmtNumber(v, v % 1 ? 2 : 0).replace(/^0\./, ".") : "";
    bins.forEach((b, i) => {
      const bx = i * (bw + gap);
      const bh = (b.n || 0) / maxN * ih;
      const win = okNum(b.lo) && b.lo >= 1;
      svg.append(
        s("rect", { x: bx, y: padT + ih - bh, width: bw, height: Math.max(0, bh), rx: 2, fill: win ? COLORS.pos : COLORS.neg, "fill-opacity": 0.8 }),
        s("text", { x: bx + bw / 2, y: padT + ih - bh - 5, "text-anchor": "middle", text: b.n ? fmtPct(b.n / total, 0) : "" }),
        s("text", { x: bx + bw / 2, y: H - 6, "text-anchor": "middle", text: okNum(b.hi) ? `x${tick(b.lo)}` : `x${tick(b.lo)}+` })
      );
    });
    return h("div", { class: "chart" }, svg);
  }
  function moneyChart({ series, width, currency = "" }) {
    const W = Math.max(200, Math.floor(width));
    const H = 180;
    const padL = 44;
    const padR = 10;
    const padT = 8;
    const padB = 22;
    const iw = W - padL - padR;
    const ih = H - padT - padB;
    const pts = series.filter((p) => p && okNum(p.ts) && okNum(p.cumulativeNet));
    const t0 = pts[0].ts;
    const t1 = Math.max(pts[pts.length - 1].ts, t0 + 1);
    const vals = pts.map((p) => p.cumulativeNet);
    const { lo, hi, ticks } = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
    const x = (t) => padL + (t - t0) / (t1 - t0) * iw;
    const y = (v) => padT + ih - (v - lo) / (hi - lo || 1) * ih;
    const last = pts[pts.length - 1];
    const svg = s("svg", {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": `Withdrawn minus deposited over time, now ${fmtMoney(last.cumulativeNet, currency, { sign: true })}`
    });
    for (const t of ticks) {
      const yy = Math.round(y(t)) + 0.5;
      svg.append(
        s("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: t === 0 ? COLORS.zero : COLORS.grid, "stroke-width": 1 }),
        s("text", { x: padL - 6, y: yy + 3.5, "text-anchor": "end", text: compact(t) })
      );
    }
    svg.append(
      s("text", { x: padL, y: H - 6, "text-anchor": "start", text: fmtDateShort(t0) }),
      s("text", { x: W - padR, y: H - 6, "text-anchor": "end", text: fmtDateShort(last.ts) })
    );
    let d = `M${x(t0).toFixed(1)},${y(0).toFixed(1)}`;
    for (const p of pts) d += `H${x(p.ts).toFixed(1)}V${y(p.cumulativeNet).toFixed(1)}`;
    svg.append(s("path", { d, fill: "none", stroke: COLORS.line, "stroke-width": 1.5, "stroke-linejoin": "round" }));
    const r = pts.length > 300 ? 1.75 : 2.75;
    for (const p of pts) svg.append(s("circle", { cx: x(p.ts), cy: y(p.cumulativeNet), r, fill: p.kind === "withdrawal" ? COLORS.withdrawal : COLORS.deposit }));
    const readout = h("div", { class: "readout" });
    const idle = () => readout.replaceChildren(
      "Withdrawn minus deposited: ",
      h("span", { class: ["num", signClass(last.cumulativeNet)], text: fmtMoney(last.cumulativeNet, currency, { sign: true }) })
    );
    idle();
    const ring = s("circle", { r: 6, fill: "none", stroke: COLORS.marker, "stroke-width": 1, visibility: "hidden" });
    svg.append(ring);
    hoverLayer(svg, {
      x0: padL,
      y0: padT,
      w: iw,
      h: ih,
      onMove: (px) => {
        let best = pts[0];
        for (const p of pts) if (Math.abs(x(p.ts) - px) < Math.abs(x(best.ts) - px)) best = p;
        ring.setAttribute("cx", x(best.ts));
        ring.setAttribute("cy", y(best.cumulativeNet));
        ring.setAttribute("visibility", "visible");
        const wd = best.kind === "withdrawal";
        readout.replaceChildren(
          h("span", { class: "num", text: `${fmtDateTime(best.ts)}  ` }),
          h("span", { class: wd ? "pos" : "neg", text: wd ? "Withdrawal " : "Deposit " }),
          h("span", { class: "num", text: fmtMoney(best.amount, currency) }),
          h("span", { class: "faint", text: "  running " }),
          h("span", { class: ["num", signClass(best.cumulativeNet)], text: fmtMoney(best.cumulativeNet, currency, { sign: true }) })
        );
      },
      onLeave: () => {
        ring.setAttribute("visibility", "hidden");
        idle();
      }
    });
    const legend = h(
      "div",
      { class: "legend" },
      h("span", null, h("i", { class: "sw", style: { background: COLORS.deposit } }), "Deposit"),
      h("span", null, h("i", { class: "sw", style: { background: COLORS.withdrawal } }), "Withdrawal")
    );
    return h("div", { class: "chart" }, readout, svg, legend);
  }
  function salesSparkline({ points, typical = null, width = 64, height = 22 }) {
    let pts = (points || []).filter((p) => okNum(p.ts) && okNum(p.price)).sort((a, b) => a.ts - b.ts);
    const ref = okNum(typical) ? typical : [...pts].sort((a, b) => a.price - b.price)[pts.length >> 1]?.price;
    pts = pts.filter((p) => p.price >= ref * 0.5 && p.price <= ref * 1.5);
    if (pts.length < 2) return null;
    const W = width;
    const H = height;
    const pad3 = 2;
    const clip = (v) => Math.max(ref * 0.5, Math.min(ref * 1.5, v));
    const vs = pts.map((p) => clip(p.price));
    if (okNum(typical)) vs.push(typical);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const t0 = pts[0].ts;
    const t1 = pts[pts.length - 1].ts;
    const x = (t) => pad3 + (t1 === t0 ? (W - 2 * pad3) / 2 : (t - t0) / (t1 - t0) * (W - 2 * pad3));
    const y = (v) => pad3 + (H - 2 * pad3) - (clip(v) - lo) / (hi - lo || 1) * (H - 2 * pad3);
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", class: "spark" });
    if (okNum(typical)) {
      const yy = Math.round(y(typical)) + 0.5;
      svg.append(s("line", { x1: 0, x2: W, y1: yy, y2: yy, stroke: COLORS.zero, "stroke-width": 1 }));
    }
    let d = "";
    pts.forEach((p, i) => d += `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.price).toFixed(1)}`);
    const last = pts[pts.length - 1];
    svg.append(
      s("path", { d, fill: "none", stroke: COLORS.line, "stroke-width": 1.25, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-opacity": 0.85 }),
      s("circle", { cx: x(last.ts), cy: y(last.price), r: 2, fill: COLORS.marker })
    );
    return svg;
  }
  function salesChart({ points, typical = null, fast = null, base = null, upper = null, width, height = 150, now = Date.now(), fmt = (v) => "$" + fmtNumber(v, 2) }) {
    const pts = (points || []).filter((p) => okNum(p.ts) && okNum(p.price)).sort((a, b) => a.ts - b.ts);
    if (!pts.length) return h("div", { class: "chart" }, h("p", { class: "faint", text: "No CSFloat sales to draw." }));
    const readout = h("div", { class: "readout", "aria-live": "off" });
    const W = Math.max(200, Math.floor(width));
    const H = height;
    const padL = 40;
    const padR = 8;
    const padT = 6;
    const padB = 20;
    const iw = W - padL - padR;
    const ih = H - padT - padB;
    const DAY2 = 864e5;
    const ref = okNum(typical) ? typical : pts.map((p) => p.price).sort((a, b) => a - b)[pts.length >> 1];
    const inRange = (v) => v >= ref * 0.5 && v <= ref * 1.5;
    const ys = pts.map((p) => p.price).filter(inRange);
    for (const v of [typical, fast, base, upper]) if (okNum(v) && inRange(v)) ys.push(v);
    const { lo, hi, ticks } = niceTicks(Math.min(...ys), Math.max(...ys), 3);
    const tEnd = Math.max(pts[pts.length - 1].ts, now);
    const span = Math.max(tEnd - pts[0].ts, 36e5);
    const t0 = pts[0].ts - span * 0.03;
    const t1 = tEnd;
    const x = (t) => padL + (t - t0) / (t1 - t0 || 1) * iw;
    const short = span < 2 * DAY2;
    const tlabel = (t) => short ? fmtDateTime(t) : fmtDateShort(t);
    const y = (v) => padT + ih - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1) * ih;
    const svg = s("svg", {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": `${pts.length} CSFloat sales from ${fmtDateShort(pts[0].ts)} to ${fmtDateShort(pts[pts.length - 1].ts)}${okNum(typical) ? `, typical ${fmt(typical)}` : ""}`
    });
    for (const t of ticks) {
      const yy = Math.round(y(t)) + 0.5;
      svg.append(
        s("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: COLORS.grid, "stroke-width": 1 }),
        s("text", { x: padL - 6, y: yy + 3.5, "text-anchor": "end", text: compact(t) })
      );
    }
    const x30 = Math.round(x(now - 30 * DAY2)) + 0.5;
    const mark30 = x30 > padL + 60 && x30 < W - padR - 60;
    if (mark30) {
      svg.append(
        s("line", { x1: x30, x2: x30, y1: padT, y2: padT + ih, stroke: COLORS.zero, "stroke-width": 1, "stroke-dasharray": "2 3" }),
        s("text", { x: x30, y: H - 6, "text-anchor": "middle", text: "30 d ago" })
      );
    } else {
      const tm = (pts[0].ts + tEnd) / 2;
      svg.append(s("text", { x: x(tm), y: H - 6, "text-anchor": "middle", text: tlabel(tm) }));
    }
    svg.append(
      s("text", { x: padL, y: H - 6, "text-anchor": "start", text: tlabel(pts[0].ts) }),
      s("text", { x: W - padR, y: H - 6, "text-anchor": "end", text: "now" })
    );
    const flat = (v, attrs) => {
      if (!okNum(v)) return;
      const yy = Math.round(y(v)) + 0.5;
      svg.append(s("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, "stroke-width": 1.25, ...attrs }));
    };
    flat(base, { stroke: COLORS.diag, "stroke-dasharray": "1 3" });
    flat(upper, { stroke: COLORS.pos, "stroke-opacity": 0.4, "stroke-dasharray": "6 4" });
    flat(fast, { stroke: COLORS.fast, "stroke-dasharray": "4 3" });
    flat(typical, { stroke: COLORS.pos });
    const cutoff = now - 30 * DAY2;
    for (const p of pts) {
      const out = !inRange(p.price);
      svg.append(
        s("circle", {
          cx: x(p.ts),
          cy: y(p.price),
          r: 2.75,
          fill: out ? "none" : COLORS.line,
          stroke: out ? COLORS.line : "none",
          "stroke-width": 1.25,
          "fill-opacity": p.ts >= cutoff ? 0.9 : 0.4
        })
      );
    }
    const ring = s("circle", { r: 5, fill: "none", stroke: COLORS.marker, "stroke-width": 1.5, visibility: "hidden" });
    svg.append(ring);
    const idle = () => {
      const last = pts[pts.length - 1];
      readout.replaceChildren(
        h("span", { class: "faint", text: `${pts.length} sales \xB7 last ` }),
        h("span", { class: "num", text: fmt(last.price) }),
        h("span", { class: "faint", text: ` on ${fmtDateTime(last.ts)} \xB7 hover a dot` })
      );
    };
    hoverLayer(svg, {
      x0: padL,
      y0: padT,
      w: iw,
      h: ih,
      onMove: (px, py) => {
        const dist = (p) => Math.hypot(x(p.ts) - px, y(p.price) - py);
        let best = pts[0];
        for (const p of pts) if (dist(p) < dist(best)) best = p;
        ring.setAttribute("cx", x(best.ts));
        ring.setAttribute("cy", y(best.price));
        ring.setAttribute("visibility", "visible");
        readout.replaceChildren(
          h("span", { class: "num", text: `${fmtDateTime(best.ts)}  ` }),
          h("span", { class: "num strong", text: fmt(best.price) }),
          okNum(best.float) ? h("span", { class: "faint num", text: `  float ${best.float.toFixed(4)}` }) : null,
          okNum(typical) ? h("span", { class: ["num", signClass(best.price - typical)], text: `  ${fmtPct(best.price / typical - 1, 1, { sign: true })} vs typical` }) : null
        );
      },
      onLeave: () => {
        ring.setAttribute("visibility", "hidden");
        idle();
      }
    });
    idle();
    const legend = h(
      "div",
      { class: "legend" },
      okNum(typical) ? h("span", null, h("i", { class: "ln", style: { borderTopColor: COLORS.pos } }), `Typical ${fmt(typical)}`) : null,
      okNum(fast) ? h("span", null, h("i", { class: "ln dash", style: { borderTopColor: COLORS.fast } }), `Fast sale ${fmt(fast)}`) : null,
      okNum(upper) ? h("span", null, h("i", { class: "ln dash", style: { borderTopColor: COLORS.pos, opacity: 0.5 } }), `Upper group ${fmt(upper)}`) : null,
      okNum(base) ? h("span", null, h("i", { class: "ln dot", style: { borderTopColor: COLORS.diag } }), `CSFloat base ${fmt(base)}`) : null
    );
    return h("div", { class: "chart" }, readout, svg, legend);
  }

  // src/ui/views-v2.js
  var ok3 = (v) => typeof v === "number" && Number.isFinite(v);
  var numOrNull3 = (v) => v === null || v === void 0 || v === "" ? null : ok3(Number(v)) ? Number(v) : null;
  var settledUpgrade = (e) => e && e.kind === "upgrade" && e.status !== "pending";
  var rtpOf = (roi) => ok3(roi) ? 1 + roi : null;
  var rtpCI = (ci) => Array.isArray(ci) && ok3(ci[0]) && ok3(ci[1]) ? [ci[0] + 1, ci[1] + 1] : null;
  function rtpCell(rtp, ci) {
    return h(
      "td",
      { class: "num" },
      h("span", { class: ok3(rtp) ? signClass(rtp - 1) : "", text: fmtPct(rtp, 1) }),
      ci ? h("span", { class: "ci", text: fmtCI(ci) }) : null
    );
  }
  function kpiSub(k, v, sub, cls) {
    return h(
      "div",
      { class: "kpi" },
      h("div", { class: "k", text: k }),
      h("div", { class: ["v", "num", cls], text: v, title: v }),
      sub ? h("div", { class: "s", text: sub }) : null
    );
  }
  function joinLabels(rows) {
    return rows.map((r) => r.label ?? `${r.lo}${DASH}${r.hi}%`).join(", ");
  }
  function viewOdds(ctx2) {
    const { state, memo, call, contentWidth, errorBox, emptyState, goDataButton, table, th, sigBadge } = ctx2;
    const ev = state.events;
    if (!ev.some((e) => settledUpgrade(e) && !e.mystery)) {
      return emptyState(
        "No upgrades yet",
        "This tab compares the chance the site shows with how often you really win. Make some upgrades or import your history from the Data tab.",
        goDataButton()
      );
    }
    const out = [];
    const curve = memo("calibrationCurve", () => call("calibrationCurve", ev));
    if (curve.error) out.push(h("section", null, h("h3", { text: "Shown chance vs real win rate" }), errorBox(curve.error)));
    else {
      const rows = (curve.value || []).filter((r) => r && r.n > 0);
      const total = rows.reduce((a, r) => a + r.n, 0);
      if (!rows.length) {
        out.push(h("section", null, h("h3", { text: "Shown chance vs real win rate" }), h("p", { class: "muted", text: "No normal upgrades to compare yet." })));
      } else {
        out.push(h("section", null, curveCallout(rows, total)));
        out.push(
          h(
            "section",
            null,
            h("h3", { text: "Shown chance vs real win rate" }),
            calibrationChart({ rows, width: contentWidth() }),
            h("p", {
              class: "hint",
              text: "Each dot is one bucket of shown chance. The dashed diagonal is what the site promises. Dots above it win more often than shown, below it less often. The vertical line is the 95% range."
            })
          )
        );
        out.push(
          h(
            "section",
            null,
            h("h3", { text: "By shown chance" }),
            table(
              [
                th("Shown chance"),
                th("Upgrades"),
                th("Wins"),
                th("Shown", "Average chance the site showed"),
                th("Real", "Your real win rate. Second line: 95% Wilson interval"),
                th("Real \xF7 shown"),
                th("RTP", "Returned divided by staked"),
                th("Result", "Holm-corrected across buckets")
              ],
              rows.map(
                (r) => h(
                  "tr",
                  null,
                  h("td", { class: "num", text: r.label ?? `${r.lo}${DASH}${r.hi}%` }),
                  h("td", { class: "num", text: fmtInt(r.n) }),
                  h("td", { class: "num", text: fmtInt(r.wins) }),
                  h("td", { class: "num", text: fmtPct(r.expectedRate, 1) }),
                  h("td", { class: "num" }, fmtPct(r.winRate, 1), r.winRateCI ? h("span", { class: "ci", text: fmtCI(r.winRateCI) }) : null),
                  h("td", {
                    class: "num",
                    text: ok3(r.winRate) && r.expectedRate > 0 ? fmtMult(r.winRate / r.expectedRate) : DASH
                  }),
                  rtpCell(r.realRtp, null),
                  h("td", null, sigBadge(r))
                )
              )
            ),
            h("p", {
              class: "hint",
              text: "Normal upgrades only. Mystery upgrades have no shown chance, and upgrades where the super-drop card appeared are left out because the card changes the odds (see below)."
            })
          )
        );
      }
    }
    out.push(superDropSection(ctx2));
    return out;
  }
  function curveCallout(rows, total) {
    const above = rows.filter((r) => r.significant && r.winRate > r.expectedRate);
    const below = rows.filter((r) => r.significant && r.winRate < r.expectedRate);
    let headline;
    let tone = "neutral";
    if (!above.length && !below.length) headline = "Your wins match the shown odds at every level";
    else if (above.length && below.length) {
      headline = "The shown odds are off, in both directions";
      tone = "warn";
    } else if (below.length) {
      headline = "You win less often than the shown odds";
      tone = "bad";
    } else {
      headline = "You win more often than the shown odds";
      tone = "good";
    }
    const parts = [];
    if (above.length) parts.push(`More often than shown at ${joinLabels(above)}.`);
    if (below.length) parts.push(`Less often than shown at ${joinLabels(below)}.`);
    if (!parts.length) parts.push("Every bucket is within random noise of the shown chance.");
    parts.push(`Based on ${fmtInt(total)} normal upgrades.`);
    return h(
      "div",
      { class: ["callout", tone] },
      h("div", { class: "headline", text: headline }),
      h("p", { class: "detail", text: parts.join(" ") }),
      above.length ? h("p", {
        class: "detail",
        text: "Winning more often than shown does not mean profit: check the RTP column. Below 100% you still lose money on average."
      }) : null
    );
  }
  function sideBox(title, m) {
    if (!m || !m.n) return h("div", { class: "box" }, h("div", { class: "k", text: title }), h("div", { class: "v muted", text: "none yet" }));
    return h(
      "div",
      { class: "box" },
      h("div", { class: "k", text: `${title}: ${fmtInt(m.n)}` }),
      h(
        "div",
        { class: "v num" },
        h("span", { class: ok3(m.winRate) && ok3(m.expectedRate) ? signClass(m.winRate - m.expectedRate) : "", text: `${fmtPct(m.winRate, 1)} won` }),
        h("span", { class: "muted", text: `  vs ${fmtPct(m.expectedRate, 1)} shown` })
      ),
      h("div", { class: "s num", text: `RTP ${fmtPct(m.rtp, 1)} \xB7 z = ${fmtZ(m.z)}, ${fmtPEq(m.p)}` })
    );
  }
  function superDropSection(ctx2) {
    const { state, memo, call, errorBox } = ctx2;
    const res = memo("superDropStats", () => call("superDropStats", state.events));
    const head = h("h3", { text: "Super-drop card" });
    if (res.error) return h("section", null, head, errorBox(res.error));
    const sd = res.value || {};
    if (!sd.n) return h("section", null, head, h("p", { class: "muted", text: "No normal upgrades yet." }));
    const shown = sd.shown || {};
    const notShown = sd.notShown || {};
    const hits = sd.hits || {};
    const cardWins = shown.n > 0 && ok3(shown.p) && shown.p < 0.05;
    const verdict = !shown.n ? "The card has not appeared on your upgrades yet." : cardWins && shown.winRate > shown.expectedRate ? `With the card shown you win more often than the shown chance (${fmtPct(shown.winRate, 0)} vs ${fmtPct(shown.expectedRate, 0)}). That is why these upgrades are left out of the odds tests.` : cardWins ? `With the card shown you win less often than the shown chance (${fmtPct(shown.winRate, 0)} vs ${fmtPct(shown.expectedRate, 0)}).` : "With the card shown, your win rate is within random noise of the shown chance.";
    return h(
      "section",
      null,
      head,
      h(
        "div",
        { class: "callout neutral" },
        h("div", { class: "headline", text: `The card appeared on ${fmtPct(sd.shownRate, 1)} of your upgrades` }),
        h("p", { class: "detail", text: `${fmtInt(sd.shownN)} of ${fmtInt(sd.n)} normal upgrades. ${verdict}` })
      ),
      h("div", { class: "split" }, sideBox("Card shown", shown), sideBox("No card", notShown)),
      hits.n ? h("p", {
        class: "hint",
        text: `${fmtInt(hits.n)} super-drop wins. The card multiplied the win by ${fmtMult(hits.avgMultiplier)} on average (from ${fmtMult(hits.minMultiplier)} to ${fmtMult(hits.maxMultiplier)}).`
      }) : h("p", { class: "hint", text: "No super-drop wins yet." })
    );
  }
  function viewMystery(ctx2) {
    const { state, memo, call, cur, contentWidth, errorBox, emptyState, goDataButton, table, th, moneyCell } = ctx2;
    const ev = state.events;
    if (!ev.some((e) => settledUpgrade(e) && e.mystery)) {
      return emptyState(
        "No mystery upgrades yet",
        "Mystery upgrades hide the chance and always give you an item. This tab shows what they really pay back.",
        goDataButton()
      );
    }
    const res = memo("mysteryStats", () => call("mysteryStats", ev));
    if (res.error) return [errorBox(res.error)];
    const m = res.value || {};
    const c = cur();
    const rtp = rtpOf(m.roi);
    const ci = rtpCI(m.roiCI);
    const out = [];
    out.push(
      h(
        "section",
        null,
        h(
          "div",
          { class: "hero" },
          h(
            "div",
            null,
            h("div", { class: "cap", text: "Mystery RTP" }),
            h("div", { class: ["big", "num", ok3(rtp) ? signClass(rtp - 1) : ""], text: fmtPct(rtp, 1) }),
            ci ? h("div", { class: "cap num", text: `95% range ${fmtCI(ci)}`, style: { marginTop: "4px" } }) : null
          ),
          h(
            "div",
            { style: { textAlign: "right" } },
            h("div", { class: "cap", text: "Net" }),
            h("div", { class: ["roi", "num", signClass(m.net)], text: fmtMoney(m.net, c, { sign: true }) })
          )
        ),
        h(
          "div",
          { class: "kpis" },
          kpiSub("Upgrades", fmtInt(m.n || 0), `spent ${fmtMoney(m.cost, c)}`),
          kpiSub("Hit rate", fmtPct(m.hitRate, 1), m.hitRateCI ? fmtCI(m.hitRateCI) : "multiplier x1 or more"),
          kpiSub("Mean multiplier", fmtMult(m.meanMultiplier)),
          kpiSub("Median", fmtMult(m.medianMultiplier))
        ),
        h("p", {
          class: "hint",
          text: `RTP is what you got back per unit staked. ${ok3(rtp) && rtp < 1 ? `On average a mystery upgrade returned ${fmtPct(rtp, 0)} of its stake.` : ""} Hit rate is the share that gave back at least the stake.`
        })
      )
    );
    const bins = Array.isArray(m.histogram) ? m.histogram : [];
    if (bins.some((b) => b && b.n > 0)) {
      out.push(
        h(
          "section",
          null,
          h("h3", { text: "What multiplier you got" }),
          histogramChart({ bins, width: contentWidth() }),
          h("p", { class: "hint", text: "Red bars returned less than the stake, green bars at least the stake. Percent is the share of your mystery upgrades." })
        )
      );
    }
    const byStake = (Array.isArray(m.byStake) ? m.byStake : []).filter((r) => r && r.n > 0);
    if (byStake.length) {
      out.push(
        h(
          "section",
          null,
          h("h3", { text: "By stake" }),
          mysteryTest(m.test),
          h("div", { style: { height: "12px" } }),
          table(
            [th("Stake"), th("Upgrades"), th("Spent"), th("RTP", "Second line: 95% range"), th("Hit rate"), th("Mean mult.")],
            byStake.map(
              (r) => h(
                "tr",
                null,
                h("td", { class: "num", text: r.label ?? DASH }),
                h("td", { class: "num", text: fmtInt(r.n) }),
                moneyCell(r.cost),
                rtpCell(rtpOf(r.roi), rtpCI(r.roiCI)),
                h("td", { class: "num", text: fmtPct(r.hitRate, 1) }),
                h("td", { class: "num", text: fmtMult(r.meanMultiplier) })
              )
            )
          )
        )
      );
    }
    return out;
  }
  function mysteryTest(t) {
    if (!t || !ok3(t.p)) {
      return h(
        "div",
        { class: "callout neutral" },
        h("div", { class: "headline", text: "Not enough data for a test yet" }),
        h("p", { class: "detail", text: "Treat differences between stake sizes as random noise for now." })
      );
    }
    const df = Array.isArray(t.df) ? t.df.map((d) => fmtInt(d)).join(", ") : ok3(t.df) ? fmtInt(t.df) + (ok3(t.dfWithin) ? `, ${fmtInt(t.dfWithin)}` : "") : null;
    const method = /^anova$/i.test(String(t.method || "")) ? "ANOVA" : t.method || "Test";
    const line = `${method}: statistic = ${fmtNumber(t.statistic, 2)}${df ? `, df = ${df}` : ""}, ${fmtPEq(t.p)}`;
    if (t.p >= 0.05) {
      return h(
        "div",
        { class: "callout neutral", role: "note" },
        h("div", { class: "headline", text: "No real effect: differences are within random noise." }),
        h("p", { class: "detail", text: "Stake size does not change the mystery multiplier beyond what luck produces." }),
        h("p", { class: "detail", text: line })
      );
    }
    return h(
      "div",
      { class: "callout warn", role: "note" },
      h("div", { class: "headline", text: "Stake size may change the multiplier" }),
      h("p", { class: "detail", text: "The rows differ more than luck usually explains. Check again after more data before acting on it." }),
      h("p", { class: "detail", text: line })
    );
  }
  function dayLabel(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    if (!m) return String(day || DASH);
    return fmtDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
  }
  function viewMoney(ctx2) {
    const { state, memo, call, cur, contentWidth, errorBox, emptyState, goDataButton, table, th, moneyCell, render } = ctx2;
    const ev = state.events;
    const hv = state.holdings || {};
    const balance = numOrNull3(hv.balance);
    const inventoryValue = numOrNull3(hv.inventoryValue);
    const hasFlow = ev.some((e) => e && (e.kind === "deposit" || e.kind === "withdrawal"));
    if (!hasFlow) {
      const held = balance === null && inventoryValue === null ? "" : ` You hold ${fmtMoney((balance || 0) + (inventoryValue || 0), cur())} right now.`;
      return emptyState(
        "No deposits or withdrawals yet",
        `Import your history from the Data tab to load your payments. Withdrawn items come from your inventory history.${held}`,
        goDataButton()
      );
    }
    const res = memo(`moneyFlow:${balance}:${inventoryValue}`, () => call("moneyFlow", ev, { balance, inventoryValue }));
    if (res.error) return [errorBox(res.error)];
    const mf = res.value || {};
    const dep = mf.deposits || {};
    const wd = mf.withdrawals || {};
    const c = cur();
    const out = [];
    const holdingsKnown = ok3(mf.holdings);
    out.push(
      h(
        "section",
        null,
        h(
          "div",
          { class: "hero" },
          h(
            "div",
            null,
            h("div", { class: "cap", text: "Real money result" }),
            h("div", { class: ["big", "num", signClass(mf.net)], text: fmtMoney(mf.net, c, { sign: true }) }),
            h("div", { class: "cap", text: holdingsKnown ? "Withdrawn + what you hold now \u2212 deposited" : "Withdrawn \u2212 deposited (holdings unknown)", style: { marginTop: "4px" } })
          )
        ),
        h(
          "div",
          { class: "kpis" },
          kpiSub("Deposited", fmtMoney(dep.sum, c), `${fmtInt(dep.n || 0)} completed`),
          kpiSub("Withdrawn", fmtMoney(wd.value, c), `${fmtInt(wd.n || 0)} items`),
          kpiSub(
            "Holdings",
            holdingsKnown ? fmtMoney(mf.holdings, c) : "unknown",
            holdingsKnown ? `cash ${balance === null ? DASH : fmtMoney(balance, "")}, skins ${inventoryValue === null ? DASH : fmtMoney(inventoryValue, "")}` : "not read from the site yet"
          ),
          kpiSub("Failed deposits", fmtInt(dep.failedN || 0), dep.failedN ? fmtMoney(dep.failedSum, c) : "none")
        ),
        state.holdingsError ? errorBox(state.holdingsError, "Could not read holdings") : null,
        dep.n ? h("p", {
          class: "hint",
          text: `Deposits from ${fmtDate(dep.firstTs)} to ${fmtDate(dep.lastTs)}${ok3(dep.perDay) ? `, about ${fmtMoney(dep.perDay, c)} per day` : ""}. Failed and expired payments are not counted as money in.`
        }) : null
      )
    );
    const series = Array.isArray(mf.series) ? mf.series.filter((p) => p && ok3(p.ts) && ok3(p.cumulativeNet)) : [];
    const approx = wd.n > 0 && ok3(wd.exactTimeN) && wd.exactTimeN < wd.n;
    if (series.length) {
      out.push(
        h(
          "section",
          null,
          h("h3", { text: "Deposits and withdrawals over time" }),
          moneyChart({ series, width: contentWidth(), currency: c }),
          h("p", { class: "hint", text: "The line is everything withdrawn minus everything deposited so far. It leaves out what you hold now." }),
          approx ? h("p", { class: "hint", text: "Withdrawal times are approximate for imported items." }) : null
        )
      );
    } else if (approx) {
      out.push(h("p", { class: "hint", text: "Withdrawal times are approximate for imported items." }));
    }
    const daily = (Array.isArray(mf.daily) ? mf.daily : []).filter((d) => d && (num2(d.deposited) || num2(d.withdrawn))).slice().sort((a, b) => a.day < b.day ? 1 : -1);
    if (daily.length) {
      const LIMIT = 14;
      const shown = state.dailyAll ? daily : daily.slice(0, LIMIT);
      out.push(
        h(
          "section",
          null,
          h("div", { class: "section-head" }, h("h3", { text: "By day" }), c ? h("span", { class: "muted", text: `Money in ${c}` }) : null),
          table(
            [th("Day"), th("Deposited"), th("Withdrawn"), th("Withdrawn \u2212 deposited")],
            shown.map(
              (d) => h(
                "tr",
                null,
                h("td", { class: "num", text: dayLabel(d.day) }),
                moneyCell(num2(d.deposited)),
                moneyCell(num2(d.withdrawn)),
                moneyCell(num2(d.withdrawn) - num2(d.deposited), true)
              )
            )
          ),
          daily.length > LIMIT ? h(
            "div",
            { style: { marginTop: "10px" } },
            h("button", {
              type: "button",
              class: "btn ghost",
              "data-fk": "daily-toggle",
              text: state.dailyAll ? "Show fewer days" : `Show all ${fmtInt(daily.length)} days`,
              on: {
                click: () => {
                  state.dailyAll = !state.dailyAll;
                  state.pendingFocus = "daily-toggle";
                  render();
                }
              }
            })
          ) : null
        )
      );
    }
    return out;
  }
  function num2(v) {
    return ok3(v) ? v : Number(v) || 0;
  }

  // src/ui/dashboard.js
  var TABS = [
    ["overview", "Overview"],
    ["odds", "Odds"],
    ["cases", "Cases"],
    ["upgrades", "Upgrades"],
    ["mystery", "Mystery"],
    ["factors", "Factors"],
    ["money", "Money"],
    ["data", "Data"]
  ];
  var FACTORS2 = [
    { key: "hour", label: "Hour of day", kinds: ["upgrade", "case"] },
    { key: "weekday", label: "Day of week", kinds: ["upgrade", "case"] },
    { key: "daypart", label: "Part of day", kinds: ["upgrade", "case"] },
    { key: "sessionPosition", label: "Position in session", kinds: ["upgrade", "case"] },
    { key: "sessionMinute", label: "Minutes into session", kinds: ["upgrade", "case"] },
    { key: "afterLossStreak", label: "Losses in a row before", kinds: ["upgrade"] },
    { key: "afterWin", label: "Previous upgrade result", kinds: ["upgrade"] },
    { key: "mode", label: "Normal or mystery", kinds: ["upgrade"] },
    { key: "multiplier", label: "Multiplier", kinds: ["upgrade"] },
    { key: "itemCount", label: "Items in the bet", kinds: ["upgrade"] },
    { key: "addedBalance", label: "Added balance", kinds: ["upgrade"] },
    { key: "free", label: "Free or paid open", kinds: ["case"] },
    { key: "gameMode", label: "Game mode", kinds: ["upgrade", "case"] },
    { key: "site", label: "Site", kinds: ["upgrade", "case"] },
    { key: "balanceBand", label: "Balance before", kinds: ["upgrade", "case"] },
    { key: "sinceDeposit", label: "Time since last deposit", kinds: ["upgrade", "case"] },
    { key: "afterDepositOrder", label: "Upgrades since last deposit", kinds: ["upgrade"] },
    { key: "sinceWithdrawal", label: "Time since last withdrawal", kinds: ["upgrade", "case"] },
    { key: "superDrop", label: "Super-drop card shown", kinds: ["upgrade"] }
  ];
  var EDGE_CFG = {
    chance: { storeKey: "cst.ui.edges.chance", def: [0, 2, 5, 10, 20, 30, 50, 75, 100], allowInf: false },
    stake: { storeKey: "cst.ui.edges.stake", def: [0, 100, 500, 1e3, 5e3, 2e4, Infinity], allowInf: true }
  };
  var ok4 = (v) => typeof v === "number" && Number.isFinite(v);
  var num3 = (v) => ok4(v) ? v : Number(v) || 0;
  function edgesToText(arr3) {
    return arr3.map((v) => v === Infinity ? "inf" : String(v)).join(", ");
  }
  function parseEdges(text, allowInf) {
    const parts = String(text || "").split(/[,;\s]+/).filter(Boolean);
    const out = [];
    for (const p of parts) {
      if (/^(inf|infinity|∞)$/i.test(p)) {
        if (!allowInf) return { error: "Infinity is not allowed here. Use 100 as the top edge." };
        out.push(Infinity);
        continue;
      }
      const n = Number(p);
      if (!Number.isFinite(n)) return { error: `"${p}" is not a number.` };
      if (n < 0) return { error: "Edges cannot be negative." };
      out.push(n);
    }
    const edges = [...new Set(out)].sort((a, b) => a - b);
    if (edges.length < 2) return { error: "Enter at least two edges, separated by commas." };
    return { edges };
  }
  function flow(e) {
    if (!e) return null;
    if (e.kind === "case") return { cost: num3(e.casePrice), ret: num3(e.item && e.item.price) };
    if (e.kind === "upgrade" && e.status !== "pending") return { cost: num3(e.stake), ret: num3(e.returned) };
    return null;
  }
  function cumulative(events) {
    const sorted = events.filter((e) => flow(e)).sort((a, b) => num3(a.ts) - num3(b.ts));
    let net = 0;
    return sorted.map((e) => {
      const f = flow(e);
      net += f.ret - f.cost;
      return { ts: num3(e.ts), v: net };
    });
  }
  function iconClose() {
    return s(
      "svg",
      { viewBox: "0 0 16 16", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" },
      s("path", { d: "M4 4l8 8M12 4l-8 8" })
    );
  }
  function mountDashboard(opts = {}) {
    const o = opts;
    const stats = o.stats || {};
    const cur = () => {
      try {
        return String((o.currency && o.currency()) ?? "");
      } catch {
        return "";
      }
    };
    const { host, root } = createHost("caser-tracker-dashboard");
    root.append(h("style", { text: BASE_CSS + DASHBOARD_CSS }));
    const wrap = h("div", { class: "root" });
    root.append(wrap);
    const savedSort = store.get("cst.ui.caseSort", null);
    const state = {
      open: false,
      tab: TABS.some(([id]) => id === store.get("cst.ui.tab", "overview")) ? store.get("cst.ui.tab", "overview") : "overview",
      events: [],
      loaded: false,
      loading: false,
      again: false,
      loadError: null,
      cache: /* @__PURE__ */ new Map(),
      caseSort: savedSort && typeof savedSort.key === "string" ? savedSort : { key: "n", dir: -1 },
      factorKey: store.get("cst.ui.factorKey", "hour"),
      factorKind: store.get("cst.ui.factorKind", "upgrade") === "case" ? "case" : "upgrade",
      edges: { chance: null, stake: null },
      edgeText: { chance: "", stake: "" },
      edgeErr: { chance: null, stake: null },
      confirmClear: false,
      busy: null,
      msg: null,
      tabChanged: true,
      pendingFocus: null,
      holdings: null,
      holdingsError: null,
      dailyAll: false,
      accounts: null
    };
    for (const kind of ["chance", "stake"]) {
      const cfg = EDGE_CFG[kind];
      const saved = store.get(cfg.storeKey, null);
      const parsed = typeof saved === "string" ? parseEdges(saved, cfg.allowInf) : { error: "none" };
      if (parsed.edges) {
        state.edges[kind] = parsed.edges;
        state.edgeText[kind] = edgesToText(parsed.edges);
      } else {
        state.edgeText[kind] = edgesToText(cfg.def);
      }
    }
    const memo = (key, fn) => {
      if (!state.cache.has(key)) state.cache.set(key, safe(fn));
      return state.cache.get(key);
    };
    const call = (name, ...args) => {
      if (typeof stats[name] !== "function") throw new Error(`stats.${name} is missing`);
      return stats[name](...args);
    };
    const launcher = h(
      "button",
      {
        type: "button",
        class: "launcher",
        "aria-expanded": "false",
        "aria-controls": "cst-panel",
        "aria-label": "Open stats panel",
        on: { click: () => state.open ? close() : open() }
      },
      h("span", { class: "mark", "aria-hidden": "true" }),
      h("span", { class: "label", text: "Stats" })
    );
    const titleEl = h("h2", { class: "title", id: "cst-title", text: "Case and upgrade stats" });
    const subEl = h("div", { class: "sub" });
    const acctEl = h("div", { class: "acct", hidden: true });
    let acctShown = "";
    const closeBtn = h("button", { type: "button", class: "iconbtn", "aria-label": "Close stats panel", on: { click: () => close() } }, iconClose());
    const head = h("div", { class: "head" }, h("div", null, titleEl, subEl, acctEl), closeBtn);
    const tabsEl = h("div", { class: "tabs", role: "tablist", "aria-label": "Stats sections" });
    const tabBtns = {};
    for (const [id, label] of TABS) {
      const b = h("button", {
        type: "button",
        role: "tab",
        id: `cst-tab-${id}`,
        class: "tab",
        "aria-controls": "cst-body",
        text: label,
        on: { click: () => selectTab(id, true) }
      });
      tabBtns[id] = b;
      tabsEl.append(b);
    }
    tabsEl.addEventListener("keydown", (e) => {
      const ids = TABS.map(([id]) => id);
      const i = ids.indexOf(state.tab);
      let next = null;
      if (e.key === "ArrowRight") next = ids[(i + 1) % ids.length];
      else if (e.key === "ArrowLeft") next = ids[(i - 1 + ids.length) % ids.length];
      else if (e.key === "Home") next = ids[0];
      else if (e.key === "End") next = ids[ids.length - 1];
      if (next) {
        e.preventDefault();
        selectTab(next, true);
      }
    });
    const body = h("div", { class: "body", id: "cst-body", role: "tabpanel", tabindex: "0" });
    const panel = h(
      "div",
      { class: "panel", id: "cst-panel", role: "dialog", "aria-modal": "false", "aria-labelledby": "cst-title", hidden: true },
      head,
      tabsEl,
      body
    );
    for (const type of ["keydown", "keyup", "keypress"]) {
      panel.addEventListener(type, (e) => {
        if (type === "keydown" && e.key === "Escape") onEscape(e);
        e.stopPropagation();
      });
    }
    wrap.append(launcher, panel);
    function onEscape(e) {
      if (!state.open) return;
      e.preventDefault();
      if (state.confirmClear) {
        state.confirmClear = false;
        state.pendingFocus = "clear";
        render();
        return;
      }
      close();
    }
    const onWindowKey = (e) => {
      if (e.key === "Escape" && state.open) onEscape(e);
    };
    window.addEventListener("keydown", onWindowKey);
    const onResize = debounce(() => state.open && render(), 150);
    window.addEventListener("resize", onResize);
    const reattach = setInterval(() => attach(host), 2e3);
    function open() {
      state.open = true;
      state.tabChanged = true;
      panel.hidden = false;
      launcher.setAttribute("aria-expanded", "true");
      render();
      tabBtns[state.tab].focus();
      doRefresh();
    }
    function close() {
      const hadFocus = root.activeElement && panel.contains(root.activeElement);
      state.open = false;
      state.confirmClear = false;
      panel.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      if (hadFocus) launcher.focus();
    }
    function selectTab(id, focus) {
      if (state.tab !== id) {
        state.tab = id;
        state.tabChanged = true;
        state.confirmClear = false;
        store.set("cst.ui.tab", id);
        body.scrollTop = 0;
      }
      render();
      if (focus) tabBtns[id].focus();
      try {
        tabBtns[id].scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch {
      }
    }
    async function doRefresh() {
      if (state.loading) {
        state.again = true;
        return;
      }
      state.loading = true;
      try {
        const ev = await o.getEvents();
        state.events = Array.isArray(ev) ? ev : [];
        state.loadError = null;
      } catch (e) {
        state.loadError = e;
      }
      if (typeof o.getAccounts === "function") state.accounts = safe(() => o.getAccounts()).value || null;
      if (typeof o.getHoldings === "function") {
        try {
          const hv = await o.getHoldings();
          state.holdings = hv && typeof hv === "object" ? hv : null;
          state.holdingsError = null;
        } catch (e) {
          state.holdingsError = e;
        }
      }
      state.loading = false;
      state.loaded = true;
      state.cache.clear();
      if (state.open) render();
      if (state.again) {
        state.again = false;
        doRefresh();
      }
    }
    const refresh = debounce(doRefresh, 250);
    function contentWidth() {
      const cs = getComputedStyle(body);
      return body.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    }
    function render() {
      if (!state.open) return;
      const active = root.activeElement;
      const fk = state.pendingFocus || (active && body.contains(active) ? active.dataset.fk : null);
      const caret = active && active.tagName === "INPUT" ? [active.selectionStart, active.selectionEnd] : null;
      const scroll = body.scrollTop;
      const n = state.events.length;
      let first = null;
      let last = null;
      for (const e of state.events) {
        const ts = num3(e.ts);
        if (!ts) continue;
        if (first === null || ts < first) first = ts;
        if (last === null || ts > last) last = ts;
      }
      subEl.textContent = !state.loaded ? "Loading\u2026" : n ? `${fmtInt(n)} events, ${fmtDate(first)} ${DASH} ${fmtDate(last)}` : "No events recorded yet";
      renderAccounts();
      for (const [id] of TABS) {
        const sel = id === state.tab;
        tabBtns[id].setAttribute("aria-selected", String(sel));
        tabBtns[id].tabIndex = sel ? 0 : -1;
      }
      body.setAttribute("aria-labelledby", `cst-tab-${state.tab}`);
      let content;
      if (!state.loaded) content = [h("p", { class: "muted", text: "Loading your events\u2026" })];
      else {
        const views = {
          overview: viewOverview,
          odds: () => viewOdds(ctx2),
          cases: viewCases,
          upgrades: viewUpgrades,
          mystery: () => viewMystery(ctx2),
          factors: viewFactors,
          money: () => viewMoney(ctx2),
          data: viewData
        };
        try {
          content = (views[state.tab] || viewOverview)();
        } catch (e) {
          console.warn("[caser-tracker] render failed", e);
          content = [errorBox(e)];
        }
        if (state.loadError && state.tab !== "data") content.unshift(errorBox(state.loadError, "Could not read stored events"));
      }
      const view = h("div", { class: ["view", state.tabChanged && "enter"] }, content);
      body.replaceChildren(view);
      if (!state.tabChanged) body.scrollTop = scroll;
      state.tabChanged = false;
      if (fk) {
        const el = body.querySelector(`[data-fk="${fk}"]`);
        if (el) {
          el.focus({ preventScroll: true });
          if (caret && el.tagName === "INPUT") {
            try {
              el.setSelectionRange(caret[0], caret[1]);
            } catch {
            }
          }
        }
      }
      state.pendingFocus = null;
    }
    function renderAccounts() {
      const a = state.accounts;
      const list = a && Array.isArray(a.list) ? a.list : [];
      const show = list.length > 1;
      const value = a && a.selected != null ? String(a.selected) : "all";
      const sig = show ? JSON.stringify([value, list.map((x) => [x.id, x.name, x.events, x.current])]) : "";
      if (sig === acctShown) return;
      acctShown = sig;
      acctEl.hidden = !show;
      if (!show) {
        acctEl.replaceChildren();
        return;
      }
      const current = list.find((x) => x.current);
      const label = (x) => `${x.name}${x.current ? " (signed in)" : ""}, ${fmtInt(x.events)} events`;
      const select = h(
        "select",
        {
          "aria-label": "Account",
          title: "Which site account the stats are for",
          on: {
            change: (e) => {
              const v = e.target.value;
              safe(() => o.selectAccount(current && v === current.id ? "current" : v));
            }
          }
        },
        list.map((x) => h("option", { value: x.id, selected: x.id === value, text: label(x) })),
        h("option", { value: "all", selected: value === "all", text: "All accounts" })
      );
      acctEl.replaceChildren(select);
    }
    function errorBox(err, prefix = "Could not compute this view") {
      return h("div", { class: "error", role: "alert", text: `${prefix}: ${err && err.message || err}` });
    }
    function emptyState(title, text, action) {
      return [h("div", { class: "empty" }, h("div", { class: "et", text: title }), h("p", { class: "ed", text }), action || null)];
    }
    function goDataButton() {
      return h("button", { type: "button", class: "btn primary", text: "Go to Data", on: { click: () => selectTab("data", true) } });
    }
    function moneyCell(v, sign = false) {
      return h("td", { class: ["num", sign && signClass(v)], text: fmtMoney(v, "", { sign }) });
    }
    function roiCell(roi, ci) {
      return h(
        "td",
        { class: "num" },
        h("span", { class: signClass(roi), text: fmtPct(roi, 1, { sign: true }) }),
        ci ? h("span", { class: "ci", text: fmtCI(ci) }) : null
      );
    }
    function rateCell(rate, ci) {
      return h("td", { class: "num" }, fmtPct(rate, 1), ci ? h("span", { class: "ci", text: fmtCI(ci) }) : null);
    }
    function sigBadge(r) {
      if (!r || !r.n) return h("span", { class: "faint", text: DASH });
      if (r.n < 10) return h("span", { class: "badge", text: "Too few", title: "Fewer than 10 upgrades in this row" });
      if (r.significant) {
        const below = num3(r.winRate) < num3(r.expectedRate);
        return h("span", {
          class: ["badge", below ? "bad" : "good"],
          text: below ? "Below odds" : "Above odds",
          title: `Too large to be luck (${fmtPEq(r.p)}, Holm-corrected)`
        });
      }
      return h("span", { class: "badge", text: "Noise", title: `Within random noise (${fmtPEq(r.p)})` });
    }
    function table(headers, rows, extraClass) {
      return h(
        "div",
        { class: "tablewrap" },
        h(
          "table",
          { class: extraClass },
          h("thead", null, h("tr", null, headers)),
          h("tbody", null, rows)
        )
      );
    }
    const th = (text, title) => h("th", { scope: "col", text, title });
    const ctx2 = {
      state,
      memo,
      call,
      cur,
      contentWidth,
      render,
      errorBox,
      emptyState,
      goDataButton,
      table,
      th,
      moneyCell,
      roiCell,
      rateCell,
      sigBadge,
      kpi
    };
    function viewOverview() {
      const ev = state.events;
      if (!ev.length) {
        return emptyState(
          "No events yet",
          "Open a case or make an upgrade on the site and it shows up here. You can also import your past history.",
          goDataButton()
        );
      }
      const c = cur();
      const sum = memo("summary", () => call("summarize", ev));
      if (sum.error) return [errorBox(sum.error)];
      const { total = {}, cases = {}, upgrades = {} } = sum.value || {};
      const out = [];
      out.push(
        h(
          "section",
          null,
          h(
            "div",
            { class: "hero" },
            h(
              "div",
              null,
              h("div", { class: "cap", text: "Total net" }),
              h("div", { class: ["big", "num", signClass(total.net)], text: fmtMoney(total.net, c, { sign: true }) })
            ),
            h(
              "div",
              null,
              h("div", { class: "cap", text: "ROI", style: { textAlign: "right" } }),
              h("div", { class: ["roi", "num", signClass(total.roi)], text: fmtPct(total.roi, 1, { sign: true }) })
            )
          ),
          h(
            "div",
            { class: "kpis" },
            kpi("Spent", fmtMoney(total.cost, c)),
            kpi("Returned", fmtMoney(total.returned, c)),
            kpi("Case drops", fmtInt(cases.n || 0)),
            kpi("Upgrades", fmtInt(upgrades.n || 0))
          ),
          h(
            "div",
            { class: "split" },
            kindBox("Cases", cases, c),
            kindBox("Upgrades", upgrades, c)
          )
        )
      );
      const series = memo("series", () => cumulative(ev)).value || [];
      out.push(
        h(
          "section",
          null,
          h("h3", { text: "Net over time" }),
          series.length >= 2 ? [lineChart({ points: series, width: contentWidth(), currency: c }), h("p", { class: "hint", text: "Each step is one event, oldest on the left." })] : h("p", { class: "muted", text: "The chart needs at least two events." })
        )
      );
      out.push(h("section", null, h("h3", { text: "Do your wins match the shown odds?" }), calibrationBlock(ev)));
      const ses = memo("sessions", () => call("sessions", ev));
      out.push(h("section", null, h("h3", { text: "Recent sessions" }), ses.error ? errorBox(ses.error) : sessionsList(ses.value || [], c)));
      return out;
    }
    function kpi(k, v) {
      return h("div", { class: "kpi" }, h("div", { class: "k", text: k }), h("div", { class: "v num", text: v, title: v }));
    }
    function kindBox(label, m, c) {
      return h(
        "div",
        { class: "box" },
        h("div", { class: "k", text: `${label}: ${fmtInt(m.n || 0)}` }),
        h(
          "div",
          { class: "v num" },
          h("span", { class: signClass(m.net), text: fmtMoney(m.net, c, { sign: true }) }),
          h("span", { class: "muted", text: `  ROI ${fmtPct(m.roi, 1, { sign: true })}` })
        )
      );
    }
    function calibrationBlock(ev) {
      const cal = memo("calibration", () => call("calibration", ev));
      if (cal.error) return errorBox(cal.error);
      const r = cal.value;
      if (!r || !r.n) {
        return h(
          "div",
          { class: "callout neutral" },
          h("div", { class: "headline", text: "No upgrades yet" }),
          h("p", { class: "detail", text: "This check compares how often you win upgrades with the chance the site showed." })
        );
      }
      const map = {
        consistent: ["Your wins match the shown odds", "neutral", "The gap between your wins and the shown odds is within random noise."],
        below: ["You win less often than the shown odds", "bad", "The gap is too large to be luck."],
        above: ["You win more often than the shown odds", "good", "The gap is too large to be luck. It can still change with more data."]
      };
      const [headline, tone, note] = map[r.verdict] || map.consistent;
      return h(
        "div",
        { class: ["callout", tone] },
        h("div", { class: "headline", text: headline }),
        h(
          "p",
          { class: "detail" },
          `${fmtInt(r.wins)} wins out of ${fmtInt(r.n)} upgrades, ${fmtNumber(r.expectedWins, 1)} expected from the shown odds. ${note}`
        ),
        h(
          "p",
          { class: "detail" },
          `z = ${fmtZ(r.z)}, ${fmtPEq(r.p)}`,
          ok4(r.impliedRtp) ? `. Upgrades paid back ${fmtPct(r.impliedRtp, 1)} of what you staked.` : ""
        ),
        r.n < 30 ? h("p", { class: "detail", text: "Fewer than 30 upgrades: this check is weak for now." }) : null
      );
    }
    function sessionsList(list, c) {
      if (!list.length) return h("p", { class: "muted", text: "No sessions yet." });
      const rows = [...list].sort((a, b) => num3(b.start) - num3(a.start)).slice(0, 10);
      return h(
        "div",
        { class: "list" },
        rows.map((x) => {
          const kinds = x.kinds || {};
          const parts = [];
          if (kinds.case) parts.push(`${fmtInt(kinds.case)} case ${kinds.case === 1 ? "drop" : "drops"}`);
          if (kinds.upgrade) parts.push(`${fmtInt(kinds.upgrade)} ${kinds.upgrade === 1 ? "upgrade" : "upgrades"}`);
          return h(
            "div",
            { class: "row" },
            h(
              "div",
              { class: "l" },
              h("div", { class: "t num", text: `${fmtDateShort(x.start)}, ${fmtTime(x.start)}${DASH}${fmtTime(x.end)}` }),
              h("div", { class: "d", text: `${parts.join(", ") || `${fmtInt(x.n)} events`} \xB7 ${fmtDuration(num3(x.end) - num3(x.start))}` })
            ),
            h(
              "div",
              { class: "r" },
              h("div", { class: ["num", signClass(x.net)], text: fmtMoney(x.net, c, { sign: true }) }),
              h("div", { class: "d muted num", text: `spent ${fmtMoney(x.cost, c)}`, style: { fontSize: "11.5px" } })
            )
          );
        })
      );
    }
    const CASE_COLS = [
      { key: "caseName", label: "Case", get: (r) => String(r.caseName || r.caseSlug || "").toLowerCase() },
      { key: "n", label: "Opens", get: (r) => r.n },
      { key: "cost", label: "Spent", get: (r) => r.cost },
      { key: "returned", label: "Returned", get: (r) => r.returned },
      { key: "roi", label: "ROI", get: (r) => r.roi, title: "Net divided by spent. Second line: 95% range." },
      { key: "hitRate", label: "Hit rate", get: (r) => r.hitRate, title: "Share of drops worth at least the case price" },
      { key: "best", label: "Best drop", get: (r) => r.best ? r.best.price : null },
      { key: "median", label: "Median drop", get: (r) => r.median }
    ];
    function viewCases() {
      const ev = state.events;
      if (!ev.some((e) => e.kind === "case")) {
        return emptyState("No case opens yet", "Open a case on the site, or import your drop history from the Data tab.", goDataButton());
      }
      const res = memo("caseRoi", () => call("caseRoi", ev));
      if (res.error) return [errorBox(res.error)];
      const rows = [...res.value || []];
      const col = CASE_COLS.find((x) => x.key === state.caseSort.key) || CASE_COLS[1];
      const dir = state.caseSort.dir === 1 ? 1 : -1;
      rows.sort((a, b) => {
        const va = col.get(a);
        const vb = col.get(b);
        const na = va === null || va === void 0 || typeof va === "number" && !Number.isFinite(va);
        const nb = vb === null || vb === void 0 || typeof vb === "number" && !Number.isFinite(vb);
        if (na || nb) return na === nb ? 0 : na ? 1 : -1;
        if (typeof va === "string") return va.localeCompare(vb) * dir;
        return (va - vb) * dir;
      });
      const headers = CASE_COLS.map((cdef) => {
        const active = cdef.key === col.key;
        return h(
          "th",
          { scope: "col", "aria-sort": active ? dir === 1 ? "ascending" : "descending" : "none", title: cdef.title },
          h(
            "button",
            {
              type: "button",
              class: "sortbtn",
              "data-fk": `sort-${cdef.key}`,
              "aria-label": `Sort by ${cdef.label}`,
              on: {
                click: () => {
                  if (state.caseSort.key === cdef.key) state.caseSort = { key: cdef.key, dir: -state.caseSort.dir };
                  else state.caseSort = { key: cdef.key, dir: cdef.key === "caseName" ? 1 : -1 };
                  store.set("cst.ui.caseSort", state.caseSort);
                  render();
                }
              }
            },
            cdef.label,
            h("span", { class: "arrow", "aria-hidden": "true", text: active ? dir === 1 ? "\u2191" : "\u2193" : "" })
          )
        );
      });
      const trs = rows.map(
        (r) => h(
          "tr",
          null,
          h(
            "td",
            { class: "name", title: r.caseName || r.caseSlug },
            r.caseName || r.caseSlug || "Unknown case",
            h("span", { class: "second num", text: r.casePrice ? `${fmtMoney(r.casePrice, "")} per open` : "free" })
          ),
          h("td", { class: "num", text: fmtInt(r.n) }),
          moneyCell(r.cost),
          moneyCell(r.returned),
          roiCell(r.roi, r.roiCI),
          h("td", { class: "num", text: fmtPct(r.hitRate, 1) }),
          h(
            "td",
            { class: "num name", title: r.best ? r.best.name : "" },
            r.best ? fmtMoney(r.best.price, "") : DASH,
            r.best ? h("span", { class: "second", text: r.best.name }) : null
          ),
          moneyCell(r.median)
        )
      );
      return [
        h(
          "section",
          null,
          h("div", { class: "section-head" }, h("h3", { text: "Return by case" }), h("span", { class: "muted", text: `Money in ${cur() || "site currency"}` })),
          table(headers, trs, "sticky-first"),
          h("p", {
            class: "hint",
            text: "The small range under ROI is the 95% interval. A wide range means few opens, so the result can still be luck. Hit rate is the share of drops worth at least the case price."
          })
        )
      ];
    }
    function edgeEditor(kind, label) {
      const cfg = EDGE_CFG[kind];
      const inputId = `cst-edges-${kind}`;
      const errId = `cst-edges-${kind}-err`;
      const apply2 = () => {
        const r = parseEdges(state.edgeText[kind], cfg.allowInf);
        if (r.error) state.edgeErr[kind] = r.error;
        else {
          state.edges[kind] = r.edges;
          state.edgeText[kind] = edgesToText(r.edges);
          state.edgeErr[kind] = null;
          store.set(cfg.storeKey, state.edgeText[kind]);
        }
        state.pendingFocus = `edges-${kind}`;
        render();
      };
      const reset = () => {
        state.edges[kind] = null;
        state.edgeText[kind] = edgesToText(cfg.def);
        state.edgeErr[kind] = null;
        store.remove(cfg.storeKey);
        state.pendingFocus = `edges-${kind}`;
        render();
      };
      return [
        h(
          "div",
          { class: "edges" },
          h("label", { for: inputId, text: label }),
          h("input", {
            type: "text",
            id: inputId,
            value: state.edgeText[kind],
            "data-fk": `edges-${kind}`,
            inputmode: "decimal",
            autocomplete: "off",
            spellcheck: "false",
            "aria-describedby": state.edgeErr[kind] ? errId : null,
            "aria-invalid": state.edgeErr[kind] ? "true" : null,
            on: {
              input: (e) => state.edgeText[kind] = e.target.value,
              keydown: (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply2();
                }
              }
            }
          }),
          h("button", { type: "button", class: "btn", text: "Apply", "data-fk": `apply-${kind}`, on: { click: apply2 } }),
          h("button", { type: "button", class: "btn ghost", text: "Reset", "aria-label": `Reset ${kind} edges to default`, on: { click: reset } })
        ),
        state.edgeErr[kind] ? h("p", { class: "err", id: errId, role: "alert", text: state.edgeErr[kind] }) : null
      ];
    }
    function bucketTable2(rows) {
      const visible = rows.filter((r) => r && r.n > 0);
      if (!visible.length) return h("p", { class: "muted", text: "No upgrades fall into these buckets." });
      const c = "";
      return table(
        [
          th("Bucket"),
          th("Upgrades"),
          th("Wins"),
          th("Win rate", "Second line: 95% Wilson interval"),
          th("Shown chance", "Average chance the site showed"),
          th("ROI"),
          th("Result", "Significance after Holm correction")
        ],
        visible.map(
          (r) => h(
            "tr",
            null,
            h("td", { class: "num", text: r.label ?? `${r.lo}${DASH}${r.hi}` }),
            h("td", { class: "num", text: fmtInt(r.n) }),
            h("td", { class: "num", text: fmtInt(r.wins) }),
            rateCell(r.winRate, r.winRateCI),
            h("td", { class: "num", text: fmtPct(r.expectedRate, 1) }),
            roiCell(r.roi, null),
            h("td", null, sigBadge(r))
          )
        ),
        c
      );
    }
    function viewUpgrades() {
      const ev = state.events;
      const hasUpgrades = ev.some((e) => e.kind === "upgrade" && e.status !== "pending");
      if (!hasUpgrades) {
        return emptyState("No upgrades yet", "Make an upgrade on the site, or import your upgrade history from the Data tab.", goDataButton());
      }
      const ce = state.edges.chance;
      const se = state.edges.stake;
      const ceKey = ce ? edgesToText(ce) : "default";
      const seKey = se ? edgesToText(se) : "default";
      const byChance = memo(`byChance:${ceKey}`, () => ce ? call("upgradeByChance", ev, ce) : call("upgradeByChance", ev));
      const byStake = memo(`byStake:${seKey}`, () => se ? call("upgradeByStake", ev, se) : call("upgradeByStake", ev));
      const edgeMap2 = memo(`edgeMap:${ceKey}`, () => ce ? call("edgeMap", ev, ce) : call("edgeMap", ev));
      return [
        h(
          "section",
          null,
          h("h3", { text: "By shown chance" }),
          edgeEditor("chance", "Edges, %"),
          byChance.error ? errorBox(byChance.error) : bucketTable2(byChance.value || [])
        ),
        h(
          "section",
          null,
          h("h3", { text: "By stake" }),
          edgeEditor("stake", `Edges${cur() ? ", " + cur() : ""}`),
          byStake.error ? errorBox(byStake.error) : bucketTable2(byStake.value || [])
        ),
        h(
          "section",
          null,
          h("h3", { text: "Shown return vs real return" }),
          edgeMap2.error ? errorBox(edgeMap2.error) : edgeMapTable(edgeMap2.value || []),
          h("p", {
            class: "hint",
            text: "Shown RTP is what the shown odds promise per unit staked. Real RTP is what you got back. Below 100% means you lose money on average in that bucket. Win-rate columns above use normal upgrades without the super-drop card; mystery upgrades are on the Mystery tab."
          })
        ),
        h(
          "section",
          null,
          h(
            "p",
            { class: "hint" },
            "Result column: ",
            h("strong", { text: "Below odds" }),
            " or ",
            h("strong", { text: "Above odds" }),
            " means the gap between your wins and the shown chance is too large to be luck (p below 0.05 after Holm correction). ",
            h("strong", { text: "Noise" }),
            " means the gap is what luck alone produces."
          )
        )
      ];
    }
    function edgeMapTable(rows) {
      const visible = rows.filter((r) => r && r.n > 0);
      if (!visible.length) return h("p", { class: "muted", text: "No upgrades fall into these buckets." });
      return table(
        [th("Bucket"), th("Mode"), th("Upgrades"), th("Shown RTP"), th("Real RTP", "Second line: 95% range")],
        visible.map(
          (r) => h(
            "tr",
            null,
            h("td", { class: "num", text: r.label ?? DASH }),
            h("td", { text: r.mode || DASH }),
            h("td", { class: "num", text: fmtInt(r.n) }),
            h("td", { class: "num", text: fmtPct(r.shownRtp, 1) }),
            h(
              "td",
              { class: "num" },
              h("span", { class: ok4(r.realRtp) ? signClass(r.realRtp - 1) : "", text: fmtPct(r.realRtp, 1) }),
              r.realRtpCI ? h("span", { class: "ci", text: fmtCI(r.realRtpCI) }) : null
            )
          )
        )
      );
    }
    function viewFactors() {
      const ev = state.events;
      const hasUp = ev.some((e) => e.kind === "upgrade" && e.status !== "pending");
      const hasCase = ev.some((e) => e.kind === "case");
      if (!hasUp && !hasCase) {
        return emptyState("Nothing to compare yet", "Factors compare your results by time, session and bet type. Record some events first.", goDataButton());
      }
      if (state.factorKind === "upgrade" && !hasUp) state.factorKind = "case";
      if (state.factorKind === "case" && !hasCase) state.factorKind = "upgrade";
      const kind = state.factorKind;
      const choices = FACTORS2.filter((f) => f.kinds.includes(kind));
      if (!choices.some((f) => f.key === state.factorKey)) state.factorKey = choices[0].key;
      const fdef = choices.find((f) => f.key === state.factorKey);
      const seg = h(
        "div",
        { class: "seg", role: "radiogroup", "aria-label": "Event kind" },
        [
          ["upgrade", "Upgrades", hasUp],
          ["case", "Cases", hasCase]
        ].map(
          ([k, label, enabled]) => h("button", {
            type: "button",
            role: "radio",
            "aria-checked": String(kind === k),
            tabindex: kind === k ? "0" : "-1",
            disabled: !enabled,
            "data-fk": `kind-${k}`,
            text: label,
            on: {
              click: () => setKind(k),
              keydown: (e) => {
                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                  e.preventDefault();
                  const other = k === "upgrade" ? "case" : "upgrade";
                  if (other === "case" && hasCase || other === "upgrade" && hasUp) setKind(other);
                }
              }
            }
          })
        )
      );
      function setKind(k) {
        state.factorKind = k;
        store.set("cst.ui.factorKind", k);
        state.pendingFocus = `kind-${k}`;
        render();
      }
      const select = h(
        "select",
        {
          "aria-label": "Factor",
          "data-fk": "factor-select",
          on: {
            change: (e) => {
              state.factorKey = e.target.value;
              store.set("cst.ui.factorKey", state.factorKey);
              state.pendingFocus = "factor-select";
              render();
            }
          }
        },
        choices.map((f) => h("option", { value: f.key, selected: f.key === state.factorKey, text: f.label }))
      );
      const out = [h("div", { class: "controls" }, seg, select)];
      const res = memo(`factor:${kind}:${fdef.key}`, () => call("factor", ev, fdef.key, { kind }));
      if (res.error) return [...out, errorBox(res.error)];
      const r = res.value || {};
      const rows = (r.rows || []).filter((x) => x && x.n > 0);
      if (!rows.length) {
        out.push(h("p", { class: "muted", text: `No ${kind === "upgrade" ? "upgrades" : "case opens"} with a value for this factor.` }));
        return out;
      }
      const isUp = kind === "upgrade";
      const hasAdj = isUp && rows.some((x) => ok4(x.zAdj));
      out.push(h("section", null, testCallout(r.test, kind, fdef)));
      if (hasAdj) {
        const bars = rows.map((x) => ({ label: x.label ?? x.value, n: x.n, value: ok4(x.zAdj) ? x.zAdj : null, significant: !!x.significantAdj }));
        out.push(
          h(
            "section",
            null,
            h("h3", { text: "How unusual each row is" }),
            diffBars({
              rows: bars,
              width: contentWidth(),
              clamp: [-6, 6],
              minSpan: 4,
              band: [-1.96, 1.96],
              fmt: (v) => "z " + fmtNumber(v, 1, { sign: true }),
              caption: `Adjusted z score per row by ${fdef.label}`
            }),
            h("p", {
              class: "hint",
              text: "Each bar compares the wins in that row with what the real odds curve expects for its bets (z score). The shaded band is \xB11.96: anything inside it is ordinary luck. Solid bars stay significant after correction for testing many rows."
            })
          )
        );
      } else {
        const bars = rows.map((x) => {
          if (isUp) {
            const e = num3(x.expectedRate);
            if (!(e > 0) || !ok4(x.winRate)) return { label: x.label ?? x.value, n: x.n, value: null };
            const ci2 = x.winRateCI || [];
            return {
              label: x.label ?? x.value,
              n: x.n,
              value: x.winRate / e - 1,
              lo: ok4(ci2[0]) ? ci2[0] / e - 1 : null,
              hi: ok4(ci2[1]) ? ci2[1] / e - 1 : null,
              significant: !!x.significant
            };
          }
          const ci = x.roiCI || [];
          return { label: x.label ?? x.value, n: x.n, value: x.roi, lo: ci[0], hi: ci[1], significant: !!x.significant };
        });
        out.push(
          h(
            "section",
            null,
            h("h3", { text: isUp ? "Wins compared with the shown odds" : "Return per row" }),
            diffBars({
              rows: bars,
              width: contentWidth(),
              caption: isUp ? `Wins relative to shown odds by ${fdef.label}` : `ROI by ${fdef.label}`
            }),
            h("p", {
              class: "hint",
              text: isUp ? "0 means you won exactly as often as the shown chance says. The line is the 95% range: if it crosses 0, the row is consistent with the shown odds. Solid bars are significant after correction, faded bars are not." : "0 means break even. The line is the 95% range. Solid bars are significant after correction, faded bars are not."
            })
          )
        );
      }
      const c = cur();
      const headers = isUp ? [
        th(fdef.label),
        th("Upgrades"),
        th("Win rate", "Second line: 95% Wilson interval"),
        th("Shown", "Average shown chance"),
        th("vs shown odds", "z score of wins against the shown chance; badge is Holm-corrected"),
        hasAdj ? th("vs real odds", "z score of wins against the real odds curve; badge is Holm-corrected") : null,
        th("ROI"),
        th("Net")
      ] : [th(fdef.label), th("Opens"), th("Spent"), th("ROI"), th("Net")];
      const trs = rows.map(
        (x) => isUp ? h(
          "tr",
          null,
          h("td", { text: String(x.label ?? x.value) }),
          h("td", { class: "num", text: fmtInt(x.n) }),
          rateCell(x.winRate, x.winRateCI),
          h("td", { class: "num", text: fmtPct(x.expectedRate, 1) }),
          zCell(x.z, x.significant, x.n),
          hasAdj ? zCell(x.zAdj, x.significantAdj, x.n) : null,
          roiCell(x.roi, null),
          moneyCell(x.net, true)
        ) : h(
          "tr",
          null,
          h("td", { text: String(x.label ?? x.value) }),
          h("td", { class: "num", text: fmtInt(x.n) }),
          moneyCell(x.cost),
          roiCell(x.roi, x.roiCI),
          moneyCell(x.net, true)
        )
      );
      out.push(h("section", null, h("div", { class: "section-head" }, h("h3", { text: "Table" }), c ? h("span", { class: "muted", text: `Money in ${c}` }) : null), table(headers, trs)));
      if (isUp) {
        out.push(
          h("p", {
            class: "hint",
            text: 'Win-rate columns use normal upgrades without the super-drop card (mystery upgrades have no shown chance). "vs real odds" is the fair test: low chances win more often than shown and high chances less, so a row full of low-chance bets looks lucky against the shown odds alone.'
          })
        );
      }
      return out;
    }
    function zCell(z, significant, n) {
      if (!ok4(z)) return h("td", { class: "num faint", text: DASH });
      let badge;
      if (!(n >= 10)) badge = h("span", { class: "badge", text: "Too few" });
      else if (significant) badge = h("span", { class: ["badge", z < 0 ? "bad" : "good"], text: z < 0 ? "Below" : "Above" });
      else badge = h("span", { class: "badge", text: "Noise" });
      return h("td", { class: "num" }, `z ${fmtNumber(z, 2, { sign: true })}`, h("span", { class: "second" }, badge));
    }
    function testCallout(t, kind, fdef) {
      if (!t || !ok4(t.p)) {
        return h(
          "div",
          { class: "callout neutral" },
          h("div", { class: "headline", text: "Not enough data for a test yet" }),
          h("p", { class: "detail", text: "Treat any differences below as random noise for now." })
        );
      }
      const isUp = kind === "upgrade";
      const statName = isUp ? "\u03C7\xB2" : "Test statistic";
      const dfText = ok4(t.df) ? `, df = ${fmtInt(t.df)}` : "";
      const shownLine = `${statName} = ${fmtNumber(t.statistic, 2)}${dfText}, ${fmtPEq(t.p)}`;
      const useAdj = isUp && ok4(t.pAdj);
      const sig = useAdj ? typeof t.significantAdj === "boolean" ? t.significantAdj : t.pAdj < 0.05 : !!t.significant;
      const lines = useAdj ? [
        `Adjusted for the real odds curve: ${statName} = ${fmtNumber(t.statisticAdj, 2)}${dfText}, ${fmtPEq(t.pAdj)}.`,
        `Against the shown odds only: ${shownLine}.`
      ] : [shownLine];
      const mixNote = useAdj && t.significant && !sig ? "Against the shown odds alone this factor looks significant. That comes from the mix of chance levels in each row (low chances win more than shown), not from the factor itself." : null;
      if (!sig) {
        return h(
          "div",
          { class: "callout neutral", role: "note" },
          h("div", { class: "headline", text: "No real effect: differences are within random noise." }),
          h("p", {
            class: "detail",
            text: `The ups and downs between rows are what luck alone produces. Do not plan when or how to play from "${fdef.label}".`
          }),
          mixNote ? h("p", { class: "detail", text: mixNote }) : null,
          lines.map((l) => h("p", { class: "detail", text: l }))
        );
      }
      return h(
        "div",
        { class: "callout warn", role: "note" },
        h("div", { class: "headline", text: "Possible real effect" }),
        h("p", {
          class: "detail",
          text: fdef.key === "superDrop" ? "Upgrades with the super-drop card shown win at a different rate. This is a site feature you cannot choose, not a pattern you can time." : `The rows differ more than luck usually explains. With ${FACTORS2.length} factors to look at, one can pass this test by chance, so check again after more data before acting on it.`
        }),
        lines.map((l) => h("p", { class: "detail", text: l }))
      );
    }
    const fileInput = h("input", {
      type: "file",
      accept: ".json,.csv,application/json,text/csv",
      class: "sr-only",
      tabindex: "-1",
      "aria-hidden": "true",
      on: {
        change: (e) => {
          const file = e.target.files && e.target.files[0];
          e.target.value = "";
          if (!file) return;
          run("file", () => o.onImportFile(file), (r) => `Imported ${fmtInt(num3(r && r.added))} new events from ${file.name}.`);
        }
      }
    });
    wrap.append(fileInput);
    async function run(name, fn, okText) {
      if (state.busy) return;
      state.busy = name;
      state.msg = { text: "Working\u2026", tone: "muted" };
      state.pendingFocus = name;
      render();
      try {
        if (typeof fn !== "function") throw new Error("not available");
        const r = await fn();
        state.msg = { text: okText(r), tone: "pos" };
      } catch (e) {
        state.msg = { text: `Failed: ${e && e.message || e}`, tone: "neg" };
      }
      state.busy = null;
      state.pendingFocus = name;
      render();
      doRefresh();
    }
    function cloudSection(cl, btn) {
      const on = !!cl.key;
      const sec = h("section", null, h("h3", { text: "Sync between browsers" }));
      if (!on) {
        const keyInput = h("input", {
          type: "text",
          class: "key-input",
          placeholder: "Paste the sync key from your other browser",
          autocomplete: "off",
          spellcheck: "false",
          "aria-label": "Sync key",
          "data-fk": "cloud-key-input",
          value: state.cloudKeyDraft || "",
          on: { input: (e) => state.cloudKeyDraft = e.target.value }
        });
        sec.append(
          h("p", {
            class: "hint",
            text: "Keeps one history in every browser you use (Brave, Chrome, another PC). Your events are stored in the tracker's cloud database under a secret key. Start in one browser, then paste the key in the others."
          }),
          h(
            "div",
            { class: "btns" },
            btn(
              "cloud-start",
              "Start cloud sync",
              "primary",
              () => run("cloud-start", () => o.onCloudStart(), () => "Cloud sync is on. Copy the key into your other browsers.")
            )
          ),
          h(
            "div",
            { class: "btns key-row" },
            keyInput,
            btn(
              "cloud-join",
              "Use key",
              "",
              () => run("cloud-join", () => o.onCloudJoin(state.cloudKeyDraft), (r) => {
                state.cloudKeyDraft = "";
                return `Cloud sync is on. ${fmtInt(num3(r && r.added))} events came from your other browsers.`;
              })
            )
          )
        );
        return sec;
      }
      const stateText = cl.state === "syncing" ? `Syncing\u2026 ${cl.progress || ""}` : cl.state === "error" ? `Failed: ${cl.error}` : ok4(cl.lastPull) ? `Up to date, checked ${fmtAgo(cl.lastPull)}` : "Waiting";
      const shown = state.cloudKeyShown ? h("input", {
        type: "text",
        readonly: true,
        class: "key-input key-shown",
        value: cl.key,
        "aria-label": "Sync key",
        "data-fk": "cloud-key-shown",
        spellcheck: "false",
        on: { focus: (e) => e.target.select(), click: (e) => e.target.select() }
      }) : `${cl.key.slice(0, 4)}${"\u2022".repeat(12)}`;
      sec.append(
        h(
          "dl",
          { class: "status" },
          h("dt", { text: "Cloud" }),
          h("dd", { class: cl.state === "error" ? "neg" : null }, h("span", { class: ["dot", cl.state === "error" ? "off" : "on"], "aria-hidden": "true" }), stateText),
          h("dt", { text: "Sync key" }),
          h("dd", { class: "num key-text" }, shown)
        ),
        h(
          "div",
          { class: "btns" },
          btn("cloud-copy", "Copy key", "primary", () => {
            const done = (text, tone) => {
              state.msg = { text, tone };
              state.pendingFocus = "cloud-copy";
              render();
            };
            const copied = () => done("Key copied. Paste it in Data \u2192 Sync between browsers in your other browser.", "pos");
            const failed = () => {
              state.cloudKeyShown = true;
              done("Could not copy. The key is shown in the box above: click it, then press Ctrl+C.", "neg");
            };
            if (typeof o.copyText === "function" && safe(() => o.copyText(cl.key)).value === true) copied();
            else {
              try {
                navigator.clipboard.writeText(cl.key).then(copied, failed);
              } catch {
                failed();
              }
            }
          }),
          btn("cloud-show", state.cloudKeyShown ? "Hide key" : "Show key", "", () => {
            state.cloudKeyShown = !state.cloudKeyShown;
            state.pendingFocus = "cloud-show";
            render();
          }),
          btn("cloud-sync", "Sync now", "", () => run("cloud-sync", () => o.onCloudSync(), (r) => `Cloud sync done: ${fmtInt(num3(r && r.added))} new events.`), {
            busyLabel: "Syncing\u2026",
            disabled: cl.state === "syncing"
          }),
          btn("cloud-stop", "Stop", "", () => run("cloud-stop", () => o.onCloudStop(), () => "Cloud sync is off in this browser. The cloud copy is kept."))
        ),
        h("p", {
          class: "hint",
          text: "Anyone with this key can read and change your history, so keep it private. Checks for new events every minute while the tab is open."
        })
      );
      return sec;
    }
    function viewData() {
      const ev = state.events;
      const c = cur();
      const st = safe(() => o.getStatus ? o.getStatus() : {}).value || {};
      const nCase = ev.filter((e) => e.kind === "case").length;
      const nUp = ev.filter((e) => e.kind === "upgrade").length;
      const nDep = ev.filter((e) => e.kind === "deposit").length;
      const nWd = ev.filter((e) => e.kind === "withdrawal").length;
      const nAccounts = state.accounts && Array.isArray(state.accounts.list) ? state.accounts.list.length : 1;
      const totalEvents = state.accounts && ok4(state.accounts.total) ? state.accounts.total : ev.length;
      const busy = !!state.busy;
      const btn = (name, label, cls, onClick, extra = {}) => h("button", {
        type: "button",
        class: ["btn", cls],
        "data-fk": name,
        disabled: busy || extra.disabled,
        "aria-busy": state.busy === name ? "true" : null,
        text: state.busy === name ? extra.busyLabel || "Working\u2026" : label,
        on: { click: onClick }
      });
      const out = [];
      if (!ev.length) {
        out.push(
          h(
            "section",
            null,
            h(
              "div",
              { class: "callout" },
              h("div", { class: "headline", text: "Nothing recorded yet" }),
              h("p", {
                class: "detail",
                text: "Capturing runs on its own while you open cases and upgrade. You can also import the history the site keeps for your account."
              })
            )
          )
        );
      }
      if (state.loadError) out.push(h("section", null, errorBox(state.loadError, "Could not read stored events")));
      out.push(
        h(
          "section",
          null,
          h("h3", { text: "Status" }),
          h(
            "dl",
            { class: "status" },
            h("dt", { text: "Capturing" }),
            h("dd", null, h("span", { class: ["dot", st.capturing ? "on" : "off"], "aria-hidden": "true" }), st.capturing ? "On" : "Off"),
            h("dt", { text: "Events stored" }),
            h("dd", {
              class: "num",
              text: `${fmtInt(ev.length)} (${fmtInt(nCase)} case drops, ${fmtInt(nUp)} upgrades${nDep ? `, ${fmtInt(nDep)} deposits` : ""}${nWd ? `, ${fmtInt(nWd)} withdrawals` : ""})`
            }),
            h("dt", { text: "Last event" }),
            h("dd", { class: "num", text: ok4(st.lastEventTs) ? `${fmtDateTime(st.lastEventTs)}, ${fmtAgo(st.lastEventTs)}` : "none yet" }),
            h("dt", { text: "Last sync" }),
            h("dd", { class: "num", text: st.syncing ? `Syncing\u2026 ${st.syncing}` : ok4(st.lastSync) ? `${fmtDateTime(st.lastSync)}, ${fmtAgo(st.lastSync)}` : "never" }),
            h("dt", { text: "Storage", title: "Whether the browser promised not to clear the stored history on its own" }),
            h("dd", { text: st.storagePersisted === true ? "Kept by the browser" : st.storagePersisted === false ? "Browser may clear it when space runs low" : DASH }),
            h("dt", { text: "Unknown responses", title: "Site responses the parser did not recognise" }),
            h("dd", { class: ["num", num3(st.unknownResponses) > 0 && "neg"], text: fmtInt(num3(st.unknownResponses)) }),
            h("dt", { text: "Version" }),
            h("dd", { class: "num", text: st.version || DASH }),
            c ? [h("dt", { text: "Currency" }), h("dd", { text: c })] : null
          )
        )
      );
      out.push(
        h(
          "section",
          null,
          h("h3", { text: "Sync" }),
          h(
            "div",
            { class: "btns" },
            btn(
              "history",
              "Sync with site",
              "primary",
              () => run("history", () => o.onImportHistory(), (r) => `Synced: ${fmtInt(num3(r && r.added))} new events from the site.`),
              { busyLabel: "Syncing\u2026", disabled: !!st.syncing }
            ),
            btn("file", "Import file", "", () => fileInput.click(), { busyLabel: "Importing\u2026" })
          ),
          h("p", {
            class: "hint",
            text: "Your history stays stored in this browser. Sync runs on its own when you open the site (at most every 15 minutes) and only fetches what is new. The first sync loads everything and takes several minutes. Import file accepts files from Export JSON."
          })
        )
      );
      if (st.cloud && typeof o.onCloudStart === "function") out.push(cloudSection(st.cloud, btn));
      const settings = safe(() => o.getSettings ? o.getSettings() : null).value;
      if (settings && typeof o.setSetting === "function") {
        out.push(
          h(
            "section",
            null,
            h("h3", { text: "Panels" }),
            h(
              "label",
              { class: "switch" },
              h("input", {
                type: "checkbox",
                checked: !!settings.upgradeOverlay,
                "data-fk": "set-overlay",
                on: {
                  change: (e) => {
                    safe(() => o.setSetting("upgradeOverlay", e.target.checked));
                    state.pendingFocus = "set-overlay";
                    render();
                  }
                }
              }),
              h("span", { text: "Upgrade odds card on the upgrade page" })
            ),
            h("p", {
              class: "hint",
              text: "Shows odds, EV and your real win rate for the selected upgrade. It recomputes over your whole history, so turn it off if the upgrade page lags."
            })
          )
        );
      }
      const exp = (format) => {
        try {
          if (typeof o.onExport !== "function") throw new Error("not available");
          o.onExport(format);
          state.msg = { text: `Export ${format.toUpperCase()} started.`, tone: "muted" };
        } catch (e) {
          state.msg = { text: `Export failed: ${e && e.message || e}`, tone: "neg" };
        }
        state.pendingFocus = `export-${format}`;
        render();
      };
      out.push(
        h(
          "section",
          null,
          h("h3", { text: "Export" }),
          h(
            "div",
            { class: "btns" },
            btn("export-json", "Export JSON", "", () => exp("json"), { disabled: !totalEvents }),
            btn("export-csv", "Export CSV", "", () => exp("csv"), { disabled: !totalEvents })
          ),
          nAccounts > 1 ? h("p", { class: "hint", text: "Exports hold the events of every account. Each event keeps its account id." }) : null
        )
      );
      const clearSection = h(
        "section",
        null,
        h("h3", { text: "Delete data" }),
        btn(
          "clear",
          "Clear all",
          "danger",
          () => {
            state.confirmClear = true;
            state.pendingFocus = "clear-cancel";
            render();
          },
          { disabled: !totalEvents || state.confirmClear }
        )
      );
      if (state.confirmClear) {
        clearSection.append(
          h(
            "div",
            { class: "confirm", role: "alertdialog", "aria-labelledby": "cst-confirm-text" },
            h("p", {
              id: "cst-confirm-text",
              text: `Delete all ${fmtInt(totalEvents)} recorded events${nAccounts > 1 ? ` of all ${nAccounts} accounts` : ""} from this browser? This cannot be undone. Export first if you want a backup.`
            }),
            h(
              "div",
              { class: "btns" },
              btn("clear-yes", "Delete everything", "danger-solid", () => {
                state.confirmClear = false;
                run("clear", () => o.onClear(), () => "All events deleted.");
              }),
              btn("clear-cancel", "Cancel", "", () => {
                state.confirmClear = false;
                state.pendingFocus = "clear";
                render();
              })
            )
          )
        );
      }
      out.push(clearSection);
      out.push(h("p", { class: ["msg", state.msg && state.msg.tone], role: "status", "aria-live": "polite", text: state.msg ? state.msg.text : "" }));
      return out;
    }
    doRefresh();
    return {
      refresh,
      destroy() {
        refresh.cancel();
        onResize.cancel();
        clearInterval(reattach);
        window.removeEventListener("keydown", onWindowKey);
        window.removeEventListener("resize", onResize);
        host.remove();
      }
    };
  }

  // src/ui/overlay.js
  var POS_KEY = "cst.ui.overlayPos";
  var COLLAPSED_KEY = "cst.ui.overlayCollapsed";
  var POLL_MS = 400;
  var MIN_HISTORY = 30;
  var REAL_MIN_N = 100;
  function curveRowFor(rows, chance) {
    if (!Array.isArray(rows) || !ok5(chance)) return null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !ok5(r.lo) || !ok5(r.hi)) continue;
      const last = i === rows.length - 1;
      if (chance >= r.lo && (chance < r.hi || last && chance <= r.hi)) return r;
    }
    return null;
  }
  var ok5 = (v) => typeof v === "number" && Number.isFinite(v);
  function icon(d) {
    return s(
      "svg",
      { viewBox: "0 0 16 16", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" },
      s("path", { d })
    );
  }
  var GRIP = "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01";
  var CHEVRON_UP = "M4 10l4-4 4 4";
  var CHEVRON_DOWN = "M4 6l4 4 4-4";
  var CLOSE = "M4.5 4.5l7 7M11.5 4.5l-7 7";
  function verdictFor(q, stake, currency, real = null, targetPrice = null) {
    if (real && ok5(real.rate) && ok5(targetPrice)) {
      const perTry = real.rate * targetPrice - stake;
      const sub2 = ok5(real.bucketRate) ? `At ${real.label || "this"} shown chance you really won ${fmtPct(real.bucketRate, 1)} vs ${fmtPct(real.bucketShown, 1)} shown (${fmtInt(real.n)} upgrades).` : `Real win rate from ${fmtInt(real.n)} of your upgrades at this level.`;
      if (Math.abs(perTry) < 5e-3) return { text: "On average you break even at these odds.", tone: "", sub: sub2 };
      return perTry < 0 ? { text: `On average you lose ${fmtMoney(-perTry, currency)} per try at these odds.`, tone: "neg", sub: sub2 } : { text: `On average you gain ${fmtMoney(perTry, currency)} per try at these odds.`, tone: "pos", sub: sub2 };
    }
    if (ok5(q.realEdge)) {
      const perTry = q.realEdge * stake;
      const sub2 = "Based on your own upgrades at similar chances.";
      if (Math.abs(perTry) < 5e-3) return { text: "On average you break even at these odds.", tone: "", sub: sub2 };
      return perTry < 0 ? { text: `On average you lose ${fmtMoney(-perTry, currency)} per try at these odds.`, tone: "neg", sub: sub2 } : { text: `On average you gain ${fmtMoney(perTry, currency)} per try at these odds.`, tone: "pos", sub: sub2 };
    }
    const sub = `By the shown odds only. Your real results here are unknown until ${MIN_HISTORY} upgrades at similar chances.`;
    if (!ok5(q.ev) || Math.abs(q.ev) < 5e-3) return { text: "By the shown odds you break even on average.", tone: "", sub };
    return q.ev < 0 ? { text: `On average you lose ${fmtMoney(-q.ev, currency)} per try at these odds.`, tone: "neg", sub } : { text: `The shown odds promise ${fmtMoney(q.ev, currency)} per try on average.`, tone: "", sub };
  }
  var pctCapped = (p) => p > 0.99 ? ">99%" : p < 0.01 ? "<1%" : fmtPct(p, 0);
  var OUTLOOK_TEXT = {
    "likely-profit": { text: "Likely profitable", tone: "pos" },
    "likely-loss": { text: "Likely losing", tone: "neg" },
    unclear: { text: "Unclear", tone: "" }
  };
  function outlookBlock(ol, currency, balance = null) {
    if (!ol || !OUTLOOK_TEXT[ol.verdict]) return null;
    const t = OUTLOOK_TEXT[ol.verdict];
    const ctx2 = ol.context || {};
    const kellyEl = kellyLine(ol, currency, balance);
    const since = ctx2.minutesSinceDeposit === null || !ok5(ctx2.minutesSinceDeposit) ? "No deposit recorded yet." : `${fmtDuration(ctx2.minutesSinceDeposit * 6e4)} since your last deposit, upgrade #${fmtInt((ctx2.upgradesSinceDeposit || 0) + 1)} after it, ${fmtMoney(ctx2.netSinceDeposit, currency, { sign: true })} since then.`;
    const rows = [];
    for (const w of ol.windows || []) {
      const cur = w.key === (ol.window && ol.window.key);
      const cls = cur ? "cur" : "";
      rows.push(
        h("span", { class: cls, text: (cur ? "Now: " : "") + w.label }),
        h("span", { class: ["num", cls], text: w.n ? fmtPct(w.realChance, 1) : DASH }),
        h("span", { class: ["num", cls], text: `n = ${fmtInt(w.n)}` })
      );
    }
    return h(
      "div",
      { class: ["outlook", t.tone], role: "status", "aria-live": "polite" },
      h(
        "div",
        { class: "ol-head" },
        h("span", { class: "ol-verdict", text: t.text }),
        h("span", {
          class: "ol-prob",
          title: `From your history: ${fmtPct(ol.probProfitable, 1)} chance that the real win rate here beats break-even, so the upgrade pays on average`,
          text: `${pctCapped(ol.verdict === "likely-loss" ? 1 - ol.probProfitable : ol.probProfitable)} ${ol.verdict === "unclear" ? "it pays" : "confident"}`
        })
      ),
      h(
        "p",
        { class: "ol-line" },
        "Real chance now ",
        h("b", { text: fmtPct(ol.realChance, 1) }),
        ` vs ${fmtChance(ol.chanceShown)} shown. Average `,
        h("b", { class: signClass(ol.ev), text: fmtMoney(ol.ev, currency, { sign: true }) }),
        ` per try (${fmtPct(ol.evPct, 1, { sign: true })}).`
      ),
      h("p", { class: "ol-line", text: since }),
      h("div", { class: "ol-win", "aria-label": `Real chance at ${ol.band} shown chance by time since deposit` }, ...rows),
      kellyEl
    );
  }
  function kellyLine(ol, currency, balance) {
    const k = ol.kelly;
    if (!k) return null;
    if (!(k.half > 0)) {
      return h("p", { class: "ol-kelly", text: "Suggested stake: 0 \u2014 skip this one." });
    }
    const amount = ok5(balance) && balance > 0 ? ` (\u2248 ${fmtMoney(k.half * balance, currency)})` : "";
    return h(
      "p",
      { class: "ol-kelly", title: "Half-Kelly: the stake that grows a bankroll fastest for this edge, halved because the real chance is an estimate" },
      "Suggested stake: ",
      h("b", { text: `${fmtPct(k.half, 1)} of balance` }),
      amount
    );
  }
  function mountUpgradeOverlay(opts = {}) {
    const o = opts;
    const stats = o.stats || {};
    const cur = () => {
      try {
        return String((o.currency && o.currency()) ?? "");
      } catch {
        return "";
      }
    };
    const { host, root } = createHost("caser-tracker-overlay", 2147482990);
    root.append(h("style", { text: BASE_CSS + OVERLAY_CSS }));
    const wrap = h("div", { class: "root" });
    root.append(wrap);
    let collapsed = !!store.get(COLLAPSED_KEY, false);
    let pos = store.get(POS_KEY, null);
    if (!pos || !ok5(pos.x) || !ok5(pos.y)) pos = null;
    const grip = h("button", { type: "button", class: "iconbtn grip", "aria-label": "Move card. Use arrow keys, hold Shift for bigger steps." }, icon(GRIP));
    const toggle = h("button", {
      type: "button",
      class: "iconbtn",
      on: {
        click: () => {
          collapsed = !collapsed;
          store.set(COLLAPSED_KEY, collapsed);
          applyCollapsed();
          clampAndPlace();
        }
      }
    });
    const off = typeof o.onTurnOff === "function" ? h("button", { type: "button", class: "iconbtn", "aria-label": "Turn off upgrade odds", title: "Turn off. Turn it back on in Stats, Data tab.", on: { click: () => o.onTurnOff() } }, icon(CLOSE)) : null;
    const bar = h("div", { class: "bar" }, grip, h("span", { class: "ttl", text: "Upgrade odds" }), toggle, off);
    const content = h("div", { class: "content", id: "cst-overlay-content" });
    const card = h("div", { class: "card", role: "region", "aria-label": "Upgrade odds", hidden: true }, bar, content);
    wrap.append(card);
    card.addEventListener("keydown", (e) => e.stopPropagation());
    function applyCollapsed() {
      card.classList.toggle("collapsed", collapsed);
      content.hidden = collapsed;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-controls", "cst-overlay-content");
      toggle.setAttribute("aria-label", collapsed ? "Expand upgrade odds" : "Collapse upgrade odds");
      toggle.replaceChildren(icon(collapsed ? CHEVRON_DOWN : CHEVRON_UP));
    }
    applyCollapsed();
    function clamp(p) {
      const w = card.offsetWidth || 300;
      const hh = card.offsetHeight || 40;
      const maxX = Math.max(0, window.innerWidth - w);
      const maxY = Math.max(0, window.innerHeight - hh);
      return { x: Math.min(Math.max(0, p.x), maxX), y: Math.min(Math.max(0, p.y), maxY) };
    }
    function place(p) {
      card.style.left = `${Math.round(p.x)}px`;
      card.style.top = `${Math.round(p.y)}px`;
    }
    function clampAndPlace() {
      if (card.hidden) return;
      if (!pos) pos = { x: window.innerWidth - (card.offsetWidth || 300) - 16, y: 96 };
      place(clamp(pos));
    }
    let drag = null;
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button") && !e.target.closest(".grip")) return;
      const r = card.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.setPointerCapture(e.pointerId);
      card.classList.add("dragging");
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      pos = clamp({ x: e.clientX - drag.dx, y: e.clientY - drag.dy });
      place(pos);
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      card.classList.remove("dragging");
      store.set(POS_KEY, pos);
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);
    grip.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 64 : 16;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      pos = clamp({ x: r.left + d[0], y: r.top + d[1] });
      place(pos);
      store.set(POS_KEY, pos);
    });
    const onResize = debounce(() => {
      if (pos) pos = clamp(pos);
      clampAndPlace();
    }, 120);
    window.addEventListener("resize", onResize);
    let events = [];
    let curveRows = null;
    let olModel = null;
    let version = 0;
    let loading = false;
    let again = false;
    async function loadEvents() {
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      try {
        const ev = await o.getEvents();
        events = Array.isArray(ev) ? ev : [];
      } catch (e) {
        console.warn("[caser-tracker] overlay could not read events", e);
      }
      const curve = safe(() => typeof stats.calibrationCurve === "function" ? stats.calibrationCurve(events) : null);
      curveRows = Array.isArray(curve.value) ? curve.value : null;
      const m = safe(() => typeof stats.outlookModel === "function" ? stats.outlookModel(events) : null);
      olModel = m.value || null;
      quoteCache = null;
      loading = false;
      version += 1;
      if (again) {
        again = false;
        loadEvents();
      }
    }
    const refresh = debounce(loadEvents, 300);
    let lastKey = null;
    let lastVersion = -1;
    let quoteCache = null;
    function tick() {
      attach(host);
      let sel = null;
      try {
        sel = o.getSelection ? o.getSelection() : null;
      } catch {
        sel = null;
      }
      const key = sel ? `${sel.stake}|${sel.targetPrice}|${sel.chanceShown}|${cur()}|${Math.floor(Date.now() / 15e3)}` : "";
      if (key === lastKey && version === lastVersion) return;
      lastKey = key;
      lastVersion = version;
      if (!sel) {
        card.hidden = true;
        return;
      }
      const wasHidden = card.hidden;
      card.hidden = false;
      renderContent(sel);
      if (wasHidden || pos) clampAndPlace();
    }
    function renderContent(sel) {
      const c = cur();
      const stake = Number(sel.stake);
      const targetPrice = Number(sel.targetPrice);
      if (!(stake > 0) || !(targetPrice > 0)) {
        content.replaceChildren(h("p", { class: "muted", text: "Pick your items and a target item to see the odds." }));
        return;
      }
      const input = { stake, targetPrice };
      if (ok5(sel.chanceShown)) input.chanceShown = sel.chanceShown;
      const qKey = `${stake}|${targetPrice}|${input.chanceShown}|${version}`;
      const res = quoteCache && quoteCache.key === qKey ? quoteCache.res : safe(() => {
        if (typeof stats.upgradeQuote !== "function") throw new Error("stats.upgradeQuote is missing");
        return stats.upgradeQuote(input, events);
      });
      quoteCache = { key: qKey, res };
      if (res.error || !res.value) {
        content.replaceChildren(h("p", { class: "error", role: "alert", text: `Could not compute odds: ${res.error && res.error.message || "no result"}` }));
        return;
      }
      const q = res.value;
      const chance = ok5(q.chanceShown) ? q.chanceShown : ok5(sel.chanceShown) ? sel.chanceShown : null;
      const row = curveRowFor(curveRows, chance);
      const real = row && row.n >= REAL_MIN_N && ok5(row.winRate) && ok5(chance) ? {
        rate: row.expectedRate > 0 ? Math.min(1, chance / 100 * (row.winRate / row.expectedRate)) : row.winRate,
        bucketRate: row.winRate,
        bucketShown: row.expectedRate,
        n: row.n,
        label: row.label
      } : null;
      const v = verdictFor(q, stake, c, real, targetPrice);
      const sim = q.similar || {};
      const lr = q.longRun || {};
      const kv = h(
        "dl",
        { class: "kv" },
        h("dt", { text: "Shown chance" }),
        h("dd", { class: "num", text: fmtChance(q.chanceShown) }),
        real ? h("dt", { text: "Real chance at this level", title: `Your real win rate for ${real.label || "this"} shown chance` }) : null,
        real ? h(
          "dd",
          { class: ["num", signClass(real.rate - (chance || 0) / 100)] },
          fmtPct(real.rate, 1),
          h("span", { class: "ci", text: `(n = ${fmtInt(real.n)})` })
        ) : null,
        h("dt", { text: "Fair chance", title: "Stake divided by target price" }),
        h("dd", { class: "num", text: fmtChance(q.chanceFair) }),
        h("dt", { text: "Multiplier" }),
        h("dd", { class: "num", text: fmtMult(q.multiplier) }),
        h("dt", { text: "EV per try", title: "Expected value by the shown chance" }),
        h(
          "dd",
          { class: ["num", signClass(q.ev)] },
          fmtMoney(q.ev, c, { sign: true }),
          h("span", { class: "ci", text: `${fmtPct(q.evPct, 1, { sign: true })} of stake` })
        ),
        h("dt", { text: "Real edge", title: "From your history at similar chances: real return minus 1" }),
        ok5(q.realEdge) ? h("dd", { class: ["num", signClass(q.realEdge)], text: fmtPct(q.realEdge, 1, { sign: true }) }) : h("dd", { class: "muted" }, "not enough data", h("span", { class: "ci", text: `needs ${MIN_HISTORY} upgrades` })),
        h("dt", { text: "Your similar tries", title: "Same chance bucket and same stake bucket" }),
        sim.n ? h(
          "dd",
          { class: "num" },
          `${fmtPct(sim.winRate, 1)} won`,
          h("span", { class: "ci", text: `${fmtCI(sim.winRateCI)}, n = ${fmtInt(sim.n)}` })
        ) : h("dd", { class: "muted", text: "none yet" })
      );
      const longRun2 = h(
        "div",
        { class: "longrun" },
        h("div", { class: "lt", text: `${fmtInt(lr.tries || 100)} tries like this${lr.basis === "history" ? ", at your real return" : ", at the shown odds"}` }),
        h("div", { class: "line" }, h("span", { text: "Average net" }), h("span", { class: ["num", signClass(lr.mean)], text: fmtMoney(lr.mean, c, { sign: true }) })),
        h(
          "div",
          { class: "line" },
          h("span", { text: "5\u201395% range" }),
          h("span", { class: "num", text: ok5(lr.p05) && ok5(lr.p95) ? `${fmtMoney(lr.p05, "", { sign: true })} to ${fmtMoney(lr.p95, c, { sign: true })}` : DASH })
        ),
        h("div", { class: "line" }, h("span", { text: "Chance to end in profit" }), h("span", { class: "num", text: fmtPct(lr.probProfit, 0) }))
      );
      const ol = safe(() => typeof stats.upgradeOutlook === "function" ? stats.upgradeOutlook(input, events, { now: Date.now(), model: olModel || void 0 }) : null);
      let balance = null;
      try {
        const hv = o.getHoldings ? o.getHoldings() : null;
        if (hv && ok5(hv.balance)) balance = hv.balance;
      } catch {
      }
      const olEl = ol.value ? outlookBlock(ol.value, c, balance) : null;
      content.replaceChildren(
        ...olEl ? [olEl] : [h("p", { class: ["verdict", v.tone], role: "status", "aria-live": "polite", text: v.text }), h("p", { class: "verdict-sub", text: v.sub })],
        kv,
        longRun2
      );
    }
    const timer = setInterval(tick, POLL_MS);
    loadEvents().then(tick);
    return {
      refresh,
      destroy() {
        clearInterval(timer);
        refresh.cancel();
        onResize.cancel();
        window.removeEventListener("resize", onResize);
        host.remove();
      }
    };
  }

  // src/ui/casepanel.js
  var COLLAPSED_KEY2 = "cst.ui.casePanelCollapsed";
  var POLL_MS2 = 500;
  function icon2(d) {
    return s(
      "svg",
      { viewBox: "0 0 16 16", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" },
      s("path", { d })
    );
  }
  var CHEVRON_UP2 = "M4 10l4-4 4 4";
  var CHEVRON_DOWN2 = "M4 6l4 4 4-4";
  function mountCasePanel(o) {
    const cur = () => {
      try {
        return String((o.currency && o.currency()) ?? "");
      } catch {
        return "";
      }
    };
    const { host, root } = createHost("caser-tracker-cases", 2147482980);
    root.append(h("style", { text: BASE_CSS + CASE_PANEL_CSS }));
    const wrap = h("div", { class: "root" });
    root.append(wrap);
    let collapsed = !!store.get(COLLAPSED_KEY2, false);
    const toggle = h("button", {
      type: "button",
      class: "iconbtn",
      "aria-controls": "cst-case-content",
      on: {
        click: () => {
          collapsed = !collapsed;
          store.set(COLLAPSED_KEY2, collapsed);
          applyCollapsed();
        }
      }
    });
    const ttl = h("span", { class: "ttl", text: "Case contents" });
    const bar = h("div", { class: "bar" }, ttl, toggle);
    const content = h("div", { class: "content", id: "cst-case-content" });
    const panel = h("div", { class: "cpanel", role: "region", "aria-label": "Case contents", hidden: true }, bar, content);
    wrap.append(panel);
    panel.addEventListener("keydown", (e) => e.stopPropagation());
    function applyCollapsed() {
      panel.classList.toggle("collapsed", collapsed);
      content.hidden = collapsed;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", collapsed ? "Expand case contents" : "Collapse case contents");
      toggle.replaceChildren(icon2(collapsed ? CHEVRON_DOWN2 : CHEVRON_UP2));
    }
    applyCollapsed();
    let slug = null;
    let loadId = 0;
    async function load(forSlug) {
      const id = ++loadId;
      ttl.textContent = "Case contents";
      content.replaceChildren(h("p", { class: "muted pad", text: "Loading items\u2026" }));
      let info = null;
      let error = null;
      try {
        info = await o.getInfo(forSlug);
      } catch (e) {
        error = e;
      }
      if (id !== loadId) return;
      if (error || !info) {
        content.replaceChildren(h("p", { class: "error pad", role: "alert", text: error ? `Could not load the case items: ${error.message || error}` : "The site sent no items for this case." }));
        return;
      }
      const res = safe(() => o.stats.caseOdds(info));
      if (res.error || !res.value) {
        content.replaceChildren(h("p", { class: "error pad", role: "alert", text: "Could not compute the case outcomes." }));
        return;
      }
      render(info, res.value);
    }
    function render(info, odds) {
      const c = cur();
      ttl.textContent = info.title;
      const multText = (m) => m === null ? "" : fmtMult(m);
      const outcome = (label, it) => h(
        "div",
        { class: "box" },
        h("div", { class: "k", text: label }),
        h("div", { class: "v num" }, it ? fmtMoney(it.price, c) : DASH, it && odds.casePrice > 0 ? h("span", { class: ["x", signClass(it.price - odds.casePrice)], text: multText(it.price / odds.casePrice) }) : null),
        h("div", { class: "s", title: it ? it.name : "", text: it ? it.name : "" })
      );
      let evBox;
      if (odds.hasChances) {
        const ratio = odds.evRatio;
        evBox = h(
          "div",
          { class: "box wide" },
          h("div", { class: "k", text: "Expected value per open", title: "Sum of item price \xD7 the chance the site shows" }),
          h(
            "div",
            { class: "v num" },
            fmtMoney(odds.ev, c),
            ratio !== null ? h("span", { class: ["x", signClass(ratio - 1)], text: `return ${fmtNumber(ratio, 3)}` }) : null
          ),
          h("div", { class: "s", text: odds.casePrice > 0 ? `${fmtMoney(odds.ev - odds.casePrice, c, { sign: true })} per open on average, by the site's chances.` : "Free case." })
        );
      } else {
        evBox = h(
          "div",
          { class: "box wide" },
          h("div", { class: "k", text: "Expected value per open" }),
          h("div", { class: "v muted", text: "Not available" }),
          h("div", { class: "s wrap", text: "The site does not publish drop chances for this case, only prices." })
        );
      }
      const head = h(
        "div",
        { class: "sum" },
        h("p", { class: "meta" }, `${fmtInt(odds.n)} items \xB7 case price `, h("b", { class: "num", text: odds.casePrice > 0 ? fmtMoney(odds.casePrice, c) : "free" })),
        h("div", { class: "grid" }, outcome("Cheapest drop", odds.min), outcome("Best drop", odds.max), evBox)
      );
      const rows = odds.items.map(
        (it) => h(
          "li",
          { class: "item" },
          it.image ? h("img", { src: it.image, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }) : h("span", { class: "noimg" }),
          h("span", { class: "name", title: it.name, text: it.name }),
          h(
            "span",
            { class: "r" },
            h("span", { class: "price num", text: fmtMoney(it.price, c) }),
            h("span", { class: "second num" }, it.mult !== null ? h("span", { class: signClass(it.mult - 1), text: fmtMult(it.mult) }) : null, odds.hasChances && it.mult !== null ? " \xB7 " : null, odds.hasChances ? fmtChance(it.chance, it.chance < 0.01 ? 4 : it.chance < 1 ? 3 : 2) : null)
          )
        )
      );
      const listHead = h("div", { class: "lhead" }, h("span", { text: "Item" }), h("span", { text: odds.hasChances ? "Price \xB7 \xD7case \xB7 chance" : "Price \xB7 \xD7case" }));
      content.replaceChildren(head, listHead, h("ul", { class: "items" }, ...rows));
    }
    function tick() {
      attach(host);
      let next = null;
      try {
        next = o.getSlug();
      } catch {
        next = null;
      }
      if (next === slug) return;
      slug = next;
      if (!slug) {
        loadId++;
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      load(slug);
    }
    const timer = setInterval(tick, POLL_MS2);
    tick();
    return {
      destroy() {
        clearInterval(timer);
        host.remove();
      }
    };
  }

  // src/ui/exchangepanel.js
  var COLLAPSED_KEY3 = "cst.ui.exchangeCollapsed";
  var SORT_KEY = "cst.ui.exchangeSort";
  var BASIS_KEY = "cst.ui.exchangeBasis";
  var MIN_SALES_KEY = "cst.ui.exchangeMinSales";
  var POLL_MS3 = 500;
  var okNum2 = (v) => typeof v === "number" && Number.isFinite(v);
  var usd = (v, opts) => okNum2(v) ? (v < 0 ? "\u2212$" : opts?.sign && v > 0 ? "+$" : "$") + fmtNumber(Math.abs(v), 2) : DASH;
  var feePct = `${fmtNumber(CSFLOAT_SELLER_FEE * 100, 0)}%`;
  function icon3(d) {
    return s("svg", { viewBox: "0 0 16 16", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }, s("path", { d }));
  }
  var sold30 = (m) => `${fmtInt(m.sales30d)}${m.salesCapped ? "+" : ""}`;
  function splitText(m) {
    const sp = m?.split;
    if (!sp) return null;
    return `Two price groups: ${fmtPct(sp.lowShare, 0)} of sales at ${usd(sp.lowMin)}\u2013${usd(sp.lowMax)}, the rest at ${usd(sp.highMin)}\u2013${usd(sp.highMax)} (pattern, phase or float). Prices use the lower group; the upper group is upside you only see once you hold the item.`;
  }
  function sourceText(m) {
    if (!m) return "";
    if (m.source === "sales") return `median of ${m.used} ${m.split ? "lower-group " : ""}sales in the last ${m.windowDays} days`;
    if (m.source === "reference") return "CSFloat base price (fewer than 3 recent sales)";
    if (m.source === "last") return "last sale only";
    return "no CSFloat sales";
  }
  function trendTag(m) {
    if (!m || !okNum2(m.trend) || Math.abs(m.trend) < 0.01) return null;
    return h("span", { class: signClass(m.trend), title: "Median of the last 14 days against days 14 to 90", text: `${m.trend > 0 ? "\u25B2" : "\u25BC"}${fmtPct(Math.abs(m.trend), 1)}` });
  }
  function detail(name, m, basis, width) {
    if (!m) return h("div", { class: "detail" }, h("p", { class: "faint", text: "Loading CSFloat sales\u2026" }));
    const stat = (k, v, extra) => h("div", { class: "st" }, h("div", { class: "k", text: k }), h("div", { class: "v num" }, v, extra ?? null));
    const fmtRange = okNum2(m.low) && okNum2(m.high) ? `${usd(m.low)} \u2013 ${usd(m.high)}` : DASH;
    return h(
      "div",
      { class: "detail" },
      salesChart({ points: expandPoints(m.pts), typical: m.source === "sales" ? m.value : null, fast: m.source === "sales" ? m.quick : null, base: m.basePrice, upper: m.split?.upper ?? null, width, height: 130 }),
      m.split ? h("p", { class: "warnline", text: splitText(m) }) : null,
      h(
        "div",
        { class: "stats" },
        stat("You get, typical", usd(m.net), basis === "typical" ? h("span", { class: "tag", text: "ranked" }) : null),
        stat("You get, fast sale", usd(m.quickNet), basis === "fast" ? h("span", { class: "tag", text: "ranked" }) : null),
        stat("Listed now", okNum2(m.listings) ? fmtInt(m.listings) : DASH),
        stat("Typical price", usd(m.value)),
        stat("Fast-sale price", usd(m.quick)),
        stat("CSFloat base", usd(m.basePrice)),
        stat("Range of used sales", fmtRange),
        stat("Trend 14 d", okNum2(m.trend) ? h("span", { class: signClass(m.trend), text: fmtPct(m.trend, 1, { sign: true }) }) : DASH),
        stat("Sold 7 d / 30 d", `${fmtInt(m.sales7d)}${m.salesCapped && m.sales7d === m.n ? "+" : ""} / ${sold30(m)}`)
      ),
      h(
        "div",
        { class: "dfoot" },
        h("span", { class: "faint", text: `Typical = ${sourceText(m)}. You get = price minus CSFloat's ${feePct} seller fee.` }),
        h("a", { href: marketUrl(name), target: "_blank", rel: "noopener noreferrer", on: { click: (e) => e.stopPropagation() }, text: "Listings \u2197" })
      )
    );
  }
  function mountExchangePanel(o) {
    const cur = () => {
      try {
        return String((o.currency && o.currency()) ?? "");
      } catch {
        return "";
      }
    };
    const { host, root } = createHost("caser-tracker-exchange", 2147482990);
    root.append(h("style", { text: BASE_CSS + EXCHANGE_CSS }));
    const wrap = h("div", { class: "root" });
    root.append(wrap);
    let collapsed = !!store.get(COLLAPSED_KEY3, false);
    let sort = store.get(SORT_KEY, "value") === "sales" ? "sales" : "value";
    let basis = store.get(BASIS_KEY, "typical") === "fast" ? "fast" : "typical";
    let minSales = Number(store.get(MIN_SALES_KEY, 3)) || 3;
    let openId = null;
    const toggle = h("button", {
      type: "button",
      class: "iconbtn",
      on: {
        click: () => {
          collapsed = !collapsed;
          store.set(COLLAPSED_KEY3, collapsed);
          applyCollapsed();
        }
      }
    });
    const ttl = h("span", { class: "ttl", text: "Exchange by CSFloat sell value" });
    const status = h("span", { class: "status num" });
    const content = h("div", { class: "content" });
    const panel = h("div", { class: "xpanel", role: "region", "aria-label": "Exchange by CSFloat sell value", hidden: true }, h("div", { class: "bar" }, ttl, status, toggle), content);
    let revealOpen = false;
    wrap.append(panel);
    panel.addEventListener("keydown", (e) => e.stopPropagation());
    function applyCollapsed() {
      panel.classList.toggle("collapsed", collapsed);
      content.hidden = collapsed;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", collapsed ? "Expand exchange panel" : "Collapse exchange panel");
      toggle.replaceChildren(icon3(collapsed ? "M4 6l4 4 4-4" : "M4 10l4-4 4 4"));
    }
    applyCollapsed();
    const results = /* @__PURE__ */ new Map();
    let state = null;
    let stateKey = "";
    let loadId = 0;
    let renderQueued = false;
    function queueRender() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        render();
      });
    }
    function loadPrices(names) {
      const id = ++loadId;
      for (const name of names) {
        const hit = o.prices.cached(name);
        if (hit) results.set(name, { summary: hit, error: null });
      }
      queueRender();
      (async () => {
        for (const name of names) {
          if (id !== loadId) return;
          if (results.get(name)?.summary) continue;
          try {
            results.set(name, { summary: await o.prices.get(name), error: null });
          } catch (e) {
            results.set(name, { summary: null, error: String(e?.message || e) });
          }
          if (id === loadId) queueRender();
        }
      })();
    }
    function setPref(fn) {
      fn();
      render();
    }
    function seg(label, value, options, onPick) {
      return h(
        "span",
        { class: "seg", role: "group", "aria-label": label },
        ...options.map(([v, text, tip]) => h("button", { type: "button", title: tip, "aria-pressed": String(value === v), text, on: { click: () => onPick(v) } }))
      );
    }
    function toggleOpen(id) {
      openId = openId === id ? null : id;
      revealOpen = openId !== null;
      render();
    }
    function render() {
      if (!state) {
        content.replaceChildren(h("p", { class: "muted pad", text: "Waiting for the site to load the replacement list\u2026" }));
        return;
      }
      const prevScroll = content.querySelector(".items")?.scrollTop ?? 0;
      const c = cur();
      const curName = state.current?.name ?? null;
      const curMarket = curName ? results.get(curName)?.summary ?? null : null;
      const curSell = o.stats.sellValue(curMarket, basis);
      const rows = o.stats.rankCandidates(state.candidates, (n) => results.get(n), { minSales, sort, basis, currentValue: curSell });
      const names = new Set([curName, ...state.candidates.map((x) => x.name)].filter(Boolean));
      const done = [...names].filter((n) => results.has(n)).length;
      const best = rows.find((r) => r.liquid) ?? null;
      const basisWord = basis === "fast" ? "fast sale" : "typical";
      const curOpen = openId === "@current";
      const yourBox = h(
        "button",
        {
          type: "button",
          class: ["box", "clickable", curOpen ? "open" : null],
          "aria-expanded": String(curOpen),
          title: "Show the sales chart for your item",
          disabled: !curName,
          on: { click: () => toggleOpen("@current") }
        },
        h("div", { class: "k", text: `Your item, you get (${basisWord})` }),
        h("div", { class: "v num" }, usd(curSell), trendTag(curMarket) ? h("span", { class: "x" }, trendTag(curMarket)) : null),
        h("div", { class: "s", title: curName ?? "", text: curName ? `${curMarket ? `${sold30(curMarket)} sold / 30 d \xB7` : ""}${curName}` : "Item name unknown" })
      );
      const bestBox = h(
        "div",
        { class: "box" },
        h("div", { class: "k", text: `Best swap, ${minSales}+ sales / 30 d` }),
        h("div", { class: "v num" }, best ? usd(best.sell) : DASH, best && best.delta !== null ? h("span", { class: ["x", signClass(best.delta)], text: usd(best.delta, { sign: true }) }) : null),
        h("div", { class: "s", title: best?.name ?? "", text: best ? best.name : done < names.size ? "Loading prices\u2026" : "None liquid enough" })
      );
      const minSel = h(
        "select",
        {
          "aria-label": "Minimum sales in 30 days",
          on: {
            change: (e) => {
              minSales = Number(e.target.value) || 1;
              store.set(MIN_SALES_KEY, minSales);
              render();
            }
          }
        },
        ...[1, 3, 5, 10, 20].map((n) => h("option", { value: String(n), selected: n === minSales, text: `${n}+ sales` }))
      );
      const tools = h(
        "div",
        { class: "tools" },
        h(
          "span",
          { class: "tg" },
          "Price",
          seg("Sell price", basis, [
            ["typical", "Typical", "Median recent sale price, after the fee"],
            ["fast", "Fast sale", "25th percentile of recent sales, after the fee: priced to sell quickly"]
          ], (v) => setPref(() => store.set(BASIS_KEY, basis = v)))
        ),
        h(
          "span",
          { class: "tg" },
          "Sort",
          seg("Sort", sort, [
            ["value", "Value"],
            ["sales", "Sales"]
          ], (v) => setPref(() => store.set(SORT_KEY, sort = v)))
        ),
        h("span", { class: "tg" }, "Liquid at", minSel)
      );
      status.textContent = done < names.size ? `prices ${done}/${names.size}` : `${fmtInt(rows.length)} items`;
      let sepDone = false;
      const items = [];
      rows.forEach((r, i) => {
        const m = r.market;
        const sep = !r.liquid && !sepDone && i > 0;
        if (!r.liquid) sepDone = true;
        const open = openId === r.id;
        const sub = `site ${fmtMoney(r.price, c)}${r.refund ? ` \xB7 refund ${fmtMoney(r.refund, c)}` : ""}`;
        const second = r.error ? h("span", { class: "neg", text: "no price" }) : !m ? "loading\u2026" : [`${sold30(m)} sold`, trendTag(m) ? " " : null, trendTag(m)];
        const title = r.error ? r.error : m ? `${r.name}
Typical ${usd(m.value)}, fast sale ${usd(m.quick)} (${sourceText(m)}).${m.split ? `
${splitText(m)}` : ""}
${sold30(m)} sold in 30 days${okNum2(m.listings) ? `, ${fmtInt(m.listings)} listed now` : ""}.
Click for the sales chart.` : r.name;
        const spark = m && m.pts?.length ? salesSparkline({ points: expandPoints(m.pts).filter((p) => Date.now() - p.ts <= 90 * 864e5), typical: m.source === "sales" ? m.value : null }) : null;
        const activate = () => {
          o.selectCandidate?.(r.id);
          toggleOpen(r.id);
        };
        items.push(
          h(
            "li",
            {
              class: ["item", r.liquid ? null : "illiquid", sep ? "sep" : null, open ? "open" : null],
              title,
              tabIndex: 0,
              "aria-expanded": String(open),
              on: {
                click: activate,
                keydown: (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate();
                  }
                }
              }
            },
            h("span", { class: "rank num", text: r.liquid ? String(i + 1) : "" }),
            r.image ? h("img", { src: r.image, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }) : h("span", { class: "noimg" }),
            h("span", { class: "mid" }, h("span", { class: "name", text: r.name }), h("span", { class: "sub num", text: sub })),
            h("span", { class: "sp" }, spark),
            h(
              "span",
              { class: "r" },
              h(
                "span",
                { class: "price num" },
                usd(r.sell),
                m?.source && m.source !== "sales" ? h("span", { class: "flag", title: sourceText(m), text: "*" }) : null,
                m?.split ? h("span", { class: "flag", title: splitText(m), text: "\xB2" }) : null,
                r.delta !== null ? h("span", { class: ["delta", signClass(r.delta)], text: usd(r.delta, { sign: true }) }) : null
              ),
              h("span", { class: "second num" }, second)
            )
          )
        );
        if (open) items.push(h("li", { class: "dwrap", on: { click: (e) => e.stopPropagation() } }, detail(r.name, m, basis, 414)));
      });
      content.replaceChildren(
        h(
          "div",
          { class: "sum" },
          h("div", { class: "grid" }, yourBox, bestBox),
          curOpen && curName ? h("div", { class: "curdetail" }, detail(curName, curMarket, basis, 388)) : null,
          tools
        ),
        h("div", { class: "lhead" }, h("span", { text: "Item \xB7 site price" }), h("span", { text: `You get (${basisWord}) \xB7 vs yours \xB7 sold 30 d` })),
        items.length ? h("ul", { class: "items" }, ...items) : h("p", { class: "muted pad", text: "The site offered no items." }),
        h(
          "div",
          { class: "note", text: `You get = recent CSFloat sale prices minus the ${feePct} seller fee. * = under 3 recent sales. \xB2 = two price groups, priced on the lower one. Float and stickers move prices. A row click opens its chart and selects it on the site; you confirm there.` }
        )
      );
      const list = content.querySelector(".items");
      if (list) list.scrollTop = prevScroll;
      if (revealOpen && list) {
        revealOpen = false;
        const d = list.querySelector(".dwrap");
        const row = d?.previousElementSibling;
        if (d && row) {
          const lr = list.getBoundingClientRect();
          const bottom = d.getBoundingClientRect().bottom;
          if (bottom > lr.bottom) list.scrollTop += Math.min(bottom - lr.bottom, row.getBoundingClientRect().top - lr.top);
        }
      }
    }
    function tick() {
      attach(host);
      let open = false;
      try {
        open = o.isOpen();
      } catch {
      }
      if (!open) {
        if (!panel.hidden) {
          panel.hidden = true;
          loadId++;
          state = null;
          stateKey = "";
          openId = null;
        }
        return;
      }
      panel.hidden = false;
      let next = null;
      try {
        next = o.getState();
      } catch {
      }
      const key = next ? `${next.itemId}|${next.current?.name ?? ""}|${next.candidates.map((x) => x.id).join(",")}` : "";
      if (key === stateKey) return;
      stateKey = key;
      state = next;
      openId = null;
      if (state) loadPrices([state.current?.name, ...state.candidates.map((x) => x.name)].filter(Boolean));
      render();
    }
    const timer = setInterval(tick, POLL_MS3);
    tick();
    return {
      destroy() {
        clearInterval(timer);
        host.remove();
      }
    };
  }

  // src/main.js
  var VERSION = true ? "0.9.1" : "dev";
  var pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  var site = location.hostname.replace(/^www\./, "");
  var ctx = new Context();
  var store2 = new Store(indexedDB);
  var sharedGm = gmStorage();
  var shared = sharedGm && createSharedStore(sharedGm);
  var browserPrefs = sharedGm ? { get: (k) => sharedGm.get(k, null), set: (k, v) => sharedGm.set(k, v) } : { get: (k) => store.get(k, null), set: (k, v) => store.set(k, v) };
  var lastAuth = null;
  var lastEventTs = null;
  var unknownResponses = 0;
  var dashboard = null;
  var overlay = null;
  var memEvents = null;
  var memIndex = null;
  var memLoad = null;
  function getEvents() {
    if (memEvents) return Promise.resolve(memEvents.slice());
    if (!memLoad) {
      memLoad = store2.allEvents().then((list) => {
        memEvents = list;
        memIndex = new Map(list.map((e, i) => [e.id, i]));
        memLoad = null;
        return list;
      }, (err) => {
        memLoad = null;
        throw err;
      });
    }
    return memLoad.then((list) => list.slice());
  }
  var accountSel = "current";
  var userAuth = null;
  var userCheck = null;
  function ensureUser() {
    const auth = getAuth();
    if (!auth || ctx.userId != null && auth === userAuth) return Promise.resolve(ctx.userId);
    if (!userCheck) {
      userCheck = (async () => {
        try {
          const res = await origFetch("/api/users/me", { headers: { Accept: "application/json", Authorization: auth } });
          if (res.ok) {
            const before = ctx.userId;
            const nameBefore = ctx.userName;
            ctx.learn({ method: "GET", path: "/users/me", status: 200, resBody: await res.json() });
            userAuth = auth;
            if (ctx.userId !== before || ctx.userName !== nameBefore) onAccountSeen(before);
          }
        } catch (err) {
          console.warn("[caser-tracker] could not read the signed-in account", err);
        } finally {
          userCheck = null;
        }
        return ctx.userId;
      })();
    }
    return userCheck;
  }
  function knownAccounts() {
    const v = browserPrefs.get("accounts");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  function rememberAccount() {
    if (ctx.userId == null) return;
    const known = knownAccounts();
    const name = ctx.userName ?? known[ctx.userId]?.name ?? null;
    if (known[ctx.userId] && known[ctx.userId].name === name) return;
    browserPrefs.set("accounts", { ...known, [ctx.userId]: { name } });
  }
  function legacyOwner() {
    const v = browserPrefs.get("acct:legacy");
    if (typeof v === "string" && v) return v;
    return memEvents ? pickLegacyOwner(memEvents) : null;
  }
  function fixLegacyOwner() {
    const v = browserPrefs.get("acct:legacy");
    if (typeof v === "string" && v) return;
    const pick = memEvents ? pickLegacyOwner(memEvents) : null;
    if (pick) browserPrefs.set("acct:legacy", pick);
  }
  function selectedAccount() {
    return resolveSelection(accountSel, ctx.userId, legacyOwner());
  }
  async function getViewEvents() {
    await ensureUser();
    const all = await getEvents();
    return filterByAccount(all, selectedAccount(), legacyOwner());
  }
  function accountsState() {
    const all = memEvents ?? [];
    return {
      list: listAccounts(all, knownAccounts(), legacyOwner(), ctx.userId),
      selected: selectedAccount(),
      total: all.length
    };
  }
  function selectAccount(sel) {
    accountSel = sel;
    dashboard?.refresh();
    overlay?.refresh();
  }
  function onAccountSeen(previous) {
    rememberAccount();
    if (ctx.userId === previous) return;
    accountSel = "current";
    dashboard?.refresh();
    overlay?.refresh();
    if (mounted && previous != null) setTimeout(maybeAutoSync, 3e3);
  }
  function holdings() {
    const sel = selectedAccount();
    if (sel != null && sel !== ctx.userId) return { balance: null, inventoryValue: null };
    return { balance: ctx.balance, inventoryValue: ctx.inventoryValue };
  }
  function applyToMemory(events) {
    if (!memEvents) return;
    let unsorted = false;
    for (const ev of events) {
      const i = memIndex.get(ev.id);
      if (i === void 0) {
        const last = memEvents[memEvents.length - 1];
        if (last && ev.ts < last.ts) unsorted = true;
        memIndex.set(ev.id, memEvents.length);
        memEvents.push(ev);
      } else if (shouldReplace(memEvents[i], ev)) {
        const merged = mergeEvent(memEvents[i], ev);
        if (merged.ts !== memEvents[i].ts) unsorted = true;
        memEvents[i] = merged;
      }
    }
    if (unsorted) {
      memEvents.sort((a, b) => a.ts - b.ts);
      memIndex = new Map(memEvents.map((e, i) => [e.id, i]));
    }
  }
  async function removeTwins() {
    const events = await getEvents();
    const twins = [...withdrawalTwinIds(events), ...caseTwinIds(events)];
    if (!twins.length) return 0;
    await deleteEvents(twins);
    return twins.length;
  }
  async function deleteEvents(ids, { cloud: toCloud = true } = {}) {
    if (!ids.length) return;
    const drop = new Set(ids);
    await store2.deleteEvents(ids);
    try {
      shared?.remove(ids);
    } catch (err) {
      console.warn("[caser-tracker] could not update shared storage", err);
    }
    if (memEvents) {
      memEvents = memEvents.filter((e) => !drop.has(e.id));
      memIndex = new Map(memEvents.map((e, i) => [e.id, i]));
    }
    if (toCloud && cloudKey()) cloud.remove(ids).catch((err) => console.warn("[caser-tracker] could not delete in cloud", err));
  }
  function dropMemory() {
    memEvents = null;
    memIndex = null;
  }
  async function saveEvents(events, { share = true, cloud: toCloud = true } = {}) {
    const added = await store2.putEvents(events);
    applyToMemory(events);
    if (memLoad) memLoad.then(() => applyToMemory(events), () => {
    });
    if (share) queueShared(events);
    if (toCloud) queueCloud(events);
    return added;
  }
  var sharedQueue = [];
  var sharedTimer = null;
  function queueShared(events) {
    if (!shared || !events.length) return;
    sharedQueue.push(...events);
    if (!sharedTimer) sharedTimer = setTimeout(flushShared, 1500);
  }
  function flushShared() {
    sharedTimer = null;
    const batch = sharedQueue;
    sharedQueue = [];
    try {
      shared.merge(batch);
    } catch (err) {
      console.warn("[caser-tracker] could not write shared storage", err);
    }
  }
  async function clearLocal() {
    const ids = new Set(Object.keys(knownAccounts()));
    for (const e of memEvents ?? await getEvents()) if (e.userId != null) ids.add(String(e.userId));
    if (ctx.userId != null) ids.add(ctx.userId);
    await store2.clearEvents();
    dropMemory();
    const keys = ["lastSync", "lastSyncBy", ...HISTORY_STREAMS.map((s2) => `sync:${s2}`)];
    for (const id of ids) for (const s2 of HISTORY_STREAMS) keys.push(progressKey(s2, id));
    for (const k of keys) await store2.setMeta(k, null);
    browserPrefs.set("sync:complete", []);
    browserPrefs.set("acct:legacy", null);
    lastSyncLegacy = null;
    lastSyncBy = {};
  }
  var HISTORY_STREAMS = ["upgrades", "inventory", "payments"];
  function browserComplete() {
    const v = browserPrefs.get("sync:complete");
    return Array.isArray(v) ? v : [];
  }
  function markBrowserComplete(flag) {
    const v = browserComplete();
    if (!v.includes(flag)) browserPrefs.set("sync:complete", [...v, flag]);
  }
  function markComplete(flag) {
    markBrowserComplete(flag);
    if (cloudKey()) cloud.markComplete(flag).catch((err) => console.warn("[caser-tracker] could not update cloud", err));
  }
  async function publishLocalComplete() {
    for (const s2 of HISTORY_STREAMS) if ((await store2.getMeta(`sync:${s2}`))?.complete) markBrowserComplete(s2);
  }
  var historyProgress = {
    async load(name) {
      const uid = ctx.userId;
      const legacy = legacyOwner();
      let local = await store2.getMeta(progressKey(name, uid));
      if (local == null && uid === legacy) local = await store2.getMeta(`sync:${name}`);
      if (local?.complete || !flagComplete(browserComplete(), name, uid, legacy)) return local;
      return { complete: true, offset: 0 };
    },
    async save(name, v) {
      await store2.setMeta(progressKey(name, ctx.userId), v);
      if (v?.complete) markComplete(streamFlag(name, ctx.userId));
    }
  };
  async function syncShared() {
    if (!shared) return;
    const clearedAt = shared.clearedAt();
    if (clearedAt && clearedAt > (await store2.getMeta("sharedClearSeen") ?? 0)) {
      await clearLocal();
      await store2.setMeta("sharedClearSeen", clearedAt);
    }
    const remote = shared.readAll();
    if (remote.length) await saveEvents(remote, { share: false, cloud: false });
    await removeTwins();
    shared.merge(await getEvents());
    shared.onRemoteChange(async (rev) => {
      try {
        const cleared = shared.clearedAt();
        if (cleared && cleared > (await store2.getMeta("sharedClearSeen") ?? 0)) {
          await clearLocal();
          await store2.setMeta("sharedClearSeen", cleared);
          dashboard?.refresh();
          return;
        }
        const events = shared.readDays(rev?.days);
        if (events.length && await saveEvents(events, { share: false, cloud: false })) {
          await removeTwins();
          refreshAfterLive();
        }
      } catch (err) {
        console.warn("[caser-tracker] could not read shared storage", err);
      }
    });
  }
  var CLOUD_PULL_EVERY_MS = 60 * 1e3;
  var cloud = createCloud({ request: gmRequest, getKey: () => cloudKey() });
  var cloudStatus = { state: "idle", lastPull: null, error: null, progress: null };
  var cloudQueue = /* @__PURE__ */ new Set();
  var cloudTimer = null;
  var cloudRun = null;
  function cloudKey() {
    const k = browserPrefs.get("cloud:key");
    return isSyncKey(k) ? k : null;
  }
  function queueCloud(events) {
    if (!cloudKey() || !events.length) return;
    for (const e of events) cloudQueue.add(e.id);
    if (!cloudTimer) {
      cloudTimer = setTimeout(() => {
        cloudTimer = null;
        flushCloud().catch(() => {
        });
      }, 3e3);
    }
  }
  async function flushCloud() {
    if (!cloudQueue.size || !cloudKey()) return;
    const ids = [...cloudQueue];
    cloudQueue.clear();
    const byId = new Map((await getEvents()).map((e) => [e.id, e]));
    const events = ids.map((id) => byId.get(id)).filter(Boolean);
    try {
      await cloud.push(events);
      if (cloudStatus.state === "error") cloudStatus = { ...cloudStatus, state: "idle", error: null };
    } catch (err) {
      for (const id of ids) cloudQueue.add(id);
      cloudStatus = { ...cloudStatus, state: "error", error: err.message || String(err) };
      throw err;
    }
  }
  function cloudSync() {
    const key = cloudKey();
    if (!key) return Promise.resolve(null);
    if (cloudRun) return cloudRun;
    cloudRun = (async () => {
      cloudStatus = { ...cloudStatus, state: "syncing", progress: "Checking" };
      dashboard?.refresh();
      try {
        const account = await cloud.account();
        const seen = Number(browserPrefs.get("cloud:clearSeen")) || 0;
        if (account.clearedAt && account.clearedAt > seen) {
          browserPrefs.set("cloud:clearSeen", account.clearedAt);
          await clearLocal();
          if (shared) await store2.setMeta("sharedClearSeen", shared.clear());
        }
        let cursor = await store2.getMeta("cloudCursor");
        if (!cursor || cursor.key !== key) cursor = null;
        cloudStatus = { ...cloudStatus, progress: cursor ? "Downloading changes" : "Downloading history" };
        dashboard?.refresh();
        const res = await cloud.pull(cursor);
        if (res.deletedIds.length) await deleteEvents(res.deletedIds, { cloud: false });
        let added = 0;
        for (let i = 0; i < res.events.length; i += 2e3) added += await saveEvents(res.events.slice(i, i + 2e3), { cloud: false });
        if (res.cursor) await store2.setMeta("cloudCursor", { key, ...res.cursor });
        if (res.events.length) {
          const byId = new Map((await getEvents()).map((e) => [e.id, e]));
          const better = res.events.map((e) => byId.get(e.id)).filter((m, i) => m && eventRank(m) > eventRank(res.events[i]));
          queueCloud(better);
        }
        if (added) await removeTwins();
        if (await store2.getMeta("cloudPushedKey") !== key) {
          await cloud.push(await getEvents(), (done, total) => {
            cloudStatus = { ...cloudStatus, progress: `Uploading ${done} / ${total}` };
            refreshSoon();
          });
          await store2.setMeta("cloudPushedKey", key);
        }
        await flushCloud();
        for (const s2 of account.complete) if (isStreamFlag(s2, HISTORY_STREAMS)) markBrowserComplete(s2);
        for (const s2 of browserComplete()) {
          if (account.complete.includes(s2)) continue;
          try {
            await cloud.markComplete(s2);
          } catch (err) {
            console.warn("[caser-tracker] could not update cloud", err);
          }
        }
        fixLegacyOwner();
        cloudStatus = { state: "idle", lastPull: Date.now(), error: null, progress: null };
        if (added) refreshSoon();
        return { added };
      } catch (err) {
        cloudStatus = { ...cloudStatus, state: "error", error: err.message || String(err), progress: null };
        throw err;
      } finally {
        cloudRun = null;
        dashboard?.refresh();
      }
    })();
    return cloudRun;
  }
  function setCloudKey(key) {
    if (key != null && !isSyncKey(key)) throw new Error("That is not a sync key. A key is 32 or more letters, digits, - or _.");
    browserPrefs.set("cloud:key", key);
    browserPrefs.set("cloud:clearSeen", key ? Date.now() : null);
    cloudQueue.clear();
    cloudStatus = { state: "idle", lastPull: null, error: null, progress: null };
    return key ? cloudSync() : null;
  }
  var cloudTicker = null;
  function startCloudTicker() {
    if (cloudTicker) return;
    cloudTicker = setInterval(() => {
      if (document.visibilityState !== "visible" || !cloudKey()) return;
      cloudSync().catch((err) => console.warn("[caser-tracker] cloud sync failed", err));
    }, CLOUD_PULL_EVERY_MS);
  }
  var liveTimer = null;
  function refreshAfterLive() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      const run = () => {
        liveTimer = null;
        dashboard?.refresh();
        overlay?.refresh();
      };
      if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2e3 });
      else run();
    }, 2500);
  }
  var caseInfos = /* @__PURE__ */ new Map();
  var caseInfoLoads = /* @__PURE__ */ new Map();
  function rememberCaseInfo(ex) {
    if (ex.method !== "GET" || ex.status >= 400) return;
    const d = caseDetailPath(ex.path);
    if (!d) return;
    const info = caseInfoFromResponse(ex.resBody, d);
    if (info) caseInfos.set(d.slug, info);
  }
  async function getCaseInfo(slug) {
    const known = caseInfos.get(slug);
    if (known) return known;
    for (let i = 0; i < 8 && !caseInfos.has(slug); i++) await new Promise((r) => setTimeout(r, 200));
    if (caseInfos.has(slug)) return caseInfos.get(slug);
    if (!caseInfoLoads.has(slug)) {
      const p = fetchCaseInfo(origFetch, slug).then((info) => {
        if (info) caseInfos.set(slug, info);
        return info;
      }).finally(() => caseInfoLoads.delete(slug));
      caseInfoLoads.set(slug, p);
    }
    return caseInfoLoads.get(slug);
  }
  var replacement = null;
  function rememberReplacement(ex) {
    if (ex.method !== "GET" || ex.status >= 400) return;
    const itemId = replacementItemId(ex.path);
    if (!itemId) return;
    replacement = { itemId, candidates: candidatesFromResponse(ex.resBody), ts: Date.now() };
  }
  function replacementState() {
    if (!replacement) return null;
    const it = ctx.items.get(replacement.itemId);
    return { itemId: replacement.itemId, current: it ? { name: it.name, price: it.price } : null, candidates: replacement.candidates };
  }
  function gmRequest({ method = "GET", url, headers = { accept: "application/json" }, body, timeout = 3e4 }) {
    return new Promise((resolve, reject) => {
      const gm = typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : null;
      const host = new URL(url).hostname;
      if (!gm) {
        reject(new Error("Reinstall the script: it needs the GM_xmlhttpRequest permission"));
        return;
      }
      gm({
        method,
        url,
        headers,
        data: body,
        anonymous: true,
        timeout,
        onload: (r) => {
          let json = null;
          try {
            json = JSON.parse(r.responseText);
          } catch {
          }
          resolve({ status: r.status, json });
        },
        onerror: () => reject(new Error(`Request to ${host} failed`)),
        ontimeout: () => reject(new Error(`Request to ${host} timed out`))
      });
    });
  }
  var csfloatRequest = (url) => gmRequest({ url });
  var prices = createPriceClient({ request: csfloatRequest, storage: store });
  var { origFetch } = installHook(pageWindow, async (ex) => {
    if (ex.auth) lastAuth = ex.auth;
    try {
      rememberCaseInfo(ex);
      rememberReplacement(ex);
    } catch {
    }
    const { events, recognized } = parseExchange(ex, ctx, site);
    const userBefore = ctx.userId;
    const nameBefore = ctx.userName;
    ctx.learn(ex);
    if (ex.path.split("?")[0] === "/users/me" && ex.status < 400 && ctx.userId != null) userAuth = getAuth();
    if (ctx.userId !== userBefore || ctx.userName !== nameBefore) onAccountSeen(userBefore);
    if (!recognized && !events.length) return;
    try {
      if (events.length) {
        const uid = await ensureUser();
        if (uid != null) for (const e of events) e.userId = uid;
        await saveEvents(events);
        lastEventTs = Date.now();
        refreshAfterLive();
      } else if (ex.status < 400) {
        unknownResponses++;
        await store2.addRaw({ path: ex.path, status: ex.status, reqBody: ex.reqBody, resBody: ex.resBody });
      }
    } catch (err) {
      console.warn("[caser-tracker] could not save", err);
    }
  });
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function getAuth() {
    try {
      const t = localStorage.getItem("auth_token");
      if (t) return `Bearer ${t}`;
    } catch {
    }
    return lastAuth;
  }
  function currencyLabel() {
    return "";
  }
  var OVERLAY_ON_KEY = "cst.ui.upgradeOverlayOn";
  function setUpgradeOverlay(on) {
    store.set(OVERLAY_ON_KEY, on);
    if (on && !overlay) {
      overlay = mountUpgradeOverlay({
        getSelection: () => readUpgradeSelection(document),
        getEvents: getViewEvents,
        stats: stats_exports,
        currency: currencyLabel,
        getHoldings: holdings,
        onTurnOff: () => {
          setUpgradeOverlay(false);
          dashboard?.refresh();
        }
      });
    } else if (!on && overlay) {
      overlay.destroy();
      overlay = null;
    }
  }
  function mount() {
    dashboard = mountDashboard({
      getEvents: getViewEvents,
      getAccounts: accountsState,
      selectAccount,
      stats: stats_exports,
      currency: currencyLabel,
      onExport: async (format) => {
        const events = await getEvents();
        const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        if (format === "csv") download(`caser-tracker-${stamp}.csv`, toCsv(events), "text/csv");
        else download(`caser-tracker-${stamp}.json`, toJson(events), "application/json");
      },
      onImportFile: async (file) => {
        const added = await saveEvents(fromJson(await file.text()));
        if (added) await removeTwins();
        dashboard.refresh();
        return { added };
      },
      onImportHistory: () => sync(),
      onClear: async () => {
        sharedQueue = [];
        await clearLocal();
        if (shared) await store2.setMeta("sharedClearSeen", shared.clear());
        if (cloudKey()) browserPrefs.set("cloud:clearSeen", await cloud.clear());
        accountSel = "current";
        dashboard.refresh();
      },
      getStatus: () => ({
        capturing: true,
        lastEventTs,
        unknownResponses,
        version: VERSION,
        lastSync: lastSyncFor(ctx.userId ?? selectedAccount()),
        syncing: syncProgress,
        storagePersisted,
        cloud: { key: cloudKey(), ...cloudStatus }
      }),
      onCloudStart: () => setCloudKey(newSyncKey()),
      onCloudJoin: (key) => setCloudKey(String(key ?? "").trim()),
      onCloudStop: () => setCloudKey(null),
      onCloudSync: () => cloudSync(),
      copyText: (text) => {
        if (typeof GM_setClipboard !== "function") return false;
        GM_setClipboard(text, "text");
        return true;
      },
      getHoldings: holdings,
      getSettings: () => ({ upgradeOverlay: !!overlay }),
      setSetting: (key, value) => {
        if (key === "upgradeOverlay") setUpgradeOverlay(!!value);
      }
    });
    setUpgradeOverlay(store.get(OVERLAY_ON_KEY, true) !== false);
    mountCasePanel({
      getSlug: () => caseSlugFromPath(location.pathname),
      getInfo: getCaseInfo,
      stats: stats_exports,
      currency: currencyLabel
    });
    mountExchangePanel({
      isOpen: () => !!document.querySelector('[data-testid="replace-item-modal"]'),
      getState: replacementState,
      prices,
      stats: stats_exports,
      currency: currencyLabel,
      // Selects the item in the site's own list (same as clicking its card). Never confirms the replacement.
      selectCandidate: (id) => {
        const card = document.querySelector(`[data-testid="replace-item-modal-candidate-${CSS.escape(id)}"]`);
        if (!card) return false;
        card.scrollIntoView({ block: "nearest" });
        card.click();
        return true;
      }
    });
    mounted = true;
    startAutoSync();
  }
  var AUTO_SYNC_AFTER_MS = 15 * 60 * 1e3;
  var lastSyncBy = {};
  var lastSyncLegacy = null;
  var mounted = false;
  function lastSyncFor(uid) {
    if (uid == null || uid === "all") return Math.max(0, lastSyncLegacy ?? 0, ...Object.values(lastSyncBy)) || null;
    return lastSyncBy[uid] ?? (uid === legacyOwner() ? lastSyncLegacy : null);
  }
  var syncProgress = null;
  var syncPromise = null;
  var storagePersisted = null;
  var refreshTimer = null;
  function refreshSoon() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      dashboard?.refresh();
    }, 3e3);
  }
  function sync() {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      try {
        if (cloudRun) {
          syncProgress = "Waiting for cloud download";
          dashboard?.refresh();
          await cloudRun.catch(() => {
          });
        }
        const res = await importHistory({
          fetch: origFetch,
          ctx,
          site,
          getAuth,
          save: async (evs) => {
            const added = await saveEvents(evs);
            if (added) refreshSoon();
            return added;
          },
          // Only the signed-in account's events: they decide where an unfinished walk resumes.
          // Live events stored before the account was known (no userId) are included so the import
          // can give them their owner.
          getStored: async () => (await getEvents()).filter((e) => e.userId == null || String(e.userId) === ctx.userId),
          onProgress: (msg) => {
            syncProgress = msg;
            refreshSoon();
          },
          progressStore: historyProgress
        });
        if (ctx.userId != null) {
          lastSyncBy = { ...lastSyncBy, [ctx.userId]: Date.now() };
          await store2.setMeta("lastSyncBy", lastSyncBy);
        }
        return res;
      } finally {
        syncProgress = null;
        syncPromise = null;
        dashboard?.refresh();
      }
    })();
    return syncPromise;
  }
  async function startAutoSync() {
    try {
      lastSyncLegacy = await store2.getMeta("lastSync") ?? null;
      const by = await store2.getMeta("lastSyncBy");
      lastSyncBy = by && typeof by === "object" ? by : {};
      await syncShared().catch((err) => console.warn("[caser-tracker] could not sync shared storage", err));
      await publishLocalComplete().catch(() => {
      });
      cloudSync().catch((err) => console.warn("[caser-tracker] cloud sync failed", err));
      startCloudTicker();
      await removeTwins().catch((err) => console.warn("[caser-tracker] could not remove duplicates", err));
      const events = await getEvents();
      if (events.length && !lastEventTs) lastEventTs = events[events.length - 1].ts;
      if (!cloudKey()) fixLegacyOwner();
      dashboard?.refresh();
    } catch {
    }
    try {
      storagePersisted = await navigator.storage?.persist?.() ?? null;
    } catch {
    }
    setTimeout(maybeAutoSync, 5e3);
  }
  async function maybeAutoSync() {
    if (!getAuth()) return;
    await ensureUser();
    const last = lastSyncFor(ctx.userId);
    if (last && Date.now() - last < AUTO_SYNC_AFTER_MS) return;
    sync().catch((err) => console.warn("[caser-tracker] sync failed", err));
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
  pageWindow.__caserTracker = { version: VERSION, store: store2, ctx, stats: stats_exports };
})();
