/**
 * @module console/agent-formatters
 * Rich UI component formatters for Broker Agent API responses:
 * - Structured interactive cards for `match_surplus_posting`, `check_shelf_life`,
 *   `get_recipient_tract_equity`, `split_large_load`, `recommend_open_postings`,
 *   `list_open_requests`, `record_grocer_request`, `record_offer`, `record_offer_response`,
 *   and `record_recipient_hold`.
 * - Full Markdown renderer (`formatAgentMarkdown`) for narrative responses, headings,
 *   lists, blockquotes (with copy buttons), and tables.
 */

import { escapeHtml, pct } from "./ui-utils.js";

export const TOOL_META_MAP = {
  match_surplus_posting: { label: "Vector Search & Matcher", icon: "hub" },
  check_shelf_life: { label: "USDA FoodKeeper Shelf Life", icon: "timer" },
  get_recipient_tract_equity: { label: "Census Tract Equity", icon: "balance" },
  split_large_load: { label: "Multi-Stop Load Split", icon: "call_split" },
  recommend_open_postings: { label: "Open Postings Sweep", icon: "playlist_add_check" },
  record_grocer_request: { label: "Saved Grocer Request", icon: "bookmark_added" },
  record_offer: { label: "Recorded Dispatch Offer", icon: "send" },
  record_offer_response: { label: "Recorded Pantry Reply", icon: "mark_chat_read" },
  record_recipient_hold: { label: "Recipient Hold", icon: "pause_circle" },
  list_open_requests: { label: "Live Queue Check", icon: "pending_actions" },
};

