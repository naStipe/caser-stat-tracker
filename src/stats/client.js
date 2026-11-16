// The few statistics the userscript still computes itself. Everything over the stored history runs
// on the stats server (src/server/views.js); these work on the page's current state or on small
// summaries the server sends (the outlook model, the quote's bucket counts).
export { quoteFromBase } from './calibration.js';
export { upgradeOutlook } from './outlook.js';
export { caseOdds } from './caseodds.js';
export { rankCandidates, sellValue, replaceVerdict } from './exchange.js';
