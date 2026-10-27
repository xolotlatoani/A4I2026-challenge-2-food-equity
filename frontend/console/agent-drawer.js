/**
 * @module console/agent-drawer
 * Slide-out Broker Agent drawer UI, ADK `/run` session client, dynamic context-aware
 * suggestion chips, and interactive response rendering.
 */

import {
  TOOL_META_MAP,
  buildAgentToolCardsHtml,
  formatAgentMarkdown,
} from "./agent-formatters.js";
import {
  AGENT_BASE,
  APP_STATE,
  SERVED,
  demoNotice,
  isDemoMode,
  resync,
} from "./state-store.js";
import { escapeHtml, getActiveOfferKey, isMatchBriefPage, showToast } from "./ui-utils.js";

let adkSessionId = null;
const adkUserId = "broker_console_" + Math.random().toString(36).slice(2, 8);

export async function ensureAdkSession(baseUrl = AGENT_BASE) {
  if (adkSessionId) return adkSessionId;
  const res = await fetch(`${baseUrl}/apps/agent/users/${adkUserId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Session creation failed (${res.status})`);
  const data = await res.json();
  adkSessionId = data.id;
  return adkSessionId;
}

export async function callCloudRunAgent(promptText, onProgress) {
  const baseUrl = AGENT_BASE;
  if (onProgress) onProgress("Connecting to the ADK agent session...");
  const sessionId = await ensureAdkSession(baseUrl);
  if (onProgress)
    onProgress("Running BigQuery VECTOR_SEARCH + USDA FoodKeeper + ACS Equity tools...");

  const res = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appName: "agent",
      userId: adkUserId,
      sessionId,
      newMessage: {
        role: "user",
        parts: [{ text: promptText }],
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Cloud Run Agent returned HTTP ${res.status}`);
  }
  const events = await res.json();
  const toolCalls = [];
  const toolResponses = [];
  let finalReply = "";

  if (Array.isArray(events)) {
    events.forEach((ev) => {
      const parts = (ev.content && ev.content.parts) || [];
      parts.forEach((p) => {
        if (p.functionCall) {
          toolCalls.push({
            name: p.functionCall.name,
            args: p.functionCall.args || {},
          });
        }
        if (p.functionResponse) {
          toolResponses.push({
            name: p.functionResponse.name,
            response: p.functionResponse.response || {},
          });
        }
        if (p.text) {
          finalReply += (finalReply ? "\n\n" : "") + p.text;
        }
      });
    });
  }

  return {
    sessionId,
    toolCalls,
    toolResponses,
    finalReply: finalReply || "Agent completed tool execution.",
  };
}

export function ensureAgentLauncherButton() {
  if (document.getElementById("adk-agent-launcher")) return;
  const launcher = document.createElement("button");
  launcher.id = "adk-agent-launcher";
  launcher.type = "button";
  launcher.className =
    "fixed bottom-5 right-5 z-40 bg-primary hover:bg-primary-container text-on-primary px-4 py-2.5 rounded-full shadow-lg flex items-center gap-2 text-xs font-bold tracking-wide transition-all border border-on-primary/20 cursor-pointer";
  launcher.innerHTML = `
    <span class="w-2 h-2 rounded-full bg-emerald-300 animate-pulse"></span>
    <span class="material-symbols-outlined text-base">smart_toy</span>
    <span>Ask the Broker Agent</span>
  `;
  launcher.addEventListener("click", () => {
    const offerKey = isMatchBriefPage() ? getActiveOfferKey(APP_STATE.offers) : null;
    openAgentDrawerForOffer(offerKey);
  });
  document.body.appendChild(launcher);
}

export function buildDynamicAgentSuggestions(offerKey) {
  const mapCtx = window.__BROKER_LATEST_MAP_DATA;
  if (mapCtx && window.location.pathname.includes("map")) {
    const selected = mapCtx.selected_posting;
    const postings = mapCtx.postings || [];
    const visible = mapCtx.visibleRecipients || mapCtx.recipients || [];
    const allRecs = mapCtx.all_recipients || visible;
    const track = mapCtx.activeTrack || mapCtx.track || "RETAIL";

    const topViable = visible.find((r) => r.viable) || allRecs.find((r) => r.viable);
    const secondViable =
      visible.filter((r) => r.viable)[1] || allRecs.filter((r) => r.viable)[1];
    const topRuledOut =
      visible.find((r) => !r.viable || r.status_category === "ruled_out") ||
      allRecs.find((r) => !r.viable || r.status_category === "ruled_out");
    const firstPost = selected || postings[0];
    const secondPost =
      postings.find((p) => !firstPost || p.posting_id !== firstPost.posting_id) || postings[1];

    const suggestions = [];

    if (firstPost) {
      const hrs = Number(firstPost.hours_remaining ?? firstPost.hours_available ?? 6);
      suggestions.push({
        label: `🎯 Match #${firstPost.posting_id} (${firstPost.track} · ${hrs}h): ${firstPost.posting_text.slice(0, 28)}...`,
        prompt: `Call match_surplus_posting for "${firstPost.posting_text}" (required_storage: "${firstPost.storage_state}", donor_deadline_hours: ${hrs}) and present the Match Brief.`,
      });
    }

    if (topViable && topRuledOut) {
      suggestions.push({
        label: `🔍 Why ${topViable.name.slice(0, 18)} vs. ${topRuledOut.name.slice(0, 16)}?`,
        prompt: `For ${firstPost ? `"${firstPost.posting_text}"` : `the ${track} track`}, explain why "${topViable.name}" (${topViable.cold_storage} storage, ${topViable.max_pallets}p max, ${topViable.pickup_window_hours}h window) is a fit while "${topRuledOut.name}" (${topRuledOut.ruled_out_reason || topRuledOut.cold_storage}) is ruled out.`,
      });
    } else if (secondPost) {
      const hrs2 = Number(secondPost.hours_remaining ?? secondPost.hours_available ?? 8);
      suggestions.push({
        label: `📦 Match #${secondPost.posting_id} (${secondPost.track} · ${hrs2}h): ${secondPost.posting_text.slice(0, 26)}...`,
        prompt: `Call match_surplus_posting for "${secondPost.posting_text}" (required_storage: "${secondPost.storage_state}", donor_deadline_hours: ${hrs2}) and rank the top viable recipients.`,
      });
    }

    if (topViable) {
      suggestions.push({
        label: `⚖️ Tract Equity: ${topViable.name.slice(0, 22)}`,
        prompt: `Call get_recipient_tract_equity for "${topViable.name}" and compare its census tract poverty_rate, no_vehicle_rate, and assistance_rate relative to the Atlanta metro baseline.`,
      });
    }

    if (firstPost) {
      suggestions.push({
        label: `⏱️ Shelf Life (#${firstPost.posting_id})`,
        prompt: `Call check_shelf_life for "${firstPost.foodkeeper_product || firstPost.posting_text}" (storage_state: "${firstPost.storage_state}", donor_deadline_hours: ${firstPost.hours_remaining || 6}).`,
      });
    }

    return {
      contextLabel: selected
        ? `Suggested from Posting #${selected.posting_id} (${visible.length} recipients on map)`
        : `Suggested from live ${track} API response (${postings.length} postings · ${visible.length} recipients)`,
      defaultPrompt: suggestions[0]?.prompt || "What should we do with today's open postings?",
      suggestions,
    };
  }

  const offer = offerKey ? APP_STATE.offers[offerKey] : null;
  const offersList = Object.values(APP_STATE.offers || {});
  const primaryOffer = offer || offersList[0];
  const suggestions = [];

  if (primaryOffer) {
    suggestions.push({
      label: `🎯 Match ${primaryOffer.offer_code} (${primaryOffer.category})`,
      prompt: `Call match_surplus_posting for ${primaryOffer.quote} (required_storage: "${primaryOffer.storage_short || primaryOffer.storage}", donor_deadline_hours: ${Math.max(1, Math.round((primaryOffer.urgency_minutes || 240) / 60))}) and present the Match Brief.`,
    });
    if (primaryOffer.primary_match && primaryOffer.ruled_out?.[0]) {
      suggestions.push({
        label: `🔍 Why ${primaryOffer.primary_match.name.slice(0, 18)} vs. ${primaryOffer.ruled_out[0].name.slice(0, 16)}?`,
        prompt: `Why is "${primaryOffer.primary_match.name}" recommended for ${primaryOffer.offer_code} while "${primaryOffer.ruled_out[0].name}" was ruled out?`,
      });
    }
    if (primaryOffer.primary_match) {
      suggestions.push({
        label: `⚖️ Equity Audit: ${primaryOffer.primary_match.name.slice(0, 20)}`,
        prompt: `Call get_recipient_tract_equity for "${primaryOffer.primary_match.name}" and report its poverty_rate, no_vehicle_rate, and assistance_rate vs. the Atlanta metro baseline.`,
      });
    }
  }
  suggestions.push({
    label: `📋 Recommend All Open Postings`,
    prompt: `Call recommend_open_postings and list the top recommended recipient, collection mode, and hours remaining for each open posting.`,
  });

  return {
    contextLabel: primaryOffer
      ? `Suggested from ${primaryOffer.offer_code} API state`
      : "Suggested from live Queue API state",
    defaultPrompt: suggestions[0]?.prompt || "What should we do with today's open postings?",
    suggestions,
  };
}

