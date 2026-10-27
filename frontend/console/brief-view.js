/**
 * @module console/brief-view
 * Renderer & controller for `match-brief-spinach.html` & `match-brief-deli.html`.
 */

import { openRuledOutModal } from "./modals.js";
import { updateSidebarBadge } from "./queue-view.js";
import {
  APP_STATE,
  activateSplitPlan,
  markOfferAccepted,
  markOfferDonated,
  markOfferSent,
   recipientsFor,
  recordDecline,
  switchToOption,
} from "./state-store.js";
import { escapeHtml, getActiveOfferKey, isMatchBriefPage, pct, showToast } from "./ui-utils.js";

let openAgentDrawerCallback = () => {};

export function setBriefAgentDrawerHandler(fn) {
  openAgentDrawerCallback = fn;
}

export function renderMatchBriefPage() {
  if (!isMatchBriefPage()) return;
  updateSidebarBadge();

  const offerKey = getActiveOfferKey(APP_STATE.offers);
  const offer = APP_STATE.offers[offerKey];
  if (!offer || !offer.primary_match) return;
  const pm = offer.primary_match;

  document.title = `${offer.offer_code} ${offer.title} \u2014 Atlanta Surplus Broker`;

  const headerSec =
    document.querySelector("main > section:first-of-type") ||
    document.querySelector("main > div.bg-surface-container-lowest:first-of-type");
  if (headerSec) {
    // Breadcrumb: Live Queue \u203a <this offer> \u203a MATCH BRIEF, in both templates.
    const queueLink = headerSec.querySelector('a[href="queue.html"]');
    const crumbs = queueLink ? Array.from(queueLink.parentElement.children) : [];
    const firstSep = crumbs.findIndex((el) => el.textContent.trim() === "\u203a");
    if (firstSep >= 0 && crumbs[firstSep + 1]) crumbs[firstSep + 1].textContent = offer.title;

    const quoteHeading = headerSec.querySelector("h1, h2");
    if (quoteHeading) quoteHeading.textContent = offer.quote;

    const metaSpans = headerSec.querySelectorAll(
      ".flex.items-center.gap-2.flex-wrap > span, .flex.flex-wrap.items-center.gap-2 > span"
    );
    if (metaSpans.length >= 5) {
      metaSpans[0].innerHTML = `<span class="material-symbols-outlined text-[15px] text-outline">storefront</span> ${escapeHtml(offer.donor)}`;
      metaSpans[1].textContent = `OFFER ${offer.offer_code}`;
      metaSpans[2].innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-primary"></span> ${escapeHtml(offer.category)}`;
      const icon = /shelf|ambient|room/i.test(offer.storage) ? "inventory_2" : "ac_unit";
      metaSpans[3].innerHTML = `<span class="material-symbols-outlined text-sm">${icon}</span> ${escapeHtml(offer.storage)}`;
      metaSpans[4].innerHTML = `<span class="material-symbols-outlined text-sm">inventory</span> ${escapeHtml(offer.pallets)}`;
    }

    const countdownBox = headerSec.querySelector(".min-w-\\[220px\\], .min-w-\\[240px\\]");
    if (countdownBox) {
      const timeEl = countdownBox.querySelector(".text-tabular-data-lg, .font-tabular-data-lg");
      const subEl = countdownBox.querySelector("p.text-body-sm, div.text-body-sm");
      if (timeEl) {
        const ownLeftLabel = /^\s*LEFT\s*$/.test(
          (timeEl.nextElementSibling || {}).textContent || ""
        );
        timeEl.textContent =
          offer.status === "donated"
            ? "PICKED UP"
            : ownLeftLabel
            ? String(offer.time_left).replace(/\s*LEFT$/i, "")
            : offer.time_left;
      }
      if (subEl) {
        subEl.innerHTML =
          offer.status === "donated"
            ? escapeHtml(offer.status_label)
            : `leaves dock by <span class="font-semibold">${escapeHtml(offer.shutoff_time)}</span>`;
      }
    }
  }

  const pipeSec =
    document.querySelectorAll("main > section")[1] ||
    document.querySelectorAll("main > div.bg-surface-container-lowest")[1];
  if (pipeSec && offer.pipeline) {
    const step1 = pipeSec.querySelector('[data-funnel-step="1"]');
    const step2 = pipeSec.querySelector('[data-funnel-step="2"]');
    const step3 = pipeSec.querySelector('[data-funnel-step="3"]');
    if (step1) step1.textContent = `${offer.pipeline.semantic || 60} candidates`;
    if (step2) step2.textContent = `${offer.pipeline.feasible || 20} viable`;
    if (step3) step3.textContent = `${offer.pipeline.recommended || 3} recommended`;
  }

  const primaryCard = document.querySelector(".border-l-4.border-l-primary");
  if (primaryCard) {
    const legacyTopBanner = document.getElementById("live-offer-state-banner");
    if (legacyTopBanner) legacyTopBanner.remove();

    const nameHeading = primaryCard.querySelector("h2, h3");
    if (nameHeading) nameHeading.textContent = pm.name;

    const archBadge = primaryCard.querySelector(
      "span.bg-tertiary-fixed, span.text-on-surface-variant.border.border-outline-variant"
    );
    if (archBadge) archBadge.textContent = pm.archetype || "VERIFIED RECIPIENT";

    const addrEl =
      primaryCard.querySelector("p.text-outline") ||
      primaryCard.querySelector("div.flex.items-center.gap-1.text-on-surface-variant");
    if (addrEl) {
      addrEl.innerHTML = `<span class="material-symbols-outlined text-[15px] align-text-bottom">location_on</span> ${escapeHtml(pm.address)}`;
    }

    const infoBoxes = primaryCard.querySelectorAll(
      ".grid.grid-cols-1.md\\:grid-cols-2.gap-4 > div"
    );
    if (infoBoxes[0]) {
      const whyP = infoBoxes[0].querySelector("p");
      if (whyP) whyP.textContent = pm.reason;
    }
    if (infoBoxes[1]) {
      const takeP = infoBoxes[1].querySelector("p");
      if (takeP) {
        takeP.textContent =
          pm.take_text ||
          `${pm.equipment || "Verified Cold Chain"} \u00b7 ${pm.capacity_Fit || "Fits full load"} \u00b7 Receiving window: ${pm.window || "9:00 AM \u2013 7:00 PM"} (${pm.window_note || "Open now"}).`;
      }
    }

    // The clock, who it helps, the pickup note and the rank line, from the match. The demo
    // catalog's offers (no server.py) keep the template's illustrative text.
    if (offer.matched && pm.candidate) {
      renderBriefClock(primaryCard, offer, pm.candidate);
      renderWhoItHelps(primaryCard, pm.candidate);
      renderPickupNote(primaryCard, pm.candidate);
      renderRankLine(primaryCard, offer, pm.candidate);
    } else {
      const clockStatusRight = primaryCard.querySelector(
        ".text-label-badge.text-primary.font-semibold, .font-tabular-data-sm.text-primary.font-semibold"
      );
      if (clockStatusRight) {
        clockStatusRight.textContent =
          pm.clock_text ||
          `Est. pickup ${pm.pickup_eta || "4:15 PM"} \u00b7 ${pm.buffer_mins || 90}m safety buffer before ${offer.shutoff_time}`;
      }
    }

    const smsBox = primaryCard.querySelector("textarea");
    if (smsBox) {
      smsBox.id = "dispatch-sms";
      smsBox.removeAttribute("readonly");
      const draftFor = `${offer.key}:${pm.recipient_id || pm.name}`;
      if (!offer.active_split_mode && smsBox.dataset.draftFor !== draftFor) {
        smsBox.value = pm.sms || "";
        smsBox.dataset.draftFor = draftFor;
      }
    }

    updatePrimaryActionButtonBar(primaryCard, offer);
  }

  renderSplitLoadSection(offer);
  renderStandbyOptionsSection(offer);
  renderRuledOutSection(offer);
}

