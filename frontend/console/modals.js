/**
 * @module console/modals
 * Coordinator Console modals: Post New Surplus, Ruled-Out Agencies, Equity Audit,
 * Recipient Directory, Active Routes & Dispatches, and Shift Handover.
 */

import {
  APP_STATE,
  api,
  createNewSurplusOffer,
  isDemoMode,
  markOfferDonated,
  refreshCurrentView,
  resetBrokerState,
  resetDemoOnServer,
} from "./state-store.js";
import { closeModal, detailText, escapeHtml, pct, showModal, showToast } from "./ui-utils.js";

export function openPostSurplusModal() {
  showModal(
    "Post New Grocer Surplus Offer",
    `
    <form id="post-surplus-modal-form" class="space-y-3 text-xs">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block font-bold uppercase text-[10px] text-on-surface-variant mb-1">Grocer / Donor Name</label>
          <input name="donorName" required value="Ponce City Grocer" class="w-full p-2 rounded border border-outline-variant bg-background text-on-surface" />
        </div>
        <div>
          <label class="block font-bold uppercase text-[10px] text-on-surface-variant mb-1">Neighborhood & Zone</label>
          <select name="zone" class="w-full p-2 rounded border border-outline-variant bg-background text-on-surface">
            <option value="Midtown">Midtown</option>
            <option value="Downtown">Downtown</option>
            <option value="Decatur">Decatur</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div>
          <label class="block font-bold uppercase text-[10px] text-on-surface-variant mb-1">Food Category</label>
          <input name="category" required value="Produce (Berries & Greens)" class="w-full p-2 rounded border border-outline-variant bg-background text-on-surface" />
        </div>
        <div>
          <label class="block font-bold uppercase text-[10px] text-on-surface-variant mb-1">Storage Type</label>
          <select name="storage" class="w-full p-2 rounded border border-outline-variant bg-background text-on-surface">
            <option value="Refrigerated (38°F)">Refrigerated (38°F)</option>
            <option value="Frozen (0°F)">Frozen (0°F)</option>
            <option value="Shelf-Stable / Ambient">Shelf-Stable / Ambient</option>
          </select>
        </div>
        <div>
          <label class="block font-bold uppercase text-[10px] text-on-surface-variant mb-1">Volume (Pallets)</label>
          <input name="palletsNum" type="number" min="1" max="12" value="2" required class="w-full p-2 rounded border border-outline-variant bg-background text-on-surface font-mono" />
        </div>
      </div>
      <div>
        <label class="block font-bold uppercase text-[10px] text-on-surface-variant mb-1">Must leave within (hours)</label>
        <input name="deadlineHours" type="number" min="0.5" max="72" step="0.5" value="3" required class="w-full p-2 rounded border border-outline-variant bg-background text-on-surface font-mono" />
      </div>
      <div>
        <label class="block font-bold uppercase text-[10px] text-on-surface-variant mb-1">Donor Surplus Quote / Description</label>
        <textarea name="quote" rows="3" required class="w-full p-2 rounded border border-outline-variant bg-background text-on-surface font-serif-quote italic">8 crates of organic strawberries and baby kale, walk-in cooler condensing unit servicing at 6pm. Needs cold pickup within 3 hours.</textarea>
      </div>
      <div class="flex items-center justify-end gap-2 pt-2 border-t border-outline-variant">
        <button type="submit" class="px-4 py-2 rounded bg-primary text-on-primary font-bold cursor-pointer hover:bg-primary-container flex items-center gap-1.5">
          <span class="material-symbols-outlined text-sm">bolt</span> Post & Match via Broker
        </button>
      </div>
    </form>
    `
  );

  const form = document.getElementById("post-surplus-modal-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add("opacity-60");
        submitBtn.lastChild.textContent = " Ranking recipients...";
      }
      const created = await createNewSurplusOffer({
        donorName: fd.get("donorName"),
        neighborhood: fd.get("zone"),
        zone: fd.get("zone"),
        category: fd.get("category"),
        storage: fd.get("storage"),
        palletsNum: Number(fd.get("palletsNum")) || 2,
        quote: fd.get("quote"),
        deadlineHours: Number(fd.get("deadlineHours")) || 3,
      });
      closeModal();
      if (!created) return;
      refreshCurrentView();
      showToast(`Ranked the new posting: top match ${created.primary_match.name}`, "add_task");
    });
  }
}

