/**
 * @module console/agent-formatters
 * Plain-English, user-friendly UI component formatters for Broker Agent responses:
 * - Translates raw operational/database fields into clear, human-readable cards for
 *   coordinators (`match_surplus_posting`, `check_shelf_life`, `get_recipient_tract_equity`,
 *   `split_large_load`, `recommend_open_postings`, `list_open_requests`, and dispatch updates).
 * - Full Markdown renderer (`formatAgentMarkdown`) for narrative responses, headings,
 *   lists, copyable SMS blockquotes, and tables.
 */

import { escapeHtml, pct } from "./ui-utils.js";

export const TOOL_META_MAP = {
  match_surplus_posting: { label: "Recipient Matching", icon: "hub" },
  check_shelf_life: { label: "Food Safety & Freshness Check", icon: "timer" },
  get_recipient_tract_equity: { label: "Community Need & Impact", icon: "diversity_3" },
  split_large_load: { label: "Multi-Stop Delivery Plan", icon: "call_split" },
  recommend_open_postings: { label: "Today's Open Offers Review", icon: "playlist_add_check" },
  record_grocer_request: { label: "Saved Grocer Donation", icon: "bookmark_added" },
  record_offer: { label: "Recorded Pantry Offer", icon: "send" },
  record_offer_response: { label: "Updated Pantry Reply", icon: "mark_chat_read" },
  record_recipient_hold: { label: "Temporary Receiving Hold", icon: "pause_circle" },
  list_open_requests: { label: "Active Queue Check", icon: "pending_actions" },
};

const STORAGE_LABELS = {
  vehicle: "Refrigerated Van",
  "walk-in": "Walk-in Cooler",
  commercial: "Commercial Kitchen Fridge",
  domestic: "Household Fridge",
  medical: "Medical Fridge Only",
  none: "Dry Storage Only (No Fridge)",
};

function friendlyStorage(coldStorage, frozenStorage = false) {
  const base =
    STORAGE_LABELS[String(coldStorage || "").toLowerCase()] ||
    String(coldStorage || "Verified Storage");
  return frozenStorage ? `${base} + Freezer` : base;
}

function friendlyCollection(canSelfCollect, reefer, pickupWinHours) {
  if (canSelfCollect && reefer) {
    return `Can pick up in their refrigerated van (${pickupWinHours || 4}h window)`;
  }
  if (canSelfCollect) {
    return `Can pick up within ${pickupWinHours || 4} hours`;
  }
  return `Needs a volunteer driver (${pickupWinHours || 12}h standard notice)`;
}

function friendlyEliminationReason(rawReason) {
  const r = String(rawReason || "").trim();
  if (!r) return "Does not meet storage or schedule requirements today";
  const lower = r.toLowerCase();
  if (lower.includes("no refrigeration")) {
    return "No refrigeration on site — perishable food would spoil";
  }
  if (lower.includes("medical fridge")) {
    return "Medical refrigerator only — cannot store donated food";
  }
  if (lower.includes("no freezer")) {
    return "No freezer available for frozen items";
  }
  if (lower.includes("contradicts") || lower.includes("single shelf")) {
    return "Storage records conflict (walk-in vs. cupboard shelf) — call to verify first";
  }
  if (lower.includes("opening days conflict")) {
    return "Operating schedule conflicts between profile and records — call to confirm";
  }
  if (lower.includes("not open in time")) {
    const openMatch = r.match(/\(open ([^)]+)\)/i);
    return openMatch
      ? `Closed during this rescue window (open ${openMatch[1]})`
      : "Closed during this rescue window";
  }
  return r.split("|")[0].trim();
}

