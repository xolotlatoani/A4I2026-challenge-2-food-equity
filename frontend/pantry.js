/**
 * Pantry page (`pantry-offer.html`): accept or decline one offer from the desk.
 *
 * The desk texts the pantry a link:  pantry-offer.html?offer=<offer_id>&recipient=<recipient_id>
 * With no query string it is the deli offer for Daniels Guiding Guardians (recipient 14).
 *
 * Backend contract. `server.py` serves these routes over the offer-state service (Cloud SQL):
 *
 *   GET  /api/offers/<offer_id>/invites/<recipient_id>             ->  invite
 *   POST /api/offers/<offer_id>/invites/<recipient_id>/response    body: { decision, reason }  ->  invite
 *        decision: "accept" | "decline"
 *        reason:   "no_capacity_today" | "closed" | "wrong_food" | "other"   (decline only, else null)
 *        These are the state service's reason codes, so a backend route can pass them through.
 *
 *   invite: { offer_id, offer_code, recipient_id, recipient_name, item_title, donor_area,
 *             posting_text, storage, must_leave_by, quantity_text, pallets, tags: [string],
 *             why_you, delivery_note, space_note, sent_at, respond_by,
 *             status: "offered" | "accepted" | "declined" | "expired", decline_reason, responded_at }
 *             Timestamps are ISO 8601.
 *
 * Three modes, decided when the page loads:
 *   live     the invite route answers: show that offer and send the answer to it.
 *   partial  a server answers but has no such invite (404): keep the deli example on
 *            the page and record the answer on the dispatch board it already serves
 *            (/api/dispatches/claim on accept, /release on decline), as app.js did.
 *   demo     no server at all (the page opened from disk): say so, and keep the answer in this
 *            browser only.
 *
 * To serve this page from a different app than the API, set
 * <meta name="broker-api-base" content="https://<the API service>">; the API already allows
 * calls from other origins.
 */