export function renderAgentSuggestionChips(drawer, offerKey) {
  const container = drawer?.querySelector("#agent-dynamic-suggestions");
  const labelEl = drawer?.querySelector("#agent-suggestions-label");
  if (!container) return;

  const { contextLabel, defaultPrompt, suggestions } = buildDynamicAgentSuggestions(offerKey);
  if (labelEl) labelEl.textContent = contextLabel;

  const input = drawer.querySelector("#agent-prompt-input");
  if (input && !input.dataset.userEdited) {
    input.value = defaultPrompt;
  }

  container.innerHTML = suggestions
    .map(
      (s, idx) => `
      <button type="button" data-dynamic-prompt-idx="${idx}" class="px-2.5 py-1 rounded bg-surface-container-lowest border border-outline-variant hover:border-primary hover:bg-surface text-[11px] font-medium text-on-surface cursor-pointer text-left transition-colors">
        ${escapeHtml(s.label)}
      </button>
    `
    )
    .join("");

  container.querySelectorAll("[data-dynamic-prompt-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-dynamic-prompt-idx"));
      const chosen = suggestions[idx];
      if (!chosen) return;
      const promptInput = drawer.querySelector("#agent-prompt-input");
      if (promptInput) {
        promptInput.value = chosen.prompt;
        drawer.querySelector("#agent-chat-form")?.dispatchEvent(new Event("submit"));
      }
    });
  });
}

