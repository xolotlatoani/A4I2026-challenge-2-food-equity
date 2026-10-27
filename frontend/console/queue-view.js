/**
 * @module console/queue-view
 * Renderer & controller for `queue.html` (metric summary cards, zone filters, sorting, and offer cards).
 */

import {
  APP_STATE,
  markOfferAccepted,
  markOfferDonated,
  markOfferSent,
  recordDecline,
  saveBrokerState,
  sourceLabel,
} from "./state-store.js";
import { escapeHtml, isQueuePage, showToast } from "./ui-utils.js";

let openAgentDrawerCallback = () => {};

export function setQueueAgentDrawerHandler(fn) {
  openAgentDrawerCallback = fn;
}

export function updateSidebarBadge() {
  const allOffers = Object.values(APP_STATE.offers);
  const activeCount = allOffers.filter((o) => o.status !== "donated").length;
  const routesCount = allOffers.filter(
    (o) => o.status === "awaiting" || o.status === "accepted"
  ).length;

  document.querySelectorAll("aside nav a").forEach((link) => {
    const text = link.textContent || "";
    if (text.includes("Live Queue") || link.hasAttribute("data-queue-link")) {
      link.setAttribute("data-queue-link", "1");
      let badge = link.querySelector("[data-queue-badge]");
      if (!badge) {
        badge = Array.from(link.querySelectorAll("span")).find((el) =>
          /^\d+$/.test(el.textContent.trim())
        );
        if (!badge) {
          badge = document.createElement("span");
          badge.className =
            "ml-auto bg-primary/10 text-primary px-1.5 py-0.5 rounded-sm text-[10px] font-bold";
          link.appendChild(badge);
        }
        badge.setAttribute("data-queue-badge", "1");
      }
      badge.textContent = String(activeCount);
    } else if (text.includes("Active Routes")) {
      let badge = link.querySelector("[data-routes-badge]");
      if (!badge) {
        badge = link.querySelector("span:last-child");
      }
      if (
        badge &&
        !badge.classList.contains("material-symbols-outlined") &&
        badge.textContent.trim() !== "Active Routes"
      ) {
        badge.textContent = String(routesCount);
      }
    }
  });
}

