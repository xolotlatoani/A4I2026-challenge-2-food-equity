/**
 * @module console/main
 * Main orchestrator for the Atlanta Coordinator Console (`queue.html`, `match-brief-spinach.html`,
 * `match-brief-deli.html`, and `map.html`).
 */

import { ensureAgentLauncherButton, openAgentDrawerForOffer } from "./agent-drawer.js";
import {
  renderMatchBriefPage,
  setBriefAgentDrawerHandler,
  wireMatchBriefButtons,
} from "./brief-view.js";
import { wireGlobalSidebarAndHeader } from "./modals.js";
import {
  renderQueuePage,
  setQueueAgentDrawerHandler,
  updateSidebarBadge,
  wireQueueControls,
} from "./queue-view.js";
import {
  APP_STATE,
  POLL_MS,
  SERVED,
  isDemoMode,
  poll,
  saveBrokerState,
  setDemoMode,
  setViewRefreshCallback,
  syncMatch,
  syncQueue,
} from "./state-store.js";
import { getActiveOfferKey, isMatchBriefPage, isQueuePage, showToast } from "./ui-utils.js";

setQueueAgentDrawerHandler(openAgentDrawerForOffer);
setBriefAgentDrawerHandler(openAgentDrawerForOffer);

export function refreshCurrentView() {
  wireGlobalSidebarAndHeader();
  updateSidebarBadge();
  if (isQueuePage()) {
    wireQueueControls();
    renderQueuePage();
  }
  if (isMatchBriefPage()) {
    renderMatchBriefPage();
    wireMatchBriefButtons();
  }
}

setViewRefreshCallback(refreshCurrentView);

export async function initBrokerConsole() {
  wireGlobalSidebarAndHeader();
  ensureAgentLauncherButton();
  // Paint immediately from initial/cached state so the UI is interactive right away
  refreshCurrentView();
  if (SERVED) {
    // Load the queue first so seed postings (farm & essentials) exist in APP_STATE.offers
    const queueOk = await syncQueue();
    const briefKey = isMatchBriefPage() ? getActiveOfferKey(APP_STATE.offers) : null;
    setDemoMode(!queueOk);
    if (!queueOk) {
      showToast("server.py isn't answering: showing demo data", "cloud_off");
    } else {
      saveBrokerState(APP_STATE, false);
      refreshCurrentView();
      if (briefKey) {
        await syncMatch(briefKey);
        saveBrokerState(APP_STATE, false);
        refreshCurrentView();
      }
    }
  }
  if (isDemoMode()) return;
  if (isQueuePage()) {
    await Promise.all(APP_STATE.offers_order.map((k) => syncMatch(k)));
    saveBrokerState(APP_STATE, false);
    refreshCurrentView();
  }
  setInterval(poll, POLL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initBrokerConsole);
} else {
  initBrokerConsole();
}
