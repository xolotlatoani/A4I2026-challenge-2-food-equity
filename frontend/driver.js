/**
 * Driver page (`driver-request.html`): take a delivery, then mark it picked up and delivered.
 *
 * The desk texts the driver a link:  driver-request.html?offer=<offer_id>&driver=<driver_id>
 * With no query string it is the deli run for Sam, a volunteer: the Little Five Points grocery
 * store to Daniels Guiding Guardians.
 *
 * Backend contract. `server.py` does not serve these routes yet:
 *
 *   GET  /api/offers/<offer_id>/drivers/<driver_id>                                      ->  delivery
 *   POST /api/offers/<offer_id>/drivers/<driver_id>/response  { decision: "accept" | "decline" }  ->  delivery
 *   POST /api/offers/<offer_id>/drivers/<driver_id>/progress  { step: "picked_up" | "delivered" } ->  delivery
 *
 *   delivery: { offer_id, offer_code, driver_id, driver_first_name, pickup_point, pickup_by,
 *               dropoff_name, dropoff_address, dropoff_note, what_text, bring_text,
 *               status: "requested" | "accepted" | "picked_up" | "delivered" | "declined"
 *                       | "cancelled" | "expired",
 *               accepted_at, picked_up_at, delivered_at }        Timestamps are ISO 8601.
 *
 * When the delivery route answers, the page is live: each tap goes to the backend, and it checks
 * every 15 seconds in case the desk has cancelled. Otherwise there is nowhere to send driver
 * updates (server.py has no driver routes at all), so the page says it is in demo mode and keeps
 * the driver's progress on this phone.
 *
 * To serve this page from a different app than the API, set
 * <meta name="broker-api-base" content="https://<the API service>">; the API already allows
 * calls from other origins.
 */
