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
import { escapeHtml, getActiveOfferKey, isMatchBriefPage, showToast } from "./ui-utils.js";

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
    const breadcrumbSpans = headerSec.querySelectorAll("div.flex.items-center.gap-2 > span");
    if (breadcrumbSpans.length >= 2) {
      breadcrumbSpans[breadcrumbSpans.length - 1].textContent = `${offer.title} \u00b7 Offer ${offer.offer_code}`;
    }

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

    const clockStatusRight = primaryCard.querySelector(
      ".text-label-badge.text-primary.font-semibold, .font-tabular-data-sm.text-primary.font-semibold"
    );
    if (clockStatusRight) {
      clockStatusRight.textContent =
        pm.clock_text ||
        `Est. pickup ${pm.pickup_eta || "4:15 PM"} \u00b7 ${pm.buffer_mins || 90}m safety buffer before ${offer.shutoff_time}`;
    }

    const allBoxes = Array.from(primaryCard.querySelectorAll("div.bg-surface.border"));
    const equityBox = allBoxes.find((b) => b.textContent.includes("WHO IT HELPS"));
    if (equityBox) {
      const eqP = equityBox.querySelector("p");
      if (eqP && pm.tract_id) {
        eqP.innerHTML = `Census Tract <strong>${escapeHtml(pm.tract_id)}</strong> \u00b7 <strong>${escapeHtml(pm.insecurity_rate)}</strong> food insecurity (${escapeHtml(pm.insecurity_note || "above 12.8% metro avg")}), <strong>${escapeHtml(pm.no_vehicle_rate)}</strong> households without a vehicle, and <strong>${escapeHtml(pm.poverty_rate)}</strong> poverty rate.`;
      } else if (eqP && pm.poverty_rate) {
        eqP.innerHTML = `Their census tract: <strong>${escapeHtml(pm.insecurity_rate)}</strong> food insecure, <strong>${escapeHtml(pm.no_vehicle_rate)}</strong> of households without a vehicle, <strong>${escapeHtml(pm.poverty_rate)}</strong> in poverty.${pm.weekly_households ? ` They serve about ${escapeHtml(pm.weekly_households)} households a week.` : ""}`;
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

  const stop1 = offer.split_plan[0];
  const stop2 = offer.split_plan[1];
  const stopCards = splitCard.querySelectorAll(".grid.grid-cols-1.md\\:grid-cols-2 > div");
  if (stopCards[0] && stop1) {
    const h4 = stopCards[0].querySelector("h4, h5");
    const sharePill = stopCards[0].querySelector(
      "span.bg-secondary-container, .font-mono.font-bold.text-primary"
    );
    if (h4) h4.textContent = `1. ${stop1.name}`;
    if (sharePill) sharePill.textContent = stop1.share;
  }
  if (stopCards[1] && stop2) {
    const h4 = stopCards[1].querySelector("h4, h5");
    const sharePill = stopCards[1].querySelector(
      "span.bg-secondary-container, .font-mono.font-bold.text-primary"
    );
    if (h4) h4.textContent = `2. ${stop2.name}`;
    if (sharePill) sharePill.textContent = stop2.share;
  }
}

function renderStandbyOptionsSection(offer) {
  const standbyHeader = Array.from(document.querySelectorAll("h3, h4")).find((el) =>
    el.textContent.includes("Next options")
  );
  const container = standbyHeader && standbyHeader.parentElement;
  if (!container || !offer.next_options) return;

  const cards = container.querySelectorAll(".grid > div");
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
  const ruledCol = ruledHeader && ruledHeader.closest("aside, .lg\\:col-span-4, .col-span-12");
  if (!ruledCol) return;

  const totalRuledOut =
    (offer.pipeline && (offer.pipeline.semantic || 60) - (offer.pipeline.feasible || 20)) ||
    offer.ruled_out.length;

  const countBadge = ruledHeader.querySelector("span:nth-child(2)");
  if (countBadge) {
    countBadge.textContent = String(totalRuledOut);
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