function updatePrimaryActionButtonBar(primaryCard, offer) {
  const buttons = Array.from(primaryCard.querySelectorAll("button"));
  const markSentBtn = buttons.find(
    (b) =>
      b.getAttribute("data-role") === "mark-sent-btn" ||
      b.textContent.includes("Mark as sent") ||
      b.textContent.includes("Sent \u00b7 Awaiting") ||
      b.textContent.includes("Accepted by") ||
      b.textContent.includes("Donated & Verified")
  );

  if (markSentBtn) {
    markSentBtn.setAttribute("data-role", "mark-sent-btn");
    if (offer.status === "awaiting") {
      markSentBtn.className =
        "h-9 px-4 bg-tertiary-fixed text-on-tertiary-fixed border border-tertiary-container rounded font-headline-sm text-headline-sm font-bold flex items-center gap-1.5 cursor-pointer shadow-xs";
      markSentBtn.innerHTML = `<span class="material-symbols-outlined text-[16px]">schedule_send</span><span>Sent \u00b7 Awaiting Reply</span>`;
    } else if (offer.status === "accepted") {
      markSentBtn.className =
        "h-9 px-4 bg-secondary-container text-on-secondary-container border border-secondary rounded font-headline-sm text-headline-sm font-bold flex items-center gap-1.5 cursor-pointer shadow-xs";
      markSentBtn.innerHTML = `<span class="material-symbols-outlined text-[16px]">local_shipping</span><span>Accepted \u00b7 Awaiting Pickup</span>`;
    } else if (offer.status === "donated") {
      markSentBtn.className =
        "h-9 px-4 bg-primary/15 text-primary border border-primary rounded font-headline-sm text-headline-sm font-bold flex items-center gap-1.5 cursor-pointer";
      markSentBtn.innerHTML = `<span class="material-symbols-outlined text-[16px]">verified</span><span>Donated & Verified</span>`;
    } else {
      markSentBtn.className =
        "h-9 px-4 bg-primary-container hover:bg-secondary text-on-primary rounded font-headline-sm text-headline-sm font-semibold flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors";
      markSentBtn.innerHTML = `<span class="material-symbols-outlined text-[16px]" data-icon="check">check</span><span>Mark as sent</span>`;
    }
  }

  let inlineBar = document.getElementById("inline-dispatch-workflow-bar");
  if (!inlineBar) {
    inlineBar = document.createElement("div");
    inlineBar.id = "inline-dispatch-workflow-bar";
    primaryCard.appendChild(inlineBar);
  }
  inlineBar.innerHTML = buildMatchBriefStateBannerHtml(offer);
  wireStateBannerActions(inlineBar, offer.key);
}