(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const OFFER_ID = params.get("offer") || "deli";
  const DRIVER_ID = params.get("driver") || "sam";
  const API_BASE = (document.querySelector('meta[name="broker-api-base"]') || {}).content || "";
  const DELIVERY_PATH = `/api/offers/${encodeURIComponent(OFFER_ID)}/drivers/${encodeURIComponent(DRIVER_ID)}`;
  const LOCAL_KEY = `surplus-broker.driver.${OFFER_ID}.${DRIVER_ID}`;
  const UNAVAILABLE = new Set([404, 405, 501]);
  const POLL_MS = 15000;

  // The run the static markup shows. Only this one may be driven without the backend.
  const EXAMPLE = { offer_id: "deli", driver_id: "sam" };
  // How far along each status is: 0 not taken, 1 accepted, 2 picked up, 3 delivered.
  const REACHED = { requested: 0, accepted: 1, picked_up: 2, delivered: 3 };
  const ENDED = new Set(["delivered", "declined", "cancelled", "expired"]);
  const HELP = {
    requested: "These unlock after you accept.",
    accepted: "Tap Picked up once it's in your cooler.",
    picked_up: "Keep it cold. Tap Delivered once it's in their fridge.",
  };

  // Looks for the Picked up / Delivered buttons and the progress dots, in the page's own palette.
  const BUTTON_LOOKS = {
    locked: ["w-full h-12 bg-surface border border-outline rounded-lg text-text-muted/50 font-semibold text-sm flex items-center justify-center gap-2 cursor-not-allowed select-none", "text-text-muted/40"],
    ready: ["w-full h-12 bg-white hover:bg-primary-light border-2 border-primary rounded-lg text-primary font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99] transition disabled:opacity-60 disabled:cursor-wait", "text-primary"],
    done: ["w-full h-12 bg-primary-light border border-primary/40 rounded-lg text-primary font-semibold text-sm flex items-center justify-center gap-2 cursor-default select-none", "text-primary"],
  };
  const DOT_LOOKS = {
    done: ["w-2.5 h-2.5 rounded-full border-2 border-primary bg-primary shrink-0", "text-primary font-semibold"],
    current: ["w-2.5 h-2.5 rounded-full border-2 border-primary bg-white shrink-0", "text-text-main font-semibold"],
    pending: ["w-2.5 h-2.5 rounded-full border-2 border-outline-strong bg-white shrink-0", "text-text-muted/60"],
  };
  const STATUS_TONES = { warn: "text-amber-text", error: "text-red-700" };

  const state = { mode: "demo", delivery: { status: "requested" }, busy: false };
  const $ = (id) => document.getElementById(id);
  const originalPickupBy = () => $("pickup-by").dataset.original;

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  function clockTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  }

  // Resolves to { ok, status, data }. Status 0 means no server answered.
  async function request(path, options) {
    try {
      const resp = await fetch(API_BASE + path, options);
      let data = null;
      try {
        data = await resp.json();
      } catch (_) {
        // Empty or non-JSON body.
      }
      return { ok: resp.ok, status: resp.status, data };
    } catch (_) {
      return { ok: false, status: 0, data: null };
    }
  }

  function postJson(path, body) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function isUnavailable(result) {
    return result.status === 0 || UNAVAILABLE.has(result.status);
  }

  // FastAPI sends validation errors as a list of { msg } objects.
  function failure(result) {
    const d = result.data && (result.data.detail || result.data.error);
    const detail = Array.isArray(d) ? d.map((e) => e.msg || String(e)).join("; ") : d;
    return `Couldn't send that: ${detail || `the server answered ${result.status}`}. Please try again.`;
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY));
    } catch (_) {
      return null;
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(state.delivery));
    } catch (_) {
      // Private browsing or storage blocked: progress still shows until the page reloads.
    }
  }

  function showStatus(message, tone) {
    const el = $("driver-status");
    el.textContent = message;
    el.classList.remove("hidden", ...Object.values(STATUS_TONES));
    if (tone) el.classList.add(STATUS_TONES[tone]);
    el.classList.toggle("hidden", !message);
  }

  function enterDemoMode() {
    state.mode = "demo";
    $("demo-mode-note").classList.remove("hidden");
  }

  // -------------------------------------------------------------------------
  // Drawing the page from state.delivery
  // -------------------------------------------------------------------------
  function fillDetails(d) {
    const set = (id, text) => {
      if (text) $(id).textContent = text;
    };
    if (d.driver_first_name) $("driver-for").textContent = `For ${d.driver_first_name} (volunteer)`;
    set("pickup-point", d.pickup_point);
    set("dropoff-name", d.dropoff_name);
    set("dropoff-address", d.dropoff_address);
    set("dropoff-note", d.dropoff_note);
    set("what-text", d.what_text);
    set("bring-text", d.bring_text);
    if (d.pickup_by) $("pickup-by").dataset.original = `Pick up by ${clockTime(d.pickup_by)}`;
  }

  function setStepButton(btn, look, label) {
    const [classes, iconTone] = BUTTON_LOOKS[look];
    const [icon, text] = btn.querySelectorAll("span");
    btn.className = classes;
    btn.disabled = look !== "ready" || state.busy;
    icon.className = `material-symbols-outlined text-[18px] ${iconTone}`;
    text.textContent = label;
  }

  function renderProgress(reached) {
    const arrow = '<span class="material-symbols-outlined text-outline-strong text-[14px]">arrow_forward</span>';
    $("progress-row").innerHTML = ["Accepted", "Picked up", "Delivered"]
      .map((name, i) => {
        const [dot, label] = DOT_LOOKS[i < reached ? "done" : i === reached ? "current" : "pending"];
        return `<div class="flex items-center gap-1.5"><span class="${dot}"></span><span class="${label}">${name}</span></div>`;
      })
      .join(arrow);
  }

  function renderBanner(d, status) {
    $("pickup-banner").classList.toggle("hidden", ENDED.has(status));
    if (status === "picked_up") {
      $("banner-label").textContent = `Picked up${d.picked_up_at ? ` at ${clockTime(d.picked_up_at)}` : ""}`;
      $("pickup-by").textContent = `Deliver to ${$("dropoff-name").textContent.trim()}`;
      $("pickup-left-box").classList.add("hidden");
      return;
    }
    $("banner-label").textContent = status === "accepted" ? "On your way" : "Action required";
    $("pickup-by").textContent = originalPickupBy();
    $("pickup-left-box").classList.remove("hidden");
  }

  function renderResult(status) {
    const panel = $("driver-result");
    const results = {
      delivered: ["done_all", "border-primary text-primary", "Delivered. Thank you!",
        "The desk, the store and the pantry can all see it arrived."],
      declined: ["do_not_disturb_on", "border-outline-strong text-text-muted", "Thanks for letting us know",
        "The desk will find another driver."],
      cancelled: ["cancel", "border-outline-strong text-text-muted", "This delivery was cancelled",
        "The desk doesn't need you for this one, so there is nothing to pick up."],
      expired: ["schedule", "border-red-300 text-red-700", "The pickup time has passed",
        "The desk will sort out what happens to this food."],
    };
    if (!results[status]) {
      panel.classList.add("hidden");
      return;
    }
    const [icon, tone, title, liveBody] = results[status];
    // In demo mode nobody else was told anything, so don't say they were.
    const body = state.mode === "live" ? liveBody : "Demo mode: this is saved on this phone only.";
    panel.innerHTML = `<div class="border rounded-xl p-4 bg-card flex flex-col gap-1 ${tone}">
<div class="flex items-center gap-2">
<span class="material-symbols-outlined text-[22px]">${icon}</span>
<h2 class="font-bold text-[16px] text-text-main">${escapeHtml(title)}</h2>
</div>
<p class="text-sm text-text-main">${escapeHtml(body)}</p>
</div>`;
    panel.classList.remove("hidden");
  }

  function render() {
    const d = state.delivery;
    const status = d.status in REACHED || ENDED.has(d.status) ? d.status : "requested";
    const reached = REACHED[status] || 0;

    $("respond-actions").classList.toggle("hidden", status !== "requested");
    $("accept-btn").disabled = state.busy;
    $("decline-btn").disabled = state.busy;
    $("steps-section").classList.toggle("hidden", ["declined", "cancelled", "expired"].includes(status));
    renderBanner(d, status);
    renderProgress(reached);
    setStepButton($("picked-btn"), status === "accepted" ? "ready" : reached >= 2 ? "done" : "locked",
      reached >= 2 && d.picked_up_at ? `Picked up · ${clockTime(d.picked_up_at)}` : "Picked up");
    setStepButton($("delivered-btn"), status === "picked_up" ? "ready" : reached >= 3 ? "done" : "locked",
      reached >= 3 && d.delivered_at ? `Delivered · ${clockTime(d.delivered_at)}` : "Delivered");
    $("steps-help").textContent = HELP[status] || "";
    $("steps-help").classList.toggle("hidden", !HELP[status]);
    renderResult(status);
  }

  // Only live deliveries have a real pickup time to count down to.
  function tick() {
    const d = state.delivery;
    if (state.mode !== "live" || !d.pickup_by || !["requested", "accepted"].includes(d.status)) return;
    const msLeft = new Date(d.pickup_by).getTime() - Date.now();
    if (msLeft <= 0) {
      if (d.status === "requested") {
        d.status = "expired";
        render();
      } else {
        $("pickup-left").textContent = "pickup time passed";
      }
      return;
    }
    const minutes = Math.ceil(msLeft / 60000);
    const h = Math.floor(minutes / 60);
    $("pickup-left").textContent = `${h ? `${h}h ` : ""}${minutes % 60}m left`;
  }

  // -------------------------------------------------------------------------
  // Taps
  // -------------------------------------------------------------------------
  async function act(path, body, nextStatus, stampField) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      if (state.mode === "live") {
        const result = await postJson(path, body);
        if (result.ok && result.data) {
          state.delivery = Object.assign({}, state.delivery, result.data);
          showStatus("");
          return;
        }
        if (!isUnavailable(result)) {
          showStatus(failure(result), "error");
          return;
        }
        enterDemoMode();
      }
      state.delivery = Object.assign({}, state.delivery, { status: nextStatus, [stampField]: new Date().toISOString() });
      saveLocal();
      showStatus("");
    } finally {
      state.busy = false;
      render();
    }
  }

  async function refresh() {
    if (state.mode !== "live" || state.busy || ENDED.has(state.delivery.status)) return;
    const result = await request(DELIVERY_PATH);
    if (result.ok && result.data) {
      state.delivery = Object.assign({}, state.delivery, result.data);
      render();
      tick();
    }
  }

  async function load() {
    const result = await request(DELIVERY_PATH);
    if (result.ok && result.data) {
      state.mode = "live";
      state.delivery = result.data;
      fillDetails(result.data);
      render();
      tick();
      setInterval(tick, 30000);
      setInterval(refresh, POLL_MS);
      return;
    }

    // Without the backend all the page has is the example run, so it can't be driven on behalf of
    // a link that was for some other delivery.
    if (OFFER_ID !== EXAMPLE.offer_id || DRIVER_ID !== EXAMPLE.driver_id) {
      $("unavailable-note").classList.remove("hidden");
      ["pickup-banner", "route-card", "details", "respond-actions", "steps-section"].forEach((id) =>
        $(id).classList.add("hidden"));
      return;
    }
    enterDemoMode();
    if (!isUnavailable(result)) {
      showStatus("Couldn't load this delivery's latest details, so this is the example run.", "warn");
    }
    const saved = loadLocal();
    if (saved) state.delivery = saved;
    render();
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("pickup-by").dataset.original = $("pickup-by").textContent.trim();
    $("accept-btn").addEventListener("click", () =>
      act(`${DELIVERY_PATH}/response`, { decision: "accept" }, "accepted", "accepted_at"));
    $("decline-btn").addEventListener("click", () =>
      act(`${DELIVERY_PATH}/response`, { decision: "decline" }, "declined", "responded_at"));
    $("picked-btn").addEventListener("click", () =>
      act(`${DELIVERY_PATH}/progress`, { step: "picked_up" }, "picked_up", "picked_up_at"));
    $("delivered-btn").addEventListener("click", () =>
      act(`${DELIVERY_PATH}/progress`, { step: "delivered" }, "delivered", "delivered_at"));
    load();
  });
})();