export function openRuledOutModal(offer) {
  if (!offer) return;
  const rows = (offer.ruled_out || [])
    .map(
      (r) => `
      <div class="p-3 border border-outline-variant rounded bg-surface-container-low flex items-start justify-between gap-3">
        <div>
          <p class="font-bold text-xs text-on-surface line-through">${escapeHtml(r.name)}</p>
          <p class="text-xs text-on-surface-variant mt-0.5">${escapeHtml(r.detail)}</p>
        </div>
        <span class="px-2 py-0.5 rounded text-[11px] font-bold bg-error-container text-on-error-container shrink-0">${escapeHtml(r.tag)}</span>
      </div>
    `
    )
    .join("");

  showModal(
    `Ruled Out Agencies for ${offer.offer_code} (${offer.title})`,
    `
    <div class="space-y-3 text-xs">
      <p class="text-on-surface-variant">
        Evaluated <strong>${offer.pipeline?.semantic || 60}</strong> candidate agencies; <strong>${(offer.pipeline?.semantic || 60) - (offer.pipeline?.feasible || 20)}</strong> were ruled out by storage, capacity, or receiving hours:
      </p>
      <div class="space-y-2 max-h-80 overflow-y-auto pr-1">${rows}</div>
    </div>
    `
  );
}

function auditLogHtml() {
  const entries = (APP_STATE.audit_log || []).slice(0, 8);
  if (!entries.length) return `<p class="text-on-surface-variant">Nothing done at this desk yet.</p>`;
  return entries
    .map(
      (entry) => `
      <div class="flex items-start gap-2.5 py-1.5 border-b border-outline-variant/40 text-xs">
        <span class="font-mono text-[11px] text-on-surface-variant shrink-0">${escapeHtml(entry.time)}</span>
        <span class="text-on-surface">${escapeHtml(entry.text)}</span>
      </div>
    `
    )
    .join("");
}

function unreachableHtml(what) {
  return `<p class="text-xs text-on-surface-variant">Couldn't load ${escapeHtml(what)}: ${
    isDemoMode() ? "server.py isn't reachable from this page." : "server.py didn't answer. Try again."
  }</p>`;
}