export function renderQueuePage() {
  if (!isQueuePage()) return;
  updateSidebarBadge();

  const allOffers = APP_STATE.offers_order
    .map((k) => APP_STATE.offers[k])
    .filter(Boolean);

  const counts = {
    urgent: allOffers.filter((o) => o.status === "urgent").length,
    ready: allOffers.filter((o) => o.status === "ready").length,
    awaiting: allOffers.filter((o) => o.status === "awaiting").length,
    accepted: allOffers.filter((o) => o.status === "accepted").length,
    donated: allOffers.filter((o) => o.status === "donated").length,
    completed: allOffers.filter((o) => o.status === "accepted" || o.status === "donated").length,
  };

  const metricSection = document.querySelector("main section.grid.grid-cols-4");
  if (metricSection) {
    const cards = metricSection.children;
    if (cards[0]) {
      const headline = cards[0].querySelector(".text-headline-md, .text-3xl");
      if (headline) {
        headline.textContent =
          counts.urgent === 1 ? "1 needs a match" : `${counts.urgent} need a match`;
      }
    }
    if (cards[1]) {
      const headline = cards[1].querySelector(".text-headline-md, .text-3xl");
      if (headline) {
        headline.textContent =
          counts.ready === 1 ? "1 match ready" : `${counts.ready} matches ready`;
      }
    }
    if (cards[2]) {
      const headline = cards[2].querySelector(".text-headline-md, .text-3xl");
      if (headline) {
        headline.textContent = `${counts.awaiting} awaiting reply`;
      }
    }
    if (cards[3]) {
      const headline = cards[3].querySelector(".text-headline-md, .text-3xl");
      const subEl = cards[3].querySelector(".text-body-sm, .text-\\[11px\\]");
      if (headline) {
        headline.textContent =
          counts.donated > 0
            ? `${counts.completed} secured (${counts.donated} donated)`
            : `${counts.accepted} accepted`;
      }
      if (subEl) {
        subEl.textContent =
          counts.donated > 0
            ? `${counts.donated} rescue completed \u00b7 ${counts.accepted} en route`
            : "Scheduled for pickup window";
      }
    }
  }

  const query = (APP_STATE.search_query || "").trim().toLowerCase();

  const filtered = allOffers.filter((offer) => {
    if (query) {
      const haystack = [
        offer.offer_code,
        offer.title,
        offer.quote,
        offer.donor,
        offer.category,
        offer.storage,
        offer.primary_match && offer.primary_match.name,
        offer.status_label,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const statusPriority = { urgent: 1, ready: 2, awaiting: 3, accepted: 4, donated: 5 };
  filtered.sort((a, b) => {
    if (APP_STATE.sort_mode === "pallets") {
      return (b.pallets_num || 0) - (a.pallets_num || 0);
    }
    if (APP_STATE.sort_mode === "status") {
      return (statusPriority[a.status] || 9) - (statusPriority[b.status] || 9);
    }
    if ((a.status === "donated") !== (b.status === "donated")) {
      return a.status === "donated" ? 1 : -1;
    }
    return (a.urgency_minutes || 999) - (b.urgency_minutes || 999);
  });

  const listContainer = document.querySelector(
    "#queue-list-container, main .grid.grid-cols-12 > .col-span-12, main .grid.grid-cols-12 > .col-span-8"
  );
  if (!listContainer) return;

  const headerStripHtml = `
    <div class="flex items-center justify-between pb-1 border-b border-outline-variant">
      <div class="flex items-center gap-2.5">
        <h1 class="text-headline-lg font-headline-lg font-bold text-on-surface tracking-tight">Today's queue</h1>
        <span class="text-body-sm font-body-sm text-on-surface-variant">\u00b7 ${filtered.length} ${filtered.length === 1 ? "offer" : "offers"} \u00b7 sorted by ${escapeHtml(APP_STATE.sort_mode || "urgency")}</span>
      </div>
      <div class="flex items-center gap-2">
        <button id="queue-sort-cycle-btn" class="px-2.5 py-1 rounded hover:bg-surface-container text-on-surface-variant border border-outline-variant text-xs font-semibold flex items-center gap-1 cursor-pointer" title="Cycle sort order">
          <span class="material-symbols-outlined text-[15px]">sort</span>
          <span>Sort: ${escapeHtml((APP_STATE.sort_mode || "urgency").toUpperCase())}</span>
        </button>
      </div>
    </div>
  `;

  if (filtered.length === 0) {
    listContainer.innerHTML =
      headerStripHtml +
      `
      <div class="bg-surface-container-lowest border border-outline-variant rounded p-8 text-center space-y-3">
        <span class="material-symbols-outlined text-3xl text-outline">search_off</span>
        <p class="text-body-md font-semibold text-on-surface">No surplus offers match your search</p>
        <p class="text-body-sm text-on-surface-variant">Search: "${escapeHtml(query || "none")}"</p>
        <button id="clear-queue-filters-btn" class="px-3.5 py-1.5 bg-primary text-on-primary rounded text-body-sm font-semibold cursor-pointer">
          Clear Search
        </button>
      </div>
    `;
    const clearBtn = document.getElementById("clear-queue-filters-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        APP_STATE.search_query = "";
        const searchInput = document.querySelector('header input[type="text"]');
        if (searchInput) searchInput.value = "";
        saveBrokerState(APP_STATE, false);
        renderQueuePage();
      });
    }
    return;
  }

  listContainer.innerHTML =
    headerStripHtml + filtered.map((offer) => buildQueueCardHtml(offer)).join("\n");

  const sortBtn = document.getElementById("queue-sort-cycle-btn");
  if (sortBtn) {
    sortBtn.addEventListener("click", () => {
      const modes = ["urgency", "pallets", "status"];
      const nextIdx = (modes.indexOf(APP_STATE.sort_mode || "urgency") + 1) % modes.length;
      APP_STATE.sort_mode = modes[nextIdx];
      saveBrokerState(APP_STATE, false);
      renderQueuePage();
      showToast(`Sorted queue by: ${APP_STATE.sort_mode.toUpperCase()}`, "sort");
    });
  }

  listContainer.querySelectorAll("[data-queue-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const action = btn.getAttribute("data-queue-action");
      const key = btn.getAttribute("data-offer-key");
      if (!key || !APP_STATE.offers[key]) return;

      if (action === "decline-next") {
        recordDecline(key);
      } else if (action === "quick-send") {
        markOfferSent(key);
      } else if (action === "mark-accepted") {
        markOfferAccepted(key);
      } else if (action === "mark-donated") {
        markOfferDonated(key);
      } else if (action === "live-ai-match") {
        openAgentDrawerCallback(key);
      }
    });
  });
}