function buildMatchBriefStateBannerHtml(offer) {
  const statuses =
    {
      awaiting: ["sent", "expired"],
      accepted: ["accepted", "picked_up"],
      donated: ["picked_up"],
    }[offer.status] || [];
  const recipient = escapeHtml(
    recipientsFor(offer, statuses)
      .map((r) => r.name)
      .join(" + ")
  );
  const pantryLinks =
    offer.live && offer.live.request_id
      ? offer.live.offers
          .filter((o) => o.status === "sent")
          .map(
            (o) =>
              `<a href="pantry-offer.html?offer=${encodeURIComponent(offer.live.request_id)}&recipient=${o.recipient_id}" target="_blank" rel="noopener" class="underline font-semibold text-tertiary">${escapeHtml(o.recipient_name || `Recipient #${o.recipient_id}`)}'s link</a>`
          )
          .join(" · ")
      : "";

  if (offer.status === "awaiting") {
    return `
      <div class="my-2 p-3 rounded bg-tertiary-fixed/60 border-2 border-tertiary-container flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div class="flex items-center gap-2.5">
          <span class="material-symbols-outlined text-tertiary text-xl">hourglass_top</span>
          <div>
            <p class="text-xs font-bold uppercase tracking-wider text-tertiary">DISPATCH SENT TO ${recipient} \u00b7 AWAITING PANTRY REPLY</p>
            <p class="text-xs text-on-surface">Next step: Confirm when ${recipient} replies YES (or rotate if they decline).${pantryLinks ? ` Or they answer on their own page: ${pantryLinks}.` : ""}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <button data-banner-action="accept" class="px-3.5 py-1.5 rounded bg-primary text-on-primary text-xs font-bold hover:bg-primary-container cursor-pointer flex items-center gap-1 shadow-xs">
            <span class="material-symbols-outlined text-sm">check_circle</span> Pantry Replied YES (Mark Accepted)
          </button>
          <button data-banner-action="decline" class="px-3 py-1.5 rounded border border-outline-variant bg-surface-container-lowest text-on-surface text-xs font-semibold hover:bg-surface-container cursor-pointer">
            They Declined \u2192 Next Option
          </button>
        </div>
      </div>
    `;
  }

  if (offer.status === "accepted") {
    return `
      <div class="my-2 p-3 rounded bg-secondary-container/80 border-2 border-secondary flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div class="flex items-center gap-2.5">
          <span class="material-symbols-outlined text-secondary text-xl" style="font-variation-settings: 'FILL' 1;">local_shipping</span>
          <div>
            <p class="text-xs font-bold uppercase tracking-wider text-on-secondary-container">ACCEPTED BY ${recipient} \u00b7 PICKUP SCHEDULED (${escapeHtml(offer.shutoff_time)})</p>
            <p class="text-xs text-on-secondary-container">Line up a volunteer driver if they can't collect. Mark as Donated once it's picked up.</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button data-banner-action="donated" class="px-3.5 py-1.5 rounded bg-primary text-on-primary text-xs font-bold hover:bg-primary-container cursor-pointer flex items-center gap-1 shadow-xs">
            <span class="material-symbols-outlined text-sm">verified</span> Mark as Donated & Completed
          </button>
        </div>
      </div>
    `;
  }

  if (offer.status === "donated") {
    return `
      <div class="my-2 p-3 rounded bg-primary/15 border-2 border-primary flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div class="flex items-center gap-2.5">
          <span class="material-symbols-outlined text-primary text-xl" style="font-variation-settings: 'FILL' 1;">workspace_premium</span>
          <div>
            <p class="text-xs font-bold uppercase tracking-wider text-primary">DONATED & VERIFIED \u00b7 RESCUE COMPLETED</p>
            <p class="text-xs text-on-surface">${escapeHtml(offer.pallets)} of ${escapeHtml(offer.category)} rescued and delivered to <strong>${recipient}</strong>.</p>
          </div>
        </div>
        <a href="queue.html" class="px-3.5 py-1.5 rounded bg-primary text-on-primary text-xs font-bold hover:bg-primary-container flex items-center gap-1">
          <span class="material-symbols-outlined text-sm">arrow_back</span> Return to Live Queue
        </a>
      </div>
    `;
  }

  return `
    <div class="my-2 p-2.5 rounded bg-surface-container-low border border-outline-variant/60 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2 text-xs text-on-surface-variant">
        <span class="w-2 h-2 rounded-full ${offer.status === "urgent" ? "bg-error animate-pulse" : "bg-primary"}"></span>
        <span>Status: <strong class="text-on-surface">${escapeHtml(offer.status_label)}</strong></span>
      </div>
      <button data-banner-action="live-ai" class="px-2.5 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs font-semibold flex items-center gap-1 cursor-pointer">
        <span class="material-symbols-outlined text-xs">smart_toy</span> Ask the agent
      </button>
    </div>
  `;
}