export async function openEquityAuditModal() {
  showModal("Atlanta Equity Audit", `<p class="text-xs text-on-surface-variant">Loading the audit...</p>`);
  const audit = await api("/api/equity-audit");
  const body = document.querySelector("#broker-modal-overlay .p-5");
  if (!body) return;
  if (!audit) {
    body.innerHTML = unreachableHtml("the equity audit") + auditLogHtml();
    return;
  }
  const geo = audit.geocoding_summary || {};
  const rows = (audit.benchmarks || [])
    .map(
      (b) => `
      <tr class="${b.highlight ? "bg-primary/10 font-semibold" : ""} border-b border-outline-variant/40">
        <td class="py-1.5 pr-2 text-on-surface">${escapeHtml(b.label)}</td>
        <td class="py-1.5 px-1 text-right font-mono">${pct(b.no_vehicle_rate)}</td>
        <td class="py-1.5 px-1 text-right font-mono">${pct(b.poverty_rate)}</td>
        <td class="py-1.5 px-1 text-right font-mono">${Number(b.need_percentile).toFixed(2)}</td>
        <td class="py-1.5 pl-1 text-right">${escapeHtml(b.reaches)}</td>
      </tr>
    `
    )
    .join("");
  body.innerHTML = `
    <div class="space-y-4 text-xs">
      <div class="grid grid-cols-3 gap-2.5">
        <div class="p-3 rounded bg-surface-container-low border border-outline-variant">
          <p class="text-[10px] font-mono uppercase text-on-surface-variant">Recipients</p>
          <p class="text-xl font-bold text-on-surface mt-0.5">${escapeHtml(geo.total_recipients)}</p>
          <p class="text-[11px] text-on-surface-variant">${escapeHtml(geo.real_irs_recipients)} IRS orgs · ${escapeHtml(geo.planted_teaching_cases)} teaching cases</p>
        </div>
        <div class="p-3 rounded bg-surface-container-low border border-outline-variant">
          <p class="text-[10px] font-mono uppercase text-on-surface-variant">Geocoded to a street</p>
          <p class="text-xl font-bold text-primary mt-0.5">${escapeHtml(geo.geocoded_street_matches)}</p>
          <p class="text-[11px] text-on-surface-variant">${escapeHtml(geo.zip_centroid_fallbacks)} fall back to a ZIP centroid</p>
        </div>
        <div class="p-3 rounded bg-surface-container-low border border-outline-variant">
          <p class="text-[10px] font-mono uppercase text-on-surface-variant">Census tracts</p>
          <p class="text-xl font-bold text-on-surface mt-0.5">${escapeHtml(geo.distinct_tracts_after_geocoding)}</p>
          <p class="text-[11px] text-on-surface-variant">up from ${escapeHtml(geo.distinct_tracts_before_geocoding)} by ZIP</p>
        </div>
      </div>
      <table class="w-full">
        <thead>
          <tr class="text-[10px] uppercase text-on-surface-variant border-b border-outline-variant">
            <th class="text-left py-1 pr-2">Where food goes</th>
            <th class="text-right px-1">No vehicle</th>
            <th class="text-right px-1">Poverty</th>
            <th class="text-right px-1">Need pct.</th>
            <th class="text-right pl-1">Reaches</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <ul class="list-disc pl-4 space-y-1 text-on-surface-variant">
        ${(audit.key_findings || []).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}
      </ul>
      <div>
        <p class="font-bold uppercase text-[10px] tracking-wider text-on-surface-variant mb-1.5">This desk's log</p>
        <div class="bg-surface-container-low border border-outline-variant rounded p-2.5 max-h-44 overflow-y-auto">
          ${auditLogHtml()}
        </div>
      </div>
    </div>
  `;
}

export async function openRecipientDirectoryModal() {
  showModal("Recipient Directory", `<p class="text-xs text-on-surface-variant">Loading recipients...</p>`);
  const data = await api("/api/recipients");
  const body = document.querySelector("#broker-modal-overlay .p-5");
  if (!body) return;
  if (!data) {
    body.innerHTML = unreachableHtml("the recipients");
    return;
  }
  const rows = (data.recipients || [])
    .map(
      (r) => `
      <div class="p-2.5 rounded border border-outline-variant bg-surface-container-low">
        <div class="flex items-start justify-between gap-2">
          <span class="font-bold text-on-surface">${escapeHtml(r.name)}</span>
          <span class="font-mono text-[10px] text-on-surface-variant shrink-0">#${escapeHtml(r.recipient_id)}</span>
        </div>
        <p class="text-[11px] text-on-surface-variant">${escapeHtml(r.archetype_label)} · ${escapeHtml(r.address)}</p>
        <p class="text-[11px] text-on-surface-variant">Cold storage: ${escapeHtml(r.cold_storage)} · up to ${escapeHtml(r.max_pallets)} pallet(s) · ${escapeHtml(r.pickup_window_hours)}h pickup window · tract: ${pct(r.no_vehicle_rate)} no vehicle, ${pct(r.poverty_rate)} poverty</p>
      </div>
    `
    )
    .join("");
  body.innerHTML = `
    <div class="space-y-3 text-xs">
      <p class="text-on-surface-variant">${escapeHtml(data.total_corpus_count)} recipients in ${escapeHtml(data.metro)}, ordered by neighborhood need.</p>
      <div class="space-y-2 max-h-96 overflow-y-auto pr-1">${rows}</div>
    </div>
  `;
}

