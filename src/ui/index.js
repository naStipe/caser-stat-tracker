// UI module entry. See docs/CONTRACT.md, "UI API".
export { mountDashboard, parseEdges, edgesToText } from './dashboard.js';
export { mountUpgradeOverlay, verdictFor, curveRowFor } from './overlay.js';
export { mountCasePanel } from './casepanel.js';
export { mountExchangePanel } from './exchangepanel.js';
export * as format from './format.js';