(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const OFFER_ID = params.get("offer") || "deli";
  const RECIPIENT_ID = params.get("recipient") || "14";
  const API_BASE = (document.querySelector('meta[name="broker-api-base"]') || {}).content || "";
  const INVITE_PATH = `/api/offers/${encodeURIComponent(OFFER_ID)}/invites/${encodeURIComponent(RECIPIENT_ID)}`;
  const LOCAL_KEY = `surplus-broker.pantry.${OFFER_ID}.${RECIPIENT_ID}`;
  const UNAVAILABLE = new Set([404, 405, 501]);

  // What the page shows before any data arrives: the deli offer for Daniels Guiding Guardians,
  // as server.py's catalog has it. In partial mode this is what goes on the dispatch board.
  const EXAMPLE = {
    offer_id: "deli",
    recipient_id: 14,
    recipient_name: "Daniels Guiding Guardians",
    posting_text: "prepared sandwiches and salads from the deli case, must move tonight",
    offer_code: "OFFER #ATL-8831",
    pallets: 0.15,
  };

  const REASONS = {
    no_capacity_today: "No fridge space",
    closed: "Closed today",
    wrong_food: "Can't use this food",
    other: "Other",
  };
  const STORAGE_LABELS = { refrigerated: "Keep cold", frozen: "Frozen", "shelf-stable": "Shelf-stable" };

  // The two looks of a reason chip, taken from the Stitch markup.
  const CHIP_ON = ["border-primary", "bg-secondary-container", "text-on-secondary-fixed-variant", "font-semibold"];
  const CHIP_OFF = ["bg-surface-container-lowest", "text-on-surface", "border-outline-variant"];
  const STATUS_TONES = { ok: "text-primary", warn: "text-amber-800", error: "text-error" };
  const TIME_CHIP = "font-tabular-data-sm text-tabular-data-sm text-on-surface font-semibold bg-surface-container-low px-1 py-0.5 rounded border border-surface-dim";

  const state = { mode: "partial", invite: null, reason: null, busy: false, done: false };
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
    return `Couldn't send your answer: ${detail || `the server answered ${result.status}`}. Please try again.`;
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY));
    } catch (_) {
      return null;
    }
  }

  function saveLocal(outcome) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(outcome));
    } catch (_) {
      // Private browsing or storage blocked: the answer still shows until the page reloads.
    }
  }

  function showStatus(message, tone) {
    const el = $("decision-status");
    el.textContent = message;
    el.classList.remove("hidden", ...Object.values(STATUS_TONES));
    el.classList.add(STATUS_TONES[tone]);
  }

  function setBusy(busy) {
    state.busy = busy;
    $("accept-btn").disabled = busy;
    $("decline-btn").disabled = busy;
  }

  // -------------------------------------------------------------------------
  // Showing the offer
  // -------------------------------------------------------------------------
  function tagHtml(label, cold) {
    if (cold) {
      return `<div class="inline-flex items-center gap-1 bg-surface-container-low text-tertiary border border-tertiary/30 px-space-xs py-1 rounded">
<span class="material-symbols-outlined text-[14px]">ac_unit</span>
<span class="font-label-badge text-label-badge font-semibold">${escapeHtml(label)}</span>
</div>`;
    }
    return `<div class="inline-flex items-center bg-surface-container-lowest text-on-surface-variant border border-outline-variant px-space-xs py-1 rounded">
<span class="font-label-badge text-label-badge font-medium">${escapeHtml(label)}</span>
</div>`;
  }

  // Fill one labeled section, or hide it when the invite has nothing to say there.
  function fillSection(id, text) {
    $(id).textContent = text || "";
    $(id).parentElement.classList.toggle("hidden", !text);
  }

  function renderInvite(inv) {
    $("offer-for").textContent = `Offer for ${inv.recipient_name || "your organization"}`;
    $("sent-at").textContent = clockTime(inv.sent_at) || "—";
    $("item-title").textContent = inv.item_title || inv.posting_text || "";
    $("donor-area").textContent = inv.donor_area ? `From a grocery store in ${inv.donor_area}` : "";

    const cold = inv.storage === "refrigerated" || inv.storage === "frozen";
    const tags = [tagHtml(STORAGE_LABELS[inv.storage] || "Check storage on arrival", cold)];
    (inv.tags || []).forEach((t) => tags.push(tagHtml(t, false)));
    tags.push(tagHtml(inv.quantity_text || "Amount to confirm on arrival", false));
    $("offer-tags").innerHTML = tags.join("");

    fillSection("why-you", inv.why_you);
    const leaves = clockTime(inv.must_leave_by);
    $("delivery-note").innerHTML = escapeHtml(inv.delivery_note || "") +
      (leaves ? ` It leaves the store by <span class="${TIME_CHIP}">${escapeHtml(leaves)}</span> today.` : "");
    $("delivery-note").parentElement.classList.toggle("hidden", !inv.delivery_note && !leaves);
    fillSection("space-note", inv.space_note);
  }

  function updateRespondBy() {
    const inv = state.invite;
    if (state.done || !inv || !inv.respond_by) return;
    const msLeft = new Date(inv.respond_by).getTime() - Date.now();
    if (msLeft <= 0) {
      showResult({ status: "expired", via: state.mode });
      return;
    }
    const minutes = Math.ceil(msLeft / 60000);
    $("respond-by").innerHTML =
      `Please answer by <span class="${TIME_CHIP}">${escapeHtml(clockTime(inv.respond_by))}</span> ` +
      `(${minutes} min left) so we can offer it to someone else if you can't take it.`;
  }

  // Replace the buttons with what happened. `via` says where the answer went.
  function showResult(outcome) {
    state.done = true;
    $("decision").classList.add("hidden");
    $("respond-footer").classList.add("hidden");

    const code = state.invite && state.invite.offer_code ? ` · ${state.invite.offer_code}` : "";
    const reason = REASONS[outcome.decline_reason];
    let icon, tone, title, body, note = "";
    if (outcome.status === "accepted") {
      icon = "check_circle";
      tone = "border-primary text-primary";
      title = "You've accepted this offer";
      body = "The desk will confirm the drop-off time. Please make room in a fridge now: it has to go straight in.";
      if (outcome.via === "partial") note = "Recorded on the desk's dispatch board.";
    } else if (outcome.status === "declined") {
      icon = "do_not_disturb_on";
      tone = "border-outline-variant text-on-surface-variant";
      title = "You've declined this offer";
      body = `Thanks for telling us${reason ? ` (${reason})` : ""}. The desk will offer it to someone else.`;
      if (outcome.via === "partial") note = "The desk's dispatch board no longer holds it for you. Your reason is saved on this device only for now.";
    } else {
      icon = "schedule";
      tone = "border-error text-error";
      title = "This offer has expired";
      body = "The desk is offering it to someone else. Thanks for checking.";
    }
    if (outcome.via === "demo") note = "Demo mode: your answer is saved on this device only.";

    const panel = $("decision-result");
    panel.innerHTML = `<div class="bg-surface-container-lowest border rounded-lg p-space-md flex flex-col gap-space-xs ${tone}">
<div class="flex items-center gap-space-xs">
<span class="material-symbols-outlined">${icon}</span>
<h2 class="font-headline-md text-headline-md font-semibold text-on-surface">${escapeHtml(title + code)}</h2>
</div>
<p class="font-body-md text-body-md text-on-surface">${escapeHtml(body)}</p>
${note ? `<p class="font-body-sm text-body-sm text-on-surface-variant">${escapeHtml(note)}</p>` : ""}
</div>`;
    panel.classList.remove("hidden");
  }

  // -------------------------------------------------------------------------
  // Answering
  // -------------------------------------------------------------------------
  function selectReason(value) {
    state.reason = state.reason === value ? null : value;
    document.querySelectorAll("#reason-block [data-reason]").forEach((chip) => {
      const on = chip.dataset.reason === state.reason;
      chip.setAttribute("aria-pressed", String(on));
      chip.classList.remove(...CHIP_ON, ...CHIP_OFF);
      chip.classList.add(...(on ? CHIP_ON : CHIP_OFF));
    });
    if (state.reason) $("decision-status").classList.add("hidden");
  }

  // The dispatch board server.py already serves: claim on accept, release on decline.
  function sendToBoard(decision) {
    const inv = state.invite || EXAMPLE;
    if (decision === "accept") {
      return postJson("/api/dispatches/claim", {
        posting_text: inv.posting_text,
        recipient_id: Number(inv.recipient_id),
        recipient_name: inv.recipient_name,
        pallets_claimed: Number(inv.pallets) || EXAMPLE.pallets,
        offer_code: inv.offer_code,
      });
    }
    return postJson("/api/dispatches/release", { recipient_id: Number(inv.recipient_id) });
  }

  // Resolves to the mode the answer actually went through; rejects with a message to show.
  async function send(decision, reason) {
    if (state.mode === "live") {
      const result = await postJson(`${INVITE_PATH}/response`, { decision, reason });
      if (result.ok && result.data) {
        state.invite = Object.assign({}, state.invite, result.data);
        return "live";
      }
      if (!isUnavailable(result)) throw failure(result);
    }
    if (state.mode !== "demo") {
      const result = await sendToBoard(decision);
      if (result.ok) return "partial";
      if (!isUnavailable(result)) throw failure(result);
    }
    $("demo-mode-note").classList.remove("hidden");
    return "demo";
  }

  async function respond(decision) {
    if (state.busy || state.done) return;
    const reason = decision === "decline" ? state.reason : null;
    if (decision === "decline" && !reason) {
      showStatus("Pick a reason below first, so the desk knows what to try next.", "error");
      return;
    }
    setBusy(true);
    try {
      const via = await send(decision, reason);
      const outcome = { status: decision === "accept" ? "accepted" : "declined", decline_reason: reason, via };
      if (via !== "live") saveLocal(outcome);
      showResult(outcome);
    } catch (message) {
      showStatus(String(message), "error");
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const result = await request(INVITE_PATH);
    if (result.ok && result.data) {
      state.mode = "live";
      state.invite = result.data;
      renderInvite(result.data);
      if (result.data.status && result.data.status !== "offered") {
        showResult({ status: result.data.status, decline_reason: result.data.decline_reason, via: "live" });
        return;
      }
      updateRespondBy();
      setInterval(updateRespondBy, 30000);
      return;
    }

    state.mode = result.status === 0 ? "demo" : "partial";
    if (state.mode === "demo") $("demo-mode-note").classList.remove("hidden");
    // Without the invite, all the page has is the deli example, so nobody may answer it on
    // behalf of a link that was for some other offer or pantry.
    if (OFFER_ID !== EXAMPLE.offer_id || Number(RECIPIENT_ID) !== EXAMPLE.recipient_id) {
      state.done = true;
      $("static-note").classList.remove("hidden");
      document.querySelector("article").classList.add("hidden");
      $("decision").classList.add("hidden");
      $("respond-footer").classList.add("hidden");
      return;
    }
    if (!isUnavailable(result)) {
      showStatus("Couldn't load this offer's latest details. Please try the link again in a minute.", "warn");
    }
    const saved = loadLocal();
    if (saved) showResult(saved);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("#reason-block [data-reason]").forEach((chip) => {
      chip.addEventListener("click", () => selectReason(chip.dataset.reason));
    });
    $("accept-btn").addEventListener("click", () => respond("accept"));
    $("decline-btn").addEventListener("click", () => respond("decline"));
    load();
  });
})();
