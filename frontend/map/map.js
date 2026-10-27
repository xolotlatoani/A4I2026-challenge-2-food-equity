/**
 * @module map/map
 * Page controller for `frontend/map.html`.
 * Coordinates `MapApiClient` (`/map/data`), `BrokerMapView`, `MapSidebarView`,
 * instant client-side preset/search filtering, and prominent API loading states.
 */

import {
  MapApiClient,
  filterRecipientsClientSide,
  formatHours,
} from "./map-api.js";
import { MapSidebarView } from "./map-sidebar.js";
import { BrokerMapView } from "./map-view.js";

const SYNC_CHANNEL = "surplus_broker_sync_v2";

export class MapPageController {
  #api;
  #mapView;
  #sidebarView;
  #els;
  #state;
  #lastData = null;
  #channel = null;

  constructor() {
    const params = new URLSearchParams(window.location.search);
    this.#state = {
      track: params.get("track") || "RETAIL",
      storageFilter: params.get("storage") || "all",
      postingId: params.get("posting_id") || "",
      offerKeyword: (params.get("offer") || "").toLowerCase(),
      preset: params.get("preset") || "recommended",
      search: params.get("q") || "",
    };

    this.#els = {
      mapCanvas: document.getElementById("broker-main-map-canvas"),
      statusLine: document.getElementById("map-status-line"),
      apiBadge: document.getElementById("api-status-badge"),
      apiBadgeText: document.getElementById("api-status-text"),
      loadingBar: document.getElementById("map-loading-bar"),
      loadingOverlay: document.getElementById("map-loading-overlay"),
      loadingPillText: document.getElementById("map-loading-pill-text"),
      sidebarScroll: document.querySelector(".custom-scroll"),
      trackSel: document.getElementById("filter-track"),
      storageSel: document.getElementById("filter-storage"),
      postingSel: document.getElementById("posting-select"),
      viewPills: document.getElementById("view-pills"),
      searchInput: document.getElementById("map-search-input"),
    };

    this.#api = new MapApiClient();
    this.#mapView = new BrokerMapView(this.#els.mapCanvas);
    this.#sidebarView = new MapSidebarView({
      postingsEl: document.getElementById("map-sidebar-postings"),
      recipientsEl: document.getElementById("map-sidebar-recipients"),
      countEl: document.getElementById("sidebar-list-count"),
      headingEl: document.getElementById("recipients-section-heading"),
      clearBtn: document.getElementById("clear-posting-btn"),
    });

    this.#bindEvents();
    this.#syncControlsFromState();
  }

  #bindEvents() {
    this.#els.trackSel?.addEventListener("change", () => {
      this.#state.track = this.#els.trackSel.value;
      this.#state.postingId = "";
      this.refresh();
    });

    this.#els.storageSel?.addEventListener("change", () => {
      this.#state.storageFilter = this.#els.storageSel.value;
      this.#state.postingId = "";
      this.refresh();
    });

    this.#els.postingSel?.addEventListener("change", () => {
      this.#state.postingId = this.#els.postingSel.value;
      this.refresh();
    });

    // Recipient preset pills & search filter `this.#lastData.all_recipients` in <1ms!
    this.#els.viewPills?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-preset]");
      if (!btn) return;
      this.#state.preset = btn.dataset.preset || "recommended";
      this.#updatePresetPills();
      this.#syncUrlQuery();
      if (this.#lastData) {
        this.#renderFromLastData();
      } else {
        this.refresh();
      }
    });

    this.#els.searchInput?.addEventListener("input", () => {
      this.#state.search = this.#els.searchInput.value.trim();
      this.#syncUrlQuery();
      if (this.#lastData) {
        this.#renderFromLastData();
      }
    });

    this.#sidebarView.addEventListener("posting-select", (e) => {
      const clickedId = String(e.detail.postingId || "");
      this.#state.postingId =
        this.#state.postingId === clickedId ? "" : clickedId;
      if (this.#els.postingSel) {
        this.#els.postingSel.value = this.#state.postingId;
      }
      this.refresh();
    });

    this.#sidebarView.addEventListener("recipient-focus", (e) => {
      this.#mapView.focusRecipient(e.detail.recipientId);
    });

    if (typeof BroadcastChannel === "function") {
      this.#channel = new BroadcastChannel(SYNC_CHANNEL);
      this.#channel.addEventListener("message", () => {
        this.refresh();
      });
    }

    // Listen for live Broker Agent tool results from the Agent Drawer on `map.html`
    window.addEventListener("broker-agent:result", (e) => {
      this.#handleAgentResult(e.detail);
    });

    window.addEventListener("broker-agent:focus-recipient", (e) => {
      const rid = Number(e.detail?.recipientId);
      if (rid) {
        this.#state.preset = "all";
        this.#updatePresetPills();
        this.#renderFromLastData();
        this.#mapView.focusRecipient(rid);
      }
    });
  }

  #handleAgentResult(detail) {
    if (!detail || !this.#lastData) return;
    const { matchResponse, result, promptText, applied } = detail;

    // 1. If the agent called `match_surplus_posting`, overlay its live rankings onto our geocoded recipients
    if (matchResponse && Array.isArray(matchResponse.ranked_matches)) {
      const byId = new Map(
        (this.#lastData.all_recipients ?? []).map((r) => [Number(r.recipient_id), { ...r }])
      );
      const splitById = new Map(
        (matchResponse.split_plan ?? []).map((s) => [Number(s.recipient_id), s])
      );

      const updatedRecipients = [];
      for (const m of matchResponse.ranked_matches) {
        const rid = Number(m.recipient_id);
        const base = byId.get(rid);
        if (!base) continue;
        const cc = m.clock_compatibility ?? {};
        updatedRecipients.push({
          ...base,
          viable: true,
          rank: Number(m.final_rank ?? 1),
          can_self_collect: Boolean(cc.can_self_collect ?? true),
          status_category: splitById.has(rid)
            ? "split_partner"
            : Number(m.final_rank ?? 99) <= 5
            ? "recommended"
            : "viable",
          ruled_out_reason: null,
        });
      }

      for (const elim of [
        ...(matchResponse.eliminated_near_misses ?? []),
        ...(matchResponse.flagged_contradictions ?? []),
      ]) {
        const rid = Number(elim.recipient_id);
        const base = byId.get(rid);
        if (!base) continue;
        updatedRecipients.push({
          ...base,
          viable: false,
          rank: null,
          status_category: "ruled_out",
          ruled_out_reason: String(elim.elimination_reason || "Ruled out by agent filter"),
        });
      }

      if (updatedRecipients.length > 0) {
        this.#lastData = {
          ...this.#lastData,
          selected_posting: {
            posting_id: "AGENT",
            track: this.#state.track,
            storage_state: matchResponse.normalized_storage_required || "refrigerated",
            hours_remaining:
              matchResponse.clock?.effective_window_hours ??
              matchResponse.clock?.donor_deadline_hours ??
              6,
            pallets: matchResponse.pallets_needed,
            posting_text: matchResponse.posting_text || promptText,
          },
          agent_clock: matchResponse.clock,
          agent_equity_audit: matchResponse.equity_audit_summary,
          all_recipients: updatedRecipients,
          counts: {
            ...this.#lastData.counts,
            recipients_total: updatedRecipients.length,
          },
        };
        this.#state.preset = "recommended";
        this.#updatePresetPills();
        this.#renderFromLastData();
        this.#setLoadingState("ready", "", "AGENT MATCH ON MAP");

        const topId = updatedRecipients[0]?.recipient_id;
        if (topId != null) {
          this.#mapView.focusRecipient(topId);
        }
        if (applied) {
          document.getElementById("cloud-run-agent-drawer")?.remove();
        }
        return;
      }
    }

    // 2. If the agent called `get_recipient_tract_equity` or named specific organizations, focus them on the map
    const replyLower = String(result?.finalReply || "").toLowerCase();
    const matchedOrg = (this.#lastData.all_recipients ?? []).find((r) =>
      replyLower.includes(r.name.toLowerCase())
    );
    if (matchedOrg) {
      this.#state.preset = "all";
      this.#updatePresetPills();
      this.#renderFromLastData();
      this.#mapView.focusRecipient(matchedOrg.recipient_id);
    }
  }

  #syncControlsFromState() {
    if (this.#els.trackSel) this.#els.trackSel.value = this.#state.track;
    if (this.#els.storageSel) this.#els.storageSel.value = this.#state.storageFilter;
    if (this.#els.searchInput) this.#els.searchInput.value = this.#state.search;
    this.#updatePresetPills();
  }

  #updatePresetPills() {
    this.#els.viewPills
      ?.querySelectorAll("button[data-preset]")
      .forEach((btn) => {
        const active = btn.dataset.preset === this.#state.preset;
        btn.setAttribute("aria-pressed", active ? "true" : "false");
      });
  }

  #syncUrlQuery() {
    const url = new URL(window.location.href);
    url.search = "";
    if (this.#state.track !== "RETAIL") url.searchParams.set("track", this.#state.track);
    if (this.#state.storageFilter !== "all") url.searchParams.set("storage", this.#state.storageFilter);
    if (this.#state.postingId) url.searchParams.set("posting_id", this.#state.postingId);
    if (this.#state.preset !== "recommended") url.searchParams.set("preset", this.#state.preset);
    if (this.#state.search) url.searchParams.set("q", this.#state.search);
    window.history.replaceState(null, "", url);
  }

  #syncPostingDropdown(postings) {
    const sel = this.#els.postingSel;
    if (!sel) return;
    const cur = this.#state.postingId;

    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = `All Matching Postings (${postings.length})`;

    const frag = document.createDocumentFragment();
    frag.append(defaultOpt);

    for (const p of postings) {
      const opt = document.createElement("option");
      opt.value = String(p.posting_id);
      const hrs = formatHours(p.hours_remaining ?? p.hours_available);
      opt.textContent = `#${p.posting_id} [${p.track} · ${hrs} · ${p.storage_state}]: ${p.posting_text.slice(0, 52)}`;
      frag.append(opt);
    }

    sel.replaceChildren(frag);
    if (cur && postings.some((p) => String(p.posting_id) === cur)) {
      sel.value = cur;
    } else if (cur) {
      this.#state.postingId = "";
      sel.value = "";
    }
  }

  #setLoadingState(state, message = "", badgeLabel = "") {
    const isLoading = state === "loading";
    if (this.#els.loadingBar) {
      this.#els.loadingBar.dataset.active = isLoading ? "true" : "false";
    }
    if (this.#els.loadingOverlay) {
      this.#els.loadingOverlay.dataset.active = isLoading ? "true" : "false";
    }
    if (isLoading && message && this.#els.loadingPillText) {
      this.#els.loadingPillText.textContent = message;
    }
    if (this.#els.apiBadge) {
      this.#els.apiBadge.dataset.state = state;
    }
    if (badgeLabel && this.#els.apiBadgeText) {
      this.#els.apiBadgeText.textContent = badgeLabel;
    }
    if (this.#els.sidebarScroll) {
      if (isLoading) {
        this.#els.sidebarScroll.setAttribute("aria-busy", "true");
      } else {
        this.#els.sidebarScroll.removeAttribute("aria-busy");
      }
    }
  }

  #renderFromLastData() {
    if (!this.#lastData) return;
    const data = this.#lastData;
    const visibleRecipients = filterRecipientsClientSide(
      data.all_recipients ?? data.recipients ?? [],
      { preset: this.#state.preset, q: this.#state.search }
    );

    this.#sidebarView.render(data, visibleRecipients);
    this.#mapView.setRecipients(visibleRecipients);

    // Publish latest API & filter context so the Broker Agent chatbot generates live suggested queries
    window.__BROKER_LATEST_MAP_DATA = {
      ...data,
      visibleRecipients,
      activePreset: this.#state.preset,
      activeTrack: this.#state.track,
      activeStorage: this.#state.storageFilter,
    };
    window.dispatchEvent(
      new CustomEvent("broker-map:context-updated", {
        detail: window.__BROKER_LATEST_MAP_DATA,
      })
    );

    if (this.#els.statusLine) {
      const selected = data.selected_posting;
      const posts = data.postings ?? [];
      if (selected) {
        const hrs = formatHours(
          data.agent_clock?.effective_window_hours ?? selected.hours_remaining
        );
        this.#els.statusLine.textContent = `Posting #${selected.posting_id} (${selected.track} · ${selected.storage_state} · ${hrs} left) → ${visibleRecipients.length} of ${data.counts?.recipients_total ?? 0} recipients shown`;
      } else {
        this.#els.statusLine.textContent = `Track: ${this.#state.track} (${posts.length} postings) · showing ${visibleRecipients.length} of ${data.counts?.recipients_total ?? 0} recipients on map`;
      }
    }
  }

  async refresh() {
    this.#syncUrlQuery();
    const loadingMsg = this.#state.postingId
      ? `Running BigQuery Vector Search & Agent Matcher for Posting #${this.#state.postingId}...`
      : `Filtering ${this.#state.track} surplus postings & matching recipients...`;

    this.#setLoadingState(
      "loading",
      loadingMsg,
      this.#state.postingId ? "RUNNING AGENT MATCHER..." : "UPDATING MAP..."
    );
    if (this.#els.statusLine) {
      this.#els.statusLine.textContent = loadingMsg;
    }

    // Yield one animation frame so the browser paints the loading overlay immediately
    await new Promise((resolve) => requestAnimationFrame(resolve));

    try {
      const data = await this.#api.fetchMapData({
        track: this.#state.track,
        storageFilter: this.#state.storageFilter,
        postingId: this.#state.postingId,
        preset: this.#state.preset,
        q: this.#state.search,
      });

      if (
        !this.#state.postingId &&
        this.#state.offerKeyword &&
        Array.isArray(data.postings)
      ) {
        const matched = data.postings.find((p) =>
          (p.posting_text || "").toLowerCase().includes(this.#state.offerKeyword)
        );
        this.#state.offerKeyword = "";
        if (matched) {
          this.#state.postingId = String(matched.posting_id);
          return await this.refresh();
        }
      }

      this.#lastData = data;
      this.#syncPostingDropdown(data.postings ?? []);
      this.#renderFromLastData();

      this.#setLoadingState(
        "ready",
        "",
        data.selected_posting
          ? "MATCHED · BIGQUERY + CLOUD SQL"
          : `LIVE · ${this.#state.track} TRACK`
      );
    } catch (err) {
      if (err?.name === "AbortError") return;
      this.#setLoadingState("error", "", "API ERROR");
      if (this.#els.statusLine) {
        this.#els.statusLine.textContent = `Could not load /map/data: ${err.message}`;
      }
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const controller = new MapPageController();
  controller.refresh();
});