function friendlyWhyWinner(top1, top2) {
  const raw = String(top1.tie_breaker_reason || "");
  if (
    raw &&
    !raw.includes("vector distance") &&
    !raw.includes("composite_score") &&
    !raw.includes("cold_storage=")
  ) {
    return raw;
  }
  const cc1 = top1.clock_compatibility || {};
  const ops1 = top1.operational_capabilities || {};
  const eq1 = top1.tract_equity || {};
  const parts = [];
  if (cc1.can_self_collect && ops1.refrigerated_transport) {
    parts.push("can collect directly in their own refrigerated vehicle before the deadline");
  } else if (cc1.can_self_collect) {
    parts.push("can collect within the store's deadline with time to spare");
  } else {
    parts.push("has the cold-storage capacity to take the full donation today");
  }
  if (ops1.weekly_households) {
    parts.push(`reaches ~${ops1.weekly_households} households each week`);
  }
  if (eq1.poverty_rate != null && eq1.no_vehicle_rate != null) {
    parts.push(
      `serves a priority neighborhood (${pct(eq1.poverty_rate)} poverty, ${pct(eq1.no_vehicle_rate)} of households without a car)`
    );
  }
  const summary = `${top1.name} ${parts.join(", and ")}.`;
  return top2 ? `Chosen ahead of ${top2.name}: ${summary}` : summary;
}

function friendlyClockFactor(factor, note) {
  const f = String(factor || "").toLowerCase();
  if (f.includes("donor_deadline")) {
    return "Store's pickup deadline comes before the food expires";
  }
  if (f.includes("foodkeeper")) {
    return "USDA food-safety window is shorter than the store's deadline";
  }
  if (note) {
    return `Guided by package date (${String(note).replace(/_/g, " ")})`;
  }
  return "Whichever comes first between the store deadline and food safety";
}

/**
 * Strips technical identifiers (`cold_storage = 'none'`, `pickup_window_hours`, etc.)
 * from inline markdown so even the agent's prose reads in plain English.
 */
function humanizeProseText(str) {
  return String(str || "")
    .replace(/\s*\((?:raw\s+)?vector\s+distance[^)]*\)/gi, "")
    .replace(/\s*\((?:cosine\s+)?distance\s+[\d.]+[^)]*\)/gi, "")
    .replace(/\s*\((?:composite\s+)?score\s+[\d.]+[^)]*\)/gi, "")
    .replace(/`cold_storage\s*=\s*'none'`/gi, "no refrigeration (dry storage only)")
    .replace(/`cold_storage\s*=\s*'([^']+)'`/gi, "$1 refrigeration")
    .replace(/\bcold_storage\b/g, "cold storage")
    .replace(/\bpickup_window_hours\b/g, "pickup window")
    .replace(/\beffective_window_hours\b/g, "rescue window")
    .replace(/\bhours_remaining\b/g, "hours remaining")
    .replace(/\bno_vehicle_rate\b/g, "households without a vehicle")
    .replace(/\bpoverty_rate\b/g, "poverty rate")
    .replace(/\bassistance_rate\b/g, "SNAP / public assistance rate")
    .replace(/\bmax_pallets\b/g, "pallet capacity")
    .replace(/\bweekly_households\b/g, "weekly households served")
    .replace(/\brefrigerated_transport\b/g, "refrigerated transport")
    .replace(/\bloading_dock\b/g, "loading dock")
    .replace(/\bservice_days\b/g, "operating days");
}