export async function openActiveRoutesModal() {
  showModal("Active Offers & Pickups", `<p class="text-xs text-on-surface-variant">Loading...</p>`);
  const data = isDemoMode() ? null : await api("/api/dispatches");
  const body = document.querySelector("#broker-modal-overlay .p-5");
  if (!body) return;
  const inPlay = APP_STATE.offers_order
    .map((k) => APP_STATE.offers[k])
    .filter((o) => o && ["awaiting", "accepted", "donated"].includes(o.status));
  const offersHtml = inPlay.length
    ? inPlay
        .map(
          (o) => `
      <div class="p-3 rounded border border-outline-variant bg-surface-container-low flex items-center justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="font-mono font-bold text-xs text-primary">${escapeHtml(o.offer_code)}</span>
            <span class="font-bold text-xs text-on-surface">${escapeHtml(o.title)}</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-surface-container-high">${escapeHtml(o.status)}</span>
          </div>
          <p class="text-[11px] text-on-surface-variant mt-0.5">${escapeHtml(o.status_label)}</p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          ${
            o.status === "accepted"
              ? `<button data-route-donate="${escapeHtml(o.key)}" class="px-2.5 py-1 rounded bg-primary text-on-primary text-[11px] font-semibold cursor-pointer">Mark Donated</button>`
              : o.status === "donated"
              ? `<span class="text-xs font-bold text-primary flex items-center gap-1"><span class="material-symbols-outlined text-sm">verified</span> Picked up</span>`
              : `<a href="${escapeHtml(o.brief_url)}" class="px-2.5 py-1 rounded border border-outline-variant text-[11px] font-semibold">View</a>`
          }
        </div>
      </div>
    `
        )
        .join("")
    : `<p class="text-on-surface-variant">No offer is out or accepted right now.</p>`;
  const tied = data && data.status === "ok" ? data.active_dispatches || [] : null;
  const tiedHtml =
    tied === null
      ? `<p class="text-on-surface-variant">${isDemoMode() ? "Demo mode: no offer-state service." : escapeHtml(detailText(data && data.detail) || "The offer-state service isn't set up (STATE_SERVICE_URL).")}</p>`
      : tied.length
      ? tied
          .map(
            (d) => `
      <div class="flex items-center justify-between gap-2 py-1.5 border-b border-outline-variant/40">
        <span><strong>${escapeHtml(d.recipient_name)}</strong> · ${escapeHtml(d.offer_code || "")}</span>
        <span class="font-mono text-[10px] uppercase text-on-surface-variant">${escapeHtml(d.status)}${d.reply_by && d.status === "sent" ? ` · answer by ${escapeHtml(new Date(d.reply_by).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}` : ""}</span>
      </div>
    `
          )
          .join("")
      : `<p class="text-on-surface-variant">Nobody is tied up right now.</p>`;
  body.innerHTML = `
    <div class="space-y-4 text-xs">
      <div class="space-y-2 max-h-64 overflow-y-auto">${offersHtml}</div>
      <div>
        <p class="font-bold uppercase text-[10px] tracking-wider text-on-surface-variant mb-1.5">Tied up by a live offer (left out of other matches)</p>
        <div class="bg-surface-container-low border border-outline-variant rounded p-2.5 max-h-44 overflow-y-auto">${tiedHtml}</div>
      </div>
      <div class="flex flex-wrap items-center gap-2 p-2.5 rounded bg-surface-container border border-outline-variant">
        <span class="font-semibold text-on-surface">The other people's pages:</span>
        <a href="grocer-post.html" target="_blank" rel="noopener" class="px-2.5 py-1 rounded bg-surface-container-lowest border border-outline-variant hover:border-primary font-semibold">Grocer</a>
        <a href="pantry-offer.html" target="_blank" rel="noopener" class="px-2.5 py-1 rounded bg-surface-container-lowest border border-outline-variant hover:border-primary font-semibold">Pantry</a>
        <a href="driver-request.html" target="_blank" rel="noopener" class="px-2.5 py-1 rounded bg-surface-container-lowest border border-outline-variant hover:border-primary font-semibold">Driver</a>
      </div>
    </div>
  `;
  body.querySelectorAll("[data-route-donate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      closeModal();
      await markOfferDonated(btn.getAttribute("data-route-donate"));
    });
  });
}