function renderInlineMarkdown(str) {
  return escapeHtml(str)
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-on-surface">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="italic">$1</em>')
    .replace(
      /`([^`]+)`/g,
      '<code class="bg-surface-container px-1 py-0.5 rounded font-mono text-[10.5px] text-primary border border-outline-variant/40">$1</code>'
    );
}

/**
 * Converts raw Markdown text from the ADK agent into clean, structured HTML
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
          <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-primary flex items-center gap-1">
            <span class="material-symbols-outlined text-[12px]">sms</span> Drafted Message
          </span>
          <button type="button" data-copy-sms="${escapeHtml(rawMsg)}" class="px-2 py-0.5 rounded bg-primary text-on-primary text-[10px] font-bold hover:bg-primary-container cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-[11px]">content_copy</span> Copy
          </button>
        </div>
        <p class="font-mono text-[11px] text-on-surface leading-relaxed">${renderInlineMarkdown(quoteLines.join("\n"))}</p>
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
            <thead class="bg-surface-container text-on-surface-variant uppercase font-mono text-[9.5px]">
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
    blocks.push(`<p class="text-[11.5px] leading-relaxed text-on-surface">${renderInlineMarkdown(trimmed)}</p>`);
  }

  flushList();
  flushQuote();
  flushTable();
  return blocks.join("");
}

/**
 * Renders structured interactive UI cards from the ADK agent's `toolResponses`
 * so the coordinator sees scannable badges, progress bars, and action buttons
 * instead of a wall of raw Markdown.
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
      // Avoid duplicating if `match_surplus_posting` already rendered the clock in the same turn
      if (!toolResponses.some((t) => t.name === "match_surplus_posting")) {
        cards.push(renderShelfLifeCard(resp));
      }
    } else if (
      name === "get_recipient_tract_equity" &&
      (resp.poverty_rate != null || resp.tract_geo_id != null || resp.tract_geoid != null)
    ) {
      cards.push(renderTractEquityCard(resp));
    } else if (name === "split_large_load" && Array.isArray(resp.allocation_plan || resp.allocations)) {
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
  const backups = ranked.slice(1, 3);

  if (!top1) {
    return `
      <div class="p-3 rounded bg-error-container/30 border border-error/40 text-xs space-y-1">
        <div class="font-bold text-error flex items-center gap-1.5">
          <span class="material-symbols-outlined text-sm">warning</span>
          <span>No Safe Operational Match Found</span>
        </div>
        <p class="text-[11px] text-on-surface-variant">Zero organizations met storage and pickup-window constraints for "${escapeHtml(resp.posting_text)}".</p>
      </div>
    `;
  }

  const ops = top1.operational_capabilities || {};
  const cc = top1.clock_compatibility || {};
  const eq = top1.tract_equity || {};
  const effHrs = clock.effective_window_hours ?? cc.effective_window_hours ?? 6;
  const marginHrs = cc.margin_hours ?? 0;

  const storageBadge = `${escapeHtml(ops.cold_storage || "verified")}${ops.frozen_storage ? " + freezer" : ""}`;
  const collectionBadge = cc.can_self_collect
    ? ops.refrigerated_transport
      ? "Reefer Van Self-Pickup"
      : "Self-Collects"
    : "Needs Volunteer Driver";

  const backupsHtml =
    backups.length > 0
      ? `
      <div class="space-y-1.5 pt-2 border-t border-outline-variant/50">
        <div class="text-[10px] font-mono font-bold uppercase tracking-wider text-on-surface-variant">Standby Backups</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${backups
            .map((b, i) => {
              const bOps = b.operational_capabilities || {};
              const bCc = b.clock_compatibility || {};
              const bEq = b.tract_equity || {};
              return `
                <div class="p-2 rounded bg-surface border border-outline-variant/70 space-y-1">
                  <div class="flex items-center justify-between gap-1">
                    <span class="font-bold text-[11px] text-on-surface truncate">#${i + 2} ${escapeHtml(b.name)}</span>
                    <span class="font-mono text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-primary font-bold shrink-0">${Number(b.composite_score || 0).toFixed(2)}</span>
                  </div>
                  <div class="flex flex-wrap gap-1 text-[10px] text-on-surface-variant">
                    <span>${escapeHtml(bOps.cold_storage || "cold")} (${bOps.max_pallets || 1}p)</span>
                    <span>·</span>
                    <span>${bCc.can_self_collect ? `${bOps.pickup_window_hours}h pickup` : "Needs driver"}</span>
                    ${bEq.no_vehicle_rate != null ? `<span>· ${pct(bEq.no_vehicle_rate)} no-car</span>` : ""}
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
          <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-900 flex items-center gap-1">
            <span class="material-symbols-outlined text-[13px]">call_split</span> Multi-Stop Split Option (${splitPlan.length} stops)
          </span>
          <span class="text-[10px] font-mono text-amber-800">${escapeHtml(resp.pallets_needed || "")}p total</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${splitPlan
            .map(
              (s) =>
                `<span class="px-2 py-0.5 rounded bg-white border border-amber-300 text-[10.5px] font-medium text-amber-950">Stop ${s.split_stop}: <strong>${escapeHtml(s.name)}</strong> (${s.pallets}p)</span>`
            )
            .join("")}
        </div>
      </div>
    `
      : "";

  const elimsHtml =
    elims.length > 0
      ? `
      <div class="space-y-1 pt-2 border-t border-outline-variant/50">
        <div class="text-[10px] font-mono font-bold uppercase tracking-wider text-on-surface-variant">Filtered Out by Safety Gates (${elims.length})</div>
        <div class="space-y-1">
          ${elims
            .slice(0, 3)
            .map(
              (e) => `
              <div class="flex items-start justify-between gap-2 px-2 py-1 rounded bg-error-container/20 border border-error/20 text-[10.5px]">
                <span class="font-semibold text-on-surface line-through">${escapeHtml(e.name)} <span class="font-mono text-[9.5px] text-outline no-underline">(Vec #${e.raw_vector_rank})</span></span>
                <span class="text-on-error-container text-right">${escapeHtml((e.elimination_reason || "").split("|")[0].trim())}</span>
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
          <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1">
            <span class="material-symbols-outlined text-[12px] text-primary">sms</span> Ready-to-Send Outreach
          </span>
          <button type="button" data-copy-sms="${escapeHtml(top1.draft_outreach_message)}" class="px-2 py-0.5 rounded bg-primary text-on-primary text-[10px] font-bold hover:bg-primary-container cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-[11px]">content_copy</span> Copy SMS
          </button>
        </div>
        <p class="font-mono text-[10.5px] text-on-surface leading-relaxed">${escapeHtml(top1.draft_outreach_message)}</p>
      </div>
    `
    : "";

  return `
    <div class="rounded border-l-4 border-l-primary border border-outline-variant bg-surface-container-lowest p-3 space-y-2.5 shadow-2xs">
      <!-- Top Recommended Header -->
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="px-1.5 py-0.5 rounded bg-primary text-on-primary font-mono text-[9.5px] font-bold uppercase">Recommended #1</span>
            <span class="px-1.5 py-0.5 rounded bg-tertiary-fixed text-on-tertiary-fixed font-mono text-[9.5px] font-semibold">${escapeHtml(top1.archetype_label || "Verified Partner")}</span>
            <span class="font-mono text-[10px] text-primary font-bold">Tier ${top1.tier} · Score ${Number(top1.composite_score || 0).toFixed(3)}</span>
          </div>
          <h4 class="font-bold text-sm text-on-surface mt-1">${escapeHtml(top1.name)}</h4>
          <p class="text-[11px] text-on-surface-variant flex items-center gap-1">
            <span class="material-symbols-outlined text-[13px] text-outline">location_on</span>
            <span>${escapeHtml(top1.address || "Atlanta Metro")}</span>
          </p>
        </div>
        <button type="button" data-focus-recipient-id="${top1.recipient_id}" class="px-2 py-1 rounded border border-outline-variant hover:border-primary text-[10px] font-semibold text-primary shrink-0 cursor-pointer flex items-center gap-1" title="Highlight recipient">
          <span class="material-symbols-outlined text-[12px]">my_location</span> #${top1.recipient_id}
        </button>
      </div>

      <!-- 3-Pillar Operational Chips: Storage, Clock, Equity -->
      <div class="grid grid-cols-3 gap-1.5 text-[10.5px]">
        <div class="p-2 rounded bg-surface-container-low border border-outline-variant/60">
          <div class="text-[9.5px] font-mono uppercase text-on-surface-variant">Storage &amp; Load</div>
          <div class="font-bold text-on-surface mt-0.5 capitalize">${storageBadge}</div>
          <div class="text-[10px] text-primary font-medium">Up to ${ops.max_pallets || 1} pallet(s)</div>
        </div>
        <div class="p-2 rounded bg-surface-container-low border border-outline-variant/60">
          <div class="text-[9.5px] font-mono uppercase text-on-surface-variant">Clock (${effHrs}h window)</div>
          <div class="font-bold ${marginHrs >= 0 ? "text-primary" : "text-amber-700"} mt-0.5">${marginHrs >= 0 ? `+${marginHrs}h buffer` : `Needs driver`}</div>
          <div class="text-[10px] text-on-surface-variant truncate">${collectionBadge}</div>
        </div>
        <div class="p-2 rounded bg-surface-container-low border border-outline-variant/60">
          <div class="text-[9.5px] font-mono uppercase text-on-surface-variant">Tract Equity</div>
          <div class="font-bold text-on-surface mt-0.5">${eq.poverty_rate != null ? `${pct(eq.poverty_rate)} poverty` : "Neutral (0.50)"}</div>
          <div class="text-[10px] text-on-surface-variant">${eq.no_vehicle_rate != null ? `${pct(eq.no_vehicle_rate)} no vehicle` : `${ops.weekly_households || 200} hh/wk`}</div>
        </div>
      </div>

      ${top1.tie_breaker_reason ? `<div class="px-2.5 py-1.5 rounded bg-secondary-container/40 border border-secondary/30 text-[10.5px] text-on-surface"><strong class="text-primary">Why #1:</strong> ${escapeHtml(top1.tie_breaker_reason)}</div>` : ""}

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
  const product = resp.matched_product || resp.matched_product_name || resp.queried_item || "Food item";
  const note = resp.storage_note || resp.usda_note || "Standard guidance";

  return `
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-primary flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px]">timer</span> USDA FoodKeeper Clock
        </span>
        <span class="px-2 py-0.5 rounded bg-tertiary-fixed text-on-tertiary-fixed font-mono text-[10px] font-bold">Effective: ${eff}h</span>
      </div>
      <div class="grid grid-cols-3 gap-2 text-[11px]">
        <div class="p-2 rounded bg-surface-container-low">
          <div class="text-[9.5px] font-mono uppercase text-on-surface-variant">Matched Entry</div>
          <div class="font-bold text-on-surface mt-0.5">${escapeHtml(product)}</div>
        </div>
        <div class="p-2 rounded bg-surface-container-low">
          <div class="text-[9.5px] font-mono uppercase text-on-surface-variant">USDA Shelf Life</div>
          <div class="font-bold text-on-surface mt-0.5">${shelf != null ? `${shelf}h` : "See Note"}</div>
        </div>
        <div class="p-2 rounded bg-surface-container-low">
          <div class="text-[9.5px] font-mono uppercase text-on-surface-variant">Donor Deadline</div>
          <div class="font-bold text-on-surface mt-0.5">${donor != null ? `${donor}h` : "N/A"}</div>
        </div>
      </div>
      <p class="text-[10.5px] text-on-surface-variant">Note: <span class="font-mono">${escapeHtml(note)}</span> · Limiting factor: <strong>${escapeHtml(resp.clock_limiting_factor || "MIN(donor, usda)")}</strong></p>
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
  const tractId = resp.tract_geo_id || resp.tract_geoid || "Unknown";

  function metricBar(label, val, baseVal) {
    if (val == null) return "";
    const widthPct = Math.min(100, Math.round(val * 220));
    const basePct = Math.min(100, Math.round(baseVal * 220));
    const higher = val >= baseVal;
    return `
      <div class="space-y-1">
        <div class="flex justify-between text-[10.5px]">
          <span class="font-semibold text-on-surface">${escapeHtml(label)}</span>
          <span class="font-mono"><strong class="${higher ? "text-primary" : "text-on-surface"}">${pct(val)}</strong> <span class="text-on-surface-variant">(Metro avg ${pct(baseVal)})</span></span>
        </div>
        <div class="h-2 w-full rounded bg-surface-container relative overflow-hidden">
          <div class="h-full ${higher ? "bg-primary" : "bg-secondary"}" style="width: ${widthPct}%"></div>
          <div class="absolute top-0 bottom-0 w-0.5 bg-on-surface/70" style="left: ${basePct}%" title="Metro Average"></div>
        </div>
      </div>
    `;
  }

  return `
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3 space-y-2.5">
      <div class="flex items-center justify-between">
        <div>
          <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-primary flex items-center gap-1">
            <span class="material-symbols-outlined text-[14px]">balance</span> Neighborhood Equity Audit
          </span>
          <h4 class="font-bold text-xs text-on-surface mt-0.5">${escapeHtml(resp.name || resp.recipient_query || "Recipient")}</h4>
        </div>
        <span class="px-2 py-0.5 rounded bg-surface-container font-mono text-[10px] font-semibold text-on-surface-variant">Tract ${escapeHtml(tractId)}</span>
      </div>
      <div class="space-y-2">
        ${metricBar("Poverty Rate", pov, mPov)}
        ${metricBar("No-Vehicle Households", veh, mVeh)}
        ${metricBar("Public Assistance / SNAP", asst, mAsst)}
      </div>
      ${resp.need_percentile != null ? `<div class="text-[10.5px] text-on-surface-variant pt-1 border-t border-outline-variant/40">Metro Need Percentile: <strong class="font-mono text-primary">${Number(resp.need_percentile).toFixed(2)}</strong> · Weekly reach: <strong>${resp.weekly_households || "—"} households</strong></div>` : ""}
    </div>
  `;
}

function renderSplitLoadCard(resp) {
  const plan = resp.allocation_plan || resp.allocations || [];
  return `
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-primary flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px]">call_split</span> Multi-Stop Load Split (${plan.length} stops)
        </span>
        <span class="px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container font-mono text-[10px] font-bold">
          ${resp.total_pallets_allocated ?? resp.total_pallets ?? ""} / ${resp.total_pallets_requested ?? resp.total_pallets ?? ""} pallets
        </span>
      </div>
      <div class="space-y-1.5">
        ${plan
          .map(
            (stop) => `
            <div class="p-2 rounded bg-surface-container-low border border-outline-variant/60 flex items-center justify-between gap-2 text-[11px]">
              <div>
                <span class="font-mono font-bold text-primary">Stop #${stop.stop_number ?? stop.stop}</span>
                <strong class="text-on-surface ml-1">${escapeHtml(stop.name)}</strong>
                <div class="text-[10px] text-on-surface-variant">${escapeHtml(stop.cold_storage || "")} storage · ${escapeHtml(stop.address || "")}</div>
              </div>
              <span class="px-2 py-0.5 rounded bg-primary/10 text-primary font-mono text-[10.5px] font-bold shrink-0">
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
    <div class="rounded border border-outline-variant bg-surface-container-lowest p-3 space-y-2.5">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-primary flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px]">playlist_add_check</span> Open Postings Triage (${postings.length})
        </span>
        <span class="font-mono text-[10px] text-on-surface-variant">${escapeHtml(resp.metro || "Atlanta")}</span>
      </div>
      ${
        sharedKeys.length > 0
          ? `<div class="p-2 rounded bg-amber-50 border border-amber-300 text-[10.5px] text-amber-950 flex items-start gap-1.5">
              <span class="material-symbols-outlined text-[14px] text-amber-700 shrink-0 mt-0.5">warning</span>
              <span><strong>Contention Alert:</strong> ${escapeHtml(sharedKeys.join(", "))} is the #1 pick on multiple postings. Dispatch to the shortest deadline first.</span>
            </div>`
          : ""
      }
      <div class="space-y-1.5">
        ${postings
          .map((p) => {
            const top = (p.recommendations || [])[0];
            return `
              <div class="p-2 rounded bg-surface-container-low border border-outline-variant/60 space-y-1 text-[11px]">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-mono font-bold text-primary text-[10.5px]">${escapeHtml(p.offer_code || `#${p.source_posting_id || ""}`)}</span>
                  <span class="font-mono text-[10px] px-1.5 py-0.5 rounded bg-error-container/50 text-on-error-container font-bold">${Number(p.hours_remaining || 0).toFixed(1)}h left · ${p.unclaimed_pallets}p</span>
                </div>
                <p class="text-[11px] text-on-surface italic truncate">“${escapeHtml(p.posting_text)}”</p>
                ${
                  top
                    ? `<div class="flex items-center justify-between text-[10.5px] pt-1 border-t border-outline-variant/40">
                        <span class="text-on-surface">Top pick: <strong class="text-primary">${escapeHtml(top.name)}</strong></span>
                        <span class="text-on-surface-variant">${escapeHtml(top.collection || "")}</span>
                      </div>`
                    : `<div class="text-[10px] text-on-surface-variant">${escapeHtml(p.note || "No match")}</div>`
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
      <div class="text-[10px] font-mono font-bold uppercase tracking-wider text-primary flex items-center gap-1">
        <span class="material-symbols-outlined text-[14px]">pending_actions</span> Open Grocer Requests (${reqs.length})
      </div>
      <div class="space-y-1.5">
        ${reqs
          .slice(0, 5)
          .map(
            (r) => `
            <div class="p-2 rounded bg-surface-container-low border border-outline-variant/60 flex items-center justify-between gap-2 text-[11px]">
              <div class="truncate">
                <strong class="text-on-surface">${escapeHtml(r.posting_text)}</strong>
                <div class="text-[10px] text-on-surface-variant">${escapeHtml(r.required_storage)} · ${r.unclaimed_pallets}p unclaimed · ${(r.offers || []).length} offer(s) sent</div>
              </div>
              <span class="font-mono text-[10px] font-bold text-primary shrink-0">${Number(r.hours_remaining || 0).toFixed(1)}h left</span>
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
  return `
    <div class="p-2.5 rounded border ${isOk ? "bg-secondary-container/30 border-secondary/40" : "bg-amber-50 border-amber-300"} flex items-center justify-between gap-2 text-[11px]">
      <div class="flex items-center gap-1.5">
        <span class="material-symbols-outlined text-sm ${isOk ? "text-primary" : "text-amber-700"}">${isOk ? "check_circle" : "info"}</span>
        <span class="font-semibold text-on-surface">${escapeHtml(toolName.replace(/_/g, " "))}: <span class="uppercase font-mono text-[10px]">${escapeHtml(status)}</span></span>
      </div>
      ${req.unclaimed_pallets != null ? `<span class="font-mono text-[10px] text-on-surface-variant">${req.unclaimed_pallets}p unclaimed</span>` : ""}
    </div>
  `;
}