function renderInlineMarkdown(str) {
  return escapeHtml(humanizeProseText(str))
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-on-surface">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="italic">$1</em>')
    .replace(
      /`([^`]+)`/g,
      '<span class="bg-surface-container px-1.5 py-0.5 rounded font-medium text-[11px] text-primary">$1</span>'
    );
}

/**
 * Converts Markdown text from the ADK agent into clean, structured HTML
 * (headings, numbered & bulleted lists, copyable SMS blockquotes, and tables).
 */
export function formatAgentMarkdown(text) {
  if (!text) return "";
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let inList = null; // "ul" | "ol"
  let listItems = [];
  let quoteLines = [];
  let tableRows = [];

  function flushList() {
    if (!inList || !listItems.length) return;
    if (inList === "ol") {
      blocks.push(
        `<ol class="space-y-1.5 my-2 pl-4 list-decimal marker:font-bold marker:text-primary text-[11.5px] text-on-surface">${listItems
          .map((item) => `<li class="leading-relaxed pl-1">${item}</li>`)
          .join("")}</ol>`
      );
    } else {
      blocks.push(
        `<ul class="space-y-1 my-1.5 pl-4 list-disc marker:text-primary text-[11.5px] text-on-surface">${listItems
          .map((item) => `<li class="leading-relaxed">${item}</li>`)
          .join("")}</ul>`
      );
    }
    inList = null;
    listItems = [];
  }

  function flushQuote() {
    if (!quoteLines.length) return;
    const rawMsg = quoteLines.join(" ").replace(/^["“]|["”]$/g, "").trim();
    blocks.push(`
      <div class="my-2 p-2.5 rounded bg-surface-container-low border-l-3 border-l-primary border border-outline-variant/60 space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] font-bold uppercase tracking-wider text-primary flex items-center gap-1">
            <span class="material-symbols-outlined text-[12px]">sms</span> Suggested Text Message
          </span>
          <button type="button" data-copy-sms="${escapeHtml(rawMsg)}" class="px-2 py-0.5 rounded bg-primary text-on-primary text-[10px] font-bold hover:bg-primary-container cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-[11px]">content_copy</span> Copy Message
          </button>
        </div>
        <p class="text-[11.5px] text-on-surface leading-relaxed">${renderInlineMarkdown(quoteLines.join("\n"))}</p>
      </div>
    `);
    quoteLines = [];
  }

  function flushTable() {
    if (!tableRows.length) return;
    const dataRows = tableRows.filter((r) => !/^[\s|:-]+$/.test(r));
    if (dataRows.length > 0) {
      const parseCells = (row) =>
        row
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => renderInlineMarkdown(c.trim()));
      const header = parseCells(dataRows[0]);
      const body = dataRows.slice(1).map(parseCells);
      blocks.push(`
        <div class="my-2 overflow-x-auto rounded border border-outline-variant/60">
          <table class="w-full text-[11px]">
            <thead class="bg-surface-container text-on-surface-variant uppercase text-[10px]">
              <tr>${header.map((h) => `<th class="px-2 py-1.5 text-left font-bold">${h}</th>`).join("")}</tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/40 bg-surface-container-lowest">
              ${body
                .map(
                  (r) =>
                    `<tr>${r.map((c) => `<td class="px-2 py-1.5 text-on-surface">${c}</td>`).join("")}</tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      `);
    }
    tableRows = [];
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushList();
      flushQuote();
      tableRows.push(trimmed);
      continue;
    } else {
      flushTable();
    }

    if (trimmed.startsWith(">")) {
      flushList();
      quoteLines.push(trimmed.replace(/^>\s?/, ""));
      continue;
    } else {
      flushQuote();
    }

    if (!trimmed) {
      flushList();
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushList();
      blocks.push('<hr class="my-2 border-outline-variant/50" />');
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushList();
      const level = hMatch[1].length;
      const title = renderInlineMarkdown(hMatch[2]);
      if (level <= 2) {
        blocks.push(
          `<h4 class="text-xs font-bold text-primary uppercase tracking-wide pt-2 pb-1 border-b border-outline-variant/50 flex items-center gap-1.5"><span class="material-symbols-outlined text-[14px]">fact_check</span><span>${title}</span></h4>`
        );
      } else {
        blocks.push(
          `<h5 class="text-xs font-bold text-on-surface pt-1.5 pb-0.5 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-primary inline-block"></span><span>${title}</span></h5>`
        );
      }
      continue;
    }

    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      if (inList !== "ol") {
        flushList();
        inList = "ol";
      }
      listItems.push(renderInlineMarkdown(olMatch[2]));
      continue;
    }

    const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== "ul") {
        flushList();
        inList = "ul";
      }
      listItems.push(renderInlineMarkdown(ulMatch[1]));
      continue;
    }

    if (inList && /^\s{2,}/.test(rawLine) && listItems.length > 0) {
      listItems[listItems.length - 1] += `<div class="mt-0.5 text-on-surface-variant">${renderInlineMarkdown(trimmed)}</div>`;
      continue;
    }

    flushList();
    blocks.push(
      `<p class="text-[11.5px] leading-relaxed text-on-surface">${renderInlineMarkdown(trimmed)}</p>`
    );
  }

  flushList();
  flushQuote();
  flushTable();
  return blocks.join("");
}

/**
 * Renders structured interactive UI cards from the ADK agent's `toolResponses`
 * in plain, non-technical language.
 */