function wireStateBannerActions(bannerEl, offerKey) {
  bannerEl.querySelectorAll("[data-banner-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const act = btn.getAttribute("data-banner-action");
      if (act === "accept") markOfferAccepted(offerKey);
      else if (act === "decline") recordDecline(offerKey);
      else if (act === "donated") markOfferDonated(offerKey);
      else if (act === "live-ai") openAgentDrawerCallback(offerKey);
    });
  });
}

// ---------------------------------------------------------------------------
// Brief sections drawn from the match, in both brief templates. Each template's Stitch HTML
// holds one offer's illustrative text; a served brief replaces it with this offer's.
// ---------------------------------------------------------------------------
const STORAGE_TAGS = {
  "walk-in": "Walk-in cooler",
  commercial: "Commercial fridge",
  vehicle: "Refrigerated van",
  domestic: "Household fridge",
  medical: "Medical fridge",
  none: "Dry storage only",
};

// A span of hours as the brief says it: "50m", "3h 10m", "4d 21h".
function spanLabel(hours) {
  const mins = Math.max(0, Math.round(hours * 60));
  if (mins >= 2880) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  return `${mins}m`;
}

// The time this many hours from now, with the weekday when it isn't today, and the date too
// when it is more than six days off.
function clockIn(hours) {
  const t = new Date(Date.now() + hours * 3600000);
  const sameDay = t.toDateString() === new Date().toDateString();
  const day = sameDay ? {} : hours < 144 ? { weekday: "short" } : { weekday: "short", month: "short", day: "numeric" };
  return t.toLocaleString([], { ...day, hour: "numeric", minute: "2-digit" });
}

function palletLabel(n) {
  const v = Number(Number(n || 0).toFixed(2));
  return `${v} pallet${v === 1 ? "" : "s"}`;
}

// "24 of 30 pallets".
function shareLabel(part, whole) {
  return `${Number(Number(part || 0).toFixed(2))} of ${palletLabel(whole)}`;
}

// How a recipient's own collection time sits against the hours left.
function spareLabel(offer, windowHours) {
  if (windowHours == null) return "";
  const spare = Number(offer.urgency_minutes || 0) / 60 - Number(windowHours);
  return spare >= 0 ? `${spanLabel(spare)} to spare` : "needs a volunteer driver";
}

// A recipient's census tract in words. Planted teaching rows have no address, so no tract.
function tractHtml(r) {
  if (r.profile_source === "planted") return "No street address on file (a teaching case), so no census tract";
  return `Their census tract: <strong>${pct(r.no_vehicle_rate)}</strong> of households have no car, <strong>${pct(r.poverty_rate)}</strong> in poverty`;
}

// The leaf element whose text starts with a section label ("THE CLOCK", "WHO IT HELPS").
function briefLabel(scope, label) {
  return Array.from(scope.querySelectorAll("span, div")).find(
    (el) => el.children.length === 0 && el.textContent.trim().startsWith(label)
  );
}

// THE CLOCK: their collection window against the hours left, and when each one lands.
function renderBriefClock(card, offer, c) {
  const label = briefLabel(card, "THE CLOCK");
  const box = label && label.closest("div.space-y-2, div.space-y-3");
  if (!box || c.pickup_window_hours == null) return;
  const left = Number(offer.urgency_minutes || 0) / 60;
  const pickup = Number(c.pickup_window_hours);
  const spare = left - pickup;

  const status = box.firstElementChild && box.firstElementChild.lastElementChild;
  if (status) {
    const dot = status.querySelector("span");
    status.textContent =
      (dot ? " " : "● ") +
      (spare >= 0
        ? `Can collect in ~${spanLabel(pickup)} (by ${clockIn(pickup)})`
        : `Needs a volunteer driver: their pickup takes ${spanLabel(pickup)}`);
    if (dot) status.prepend(dot);
  }

  const bar = box.querySelector("div.flex.overflow-hidden");
  if (bar && bar.children.length >= 2) {
    const [route, buffer] = bar.children;
    if (spare >= 0) {
      const share = Math.min(88, Math.max(12, (pickup / Math.max(left, 0.01)) * 100));
      route.style.width = `${share}%`;
      // A thin segment on a long clock has room for the hours only.
      route.textContent = share >= 30 ? `Collection window (${spanLabel(pickup)})` : spanLabel(pickup);
      route.title = `Collection window: ${spanLabel(pickup)}`;
      buffer.style.display = "";
      buffer.style.width = `${100 - share}%`;
      buffer.textContent = `+${spanLabel(spare)} spare`;
    } else {
      route.style.width = "100%";
      route.textContent = `Their pickup takes ${spanLabel(pickup)}, ${spanLabel(-spare)} longer than the clock`;
      buffer.style.display = "none";
    }
  }

  const markers = Array.from(box.querySelectorAll("div")).find(
    (d) => d.children.length === 3 && /DOCK SHUTOFF/.test(d.textContent)
  );
  if (markers) {
    const [now, eta, shutoff] = markers.children;
    now.textContent = `NOW (${clockIn(0)})`;
    eta.textContent = spare >= 0 ? `EST. PICKUP: ${clockIn(pickup)}` : "SEND A DRIVER";
    shutoff.textContent = `DOCK SHUTOFF: ${offer.shutoff_time}`;
  }
}