export function openShiftHandoverModal() {
  const demo = isDemoMode();
  showModal(
    "Shift Handover",
    `
    <div class="space-y-4 text-xs">
      <p class="text-on-surface-variant">
        ${
          demo
            ? "Demo mode: what you do here is kept in this browser only."
            : "Offers, replies and pickups are saved in the offer-state service, so the next coordinator, the agent and the grocer and pantry pages all see them."
        }
      </p>
      <div class="p-3 rounded bg-surface-container-low border border-outline-variant flex items-center justify-between">
        <div>
          <p class="font-bold text-on-surface">Reset the demo</p>
          <p class="text-[11px] text-on-surface-variant">${
            demo
              ? "Puts the four demo offers back where they started."
              : "Deletes every saved offer, reply and hold, then loads the retail, farm and essentials postings again from BigQuery."
          }</p>
        </div>
        <button id="modal-reset-demo-btn" class="px-3.5 py-2 rounded bg-error text-on-error font-bold cursor-pointer hover:opacity-90 flex items-center gap-1 shrink-0">
          <span class="material-symbols-outlined text-sm">restart_alt</span> Reset
        </button>
      </div>
    </div>
    `
  );
  const resetBtn = document.getElementById("modal-reset-demo-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (!demo) {
        openResetConfirmModal();
        return;
      }
      closeModal();
      resetBrokerState();
    });
  }
}

function openResetConfirmModal() {
  showModal(
    "Reset the demo?",
    `
    <div class="space-y-4 text-xs">
      <p class="text-on-surface">
        This deletes every offer, reply, pickup and hold saved in the offer-state service, for
        every coordinator, the agent, and the grocer and pantry pages. Then it loads all the seed
        postings (retail, farm and essentials) again from BigQuery, each with a fresh clock. It
        can't be undone.
      </p>
      <p id="modal-reset-error" class="hidden p-2.5 rounded bg-error-container text-on-error-container"></p>
      <div class="flex justify-end gap-2">
        <button id="modal-reset-cancel-btn" class="px-3.5 py-2 rounded border border-outline-variant text-on-surface font-bold cursor-pointer hover:bg-surface-container">
          Cancel
        </button>
        <button id="modal-reset-confirm-btn" class="px-3.5 py-2 rounded bg-error text-on-error font-bold cursor-pointer hover:opacity-90 flex items-center gap-1">
          <span class="material-symbols-outlined text-sm">delete_forever</span> Delete and reset
        </button>
      </div>
    </div>
    `
  );
  document.getElementById("modal-reset-cancel-btn")?.addEventListener("click", openShiftHandoverModal);
  const confirmBtn = document.getElementById("modal-reset-confirm-btn");
  confirmBtn?.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.classList.add("opacity-60");
    confirmBtn.lastChild.textContent = " Resetting...";
    const error = await resetDemoOnServer();
    if (!error) {
      closeModal();
      return;
    }
    const box = document.getElementById("modal-reset-error");
    if (box) {
      box.textContent = error;
      box.classList.remove("hidden");
    }
    confirmBtn.disabled = false;
    confirmBtn.classList.remove("opacity-60");
    confirmBtn.lastChild.textContent = " Delete and reset";
  });
}