export function buildAgentToolCardsHtml(toolResponses) {
  if (!Array.isArray(toolResponses) || toolResponses.length === 0) return "";
  const cards = [];

  for (const tr of toolResponses) {
    const name = tr.name;
    const resp = tr.response || {};

    if (name === "match_surplus_posting" && Array.isArray(resp.ranked_matches)) {
      cards.push(renderMatchSurplusCard(resp));
    } else if (
      name === "check_shelf_life" &&
      (resp.effective_window_hours != null || resp.effective_hours_remaining != null)
    ) {
      if (!toolResponses.some((t) => t.name === "match_surplus_posting")) {
        cards.push(renderShelfLifeCard(resp));
      }
    } else if (
      name === "get_recipient_tract_equity" &&
      (resp.poverty_rate != null || resp.tract_geo_id != null || resp.tract_geoid != null)
    ) {
      cards.push(renderTractEquityCard(resp));
    } else if (
      name === "split_large_load" &&
      Array.isArray(resp.allocation_plan || resp.allocations)
    ) {
      cards.push(renderSplitLoadCard(resp));
    } else if (name === "recommend_open_postings" && Array.isArray(resp.postings)) {
      cards.push(renderRecommendOpenPostingsCard(resp));
    } else if (name === "list_open_requests" && Array.isArray(resp.requests)) {
      cards.push(renderOpenRequestsCard(resp));
    } else if (
      (name === "record_grocer_request" ||
        name === "record_offer" ||
        name === "record_offer_response" ||
        name === "record_recipient_hold") &&
      resp.status
    ) {
      cards.push(renderStateActionCard(name, resp));
    }
  }

  return cards.filter(Boolean).join("");
}