window.addEventListener("broker-map:context-updated", () => {
  const drawer = document.getElementById("cloud-run-agent-drawer");
  if (drawer) {
    renderAgentSuggestionChips(drawer, null);
  }
});

export function openAgentDrawerForOffer(offerKey) {
  let drawer = document.getElementById("cloud-run-agent-drawer");
  if (!drawer) {
    drawer = document.createElement("div");
    drawer.id = "cloud-run-agent-drawer";
    drawer.className =
      "fixed inset-y-0 right-0 z-50 w-full max-w-xl bg-surface-container-lowest border-l border-outline-variant shadow-2xl flex flex-col";
    document.body.appendChild(drawer);
  }

  const { contextLabel, defaultPrompt } = buildDynamicAgentSuggestions(offerKey);

  drawer.innerHTML = `
    <div class="p-4 bg-primary text-on-primary flex items-center justify-between">
      <div class="flex items-center gap-2.5">
        <span class="material-symbols-outlined text-xl">smart_toy</span>
        <div>
          <div class="flex items-center gap-2">
            <h3 class="font-bold text-sm tracking-wide">Resilient Food Equity & Surplus Broker Agent</h3>
            <span class="px-1.5 py-0.5 text-[10px] font-mono bg-emerald-400/20 text-emerald-100 rounded border border-emerald-300/30">${SERVED ? "LIVE" : "CLOUD RUN"}</span>
          </div>
          <p class="text-[11px] text-on-primary/80 font-mono">gemini-3.8-flash \u00b7 BigQuery a4i_food \u00b7 VECTOR_SEARCH</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <a href="${AGENT_BASE}/dev-ui/?app=agent" target="_blank" rel="noopener" class="px-2 py-1 rounded bg-on-primary/10 hover:bg-on-primary/20 text-[11px] font-semibold flex items-center gap-1 text-on-primary" title="Open the full ADK Developer UI">
          <span>ADK UI</span>
          <span class="material-symbols-outlined text-xs">open_in_new</span>
        </a>
        <button id="close-agent-drawer-btn" class="p-1 rounded hover:bg-on-primary/10 text-on-primary cursor-pointer">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>

    <div class="p-3 bg-surface-container-low border-b border-outline-variant space-y-2">
      <div class="flex items-center justify-between">
        <p id="agent-suggestions-label" class="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">${escapeHtml(contextLabel)}</p>
        <span class="font-mono text-[10px] text-primary">Click to run</span>
      </div>
      <div id="agent-dynamic-suggestions" class="flex flex-wrap gap-1.5"></div>
    </div>

    <div id="agent-chat-messages" class="flex-1 overflow-y-auto p-4 space-y-3 bg-background">
      <div class="bg-surface-container-lowest border border-outline-variant rounded p-3 text-xs space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="font-bold text-primary">ADK agent endpoint</span>
          <span class="font-mono text-[10px] text-on-surface-variant">${escapeHtml((AGENT_BASE || window.location.origin).replace(/^https?:\/\//, ""))}</span>
        </div>
        <p class="text-on-surface-variant leading-relaxed">
          Suggested queries above update automatically from the current API response. Click any chip or type below to run live BigQuery tool calls.
        </p>
      </div>
    </div>

    <form id="agent-chat-form" class="p-3 bg-surface-container-lowest border-t border-outline-variant space-y-2">
      <textarea id="agent-prompt-input" rows="3" class="w-full bg-background border border-outline-variant rounded p-2.5 text-xs text-on-surface focus:border-primary focus:outline-none font-mono" placeholder="Ask the Atlanta Food Rescue Broker Agent...">${escapeHtml(defaultPrompt)}</textarea>
      <div class="flex items-center justify-between">
        <span id="agent-status-indicator" class="text-[11px] text-on-surface-variant font-mono">Ready</span>
        <button type="submit" id="agent-send-btn" class="bg-primary hover:bg-primary-container text-on-primary px-4 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 cursor-pointer">
          <span class="material-symbols-outlined text-sm">send</span>
          <span>Run Live Agent Query</span>
        </button>
      </div>
    </form>
  `;

  document.getElementById("close-agent-drawer-btn").addEventListener("click", () => {
    drawer.remove();
  });

  const promptInputEl = document.getElementById("agent-prompt-input");
  promptInputEl?.addEventListener("input", () => {
    promptInputEl.dataset.userEdited = "true";
  });

  renderAgentSuggestionChips(drawer, offerKey);

  const form = document.getElementById("agent-chat-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("agent-prompt-input");
    const statusEl = document.getElementById("agent-status-indicator");
    const sendBtn = document.getElementById("agent-send-btn");
    const chatBox = document.getElementById("agent-chat-messages");
    const text = (input.value || "").trim();
    if (!text) return;

    input.value = "";
    input.dataset.userEdited = "true";

    const userBubble = document.createElement("div");
    userBubble.className =
      "bg-primary/10 border border-primary/30 rounded p-3 text-xs text-on-surface ml-6";
    userBubble.innerHTML = `<p class="font-bold text-[10px] uppercase text-primary mb-1">Coordinator Query</p><p>${escapeHtml(text)}</p>`;
    chatBox.appendChild(userBubble);

    const loadingBubble = document.createElement("div");
    loadingBubble.className =
      "bg-surface-container-lowest border border-outline-variant rounded p-3 text-xs text-on-surface-variant flex items-center gap-2 mr-6";
    loadingBubble.innerHTML = `
      <span class="w-2 h-2 rounded-full bg-primary animate-ping"></span>
      <span class="font-mono text-[11px]" data-loading-text>Running BigQuery VECTOR_SEARCH &amp; constraint filters...</span>
    `;
    chatBox.appendChild(loadingBubble);
    chatBox.scrollTop = chatBox.scrollHeight;

    sendBtn.disabled = true;
    sendBtn.classList.add("opacity-60");
    const startedAt = performance.now();

    try {
      const result = await callCloudRunAgent(text, (msg) => {
        statusEl.textContent = msg;
        const lbl = loadingBubble.querySelector("[data-loading-text]");
        if (lbl) lbl.textContent = msg;
      });
      loadingBubble.remove();
      const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);

      const botBubble = document.createElement("div");
      botBubble.className =
        "bg-surface-container-lowest border border-outline-variant rounded p-3.5 text-xs space-y-3 mr-2 shadow-xs";

      let toolsHtml = "";
      if (result.toolCalls.length > 0) {
        toolsHtml = `
          <div class="flex flex-wrap gap-1.5 pb-2 border-b border-outline-variant/50">
            ${result.toolCalls
              .map((tc) => {
                const meta = TOOL_META_MAP[tc.name] || { label: tc.name, icon: "database" };
                return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container font-mono text-[10px] font-bold" title="${escapeHtml(tc.name)}">
                  <span class="material-symbols-outlined text-[11px]">${escapeHtml(meta.icon)}</span> ${escapeHtml(meta.label)}
                </span>`;
              })
              .join("")}
          </div>
        `;
      }

      const matchResp = result.toolResponses.find((tr) => tr.name === "match_surplus_posting");
      const targetKey =
        offerKey ||
        (text.toLowerCase().includes("deli")
          ? "deli"
          : text.toLowerCase().includes("dairy")
          ? "dairy"
          : "spinach");

      let applyBtnHtml = "";
      const followUps = [];
      if (matchResp && matchResp.response && Array.isArray(matchResp.response.ranked_matches)) {
        const ranked = matchResp.response.ranked_matches;
        const elims = matchResp.response.eliminated_near_misses || [];
        const top1 = ranked[0];
        const top2 = ranked[1];
        const elim1 = elims[0];

        const btnLabel = window.location.pathname.includes("map")
          ? "Focus Matches on Map"
          : `Refresh ${(APP_STATE.offers[targetKey] && APP_STATE.offers[targetKey].offer_code) || "the"} brief`;

        applyBtnHtml = `
          <div class="pt-2 border-t border-outline-variant/50 flex items-center justify-between">
            <span class="text-[11px] text-primary font-semibold">Live BigQuery returned ${ranked.length} ranked matches</span>
            <button type="button" class="apply-live-bq-btn px-3 py-1 rounded bg-primary text-on-primary text-[11px] font-bold cursor-pointer hover:bg-primary-container">
              ${escapeHtml(btnLabel)}
            </button>
          </div>
        `;

        if (top1) {
          followUps.push({
            label: `❌ ${top1.name.slice(0, 18)} said no → Who's next?`,
            prompt: `"${top1.name}" (recipient_id ${top1.recipient_id}) declined. Record the decline and run match_surplus_posting excluding recipient_id ${top1.recipient_id} to promote #2${top2 ? ` ("${top2.name}")` : ""}.`,
          });
          followUps.push({
            label: `⚖️ Neighborhood Equity: ${top1.name.slice(0, 20)}`,
            prompt: `Call get_recipient_tract_equity for "${top1.name}" (recipient_id ${top1.recipient_id}) and compare its tract poverty_rate and no_vehicle_rate to the Atlanta metro average.`,
          });
        }
        if (elim1) {
          followUps.push({
            label: `🚫 Why not ${elim1.name.slice(0, 20)}?`,
            prompt: `Why was "${elim1.name}" ruled out for "${matchResp.response.posting_text}" despite ranking #${elim1.raw_vector_rank} in semantic search?`,
          });
        }
      }

      const structuredCardsHtml = buildAgentToolCardsHtml(result.toolResponses);
      const hasRichToolCards = structuredCardsHtml.length > 0;
      const formattedNarrativeHtml = formatAgentMarkdown(result.finalReply);

      const narrativeHtml = hasRichToolCards
        ? `
          <details class="group rounded border border-outline-variant/60 bg-surface-container-low/40 overflow-hidden">
            <summary class="px-3 py-2 cursor-pointer select-none flex items-center justify-between text-[11px] font-semibold text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low">
              <span class="flex items-center gap-1.5">
                <span class="material-symbols-outlined text-[14px] text-primary">article</span>
                <span>Full Agent Narrative &amp; Reasoning</span>
              </span>
              <span class="material-symbols-outlined text-[15px] transition-transform group-open:rotate-180">expand_more</span>
            </summary>
            <div class="p-3 pt-2 border-t border-outline-variant/40 text-on-surface leading-relaxed font-sans space-y-2 bg-surface-container-lowest">
              ${formattedNarrativeHtml}
            </div>
          </details>
        `
        : `<div class="text-on-surface leading-relaxed font-sans space-y-2">${formattedNarrativeHtml}</div>`;

      const followUpHtml =
        followUps.length > 0
          ? `
        <div class="pt-2 border-t border-outline-variant/50 space-y-1.5">
          <div class="text-[10px] font-mono font-bold uppercase text-on-surface-variant">Suggested Follow-Up Queries</div>
          <div class="flex flex-wrap gap-1.5">
            ${followUps
              .map(
                (f, i) => `
              <button type="button" data-followup-idx="${i}" class="px-2 py-1 rounded bg-surface border border-outline-variant hover:border-primary text-[11px] font-medium text-on-surface cursor-pointer">
                ${escapeHtml(f.label)}
              </button>`
              )
              .join("")}
          </div>
        </div>`
          : "";

      botBubble.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="font-bold text-primary flex items-center gap-1">
            <span class="material-symbols-outlined text-sm">verified</span> Broker Agent Response
          </span>
          <span class="font-mono text-[10px] text-on-surface-variant">${elapsedSec}s \u00b7 Session ${escapeHtml((result.sessionId || "").slice(0, 8))}</span>
        </div>
        ${toolsHtml}
        ${structuredCardsHtml}
        ${narrativeHtml}
        ${applyBtnHtml}
        ${followUpHtml}
      `;
      chatBox.appendChild(botBubble);
      chatBox.scrollTop = chatBox.scrollHeight;

      botBubble.querySelectorAll("[data-copy-sms]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const msg = btn.getAttribute("data-copy-sms") || "";
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(msg).catch(() => {});
          }
          const smsBox = document.getElementById("dispatch-sms");
          if (smsBox) smsBox.value = msg;
          showToast("Outreach message copied to clipboard!", "content_copy");
        });
      });

      botBubble.querySelectorAll("[data-focus-recipient-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const rid = Number(btn.getAttribute("data-focus-recipient-id"));
          if (!rid) return;
          window.dispatchEvent(
            new CustomEvent("broker-agent:focus-recipient", { detail: { recipientId: rid } })
          );
          showToast(`Highlighted Recipient #${rid}`, "my_location");
        });
      });

      botBubble.querySelectorAll("[data-followup-idx]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.getAttribute("data-followup-idx"));
          const f = followUps[idx];
          if (!f) return;
          input.value = f.prompt;
          form.dispatchEvent(new Event("submit"));
        });
      });

      window.dispatchEvent(
        new CustomEvent("broker-agent:result", {
          detail: {
            promptText: text,
            result,
            matchResponse: matchResp ? matchResp.response : null,
            applied: false,
          },
        })
      );

      const applyBtn = botBubble.querySelector(".apply-live-bq-btn");
      if (applyBtn && matchResp) {
        applyBtn.addEventListener("click", async () => {
          window.dispatchEvent(
            new CustomEvent("broker-agent:result", {
              detail: {
                promptText: text,
                result,
                matchResponse: matchResp.response,
                applied: true,
              },
            })
          );
          if (window.location.pathname.includes("map")) {
            showToast("Focused live BigQuery match results on Map", "database");
            return;
          }
          if (isDemoMode()) {
            demoNotice();
            return;
          }
          await resync(targetKey);
          showToast(
            `Re-ran the match for ${APP_STATE.offers[targetKey]?.offer_code || "offer"}`,
            "database"
          );
        });
      }

      statusEl.textContent = `Completed in ${elapsedSec}s via ADK + BigQuery`;
    } catch (err) {
      loadingBubble.remove();
      const errBubble = document.createElement("div");
      errBubble.className =
        "bg-error-container/40 border border-error rounded p-3 text-xs text-on-error-container";
      errBubble.innerHTML = `<p class="font-bold">Cloud Run Agent Connection Notice</p><p class="mt-1">${escapeHtml(err.message)}. Using cached BigQuery a4i_food snapshot.</p>`;
      chatBox.appendChild(errBubble);
      statusEl.textContent = "Ready (Fallback active)";
    } finally {
      sendBtn.disabled = false;
      sendBtn.classList.remove("opacity-60");
    }
  });
}