// WHO IT HELPS: how many households, and the tract their street address is in.
function renderWhoItHelps(card, c) {
  const label = briefLabel(card, "WHO IT HELPS");
  const p = label && label.parentElement.querySelector("p");
  if (!p) return;
  const need =
    c.profile_source !== "planted" && c.need_score != null
      ? `, needier than about <strong>${Math.round(Number(c.need_score) * 100)}%</strong> of the metro's tracts`
      : "";
  p.innerHTML =
    (c.weekly_households
      ? `About <strong class="font-semibold text-primary">${escapeHtml(c.weekly_households)} households a week</strong>. `
      : "") + `${tractHtml(c)}${need}.`;
}

// The deli template's PICKUP note: the match's own pickup warning, or no note.
function renderPickupNote(card, c) {
  const label = Array.from(card.querySelectorAll("span")).find((el) => el.textContent.trim() === "PICKUP");
  if (!label) return;
  const note = label.parentElement.parentElement;
  const p = label.parentElement.querySelector("p");
  note.style.display = c.pickup_warning ? "" : "none";
  if (p && c.pickup_warning) p.textContent = c.pickup_warning;
}

// "Ranked #1 of 20 that can take it · closest by meaning: #7 of 60".
function renderRankLine(card, offer, c) {
  const line = briefLabel(card, "Ranked #1 of");
  if (!line || !offer.pipeline) return;
  line.textContent = `Ranked #1 of ${offer.pipeline.feasible} that can take it`;
  const meaning = line.nextElementSibling;
  if (meaning && c.semantic_rank) {
    meaning.textContent = `closest by meaning: #${c.semantic_rank} of ${offer.pipeline.semantic}`;
  }
}

// A split stop as a card: its share, storage, collection time, tract and drafted message.
function splitStopHtml(offer, s, i) {
  const storage = STORAGE_TAGS[s.cold_storage] || s.cold_storage;
  return `
    <div class="bg-surface-container-low/40 border border-outline-variant/80 rounded p-4 flex flex-col justify-between space-y-3">
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-label-uppercase font-label-uppercase font-bold text-primary">STOP ${i + 1} · ${escapeHtml(palletLabel(s.share_pallets))}</span>
          ${storage ? `<span class="bg-surface-container text-on-surface-variant text-label-badge font-label-badge px-2 py-0.5 rounded border border-outline-variant/60">${escapeHtml(storage)}</span>` : ""}
        </div>
        <div>
          <h4 class="text-headline-sm font-headline-sm text-on-surface">${escapeHtml(s.name)}</h4>
          <p class="text-body-sm font-body-sm text-outline flex items-center gap-1 mt-0.5">
            <span class="material-symbols-outlined text-sm">pin_drop</span> ${escapeHtml(s.address || "")}
          </p>
        </div>
        ${s.archetype_label ? `<div><span class="inline-block bg-tertiary-fixed text-on-tertiary-fixed text-label-badge font-label-badge px-2 py-0.5 rounded">${escapeHtml(s.archetype_label)}</span></div>` : ""}
        <div class="text-body-sm space-y-1 pt-1">
          ${
            s.pickup_window_hours != null
              ? `<div class="flex items-center gap-1.5 text-on-surface"><span class="material-symbols-outlined text-sm text-primary">schedule</span><span>Collects in ${escapeHtml(spanLabel(s.pickup_window_hours))}, ${escapeHtml(spareLabel(offer, s.pickup_window_hours))}</span></div>`
              : ""
          }
          <div class="flex items-center gap-1.5 text-error pt-0.5"><span class="material-symbols-outlined text-sm">analytics</span><span>${tractHtml(s)}</span></div>
        </div>
      </div>
      <div class="space-y-1.5 pt-2 border-t border-outline-variant/60">
        <label class="text-label-uppercase font-label-uppercase text-outline font-semibold flex items-center gap-1" for="sms-split-${i + 1}">
          <span class="material-symbols-outlined text-xs">sms</span><span>Drafted SMS · Stop ${i + 1}</span>
        </label>
        <textarea class="w-full bg-background border border-outline-variant rounded p-2.5 text-body-sm font-body-sm text-on-surface focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none resize-none font-mono text-[12px] leading-relaxed" id="sms-split-${i + 1}" rows="4">${escapeHtml(s.sms || "")}</textarea>
      </div>
    </div>`;
}