let liveClockInterval = null;
function updateLiveClocks() {
  const now = new Date();
  const dayDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const formatted = `${dayDate} \u00b7 ${timeStr}`;
  document.querySelectorAll("[data-live-clock]").forEach((el) => {
    el.textContent = formatted;
  });
}

export function wireGlobalSidebarAndHeader() {
  updateLiveClocks();
  if (!liveClockInterval) {
    liveClockInterval = setInterval(updateLiveClocks, 15000);
  }
  const asideNav = document.querySelector("aside nav");
  if (asideNav) {
    const existingLinks = Array.from(asideNav.querySelectorAll("a"));
    const hasActiveRoutes = existingLinks.some((a) =>
      (a.textContent || "").includes("Active Routes")
    );
    if (!hasActiveRoutes) {
      const recipientsLink = existingLinks.find(
        (a) =>
          (a.textContent || "").includes("Recipients") ||
          (a.textContent || "").includes("Recipient Directory")
      );
      const activeRoutesLink = document.createElement("a");
      activeRoutesLink.href = "#";
      activeRoutesLink.className =
        "flex items-center gap-3 px-3 py-2 text-on-surface-variant dark:text-outline-variant font-body-md hover:bg-surface-container dark:hover:bg-surface-container-high hover:text-on-surface dark:hover:text-inverse-on-surface duration-0 cursor-pointer";
      activeRoutesLink.innerHTML = `
        <span class="material-symbols-outlined text-[20px]">local_shipping</span>
        <span class="flex-1 truncate">Active Routes</span>
        <span data-routes-badge="1" class="ml-auto bg-primary/10 text-primary px-1.5 py-0.5 rounded-sm text-[10px] font-bold">2</span>
      `;
      if (recipientsLink && recipientsLink.nextSibling) {
        asideNav.insertBefore(activeRoutesLink, recipientsLink.nextSibling);
      } else {
        asideNav.appendChild(activeRoutesLink);
      }
    } else {
      existingLinks.forEach((a) => {
        if ((a.textContent || "").includes("Active Routes") && !a.querySelector("[data-routes-badge]")) {
          const badge = document.createElement("span");
          badge.setAttribute("data-routes-badge", "1");
          badge.className =
            "ml-auto bg-primary/10 text-primary px-1.5 py-0.5 rounded-sm text-[10px] font-bold";
          badge.textContent = "2";
          a.appendChild(badge);
        }
      });
    }
  }

  document.querySelectorAll("aside nav a, aside div a").forEach((link) => {
    if (link.hasAttribute("data-nav-wired")) return;
    const text = link.textContent.trim();
    if (text.includes("Live Queue")) {
      link.setAttribute("href", "queue.html");
    } else if (text.includes("Recipient Directory") || text.includes("Recipients")) {
      link.setAttribute("data-nav-wired", "1");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        openRecipientDirectoryModal();
      });
    } else if (text.includes("Active Routes")) {
      link.setAttribute("data-nav-wired", "1");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        openActiveRoutesModal();
      });
    } else if (text.includes("Equity Audit")) {
      link.setAttribute("data-nav-wired", "1");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        openEquityAuditModal();
      });
    } else if (text.includes("Shift Handover") || text.includes("Settings")) {
      link.setAttribute("data-nav-wired", "1");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        openShiftHandoverModal();
      });
    }
  });

  document.querySelectorAll("aside button, header button").forEach((btn) => {
    if (btn.hasAttribute("data-global-btn-wired")) return;
    const text = (btn.textContent || "").trim();
    if (text.includes("New Offer")) {
      btn.setAttribute("data-global-btn-wired", "1");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openPostSurplusModal();
      });
    } else if (text.includes("Shift Handover")) {
      btn.setAttribute("data-global-btn-wired", "1");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openShiftHandoverModal();
      });
    }
  });
}
