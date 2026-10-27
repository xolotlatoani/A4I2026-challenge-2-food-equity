/**
 * Grocer page (`grocer-post.html`): post surplus, then track it to pickup.
 *
 * Backend contract. `server.py` does not serve these routes yet; until it does, the page runs in
 * a labeled demo mode that keeps posts in this browser only.
 *
 *   POST /api/offers                    body: new offer          ->  offer
 *   GET  /api/offers?store=<store_id>                            ->  { offers: [offer, ...] }, newest first
 *   GET  /api/offers/<offer_id>                                  ->  offer
 *
 *   new offer: { store_id, donor_label, pickup_point, posting_text,
 *                storage: "refrigerated" | "frozen" | "shelf-stable",
 *                must_leave_by: ISO 8601 with offset, quantity_text: string | null }
 *
 *   offer: the new offer plus { offer_id, offer_code, posted_at,
 *          status: "posted" | "matched" | "driver_assigned" | "picked_up" | "expired",
 *          matched_at, recipient_name, driver_assigned_at, driver_first_name, picked_up_at }
 *          Timestamps are ISO 8601 and stay null until that step happens.
 *
 * No server at all (the page opened from disk), or a 404, 405 or 501 from these routes, puts the
 * page in demo mode. Any other error is shown to the grocer and nothing is saved.
 *
 * To serve this page from a different app than the API, set
 * <meta name="broker-api-base" content="https://<the API service>">; the API already allows
 * calls from other origins.
 */