// "Or split it", served: the plan's stops, how much of the load they take, and what is left.
function renderLiveSplit(splitCard, offer) {
  const plan = offer.split_plan;
  // Polls re-render the brief: redraw only when the plan changes, so edited messages stay.
  const signature = JSON.stringify(plan.map((s) => [s.recipient_id, s.share_pallets]));
  if (splitCard.dataset.plan === signature) return;
  splitCard.dataset.plan = signature;

  const pm = offer.primary_match || {};
  const c = pm.candidate || {};
  const load = Number(offer.pallets_num || 0);
  const placed = plan.reduce((sum, s) => sum + Number(s.share_pallets || 0), 0);
  const unplaced = Math.max(0, load - placed);
  const summary = c.takes_it_all
    ? `${pm.name} can take the whole load in one stop. Splitting spreads it over ${plan.length} stops in other neighborhoods instead.`
    : `No one recipient can take all ${palletLabel(load)} in time. The plan places ${palletLabel(placed)} across ${plan.length} stops` +
      (unplaced > 0.01 ? `, and leaves ${palletLabel(unplaced)} unplaced: find another dock or call the donor back.` : ".");
  const tightest = Math.min(...plan.map((s) => Number(s.pickup_window_hours ?? 0)).map((w) => Number(offer.urgency_minutes || 0) / 60 - w));
  const noCar = plan
    .filter((s) => s.profile_source !== "planted")
    .map((s) => pct(s.no_vehicle_rate))
    .join(", ");

  splitCard.innerHTML = `
    <div class="border-b border-outline-variant/60 pb-3 space-y-1">
      <div class="flex items-center justify-between">
        <h3 class="text-headline-md font-headline-md text-on-surface flex items-center gap-2">
          <span class="material-symbols-outlined text-primary text-xl">call_split</span>
          <span>Or split it</span>
        </h3>
        <span class="bg-secondary-container text-on-secondary-container text-label-badge font-label-badge px-2 py-0.5 rounded font-semibold">${plan.length} stops · ${escapeHtml(shareLabel(placed, load))}</span>
      </div>
      <p class="text-body-md font-body-md text-on-surface-variant">${escapeHtml(summary)}</p>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 bg-surface-container-low/50 border border-outline-variant/60 rounded p-3">
      <div class="space-y-1 text-body-sm">
        <div class="font-semibold text-on-surface flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-outline"></span><span>One stop · ${escapeHtml(pm.name || "")}</span>
        </div>
        <div class="text-on-surface-variant pl-3.5 space-y-0.5">
          <div>Takes ${escapeHtml(c.takes_it_all ? `all ${palletLabel(load)}` : shareLabel(c.capacity_pallets, load))}, ${escapeHtml(spareLabel(offer, c.pickup_window_hours))}</div>
          <div>${tractHtml(c)}</div>
        </div>
      </div>
      <div class="space-y-1 text-body-sm md:border-l md:border-outline-variant/60 md:pl-4">
        <div class="font-semibold text-primary flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-primary"></span><span>Split · ${plan.length} stops, ${escapeHtml(palletLabel(placed))}</span>
        </div>
        <div class="text-on-surface-variant pl-3.5 space-y-0.5">
          <div class="font-medium text-primary">${escapeHtml(tightest >= 0 ? `${spanLabel(tightest)} to spare at the tightest stop` : "A stop needs a volunteer driver")}</div>
          ${noCar ? `<div>Households with no car in their tracts: ${escapeHtml(noCar)}</div>` : ""}
        </div>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">${plan.map((s, i) => splitStopHtml(offer, s, i)).join("")}</div>
    <div class="pt-2 border-t border-outline-variant/60 flex items-center justify-end">
      <button class="bg-primary text-on-primary hover:bg-secondary px-4 py-2 rounded text-body-sm font-body-sm font-semibold flex items-center gap-2 transition-colors cursor-pointer">
        <span class="material-symbols-outlined text-base">content_copy</span>
        <span>Use split plan · copy ${plan.length} messages</span>
      </button>
    </div>`;
}