function renderMatchSurplusCard(resp) {
  const ranked = resp.ranked_matches || [];
  const elims = resp.eliminated_near_misses || [];
  const clock = resp.clock || {};
  const splitPlan = resp.split_plan || [];
  const top1 = ranked[0];
  const top2 = ranked[1];
  const backups = ranked.slice(1, 3);

  if (!top1) {
    return `
      <div class="p-3 rounded bg-error-container/30 border border-error/40 text-xs space-y-1">
        <div class="font-bold text-error flex items-center gap-1.5">
          <span class="material-symbols-outlined text-sm">warning</span>
          <span>No Safe Match Available right now</span>
        </div>
        <p class="text-[11px] text-on-surface-variant">No open partner has the required refrigeration and pickup window for "${escapeHtml(resp.posting_text)}".</p>
      </div>
    `;
  }

  const ops = top1.operational_capabilities || {};
  const cc = top1.clock_compatibility || {};
  const eq = top1.tract_equity || {};
  const effHrs = Number(clock.effective_window_hours ?? cc.effective_window_hours ?? 6).toFixed(1).replace(/\.0$/, "");
  const marginHrs = Number(cc.margin_hours ?? 0).toFixed(1).replace(/\.0$/, "");

  const storageLabel = friendlyStorage(ops.cold_storage, ops.frozen_storage);
  const collectionLabel = friendlyCollection(
    cc.can_self_collect,
    ops.refrigerated_transport,
    ops.pickup_window_hours
  );
  const whyWinnerText = friendlyWhyWinner(top1, top2);

  const backupsHtml =
    backups.length > 0
      ? `
      <div class="space-y-1.5 pt-2 border-t border-outline-variant/50">
        <div class="text-[10.5px] font-bold uppercase tracking-wider text-on-surface-variant">Backup Options (If #1 Is Unavailable)</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${backups
            .map((b, i) => {
              const bOps = b.operational_capabilities || {};
              const bCc = b.clock_compatibility || {};
              const bEq = b.tract_equity || {};
              return `
                <div class="p-2.5 rounded bg-surface border border-outline-variant/70 space-y-1">
                  <div class="flex items-center justify-between gap-1">
                    <span class="font-bold text-[11.5px] text-on-surface truncate">Option #${i + 2}: ${escapeHtml(b.name)}</span>
                  </div>
                  <div class="text-[10.5px] text-on-surface-variant space-y-0.5">
                    <div>${escapeHtml(friendlyStorage(bOps.cold_storage, bOps.frozen_storage))} · holds up to ${bOps.max_pallets || 1} pallet(s)</div>
                    <div>${bCc.can_self_collect ? `Can pick up in ${bOps.pickup_window_hours}h` : "Needs a volunteer driver"}</div>
                    ${bEq.no_vehicle_rate != null ? `<div class="text-primary font-medium">${pct(bEq.no_vehicle_rate)} of local households have no car</div>` : ""}
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `
      : "";

  const splitHtml =
    splitPlan.length >= 2
      ? `
      <div class="p-2.5 rounded bg-amber-50/80 border border-amber-300/80 space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[10.5px] font-bold uppercase tracking-wider text-amber-900 flex items-center gap-1">
            <span class="material-symbols-outlined text-[14px]">call_split</span> Or Split Across ${splitPlan.length} Smaller Pantries
          </span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${splitPlan
            .map(
              (s) =>
                `<span class="px-2 py-0.5 rounded bg-white border border-amber-300 text-[11px] font-medium text-amber-950">Stop ${s.split_stop}: <strong>${escapeHtml(s.name)}</strong> (${s.pallets} pallet)</span>`
            )
            .join("")}
        </div>
      </div>
    `
      : "";

  const elimsHtml =
    elims.length > 0
      ? `
      <div class="space-y-1.5 pt-2 border-t border-outline-variant/50">
        <div class="text-[10.5px] font-bold uppercase tracking-wider text-on-surface-variant">Why Other Close Matches Were Ruled Out</div>
        <div class="space-y-1">
          ${elims
            .slice(0, 3)
            .map(
              (e) => `
              <div class="flex items-start justify-between gap-2 px-2.5 py-1.5 rounded bg-error-container/20 border border-error/20 text-[11px]">
                <span class="font-semibold text-on-surface line-through shrink-0">${escapeHtml(e.name)}</span>
                <span class="text-on-error-container text-right">${escapeHtml(friendlyEliminationReason(e.elimination_reason))}</span>
              </div>
            `
            )
            .join("")}
        </div>
      </div>
    `
      : "";

  const smsHtml = top1.draft_outreach_message
    ? `
      <div class="p-2.5 rounded bg-surface-container-low border border-outline-variant space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[10.5px] font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1">
            <span class="material-symbols-outlined text-[13px] text-primary">sms</span> Ready-to-Send Text Message
          </span>
          <button type="button" data-copy-sms="${escapeHtml(top1.draft_outreach_message)}" class="px-2.5 py-1 rounded bg-primary text-on-primary text-[10.5px] font-bold hover:bg-primary-container cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-[12px]">content_copy</span> Copy Message
          </button>
        </div>
        <p class="text-[11px] text-on-surface leading-relaxed">${escapeHtml(top1.draft_outreach_message)}</p>
      </div>
    `
    : "";

  return `
    <div class="rounded border-l-4 border-l-primary border border-outline-variant bg-surface-container-lowest p-3.5 space-y-3 shadow-2xs">
      <!-- Top Recommended Header -->
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="px-2 py-0.5 rounded bg-primary text-on-primary text-[10px] font-bold uppercase">Best Match</span>
            <span class="px-2 py-0.5 rounded bg-tertiary-fixed text-on-tertiary-fixed text-[10px] font-semibold">${escapeHtml(top1.archetype_label || "Verified Partner")}</span>
          </div>
          <h4 class="font-bold text-sm text-on-surface mt-1">${escapeHtml(top1.name)}</h4>
          <p class="text-[11px] text-on-surface-variant flex items-center gap-1">
            <span class="material-symbols-outlined text-[13px] text-outline">location_on</span>
            <span>${escapeHtml(top1.address || "Atlanta Metro")}</span>
          </p>
        </div>
        <button type="button" data-focus-recipient-id="${top1.recipient_id}" class="px-2.5 py-1 rounded border border-outline-variant hover:border-primary text-[10.5px] font-semibold text-primary shrink-0 cursor-pointer flex items-center gap-1" title="Show on map">
          <span class="material-symbols-outlined text-[13px]">my_location</span> Show on Map
        </button>
      </div>

      <!-- 3 Plain-Language Highlights: Storage, Pickup Timing, Community Impact -->
      <div class="grid grid-cols-3 gap-2 text-[11px]">
        <div class="p-2.5 rounded bg-surface-container-low border border-outline-variant/60">
          <div class="text-[10px] font-bold uppercase text-on-surface-variant">Cold Storage &amp; Space</div>
          <div class="font-bold text-on-surface mt-0.5">${escapeHtml(storageLabel)}</div>
          <div class="text-[10.5px] text-primary font-medium">Holds up to ${ops.max_pallets || 1} pallet(s)</div>
        </div>
        <div class="p-2.5 rounded bg-surface-container-low border border-outline-variant/60">
          <div class="text-[10px] font-bold uppercase text-on-surface-variant">Pickup Plan (${effHrs}h left)</div>
          <div class="font-bold ${Number(marginHrs) >= 0 ? "text-primary" : "text-amber-700"} mt-0.5">${Number(marginHrs) >= 0 ? `${marginHrs}h time buffer` : `Needs volunteer driver`}</div>
          <div class="text-[10.5px] text-on-surface-variant leading-snug">${escapeHtml(collectionLabel)}</div>
        </div>
        <div class="p-2.5 rounded bg-surface-container-low border border-outline-variant/60">
          <div class="text-[10px] font-bold uppercase text-on-surface-variant">Who It Helps</div>
          <div class="font-bold text-on-surface mt-0.5">${ops.weekly_households ? `~${ops.weekly_households} families/wk` : eq.poverty_rate != null ? `${pct(eq.poverty_rate)} poverty` : "Local families"}</div>
          <div class="text-[10.5px] text-on-surface-variant">${eq.no_vehicle_rate != null ? `${pct(eq.no_vehicle_rate)} have no car` : "Verified partner"}</div>
        </div>
      </div>

      <div class="px-2.5 py-2 rounded bg-secondary-container/40 border border-secondary/30 text-[11px] text-on-surface leading-relaxed">
        <strong class="text-primary">Why this partner:</strong> ${escapeHtml(whyWinnerText)}
      </div>

      ${splitHtml}
      ${backupsHtml}
      ${elimsHtml}
      ${smsHtml}
    </div>
  `;
}

function renderShelfLifeCard(resp) {
  const eff = resp.effective_window_hours ?? resp.effective_hours_remaining ?? 6;
  const shelf = resp.shelf_life_hours ?? resp.usda_shelf_life_hours;
  const donor = resp.donor_deadline_hours;
  const product =
    resp.matched_product || resp.matched_product_name || resp.queried_item || "Food item";
  const note = resp.storage_note || resp.usda_note;

  return `
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[10.5px] font-bold uppercase tracking-wider text-primary flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px]">timer</span> Food Safety &amp; Pickup Window
        </span>
        <span class="px-2 py-0.5 rounded bg-tertiary-fixed text-on-tertiary-fixed text-[10.5px] font-bold">Must move within ${eff} hours</span>
      </div>
      <div class="grid grid-cols-3 gap-2 text-[11px]">
        <div class="p-2 rounded bg-surface-container-low">
          <div class="text-[10px] font-bold uppercase text-on-surface-variant">Food Type</div>
          <div class="font-bold text-on-surface mt-0.5">${escapeHtml(product)}</div>
        </div>
        <div class="p-2 rounded bg-surface-container-low">
          <div class="text-[10px] font-bold uppercase text-on-surface-variant">USDA Freshness Guide</div>
          <div class="font-bold text-on-surface mt-0.5">${shelf != null ? `${shelf} hours` : "Check package date"}</div>
        </div>
        <div class="p-2 rounded bg-surface-container-low">
          <div class="text-[10px] font-bold uppercase text-on-surface-variant">Store Dock Deadline</div>
          <div class="font-bold text-on-surface mt-0.5">${donor != null ? `${donor} hours` : "Not set"}</div>
        </div>
      </div>
      <p class="text-[11px] text-on-surface-variant"><strong>Why this clock:</strong> ${escapeHtml(friendlyClockFactor(resp.clock_limiting_factor, note))}.</p>
    </div>
  `;
}

function renderTractEquityCard(resp) {
  const bench = resp.atlanta_metro_benchmarks || resp.metro_averages || {};
  const pov = resp.poverty_rate;
  const mPov = bench.metro_poverty_rate ?? bench.poverty_rate ?? 0.185;
  const veh = resp.no_vehicle_rate;
  const mVeh = bench.metro_no_vehicle_rate ?? bench.no_vehicle_rate ?? 0.129;
  const asst = resp.assistance_rate;
  const mAsst = bench.metro_assistance_rate ?? bench.assistance_rate ?? 0.181;

  function metricBar(label, val, baseVal) {
    if (val == null) return "";
    const widthPct = Math.min(100, Math.round(val * 220));
    const basePct = Math.min(100, Math.round(baseVal * 220));
    const higher = val >= baseVal;
    return `
      <div class="space-y-1">
        <div class="flex justify-between text-[11px]">
          <span class="font-semibold text-on-surface">${escapeHtml(label)}</span>
          <span><strong class="${higher ? "text-primary" : "text-on-surface"}">${pct(val)}</strong> <span class="text-on-surface-variant">(Atlanta average: ${pct(baseVal)})</span></span>
        </div>
        <div class="h-2 w-full rounded bg-surface-container relative overflow-hidden">
          <div class="h-full ${higher ? "bg-primary" : "bg-secondary"}" style="width: ${widthPct}%"></div>
          <div class="absolute top-0 bottom-0 w-0.5 bg-on-surface/70" style="left: ${basePct}%" title="Atlanta Average"></div>
        </div>
      </div>
    `;
  }

  return `
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3.5 space-y-2.5">
      <div class="flex items-center justify-between">
        <div>
          <span class="text-[10.5px] font-bold uppercase tracking-wider text-primary flex items-center gap-1">
            <span class="material-symbols-outlined text-[14px]">diversity_3</span> Who This Partner Helps
          </span>
          <h4 class="font-bold text-xs text-on-surface mt-0.5">${escapeHtml(resp.name || resp.recipient_query || "Partner Organization")}</h4>
        </div>
        ${resp.weekly_households ? `<span class="px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container text-[10.5px] font-bold">Serves ~${resp.weekly_households} families/wk</span>` : ""}
      </div>
      <div class="space-y-2">
        ${metricBar("Local Poverty Rate", pov, mPov)}
        ${metricBar("Households Without a Car", veh, mVeh)}
        ${metricBar("Families on SNAP / Food Assistance", asst, mAsst)}
      </div>
      ${resp.address ? `<p class="text-[10.5px] text-on-surface-variant pt-1 border-t border-outline-variant/40">Neighborhood location: ${escapeHtml(resp.address)}</p>` : ""}
    </div>
  `;
}

function renderSplitLoadCard(resp) {
  const plan = resp.allocation_plan || resp.allocations || [];
  return `
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[10.5px] font-bold uppercase tracking-wider text-primary flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px]">call_split</span> Multi-Stop Delivery Plan (${plan.length} stops)
        </span>
        <span class="px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container text-[10.5px] font-bold">
          ${resp.total_pallets_allocated ?? resp.total_pallets ?? ""} of ${resp.total_pallets_requested ?? resp.total_pallets ?? ""} pallets placed
        </span>
      </div>
      <div class="space-y-1.5">
        ${plan
          .map(
            (stop) => `
            <div class="p-2.5 rounded bg-surface-container-low border border-outline-variant/60 flex items-center justify-between gap-2 text-[11px]">
              <div>
                <span class="font-bold text-primary">Stop #${stop.stop_number ?? stop.stop}:</span>
                <strong class="text-on-surface ml-1">${escapeHtml(stop.name)}</strong>
                <div class="text-[10.5px] text-on-surface-variant">${escapeHtml(friendlyStorage(stop.cold_storage))} · ${escapeHtml(stop.address || "")}</div>
              </div>
              <span class="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10.5px] font-bold shrink-0">
                ${stop.pallets_allocated ?? stop.allocated_pallets} pallet(s)
              </span>
            </div>
          `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderRecommendOpenPostingsCard(resp) {
  const postings = resp.postings || [];
  const shared = resp.shared_top_picks || {};
  const sharedKeys = Object.keys(shared);

  return `
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3.5 space-y-2.5">
      <div class="flex items-center justify-between">
        <span class="text-[10.5px] font-bold uppercase tracking-wider text-primary flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px]">playlist_add_check</span> Recommended Plan for Today's Open Offers (${postings.length})
        </span>
        <span class="text-[10.5px] text-on-surface-variant">${escapeHtml(resp.metro || "Atlanta")}</span>
      </div>
      ${
        sharedKeys.length > 0
          ? `<div class="p-2.5 rounded bg-amber-50 border border-amber-300 text-[11px] text-amber-950 flex items-start gap-1.5">
              <span class="material-symbols-outlined text-[15px] text-amber-700 shrink-0 mt-0.5">warning</span>
              <span><strong>Scheduling Note:</strong> ${escapeHtml(sharedKeys.join(", "))} is the top match for more than one offer. Send them the most urgent offer first so we don't double-book their van.</span>
            </div>`
          : ""
      }
      <div class="space-y-1.5">
        ${postings
          .map((p) => {
            const top = (p.recommendations || [])[0];
            return `
              <div class="p-2.5 rounded bg-surface-container-low border border-outline-variant/60 space-y-1 text-[11px]">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold text-primary text-[11px]">${escapeHtml(p.offer_code || `Offer #${p.source_posting_id || ""}`)}</span>
                  <span class="text-[10.5px] px-2 py-0.5 rounded bg-error-container/50 text-on-error-container font-bold">${Number(p.hours_remaining || 0).toFixed(1)}h left · ${p.unclaimed_pallets} pallet(s)</span>
                </div>
                <p class="text-[11px] text-on-surface italic truncate">“${escapeHtml(p.posting_text)}”</p>
                ${
                  top
                    ? `<div class="flex items-center justify-between text-[11px] pt-1 border-t border-outline-variant/40">
                        <span class="text-on-surface">Best Match: <strong class="text-primary">${escapeHtml(top.name)}</strong></span>
                        <span class="text-on-surface-variant">${escapeHtml(top.collection || "")}</span>
                      </div>`
                    : `<div class="text-[10.5px] text-on-surface-variant">${escapeHtml(p.note || "No match available")}</div>`
                }
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderOpenRequestsCard(resp) {
  const reqs = resp.requests || [];
  return `
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3 space-y-2">
      <div class="text-[10.5px] font-bold uppercase tracking-wider text-primary flex items-center gap-1">
        <span class="material-symbols-outlined text-[14px]">pending_actions</span> Open Grocer Donations (${reqs.length})
      </div>
      <div class="space-y-1.5">
        ${reqs
          .slice(0, 5)
          .map(
            (r) => `
            <div class="p-2.5 rounded bg-surface-container-low border border-outline-variant/60 flex items-center justify-between gap-2 text-[11px]">
              <div class="truncate">
                <strong class="text-on-surface">${escapeHtml(r.posting_text)}</strong>
                <div class="text-[10.5px] text-on-surface-variant capitalize">${escapeHtml(r.required_storage)} · ${r.unclaimed_pallets} pallet(s) available · ${(r.offers || []).length} pantry contacted</div>
              </div>
              <span class="text-[10.5px] font-bold text-primary shrink-0">${Number(r.hours_remaining || 0).toFixed(1)}h left</span>
            </div>
          `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderStateActionCard(toolName, resp) {
  const req = resp.request || {};
  const status = resp.status;
  const isOk = status === "recorded" || status === "ok";
  const label = TOOL_META_MAP[toolName]?.label || "Dispatch Update";
  return `
    <div class="p-2.5 rounded border ${isOk ? "bg-secondary-container/30 border-secondary/40" : "bg-amber-50 border-amber-300"} flex items-center justify-between gap-2 text-[11px]">
      <div class="flex items-center gap-1.5">
        <span class="material-symbols-outlined text-sm ${isOk ? "text-primary" : "text-amber-700"}">${isOk ? "check_circle" : "info"}</span>
        <span class="font-semibold text-on-surface">${escapeHtml(label)}: <span class="capitalize font-bold">${escapeHtml(status)}</span></span>
      </div>
      ${req.unclaimed_pallets != null ? `<span class="text-[10.5px] text-on-surface-variant">${req.unclaimed_pallets} pallet(s) remaining</span>` : ""}
    </div>
  `;
}