(function () {
  "use strict";

  // The signed-in store. Fixed for the demo; a real login would supply these.
  const STORE_ID = "little-five-points";
  const DONOR_LABEL = "Grocery store · Little Five Points";

  const API_BASE = (document.querySelector('meta[name="broker-api-base"]') || {}).content || "";
  const POLL_MS = 10000;
  const LOCAL_KEY = "surplus-broker.grocer-posts";
  const UNAVAILABLE = new Set([404, 405, 501]);
  const ACTIVE = new Set(["posted", "matched", "driver_assigned"]);

  const STORAGE_LABELS = { refrigerated: "Keep cold", frozen: "Frozen", "shelf-stable": "Shelf-stable" };
  const BADGES = {
    posted: "FINDING A MATCH",
    matched: "FINDING A DRIVER",
    driver_assigned: "DRIVER ON THE WAY",
    picked_up: "PICKED UP",
    expired: "NO MATCH IN TIME",
  };
  // How far along the tracker each status is: 1 posted, 2 matched, 3 driver, 4 picked up.
  const REACHED = { posted: 1, matched: 2, driver_assigned: 3, picked_up: 4, expired: 1 };

  // The two looks of a storage option, taken from the Stitch markup.
  const OPTION_ON = ["bg-primary-container", "text-on-primary", "border-primary", "shadow-none"];
  const OPTION_OFF = ["bg-surface-container-lowest", "text-on-surface-variant", "border-outline-variant",
    "hover:bg-surface-container-high"];
  const STATUS_TONES = { ok: "text-primary", warn: "text-amber-800", error: "text-error" };

  const state = { storage: "refrigerated", demo: false, busy: false, posts: [] };
  const $ = (id) => document.getElementById(id);

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

  // ISO 8601 in the browser's own time zone, e.g. 2026-10-28T18:10:00-04:00.
  function localIso(date) {
    const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, "0");
    const offset = -date.getTimezoneOffset();
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
      `${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`
    );
  }

  // Four hours from now, rounded up to ten minutes, and never past the end of today.
  function defaultLeaveBy() {
    const t = new Date(Date.now() + 4 * 3600 * 1000);
    t.setSeconds(0, 0);
    t.setMinutes(Math.ceil(t.getMinutes() / 10) * 10);
    if (t.toDateString() !== new Date().toDateString()) return "23:50";
    return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  }

  function todayAt(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  // -------------------------------------------------------------------------
  // Talking to the backend
  // -------------------------------------------------------------------------
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

  function isUnavailable(result) {
    return result.status === 0 || UNAVAILABLE.has(result.status);
  }

  // FastAPI sends validation errors as a list of { msg } objects.
  function errorDetail(data) {
    const d = data && (data.detail || data.error);
    if (Array.isArray(d)) return d.map((e) => e.msg || String(e)).join("; ");
    return d ? String(d) : "";
  }

  function enterDemoMode() {
    state.demo = true;
    $("demo-mode-note").classList.remove("hidden");
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY)) || [];
    } catch (_) {
      return [];
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(state.posts));
    } catch (_) {
      // Private browsing or storage blocked: the post still shows until the page reloads.
    }
  }

  // -------------------------------------------------------------------------
  // The form
  // -------------------------------------------------------------------------
  function selectStorage(value) {
    state.storage = value;
    document.querySelectorAll("#storage-options [data-storage]").forEach((btn) => {
      const on = btn.dataset.storage === value;
      btn.setAttribute("aria-checked", String(on));
      btn.classList.remove(...OPTION_ON, ...OPTION_OFF);
      btn.classList.add(...(on ? OPTION_ON : OPTION_OFF));
    });
  }

  function showFieldError(id, message) {
    const el = $(id);
    el.textContent = message;
    el.classList.toggle("hidden", !message);
  }

  function showStatus(message, tone) {
    const el = $("post-surplus-status");
    el.textContent = message;
    el.classList.remove("hidden", ...Object.values(STATUS_TONES));
    el.classList.add(STATUS_TONES[tone]);
  }

  function setBusy(busy) {
    state.busy = busy;
    $("post-surplus-btn").disabled = busy;
    $("post-surplus-label").textContent = busy ? "Posting…" : "Post surplus";
  }

  // The new-offer body, or null after marking whatever is missing.
  function readForm() {
    const text = $("surplus-desc").value.trim();
    const leaveBy = $("surplus-leave-by").value;
    const when = leaveBy ? todayAt(leaveBy) : null;

    showFieldError("surplus-desc-error", text ? "" : "Tell us what you have.");
    if (!when) {
      showFieldError("surplus-leave-by-error", "Pick the time it has to leave your dock.");
    } else if (when.getTime() <= Date.now()) {
      showFieldError("surplus-leave-by-error", "That time has already passed. Pick a later one.");
    } else {
      showFieldError("surplus-leave-by-error", "");
    }
    if (!text || !when || when.getTime() <= Date.now()) return null;

    return {
      store_id: STORE_ID,
      donor_label: DONOR_LABEL,
      pickup_point: $("pickup-point").textContent.trim(),
      posting_text: text,
      storage: state.storage,
      must_leave_by: localIso(when),
      quantity_text: $("surplus-qty").value.trim() || null,
    };
  }

  function resetForm() {
    $("surplus-desc").value = "";
    $("surplus-qty").value = "";
    $("surplus-leave-by").value = defaultLeaveBy();
  }

  async function submitPost() {
    if (state.busy) return;
    const body = readForm();
    if (!body) return;
    setBusy(true);

    let offer = null;
    if (!state.demo) {
      const result = await request("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (result.ok && result.data) {
        offer = result.data;
      } else if (isUnavailable(result)) {
        enterDemoMode();
      } else {
        setBusy(false);
        const detail = errorDetail(result.data) || `the server answered ${result.status}`;
        showStatus(`Couldn't post: ${detail}. Please try again.`, "error");
        return;
      }
    }
    if (!offer) {
      offer = Object.assign({}, body, {
        offer_id: `local-${Date.now()}`,
        offer_code: null,
        status: "posted",
        posted_at: localIso(new Date()),
      });
    }

    state.posts.unshift(offer);
    if (state.demo) saveLocal();
    render();
    resetForm();
    setBusy(false);
    if (state.demo) {
      showStatus("Saved on this device. It reaches the coordinator once the posting service is connected.", "warn");
    } else {
      showStatus("Posted. We'll text you when a driver is on the way.", "ok");
    }
  }

  // -------------------------------------------------------------------------
  // Today's posts
  // -------------------------------------------------------------------------
  function step(kind, label, time, icon) {
    const looks = {
      done: ["", "bg-primary-container text-on-primary border-primary", "check", "text-on-surface font-medium",
        "text-on-surface-variant"],
      current: ["bg-surface-container-low p-space-xs rounded -ml-space-xs border border-secondary-container",
        "bg-primary text-on-primary border-primary animate-pulse", icon || "search", "text-primary font-bold",
        "text-primary font-bold"],
      pending: ["", "bg-surface-container-low text-outline border-outline-variant", "radio_button_unchecked",
        "text-outline font-normal", "text-outline"],
      failed: ["", "bg-error-container text-error border-error", "close", "text-error font-medium", "text-error"],
    };
    const [row, dot, glyph, labelTone, timeTone] = looks[kind];
    return `<div class="relative flex items-start gap-space-md z-10 ${row}">
<div class="w-6 h-6 rounded-full ${dot} flex items-center justify-center border shrink-0">
<span class="material-symbols-outlined text-sm leading-none">${glyph}</span>
</div>
<div class="flex flex-1 items-baseline justify-between pt-0.5">
<span class="font-headline-sm text-headline-sm ${labelTone} pr-2">${escapeHtml(label)}</span>
<span class="font-tabular-data-sm text-tabular-data-sm ${timeTone} shrink-0">${escapeHtml(time)}</span>
</div>
</div>`;
  }

  function steps(offer) {
    const status = REACHED[offer.status] ? offer.status : "posted";
    const reached = REACHED[status];
    const driver = offer.driver_first_name ? `${offer.driver_first_name} (volunteer)` : "a volunteer";

    let match;
    if (status === "expired") match = step("failed", "No pantry could take it in time", "");
    else if (reached >= 2) match = step("done", `Matched: ${offer.recipient_name || "a pantry"} accepted`, clockTime(offer.matched_at));
    else match = step("current", "Finding a pantry that can take it", "");

    let drive;
    if (reached >= 3) {
      drive = step(reached === 3 ? "current" : "done", `Driver on the way: ${driver} accepted`,
        clockTime(offer.driver_assigned_at), "near_me");
    } else if (reached === 2) {
      drive = step("current", "Finding a driver", "");
    } else {
      drive = step("pending", "Driver on the way", "");
    }

    const pickup = reached >= 4
      ? step("done", "Picked up", clockTime(offer.picked_up_at))
      : step("pending", "Picked up", status === "expired" ? "" : "waiting");

    return step("done", "Posted", clockTime(offer.posted_at)) + match + drive + pickup;
  }

  function cardHtml(offer) {
    const text = offer.posting_text || "";
    const title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    const local = String(offer.offer_id || "").startsWith("local-");
    const details = [
      STORAGE_LABELS[offer.storage] || "",
      offer.must_leave_by ? `leaves by ${clockTime(offer.must_leave_by)}` : "",
      offer.quantity_text || "",
      offer.offer_code || "",
    ].filter(Boolean).join(" · ");
    const badgeTone = offer.status === "expired"
      ? "bg-error-container text-error border-error"
      : "bg-secondary-container text-on-secondary-container border-outline-variant";
    const footer = local
      ? "Saved on this device only. Not sent to the coordinator yet."
      : "We'll text you when the driver arrives at your dock.";

    return `<div class="bg-surface-container-lowest border border-outline-variant rounded-lg p-space-md flex flex-col gap-space-md" data-offer-id="${escapeHtml(offer.offer_id)}">
<div class="border-b border-outline-variant pb-space-sm flex items-start justify-between gap-space-sm">
<div class="min-w-0">
<h3 class="font-headline-sm text-headline-sm text-on-surface font-bold break-words">${escapeHtml(title)}</h3>
<p class="font-body-sm text-body-sm text-on-surface-variant">${escapeHtml(details)}</p>
</div>
<span class="font-label-badge text-label-badge px-2 py-0.5 rounded border shrink-0 ${badgeTone}">${BADGES[offer.status] || BADGES.posted}</span>
</div>
<div class="relative flex flex-col gap-space-md pl-2 pt-1 pb-1">
<div aria-hidden="true" class="absolute left-[19px] top-4 bottom-5 w-0.5 bg-outline-variant"></div>
${steps(offer)}
</div>
<div class="pt-space-xs border-t border-outline-variant">
<p class="font-body-sm text-body-sm text-on-surface-variant flex items-center gap-space-xs">
<span class="material-symbols-outlined text-outline">sms</span>
<span>${footer}</span>
</p>
</div>
</div>`;
  }

  function markExample() {
    const heading = document.querySelector("#example-post h3");
    if (heading && !$("example-chip")) {
      heading.insertAdjacentHTML(
        "afterend",
        '<span class="inline-block mt-0.5 font-label-badge text-label-badge text-outline border border-outline-variant rounded px-1.5" id="example-chip">EXAMPLE</span>'
      );
    }
  }

  function render() {
    // The Stitch example card stays only in demo mode with nothing posted yet.
    const showExample = state.demo && state.posts.length === 0;
    let html = state.posts.map(cardHtml).join("");
    if (!state.posts.length && !showExample) {
      html = '<p class="font-body-sm text-body-sm text-on-surface-variant">No posts yet today.</p>';
    }
    $("posts-list").innerHTML = html;
    $("example-post").classList.toggle("hidden", !showExample);
    if (showExample) markExample();
    const active = state.posts.filter((p) => ACTIVE.has(p.status)).length;
    $("active-count").textContent = `${active} ACTIVE`;
  }

  async function loadPosts() {
    const result = await request(`/api/offers?store=${encodeURIComponent(STORE_ID)}`);
    if (result.ok && result.data && Array.isArray(result.data.offers)) {
      state.posts = result.data.offers;
    } else if (isUnavailable(result)) {
      enterDemoMode();
      state.posts = loadLocal();
    } else {
      showStatus("Couldn't load today's posts. They'll appear once the server answers.", "error");
    }
    render();
  }

  // Ask the backend where each active post has got to. Demo posts have nowhere to ask.
  async function refreshActive() {
    if (state.demo) return;
    let changed = false;
    for (const post of state.posts.filter((p) => ACTIVE.has(p.status))) {
      const result = await request(`/api/offers/${encodeURIComponent(post.offer_id)}`);
      if (result.ok && result.data) {
        Object.assign(post, result.data);
        changed = true;
      }
    }
    if (changed) render();
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("#storage-options [data-storage]").forEach((btn) => {
      btn.addEventListener("click", () => selectStorage(btn.dataset.storage));
    });
    $("surplus-leave-by").value = defaultLeaveBy();
    $("surplus-desc").addEventListener("input", () => showFieldError("surplus-desc-error", ""));
    $("surplus-leave-by").addEventListener("input", () => showFieldError("surplus-leave-by-error", ""));
    $("post-surplus-btn").addEventListener("click", submitPost);
    loadPosts();
    setInterval(refreshActive, POLL_MS);
  });
})();