// A standby recipient as a card: storage, collection time, tract, and the switch button.
function standbyCardHtml(offer, opt) {
  const c = opt.candidate;
  const pickup = Number(c.pickup_window_hours);
  const spare = Number(offer.urgency_minutes || 0) / 60 - pickup;
  const storage = STORAGE_TAGS[c.cold_storage] || c.cold_storage;
  return `
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-label-uppercase font-label-uppercase font-bold text-outline">OPTION ${opt.rank}</span>
        <div class="flex items-center gap-1">
          ${c.profile_source === "planted" ? `<span class="bg-surface-container text-outline text-label-uppercase font-label-uppercase px-1.5 py-0.5 rounded">teaching case</span>` : ""}
          ${storage ? `<span class="bg-tertiary-fixed text-on-tertiary-fixed text-label-badge font-label-badge px-2 py-0.5 rounded">${escapeHtml(storage)}</span>` : ""}
        </div>
      </div>
      <div>
        <h5 class="text-headline-sm font-headline-sm text-on-surface">${opt.rank}. ${escapeHtml(opt.name)}</h5>
        <p class="text-body-sm font-body-sm text-outline">${escapeHtml(opt.address || "")}</p>
      </div>
      <div class="text-body-sm space-y-1 pt-1">
        ${
          spare >= 0
            ? `<div class="flex items-center gap-1.5 text-on-surface"><span class="material-symbols-outlined text-sm text-primary">pace</span><span>Can collect in ${escapeHtml(spanLabel(pickup))}, ${escapeHtml(spanLabel(spare))} to spare</span></div>`
            : `<div class="bg-error-container/20 border border-error/20 rounded p-2 text-on-error-container flex items-start gap-1.5"><span class="material-symbols-outlined text-sm text-error mt-0.5">warning</span><span>Needs a volunteer driver: they need ${escapeHtml(spanLabel(pickup))} to collect</span></div>`
        }
        <div class="flex items-start gap-1.5 text-error"><span class="material-symbols-outlined text-sm mt-0.5">analytics</span><span>${tractHtml(c)}</span></div>
      </div>
    </div>
    <button class="w-full bg-surface-container-low border border-outline-variant text-on-surface hover:bg-surface-container py-1.5 px-3 rounded text-body-sm font-body-sm font-medium flex items-center justify-center gap-1 transition-colors cursor-pointer">
      <span class="material-symbols-outlined text-sm">swap_horiz</span><span>Switch to this match</span>
    </button>`;
}

function renderSplitLoadSection(offer) {
  const splitHeader = Array.from(document.querySelectorAll("h3, h4")).find((el) =>
    el.textContent.includes("Or split it")
  );
  const splitCard = splitHeader && splitHeader.closest(".bg-surface-container-lowest");
  if (!splitCard) return;

  if (!offer.split_plan || offer.split_plan.length < 2) {
    splitCard.style.display = "none";
    return;
  }
  splitCard.style.display = "";
  if (offer.matched) {
    renderLiveSplit(splitCard, offer);
    return;
  }

  const stop1 = offer.split_plan[0];
  const stop2 = offer.split_plan[1];
  const stopCards = splitCard.querySelectorAll(".grid.grid-cols-1.md\\:grid-cols-2 > div");
  if (stopCards[0] && stop1) {
    const h4 = stopCards[0].querySelector("h4, h5");
    const sharePill = stopCards[0].querySelector("span.bg-secondary-container, .font-mono.font-bold.text-primary");
    if (h4) h4.textContent = `1. ${stop1.name}`;
    if (sharePill) sharePill.textContent = stop1.share;
  }
  if (stopCards[1] && stop2) {
    const h4 = stopCards[1].querySelector("h4, h5");
    const sharePill = stopCards[1].querySelector("span.bg-secondary-container, .font-mono.font-bold.text-primary");
    if (h4) h4.textContent = `2. ${stop2.name}`;
    if (sharePill) sharePill.textContent = stop2.share;
  }
}

function renderStandbyOptionsSection(offer) {
  const standbyHeader = Array.from(document.querySelectorAll("h3, h4")).find((el) =>
    el.textContent.includes("Next options")
  );
  // The header sits in its own row; the cards are in the grid beside it, in both templates.
  const container = standbyHeader && standbyHeader.closest("div.space-y-3, div.space-y-4");
  if (!container || !offer.next_options) return;

  const cards = container.querySelectorAll(".grid > div");
  if (offer.matched) {
    Array.from(cards).slice(0, 2).forEach((card, idx) => {
      const opt = offer.next_options[idx];
      card.style.display = opt && opt.candidate ? "" : "none";
      if (!opt || !opt.candidate) return;
      card.setAttribute("data-standby-index", String(idx));
      card.innerHTML = standbyCardHtml(offer, opt);
    });
    return;
  }
  offer.next_options.slice(0, 2).forEach((opt, idx) => {
    const card = cards[idx];
    if (!card) return;
    card.setAttribute("data-standby-index", String(idx));

    const titleEl = card.querySelector("h4, h5");
    if (titleEl) titleEl.textContent = opt.name;

    const addrEl =
      card.querySelector("p.text-outline") ||
      card.querySelector("div.flex.items-center.gap-1 > span:last-child") ||
      card.querySelector("p.text-\\[12px\\], p.text-xs");
    if (addrEl) {
      addrEl.textContent = opt.address;
    }

    const reasonBox = card.querySelector("div.bg-surface.border p, p.text-on-surface.pt-0\\.5");
    if (reasonBox && opt.reason) {
      reasonBox.textContent = opt.reason;
    }
  });
}

