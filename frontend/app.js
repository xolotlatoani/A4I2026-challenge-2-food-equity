/**
 * Atlanta Food Rescue — Surplus Broker Console Entry Point (`frontend/app.js`)
 *
 * Loads the modular ES component architecture in `frontend/console/`:
 *   - `console/main.js`             App bootstrap & polling lifecycle
 *   - `console/state-store.js`      State store, `/api/*` client & dispatch actions
 *   - `console/demo-catalog.js`     Offline demo catalog fallback
 *   - `console/queue-view.js`       `queue.html` renderer & filter/sort controls
 *   - `console/brief-view.js`       `match-brief-*.html` renderer & button wiring
 *   - `console/agent-drawer.js`     Slide-out ADK Agent drawer & live query client
 *   - `console/agent-formatters.js` Plain-language interactive cards & Markdown formatter
 *   - `console/modals.js`           Equity Audit, Recipient Directory, Active Routes, Post Surplus & Reset Demo modals
 *   - `console/ui-utils.js`         Shared DOM, modal, toast & formatting utilities
 */
(function () {
  "use strict";
  const isServedConsole = window.location.pathname.startsWith("/console/");
  const moduleUrl = isServedConsole ? "/console/console/main.js" : "/console-js/main.js";
  import(moduleUrl).catch(() => {
    import("./console/main.js");
  });
})();
