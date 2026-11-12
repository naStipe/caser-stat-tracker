# Fix list

## Open

- **Money tab: Holdings skin value goes stale.** `ctx.inventoryValue` only updates when the site calls
  `GET /api/items/inventory/balance`. Case wins, upgrade wins, sales, replacements and withdrawals do not
  update it, so Holdings can show `skins 0.00` while the inventory holds items (seen 2026-11-10: an
  8 281.34 StatTrak M4A4 Buzz Kill was missing, so the real money result was off by that amount).
  Fix: keep the value in step with inventory changes, or compute it from the tracked inventory items
  (`ctx.items`), and refresh Holdings while the dashboard is open.