function buildQueueCardHtml(offer) {
  const key = escapeHtml(offer.key);
  const code = escapeHtml(offer.offer_code);
  const quote = escapeHtml(offer.quote);
  const donorShort = escapeHtml(offer.donor_short || offer.donor);
  const storageShort = escapeHtml(offer.storage_short || offer.storage);
  const timeLeft = escapeHtml(offer.time_left);
  const statusLabel = escapeHtml(offer.status_label);
  const briefUrl = escapeHtml(offer.brief_url || `match-brief-spinach.html?offer=${offer.key}`);
  const storageIcon = /shelf|ambient|room/i.test(storageShort) ? "inventory_2" : "ac_unit";

  if (offer.status === "urgent") {
    return `
      <div class="bg-surface-container-lowest border border-outline-variant border-l-4 border-l-error rounded p-4 shadow-xs hover:border-outline transition-all" data-offer-card="${key}">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-2 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
              <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
              <span class="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-container-high text-on-surface px-2 py-0.5 rounded">
                <span class="material-symbols-outlined text-xs text-primary">${storageIcon}</span> ${storageShort}
              </span>
            </div>
            <p class="font-serif-quote italic text-base text-on-surface leading-snug bg-surface-container-low p-3 rounded border-l-2 border-outline">
              ${quote}
            </p>
          </div>
          <div class="text-right flex flex-col items-end shrink-0">
            <div class="inline-flex items-center gap-1.5 bg-error-container text-on-error-container px-2.5 py-1 rounded font-mono text-xs font-bold">
              <span class="material-symbols-outlined text-xs" style="font-variation-settings: 'FILL' 1;">timer</span>
              ${timeLeft}
            </div>
          </div>
        </div>
        <div class="mt-3 pt-3 border-t border-outline-variant/50 flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-error animate-pulse"></span>
            <span class="text-body-sm font-bold text-error">${statusLabel}</span>
            ${offer.primary_match.name ? `<span class="text-xs text-on-surface-variant ml-1">\u00b7 Top candidate: <strong class="text-on-surface">${escapeHtml(offer.primary_match.name)}</strong>${offer.primary_match.match_score ? ` (${escapeHtml(offer.primary_match.match_score)})` : ""}</span>` : ""}
          </div>
          <div class="flex items-center gap-2">
            <button data-queue-action="live-ai-match" data-offer-key="${key}" class="px-2.5 py-1.5 rounded border border-primary/40 text-primary hover:bg-primary/5 text-xs font-semibold flex items-center gap-1 cursor-pointer" title="Query live Cloud Run Agent">
              <span class="material-symbols-outlined text-xs">smart_toy</span> Live AI Match
            </button>
            <a class="bg-primary hover:bg-primary-container text-on-primary font-semibold text-xs px-4 py-2 rounded transition-colors flex items-center gap-1.5 shadow-xs" href="${briefUrl}">
              Find recipients
              <span class="material-symbols-outlined text-sm">arrow_forward</span>
            </a>
          </div>
        </div>
      </div>
    `;
  }

  if (offer.status === "ready") {
    return `
      <div class="bg-surface-container-lowest border border-outline-variant border-l-4 border-l-primary rounded p-4 shadow-xs hover:border-outline transition-all" data-offer-card="${key}">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-2 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
              <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
              <span class="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-container-high text-on-surface px-2 py-0.5 rounded">
                <span class="material-symbols-outlined text-xs text-primary">${storageIcon}</span> ${storageShort}
              </span>
            </div>
            <p class="font-serif-quote italic text-base text-on-surface leading-snug bg-surface-container-low p-3 rounded border-l-2 border-outline">
              ${quote}
            </p>
          </div>
          <div class="text-right flex flex-col items-end shrink-0">
            <div class="inline-flex items-center gap-1.5 bg-tertiary-fixed text-on-tertiary-fixed-variant px-2.5 py-1 rounded font-mono text-xs font-bold">
              <span class="material-symbols-outlined text-xs">schedule</span>
              ${timeLeft}
            </div>
          </div>
        </div>
        <div class="mt-3 pt-3 border-t border-outline-variant/50 flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary text-base" style="font-variation-settings: 'FILL' 1;">check_circle</span>
            <span class="text-body-sm font-bold text-primary">${statusLabel}</span>
            <span class="text-xs text-on-surface-variant ml-1">${[offer.primary_match.match_score, offer.primary_match.capacity_Fit].filter(Boolean).map((t) => `\u00b7 ${escapeHtml(t)}`).join(" ")}</span>
          </div>
          <div class="flex items-center gap-2">
            <button data-queue-action="quick-send" data-offer-key="${key}" class="px-3 py-1.5 rounded border border-outline-variant hover:bg-surface-container text-on-surface text-xs font-semibold flex items-center gap-1 cursor-pointer">
              <span class="material-symbols-outlined text-xs">send</span> Send SMS
            </button>
            <a class="bg-primary hover:bg-primary-container text-on-primary font-semibold text-xs px-4 py-2 rounded transition-colors flex items-center gap-1.5 shadow-xs" href="${briefUrl}">
              Review match brief
              <span class="material-symbols-outlined text-sm">arrow_forward</span>
            </a>
          </div>
        </div>
      </div>
    `;
  }

  if (offer.status === "awaiting") {
    return `
      <div class="bg-surface-container-lowest border border-outline-variant border-l-4 border-l-tertiary-container rounded p-4 shadow-xs hover:border-outline transition-all" data-offer-card="${key}">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-2 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
              <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
              <span class="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-container-high text-on-surface px-2 py-0.5 rounded">
                <span class="material-symbols-outlined text-xs text-primary">${storageIcon}</span> ${storageShort}
              </span>
            </div>
            <p class="font-serif-quote italic text-base text-on-surface leading-snug bg-surface-container-low p-3 rounded border-l-2 border-outline">
              ${quote}
            </p>
          </div>
          <div class="text-right flex flex-col items-end shrink-0">
            <div class="inline-flex items-center gap-1.5 bg-surface-container-high text-on-surface-variant px-2.5 py-1 rounded font-mono text-xs font-bold">
              <span class="material-symbols-outlined text-xs">schedule</span>
              ${timeLeft}
            </div>
          </div>
        </div>
        <div class="mt-3 pt-3 border-t border-outline-variant/50 flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-tertiary-container text-base">hourglass_top</span>
            <span class="text-body-sm font-bold text-tertiary">${statusLabel}</span>
          </div>
          <div class="flex items-center gap-2">
            <button data-queue-action="decline-next" data-offer-key="${key}" class="border border-outline-variant bg-surface-container-low hover:bg-surface-container-high text-on-surface font-semibold text-xs px-3 py-1.5 rounded transition-colors cursor-pointer">
              They said no \u2192 next
            </button>
            <button data-queue-action="mark-accepted" data-offer-key="${key}" class="bg-primary text-on-primary hover:bg-primary-container font-semibold text-xs px-3 py-1.5 rounded transition-colors cursor-pointer flex items-center gap-1">
              <span class="material-symbols-outlined text-xs">check</span> Mark Accepted
            </button>
            <a class="text-primary hover:underline font-semibold text-xs px-2 py-1.5" href="${briefUrl}">
              View
            </a>
          </div>
        </div>
      </div>
    `;
  }

  if (offer.status === "accepted") {
    return `
      <div class="bg-surface-container-low/70 border border-outline-variant border-l-4 border-l-secondary rounded p-4 hover:opacity-100 transition-all" data-offer-card="${key}">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1.5 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
              <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
              <span class="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-container text-on-surface-variant px-2 py-0.5 rounded">
                <span class="material-symbols-outlined text-xs">${storageIcon}</span> ${storageShort}
              </span>
            </div>
            <p class="font-serif-quote italic text-sm text-on-surface-variant leading-snug pl-2 border-l-2 border-outline-variant">
              ${quote}
            </p>
          </div>
          <div class="text-right flex flex-col items-end shrink-0">
            <div class="inline-flex items-center gap-1.5 bg-secondary-container text-on-secondary-container px-2.5 py-1 rounded font-mono text-xs font-bold">
              <span class="material-symbols-outlined text-xs">local_shipping</span>
              PICKUP BY ${escapeHtml(offer.shutoff_time)}
            </div>
          </div>
        </div>
        <div class="mt-2.5 pt-2.5 border-t border-outline-variant/40 flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-secondary text-base" style="font-variation-settings: 'FILL' 1;">verified</span>
            <span class="text-xs font-bold text-secondary">${statusLabel}</span>
          </div>
          <div class="flex items-center gap-2">
            <button data-queue-action="mark-donated" data-offer-key="${key}" class="bg-primary text-on-primary hover:bg-primary-container font-semibold text-xs px-3 py-1.5 rounded transition-colors cursor-pointer flex items-center gap-1">
              <span class="material-symbols-outlined text-xs">task_alt</span> Mark Donated
            </button>
            <a class="text-on-surface-variant hover:text-on-surface font-semibold text-xs px-2 py-1 rounded hover:bg-surface-container" href="${briefUrl}">
              View
            </a>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="bg-surface-container-low/50 border border-outline-variant rounded p-4 opacity-80 hover:opacity-100 transition-opacity" data-offer-card="${key}">
      <div class="flex items-start justify-between gap-4">
        <div class="space-y-1.5 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
            <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
            <span class="inline-flex items-center gap-1 text-[11px] font-bold bg-primary/15 text-primary px-2 py-0.5 rounded">
              <span class="material-symbols-outlined text-xs">verified</span> DONATED & COMPLETED
            </span>
          </div>
          <p class="font-serif-quote italic text-sm text-on-surface-variant leading-snug pl-2 border-l-2 border-outline-variant">
            ${quote}
          </p>
        </div>
        <div class="text-right flex flex-col items-end shrink-0">
          <div class="inline-flex items-center gap-1.5 bg-primary/15 text-primary px-2.5 py-0.5 rounded font-mono text-xs font-bold">
            RESCUED
          </div>
        </div>
      </div>
      <div class="mt-2.5 pt-2.5 border-t border-outline-variant/40 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-primary text-base" style="font-variation-settings: 'FILL' 1;">workspace_premium</span>
          <span class="text-xs font-bold text-primary">${statusLabel}</span>
        </div>
        <a class="text-on-surface-variant hover:text-on-surface font-semibold text-xs px-2 py-1 rounded hover:bg-surface-container" href="${briefUrl}">
          View Audit
        </a>
      </div>
    </div>
  `;
}

export function wireQueueControls() {
  if (!isQueuePage()) return;

  const searchInput = document.querySelector('header input[type="text"]');
  if (searchInput && !searchInput.hasAttribute("data-wired")) {
    searchInput.setAttribute("data-wired", "1");
    searchInput.value = APP_STATE.search_query || "";
    searchInput.addEventListener("input", () => {
      APP_STATE.search_query = searchInput.value;
      saveBrokerState(APP_STATE, false);
      renderQueuePage();
    });
  }
}
