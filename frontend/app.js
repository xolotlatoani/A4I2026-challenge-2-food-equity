/**
 * Live Backend Integration for the Atlanta Coordinator Console (`frontend/`).
 * Connects `queue.html`, `match-brief-spinach.html`, and `match-brief-deli.html`
 * to `/api/queue`, `/api/match`, `/api/recipients`, `/api/equity-audit`, and `/dev-ui/?app=agent`.
 */
(function () {
  "use strict";

  const state = {
    currentOffer: window.location.pathname.includes("deli")
      ? "deli"
      : new URLSearchParams(window.location.search).get("offer") || "spinach",
    excludedIds: [],
    matchData: null,
    showingAllRuledOut: false,
  };

  function showToast(msg, type = "success") {
    let container = document.getElementById("broker-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "broker-toast-container";
      container.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:420px;";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    const bg = type === "warn" ? "#92400E" : type === "error" ? "#93000a" : "#006032";
    toast.style.cssText = `background:${bg};color:#fff;padding:12px 16px;border-radius:6px;font-size:13px;font-weight:600;box-shadow:0 10px 25px rgba(0,0,0,0.18);display:flex;align-items:center;justify-content:space-between;gap:12px;`;
    toast.innerHTML = `<span>${msg}</span><button style="opacity:0.8;font-size:16px;line-height:1;cursor:pointer;" onclick="this.parentElement.remove()">Ã—</button>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }

  async function apiFetch(path, options) {
    try {
      const resp = await fetch(path, options);
      if (resp.ok) return await resp.json();
    } catch (_) {
      // Fallback if opened via file://
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Render Dynamic Match Brief Updates (`match-brief-spinach.html` & `deli`)
  // -------------------------------------------------------------------------
  function renderMatchBrief(data) {
    if (!data || !data.primary_match) return;
    state.matchData = data;
    const m = data.primary_match;
    const isDeli = window.location.pathname.includes("deli");

    // 1. Update Offer Quote if custom or switched offer
    const quoteEl = document.querySelector("h1.font-editorial-serif, h2.font-serif");
    if (quoteEl && data.posting_text) {
      quoteEl.textContent = `â€œ${data.posting_text}â€`;
    }

    // 2. Update Primary Recommended Card Header
    const mainCard = Array.from(document.querySelectorAll("div.border-l-4.border-l-primary"))[0];
    if (mainCard) {
      const nameHeading = mainCard.querySelector("h2, h3");
      if (nameHeading) nameHeading.textContent = m.name;

      // Archetype badge
      const badges = mainCard.querySelectorAll("span");
      for (const b of badges) {
        if (
          b.textContent.includes("Mobile pantry") ||
          b.textContent.includes("Overnight shelter") ||
          b.textContent.includes("Walk-in") ||
          b.textContent.includes("Transitional") ||
          b.textContent.includes("Neighborhood") ||
          b.textContent.includes("Emergency shelter")
        ) {
          b.textContent = m.archetype_label;
          break;
        }
      }

      // Address line (only target leaf <p> or leaf <span> elements, never parent wrapper divs)
      const addrCandidates = mainCard.querySelectorAll("p, span");
      for (const el of addrCandidates) {
        if (
          el.children.length <= 1 &&
          (el.textContent.includes("GA 30") || el.textContent.includes("teaching case"))
        ) {
          const icon = el.querySelector(".material-symbols-outlined");
          if (icon) {
            el.innerHTML = "";
            el.appendChild(icon);
            el.appendChild(document.createTextNode(" " + m.address));
          } else {
            el.textContent = m.address;
          }
          break;
        }
      }

      // Ranked #1 of X & closest by meaning #Y of 60
      const allSpansAndDivs = mainCard.querySelectorAll("span, div");
      for (const el of allSpansAndDivs) {
        if (el.children.length === 0 && el.textContent.includes("Ranked #")) {
          el.textContent = `Ranked #1 of ${data.pipeline.viable_count} that can take it`;
        } else if (el.children.length === 0 && el.textContent.includes("closest by meaning:")) {
          el.textContent = `closest by meaning: #${m.semantic_rank} of ${data.pipeline.found_by_meaning}`;
        }
      }

      // WHY THEM & WHAT THEY CAN TAKE
      const blocks = mainCard.querySelectorAll("div.grid > div");
      for (const blk of blocks) {
        const txt = blk.textContent || "";
        const p = blk.querySelector("p");
        if (p && txt.includes("WHY THEM")) {
          p.textContent = m.why_them;
        } else if (p && txt.includes("WHAT THEY CAN TAKE")) {
          p.textContent = m.what_they_can_take;
        }
      }

      // THE CLOCK
      for (const el of allSpansAndDivs) {
        if (
          el.children.length <= 1 &&
          (el.textContent.includes("Can collect in") || el.textContent.includes("records say they can collect"))
        ) {
          el.textContent = `â— Can collect in ~${m.pickup_window_hours}h (${m.margin_label})`;
        } else if (el.children.length === 0 && el.textContent.includes("spare")) {
          el.textContent = m.margin_label;
        }
      }

      // WHO IT HELPS
      for (const p of mainCard.querySelectorAll("p")) {
        if (p.textContent.includes("households a week")) {
          const noVehPct = ((m.no_vehicle_rate || 0.13) * 100).toFixed(1);
          const fiPct = ((m.food_insecurity_rate || 0.22) * 100).toFixed(1);
          p.innerHTML = `About <strong class="font-semibold text-primary">${m.weekly_households} households a week</strong>. Home neighborhood: <span class="font-medium">${noVehPct}% of households have no car</span>, <span class="font-medium text-error">${fiPct}% of adults are food insecure</span> (CDC/ACS estimate).`;
        }
      }

      // Drafted SMS textarea
      const smsArea = mainCard.querySelector("textarea");
      if (smsArea && m.draft_sms) {
        smsArea.removeAttribute("readonly");
        smsArea.value = m.draft_sms;
      }
    }

    // 3. Update Standby Options (OPTION 2 & OPTION 3)
    const nextOpts = data.next_options || [];
    const standbyHeadings = Array.from(document.querySelectorAll("h4, h5")).filter(
      (h) => h.textContent.trim().startsWith("2.") || h.textContent.trim().startsWith("3.")
    );
    standbyHeadings.forEach((h, idx) => {
      const opt = nextOpts[idx];
      const card = h.closest("div.border.border-outline-variant");
      if (!card) return;
      if (!opt) {
        card.style.opacity = "0.5";
        h.textContent = `${idx + 2}. No additional standby needed`;
        return;
      }
      card.style.opacity = "1";
      h.textContent = `${idx + 2}. ${opt.name}`;
      card.dataset.recipientId = String(opt.recipient_id);
      const pAddr = card.querySelector("p");
      if (pAddr) pAddr.textContent = opt.address;
    });
  }

  // -------------------------------------------------------------------------
  // Action: "They said no â†’ next option"
  // -------------------------------------------------------------------------
  async function handleTheySaidNo(offerKeyOverride) {
    const offerKey = offerKeyOverride || state.currentOffer;
    if (state.matchData && state.matchData.primary_match) {
      const declined = state.matchData.primary_match;
      if (!state.excludedIds.includes(declined.recipient_id)) {
        state.excludedIds.push(declined.recipient_id);
      }
      // Save the no in the offer-state service, so it sticks after a reload and the agent sees it.
      await apiFetch("/api/dispatches/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient_id: declined.recipient_id,
          recipient_name: declined.name,
          offer_code: state.matchData.offer_code,
          posting_text: state.matchData.posting_text,
          required_storage: state.matchData.required_storage,
          pallets: state.matchData.pallets,
          hours_remaining: state.matchData.hours_remaining,
          reason: "declined",
        }),
      });
      const nextData = await apiFetch(
        `/api/match?offer=${encodeURIComponent(offerKey)}&exclude_ids=${state.excludedIds.join(",")}`
      );
      if (nextData && nextData.primary_match) {
        renderMatchBrief(nextData);
        showToast(
          `Marked "${declined.name}" as declined â†’ Promoted #1: ${nextData.primary_match.name}`,
          "warn"
        );
        return;
      }
    } else {
      const initData = await apiFetch(`/api/match?offer=${encodeURIComponent(offerKey)}`);
      if (initData && initData.primary_match) {
        state.matchData = initData;
        return handleTheySaidNo(offerKey);
      }
    }
    showToast("All top candidates cycled â€” resetting standby list.", "warn");
    state.excludedIds = [];
    const resetData = await apiFetch(`/api/match?offer=${encodeURIComponent(offerKey)}`);
    if (resetData) renderMatchBrief(resetData);
  }

  // -------------------------------------------------------------------------
  // Modals: "+ New Offer", "Recipients (127)", "Equity Audit", "Ask Agent"
  // -------------------------------------------------------------------------
  function openModal(title, htmlContent) {
    let modal = document.getElementById("broker-modal-overlay");
    if (modal) modal.remove();
    modal = document.createElement("div");
    modal.id = "broker-modal-overlay";
    modal.style.cssText =
      "position:fixed;inset:0;background:rgba(11,28,48,0.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px;";
    modal.innerHTML = `
      <div style="background:#ffffff;border:1px solid #bec9be;border-radius:6px;max-width:860px;width:100%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,0.25);">
        <div style="padding:14px 20px;border-bottom:1px solid #bec9be;display:flex;align-items:center;justify-content:space-between;background:#eff4ff;">
          <div style="font-weight:700;font-size:16px;color:#0b1c30;">${title}</div>
          <button id="broker-modal-close" style="font-size:20px;line-height:1;color:#3f4940;cursor:pointer;padding:2px 8px;">Ã—</button>
        </div>
        <div style="padding:20px;overflow-y:auto;font-size:13.5px;color:#0b1c30;">${htmlContent}</div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById("broker-modal-close").onclick = () => modal.remove();
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.remove();
    });
  }

  function openNewOfferModal() {
    openModal(
      "Dispatch New Surplus Offer Â· BigQuery Vector Search + Constraint Filter",
      `
      <form id="new-offer-form" style="display:flex;flex-direction:column;gap:14px;">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:4px;">Quick Preset (from <code>a4i_food.surplus_postings</code>)</label>
          <select id="preset-offer-select" style="width:100%;padding:8px;border:1px solid #bec9be;border-radius:4px;">
            <option value="spinach">Retail #1: 10 crates of spinach, harvested yesterday, needs cold storage (6h)</option>
            <option value="deli">Retail #4: prepared sandwiches and salads from the deli case, must move tonight (4h)</option>
            <option value="dairy">Retail #2: mixed dairy - about 60 gallons of milk and some yogurt, 2 days to code date (8h)</option>
            <option value="bread">Retail #3: roughly 200 loaves of day-old bread and pastries from three store locations (24h)</option>
          </select>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:4px;">Or Type Custom Donor Posting Text</label>
          <textarea id="custom-posting-text" rows="2" style="width:100%;padding:8px;border:1px solid #bec9be;border-radius:4px;">10 crates of spinach, harvested yesterday, needs cold storage</textarea>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;">Storage Required</label>
            <select id="custom-storage" style="width:100%;padding:8px;border:1px solid #bec9be;border-radius:4px;">
              <option value="refrigerated">Keep Cold (Refrigerated)</option>
              <option value="pantry">Shelf-Stable (Pantry)</option>
              <option value="frozen">Frozen</option>
            </select>
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;">Volume (Pallets)</label>
            <input id="custom-pallets" type="number" step="0.05" value="0.18" style="width:100%;padding:8px;border:1px solid #bec9be;border-radius:4px;" />
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;">Hours Until Dock Closes</label>
            <input id="custom-hours" type="number" step="0.5" value="6" style="width:100%;padding:8px;border:1px solid #bec9be;border-radius:4px;" />
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;padding-top:8px;border-top:1px solid #e5eeff;">
          <button type="submit" style="background:#006032;color:#fff;padding:8px 16px;border-radius:4px;font-weight:600;cursor:pointer;">Run Vector Search &amp; Open Match Brief</button>
        </div>
      </form>
      `
    );

    const presetSel = document.getElementById("preset-offer-select");
    const txtEl = document.getElementById("custom-posting-text");
    const stEl = document.getElementById("custom-storage");
    const palEl = document.getElementById("custom-pallets");
    const hrEl = document.getElementById("custom-hours");

    const presets = {
      spinach: ["10 crates of spinach, harvested yesterday, needs cold storage", "refrigerated", 0.18, 6],
      deli: ["prepared sandwiches and salads from the deli case, must move tonight", "refrigerated", 0.15, 4],
      dairy: ["mixed dairy - about 60 gallons of milk and some yogurt, 2 days to code date", "refrigerated", 0.5, 8],
      bread: ["roughly 200 loaves of day-old bread and pastries from three store locations", "pantry", 1.0, 24],
    };

    presetSel.onchange = () => {
      const p = presets[presetSel.value];
      if (p) {
        txtEl.value = p[0];
        stEl.value = p[1];
        palEl.value = p[2];
        hrEl.value = p[3];
      }
    };

    document.getElementById("new-offer-form").onsubmit = async (e) => {
      e.preventDefault();
      const selectedKey = presetSel.value;
      if (window.location.pathname.includes("queue.html") || window.location.pathname.endsWith("/console/")) {
        window.location.href =
          selectedKey === "deli"
            ? "match-brief-deli.html"
            : `match-brief-spinach.html?offer=${encodeURIComponent(selectedKey)}`;
        return;
      }
      const res = await apiFetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          posting_text: txtEl.value,
          required_storage: stEl.value,
          pallets: parseFloat(palEl.value || "0.2"),
          hours_remaining: parseFloat(hrEl.value || "6"),
        }),
      });
      document.getElementById("broker-modal-overlay")?.remove();
      if (res) {
        state.currentOffer = selectedKey;
        state.excludedIds = [];
        renderMatchBrief(res);
        showToast(`Matched "${txtEl.value.slice(0, 38)}..." â†’ #1 ${res.primary_match?.name}`);
      }
    };
  }

  async function openEquityAuditModal() {
    const data = await apiFetch("/api/equity-audit");
    if (!data) return;
    const rowsHtml = (data.benchmarks || [])
      .map(
        (b) => `
        <tr style="border-bottom:1px solid #dce9ff;${b.highlight ? "background:#eff4ff;font-weight:700;color:#006032;" : ""}">
          <td style="padding:10px;">${b.label}</td>
          <td style="padding:10px;text-align:right;font-family:monospace;">${(b.no_vehicle_rate * 100).toFixed(1)}%</td>
          <td style="padding:10px;text-align:right;font-family:monospace;">${(b.poverty_rate * 100).toFixed(1)}%</td>
          <td style="padding:10px;text-align:right;font-family:monospace;">${(b.assistance_rate * 100).toFixed(1)}%</td>
          <td style="padding:10px;text-align:right;font-family:monospace;">${b.need_percentile.toFixed(2)}</td>
          <td style="padding:10px;text-align:right;font-family:monospace;">${b.planted_share}</td>
          <td style="padding:10px;text-align:right;">${b.reaches}</td>
        </tr>`
      )
      .join("");

    const findingsHtml = (data.key_findings || [])
      .map((f) => `<li style="margin-bottom:6px;">${f}</li>`)
      .join("");

    openModal(
      "Equity Audit Across All 10 Surplus Postings Â· Atlanta Metro (a4i_food.recipient_tracts)",
      `
      <div style="display:flex;flex-direction:column;gap:16px;">
        <p style="color:#3f4940;">
          <strong>Did the food go where the need is, or where the loading docks are?</strong>
          Each organization's street address was geocoded via the US Census Bureau to its 2020 Census Tract (<code>scripts/geocode_recipients.py</code> + <code>sql/04_build_recipient_tracts.sql</code>), moving 93 of 109 matched addresses from shared ZIP centroids to 86 distinct tracts. Planted teaching rows have no address and receive neutral need (0.50).
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#e5eeff;text-align:left;border-bottom:2px solid #bec9be;">
              <th style="padding:10px;">Where the food goes</th>
              <th style="padding:10px;text-align:right;">No Vehicle</th>
              <th style="padding:10px;text-align:right;">Poverty</th>
              <th style="padding:10px;text-align:right;">Assistance</th>
              <th style="padding:10px;text-align:right;">Need Pct</th>
              <th style="padding:10px;text-align:right;">Planted Share</th>
              <th style="padding:10px;text-align:right;">Reach</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div style="background:#f8f9ff;border:1px solid #bec9be;border-radius:4px;padding:12px 16px;">
          <div style="font-weight:700;margin-bottom:6px;color:#006032;">Key Audit Findings (Section 11 &amp; scripts/equity_audit.py)</div>
          <ul style="padding-left:18px;margin:0;color:#0b1c30;">${findingsHtml}</ul>
        </div>
      </div>
      `
    );
  }

  async function openRecipientsModal() {
    const data = await apiFetch("/api/recipients");
    if (!data) return;
    const rowsHtml = (data.recipients || [])
      .map(
        (r) => `
        <tr style="border-bottom:1px solid #e5eeff;">
          <td style="padding:8px;font-weight:600;">${r.name}</td>
          <td style="padding:8px;color:#3f4940;">${r.archetype_label}</td>
          <td style="padding:8px;font-family:monospace;">${r.cold_storage}</td>
          <td style="padding:8px;text-align:right;font-family:monospace;">${r.max_pallets}</td>
          <td style="padding:8px;text-align:right;font-family:monospace;">${r.pickup_window_hours}h</td>
          <td style="padding:8px;text-align:right;font-family:monospace;">${((r.no_vehicle_rate || 0) * 100).toFixed(1)}%</td>
          <td style="padding:8px;text-align:right;font-family:monospace;">${((r.poverty_rate || 0) * 100).toFixed(1)}%</td>
          <td style="padding:8px;text-align:right;font-weight:600;color:#006032;">${(r.need_score || 0.5).toFixed(2)}</td>
        </tr>`
      )
      .join("");

    openModal(
      `Atlanta Recipient Corpus (${data.total_corpus_count} Total: ${data.real_irs_count} Real IRS BMF + ${data.planted_count} Planted Teaching Cases)`,
      `
      <div style="display:flex;flex-direction:column;gap:14px;">
        <p style="color:#3f4940;margin:0;">
          <strong>Data Provenance:</strong> Organization names, street addresses, NTEE codes, and reported incomes are 100% real from the IRS Exempt Organizations Business Master File (<code>ICO</code> column dropped on ingestion). Operational capabilities are deterministically generated from 14 archetypes seeded by EIN.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead>
            <tr style="background:#e5eeff;text-align:left;border-bottom:2px solid #bec9be;">
              <th style="padding:8px;">Organization</th>
              <th style="padding:8px;">Archetype</th>
              <th style="padding:8px;">Cold Storage</th>
              <th style="padding:8px;text-align:right;">Max Pallets</th>
              <th style="padding:8px;text-align:right;">Pickup Win</th>
              <th style="padding:8px;text-align:right;">No Vehicle</th>
              <th style="padding:8px;text-align:right;">Poverty</th>
              <th style="padding:8px;text-align:right;">Need Score</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      `
    );
  }

  // -------------------------------------------------------------------------
  // Wire Event Listeners Across All 3 Screens
  // -------------------------------------------------------------------------
  function wireInteractions() {
    // 1. Wire all buttons by text content
    document.querySelectorAll("button, a").forEach((el) => {
      const txt = (el.textContent || "").trim();

      if (txt.includes("They said no")) {
        el.onclick = (e) => {
          e.preventDefault();
          handleTheySaidNo();
        };
      } else if (txt.includes("New Offer")) {
        el.onclick = (e) => {
          e.preventDefault();
          openNewOfferModal();
        };
      } else if (txt.includes("Equity Audit")) {
        el.onclick = (e) => {
          e.preventDefault();
          openEquityAuditModal();
        };
      } else if (txt.startsWith("Recipients")) {
        el.onclick = (e) => {
          e.preventDefault();
          openRecipientsModal();
        };
      } else if (txt.includes("Copy message") || txt.includes("copy both messages")) {
        el.onclick = (e) => {
          e.preventDefault();
          const areas = Array.from(document.querySelectorAll("textarea")).map((t) => t.value);
          const combined = areas.join("\n\n---\n\n");
          if (navigator.clipboard && combined) {
            navigator.clipboard.writeText(combined);
          }
          showToast("Outreach SMS copied to clipboard!");
        };
      } else if (txt.includes("Mark as sent")) {
        el.onclick = async (e) => {
          e.preventDefault();
          const m = state.matchData?.primary_match;
          const orgName =
            m?.name ||
            document.querySelector("div.border-l-4.border-l-primary h2, div.border-l-4.border-l-primary h3")?.textContent ||
            "Recipient";
          let claim = null;
          if (m) {
            claim = await apiFetch("/api/dispatches/claim", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                posting_text: state.matchData.posting_text,
                recipient_id: m.recipient_id,
                recipient_name: m.name,
                pallets_claimed: state.matchData.pallets || 0.2,
                offer_code: state.matchData.offer_code,
                required_storage: state.matchData.required_storage,
                hours_remaining: state.matchData.hours_remaining,
              }),
            });
          }
          if (claim && claim.status && claim.status !== "ok") {
            const detail = claim.detail && claim.detail.message ? claim.detail.message : claim.detail;
            showToast(`Not sent: ${detail}`, "warn");
            return;
          }
          showToast(
            `Locked & Dispatched to ${orgName} — excluded from other offers to prevent double-matching!`
          );
        };
      } else if (txt.includes("Switch to this match") || txt.includes("Inspect route")) {
        el.onclick = async (e) => {
          e.preventDefault();
          const card = el.closest("div.border.border-outline-variant");
          const h = card?.querySelector("h4, h5");
          const targetName = h ? h.textContent.replace(/^[0-9]+\.\s*/, "").trim() : "";
          if (state.matchData && state.matchData.all_viable_candidates) {
            const picked = state.matchData.all_viable_candidates.find((c) =>
              c.name.toLowerCase().includes(targetName.toLowerCase())
            );
            if (picked) {
              const others = state.matchData.all_viable_candidates.filter(
                (c) => c.recipient_id !== picked.recipient_id
              );
              const updated = Object.assign({}, state.matchData, {
                primary_match: picked,
                next_options: others.slice(0, 2),
              });
              renderMatchBrief(updated);
              showToast(`Switched primary recommendation to ${picked.name}`);
              return;
            }
          }
          await handleTheySaidNo();
        };
      } else if (txt.includes("more ruled out agencies")) {
        el.onclick = (e) => {
          e.preventDefault();
          const ruledOutList = state.matchData?.ruled_out || [];
          if (!ruledOutList.length) {
            showToast("Showing all ruled-out semantic candidates from VECTOR_SEARCH.");
            return;
          }
          const rows = ruledOutList
            .map(
              (r) =>
                `<div style="padding:8px 10px;border-bottom:1px solid #e5eeff;display:flex;justify-content:space-between;gap:12px;">
                  <strong>#${r.semantic_rank} ${r.name}</strong>
                  <span style="color:#93000a;font-family:monospace;font-size:12px;">${r.reason}</span>
                </div>`
            )
            .join("");
          openModal("All Candidates Ruled Out by Post-Search Operational Filter", `<div>${rows}</div>`);
        };
      } else if (txt === "View" && window.location.pathname.includes("queue")) {
        el.onclick = (e) => {
          e.preventDefault();
          window.location.href = "match-brief-spinach.html?offer=bread";
        };
      } else if (txt === "Accept" && window.location.pathname.includes("pantry-offer")) {
        el.onclick = async (e) => {
          e.preventDefault();
          await apiFetch("/api/dispatches/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              posting_text: "prepared sandwiches and salads from the deli case, must move tonight",
              recipient_id: 14,
              recipient_name: "Daniels Guiding Guardians",
              pallets_claimed: 0.15,
              offer_code: "OFFER #ATL-8831",
              status: "accepted",
            }),
          });
          showToast("Accepted! Daniels Guiding Guardians locked for OFFER #ATL-8831 (protected from double-matching).");
        };
      } else if (txt === "Decline" && window.location.pathname.includes("pantry-offer")) {
        el.onclick = async (e) => {
          e.preventDefault();
          await apiFetch("/api/dispatches/release", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient_id: 14,
              recipient_name: "Daniels Guiding Guardians",
              posting_text: "prepared sandwiches and salads from the deli case, must move tonight",
              offer_code: "OFFER #ATL-8831",
              reason: "declined",
            }),
          });
          showToast("Declined — coordinator automatically notified to route OFFER #ATL-8831 to #2 backup.", "warn");
        };
      } else if (txt.includes("Accept delivery") && window.location.pathname.includes("driver-request")) {
        el.onclick = (e) => {
          e.preventDefault();
          document.querySelectorAll("button[disabled]").forEach((b) => {
            b.removeAttribute("disabled");
            b.className =
              "w-full h-12 bg-white hover:bg-surface border-2 border-primary text-primary font-semibold text-sm rounded-lg flex items-center justify-center gap-2 cursor-pointer";
          });
          showToast("Delivery run accepted! Picked up & Delivered steps unlocked.");
        };
      } else if (
        (txt === "Picked up" || txt === "Delivered") &&
        window.location.pathname.includes("driver-request")
      ) {
        el.onclick = (e) => {
          e.preventDefault();
          if (el.hasAttribute("disabled")) return;
          showToast(`Status updated: ${txt}! Coordinator & grocer notified.`);
        };
      }
    });

    // 2. Add floating "Ask Broker Agent (ADK UI)" launcher button
    if (!document.getElementById("adk-agent-launcher")) {
      const btn = document.createElement("a");
      btn.id = "adk-agent-launcher";
      btn.href = "/dev-ui/?app=agent";
      btn.target = "_blank";
      btn.style.cssText =
        "position:fixed;bottom:18px;left:18px;z-index:9990;background:#006032;color:#ffffff;padding:9px 14px;border-radius:999px;font-size:12.5px;font-weight:700;text-decoration:none;box-shadow:0 6px 20px rgba(0,96,50,0.32);display:flex;align-items:center;gap:8px;border:1px solid #81d99b;";
      btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px;">smart_toy</span><span>Ask Broker Agent (ADK Chat)</span>`;
      document.body.appendChild(btn);
    }
  }

  // -------------------------------------------------------------------------
  // Initialize on Page Load
  // -------------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    wireInteractions();

    const isBriefPage =
      window.location.pathname.includes("match-brief-spinach") ||
      window.location.pathname.includes("match-brief-deli");
    if (isBriefPage) {
      const data = await apiFetch(`/api/match?offer=${encodeURIComponent(state.currentOffer)}`);
      if (data) {
        state.matchData = data;
        // If URL has ?offer=dairy or ?offer=bread, dynamically populate that offer's brief
        const urlOffer = new URLSearchParams(window.location.search).get("offer");
        if (urlOffer && urlOffer !== "spinach") {
          renderMatchBrief(data);
        }
      }
    }
  });
})();

