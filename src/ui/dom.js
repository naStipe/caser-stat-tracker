// Small DOM helpers for the UI. No framework. Text is always set with textContent,
// so names coming from the site can never inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'tabIndex']);

function apply(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** h('div', {class:'x', on:{click}}, child, 'text', [more]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

/** Same as h() for SVG elements. */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

/**
 * Create (or replace) a host element with an open shadow root.
 * The host is a zero-size fixed box; the widgets inside position themselves.
 */
export function createHost(id, zIndex = 2147483000) {
  const old = document.getElementById(id);
  if (old) old.remove();
  // Custom tag name: site selectors like `div { ... }` cannot match the host.
  const host = document.createElement('caser-tracker-root');
  host.id = id;
  host.setAttribute('style', 'position:fixed;top:0;left:0;width:0;height:0;z-index:' + zIndex + ';display:block;');
  const root = host.attachShadow({ mode: 'open' });
  attach(host);
  return { host, root };
}

/** Append outside <body> when possible so framework hydration does not remove it. */
export function attach(host) {
  const parent = document.documentElement || document.body;
  if (parent && !host.isConnected) parent.appendChild(host);
}

/** localStorage wrapper. Every call is guarded: storage can be blocked or full. */
export const store = {
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
      /* ignore */
    }
  },
  remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function debounce(fn, ms) {
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

/** Run a stats call; never let one failing function break the whole panel. */
export function safe(fn) {
  try {
    return { value: fn(), error: null };
  } catch (error) {
    console.warn('[caser-tracker] stats call failed', error);
    return { value: null, error };
  }
}

export function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

let uid = 0;
export function nextId(prefix) {
  uid += 1;
  return `${prefix}-${uid}`;
}