function renderRuledOutSection(offer) {
  if (!offer.ruled_out) return;
  const ruledHeader = Array.from(document.querySelectorAll("h3")).find((el) =>
    el.textContent.includes("Ruled out")
  );
  // The deli template's right column is xl:col-span-4.
  const ruledCol =
    ruledHeader && ruledHeader.closest("aside, .lg\\:col-span-4, .xl\\:col-span-4, .col-span-12");
  if (!ruledCol) return;

  const totalRuledOut =
    (offer.pipeline && (offer.pipeline.semantic || 60) - (offer.pipeline.feasible || 20)) ||
    offer.ruled_out.length;

  const countBadge = ruledHeader.querySelector("span:nth-child(2)");
  if (countBadge) {
    countBadge.textContent = String(totalRuledOut);
  } else if (!ruledHeader.children.length) {
    ruledHeader.textContent = `Ruled out ${totalRuledOut}`;   // the deli heading has no badge
  }
  const moreBtn = Array.from(ruledCol.querySelectorAll("button")).find((b) =>
    b.textContent.includes("ruled out agencies")
  );
  if (moreBtn && offer.matched) {
    const more = totalRuledOut - Math.min(5, offer.ruled_out.length);
    (moreBtn.querySelector("span") || moreBtn).textContent =
      more > 0 ? `Show ${more} more ruled out agencies` : "Show the ruled out agencies";
  }

  const listEl = ruledCol.querySelector(".divide-y, .space-y-3");
  if (listEl) {
    listEl.innerHTML = offer.ruled_out
      .slice(0, 5)
      .map(
        (item) => `
        <div class="p-3 rounded bg-surface border border-outline-variant/80 space-y-1.5">
          <div class="flex items-start justify-between gap-2">
            <span class="font-semibold text-body-sm text-on-surface line-through decoration-outline">${escapeHtml(item.name)}</span>
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold ${
              item.color === "error"
                ? "bg-error-container text-on-error-container"
                : "bg-surface-container-high text-on-surface-variant"
            } shrink-0">
              <span class="material-symbols-outlined text-[12px]">${escapeHtml(item.icon || "block")}</span>
              ${escapeHtml(item.tag)}
            </span>
          </div>
          <p class="text-[12px] text-on-surface-variant leading-snug">${escapeHtml(item.detail)}</p>
        </div>
      `
      )
      .join("\n");
  }
}

export function wireMatchBriefButtons() {
  if (!isMatchBriefPage()) return;
  const offerKey = getActiveOfferKey(APP_STATE.offers);

  document.querySelectorAll("button, a").forEach((btn) => {
    if (btn.hasAttribute("data-mb-wired")) return;
    const text = (btn.textContent || "").trim();

    if (text.includes("Copy message")) {
      btn.setAttribute("data-mb-wired", "1");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const smsBox = document.getElementById("dispatch-sms") || document.querySelector("textarea");
        const msg = smsBox ? smsBox.value : "";
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(msg).catch(() => {});
        }
        showToast("Dispatch SMS copied to clipboard!", "content_copy");
      });
    } else if (
      text.includes("Mark as sent") ||
      btn.getAttribute("data-role") === "mark-sent-btn"
    ) {
      btn.setAttribute("data-mb-wired", "1");
      btn.setAttribute("data-role", "mark-sent-btn");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const currentOffer = APP_STATE.offers[offerKey];
        if (currentOffer && currentOffer.status === "awaiting") {
          markOfferAccepted(offerKey);
          return;
        }
        if (currentOffer && currentOffer.status === "accepted") {
          markOfferDonated(offerKey);
          return;
        }
        const smsBox = document.getElementById("dispatch-sms") || document.querySelector("textarea");
        markOfferSent(offerKey, smsBox ? smsBox.value : undefined);
      });
    } else if (text.includes("Use split plan")) {
      btn.setAttribute("data-mb-wired", "1");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        activateSplitPlan(offerKey);
      });
    } else if (text.includes("They said no")) {
      btn.setAttribute("data-mb-wired", "1");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        recordDecline(offerKey);
      });
    } else if (text.includes("Switch to this match") || text.includes("Inspect route")) {
      btn.setAttribute("data-mb-wired", "1");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const parentCard = btn.closest("[data-standby-index], .bg-surface-container-lowest");
        const idx =
          parentCard && parentCard.hasAttribute("data-standby-index")
            ? Number(parentCard.getAttribute("data-standby-index"))
            : 0;
        switchToOption(offerKey, idx);
      });
    } else if (text.includes("ruled out agencies")) {
      btn.setAttribute("data-mb-wired", "1");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openRuledOutModal(APP_STATE.offers[offerKey]);
      });
    }
  });

  document.querySelectorAll('[data-icon="arrow_back"]').forEach((icon) => {
    if (icon.hasAttribute("data-mb-wired")) return;
    icon.setAttribute("data-mb-wired", "1");
    icon.addEventListener("click", () => {
      window.location.href = "queue.html";
    });
  });
}
