/**
 * @module console/state-store
 * Stateful store (`APP_STATE`), API client (`api`), and dispatch actions (`markOfferSent`,
 * `recordDecline`, `switchToOption`, `markOfferAccepted`, `markOfferDonated`, `activateSplitPlan`).
 */

import { DEFAULT_OFFERS_CATALOG } from "./demo-catalog.js";
import {
  detailText,
  getActiveOfferKey,
  isMatchBriefPage,
  isQueuePage,
  pct,
  scoreLabel,
  showToast,
} from "./ui-utils.js";

export const CLOUD_RUN_AGENT_URL = "https://food-rescue-agent-2u2wh53apa-uc.a.run.app";
export const STORAGE_KEY = "surplus_broker_state_v3";
export const CHANNEL_NAME = "surplus_broker_sync_v3";
export const POLL_MS = 15000;

export const API_BASE = (
  (document.querySelector('meta[name="broker-api-base"]') || {}).content || ""
).replace(/\/$/, "");
export const SERVED = API_BASE !== "" || /^https?:$/.test(window.location.protocol);
export const AGENT_BASE = SERVED ? API_BASE : CLOUD_RUN_AGENT_URL;

let demoMode = !SERVED;
let onViewRefresh = () => {};

export function setViewRefreshCallback(fn) {
  onViewRefresh = fn;
}

export function isDemoMode() {
  return demoMode;
}

export function setDemoMode(val) {
  demoMode = Boolean(val);
}

export function refreshCurrentView() {
  onViewRefresh();
}

export async function api(path, body) {
  if (!SERVED) return null;
  try {
    const res = await fetch(
      API_BASE + path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function toPrimaryMatch(c, data) {
  return {
    recipient_id: c.recipient_id,
    name: c.name,
    archetype: String(c.archetype_label || "Recipient").toUpperCase(),
    match_score: scoreLabel(c),
    address: c.address,
    reason: c.why_them || "",
    take_text: [c.what_they_can_take, c.pickup_warning].filter(Boolean).join(" "),
    capacity_Fit: c.takes_it_all
      ? "takes the whole load"
      : `takes ${c.capacity_pallets} pallet(s)`,
    clock_text: `Est. pickup ${c.est_pickup_time} · ${c.margin_label} before ${
      (data && data.dock_shutoff) || "the deadline"
    }`,
    insecurity_rate: pct(c.food_insecurity_rate),
    no_vehicle_rate: pct(c.no_vehicle_rate),
    poverty_rate: pct(c.poverty_rate),
    weekly_households: c.weekly_households,
    sms: c.draft_sms || "",
  };
}

function toStandby(c, idx) {
  return {
    rank: idx + 2,
    recipient_id: c.recipient_id,
    name: c.name,
    archetype: String(c.archetype_label || "").toUpperCase(),
    score: scoreLabel(c),
    address: c.address,
    window: `${c.pickup_window_hours}h pickup window`,
    warning: c.pickup_warning || c.margin_label,
    insecurity: pct(c.food_insecurity_rate),
    reason: c.why_them || "",
    candidate: c,
  };
}

function toSplitStop(s) {
  return {
    stop: `Stop ${s.split_stop}`,
    recipient_id: s.recipient_id,
    name: s.name,
    share: s.share_label,
    share_pallets: s.split_share_pallets,
    address: s.address,
    sms: s.draft_sms || "",
  };
}

const RULED_OUT_TAGS = {
  storage: ["No cold storage", "ac_unit", "error"],
  schedule: ["Closed today", "schedule", "outline"],
  medical: ["Medical fridge only", "medical_services", "outline"],
  conflict: ["Call to verify", "warning", "error"],
  double_match_prevented: ["Already matched", "link_off", "error"],
  filter: ["Filtered out", "block", "outline"],
};

function toRuledOut(r) {
  const [tag, icon, color] = RULED_OUT_TAGS[r.category] || RULED_OUT_TAGS.filter;
  return { name: r.name, tag, icon, color, detail: r.reason };
}

function applyLive(offer, src) {
  if (src.status_type && (src.live || !offer.local_status)) {
    offer.status = src.status_type;
    offer.status_label = src.status;
  }
  if (
    offer.status === "ready" &&
    offer.primary_match &&
    offer.primary_match.name &&
    offer.matched
  ) {
    offer.status_label = `Match ready: ${offer.primary_match.name}`;
  }
  if (src.live !== undefined) offer.live = src.live;
  const held = ((offer.live && offer.live.offers) || []).filter((o) =>
    ["sent", "accepted", "picked_up"].includes(o.status)
  );
  if (offer.live) offer.active_split_mode = held.length > 1;
}

function applyMatch(offer, data) {
  const cands = (data.all_viable_candidates || []).slice();
  const pinned = cands.findIndex((c) => c.recipient_id === offer.pinned_recipient_id);
  if (pinned > 0) cands.unshift(cands.splice(pinned, 1)[0]);
  offer.primary_match = cands.length
    ? toPrimaryMatch(cands[0], data)
    : {
        name: "Nobody left who can take it in time",
        archetype: "",
        match_score: "",
        address: "",
        reason:
          "Everyone who fits has said no or is tied up by another offer. Ask the agent to widen the search.",
        sms: "",
      };
  offer.next_options = cands.slice(1, 3).map(toStandby);
  offer.split_plan = (data.split_plan || []).map(toSplitStop);
  offer.ruled_out = (data.ruled_out || []).map(toRuledOut);
  if (data.pipeline) {
    offer.pipeline = {
      semantic: data.pipeline.found_by_meaning,
      feasible: data.pipeline.viable_count,
      recommended: data.pipeline.recommended_count,
    };
  }
  if (data.pallets != null) offer.pallets_num = Number(data.pallets);
  offer.data_source = data.data_source;
  offer.matched = true;
  applyLive(offer, data);
}

function applyQueueEntry(offer, q) {
  const donor = String(q.donor_label || "");
  offer.server_code = q.offer_code;
  offer.offer_code = String(q.offer_code || "").replace(/^OFFER\s+/i, "");
  offer.posting_id = q.posting_id;
  offer.posting_text = q.posting_text;
  offer.title = `${q.category_tag} · ${donor
    .split("·")
    .slice(0, 2)
    .map((s) => s.trim())
    .join(" · ")}`;
  offer.quote = `“${q.posting_text}”`;
  offer.donor = donor;
  offer.donor_short = donor;
  offer.category = q.category_tag;
  offer.storage = q.storage_tag;
  offer.storage_short = q.storage_tag;
  offer.pallets = q.pallets_label;
  offer.time_left = String(q.countdown_label || "").replace(/left$/i, "LEFT");
  offer.urgency_minutes = Math.round(Number(q.hours_remaining || 0) * 60);
  offer.shutoff_time = q.dock_shutoff;
  offer.brief_url = `${q.brief_url}${q.brief_url.includes("?") ? "&" : "?"}offer=${offer.key}`;
  if (!offer.matched) {
    offer.primary_match = { name: q.top_match_name || "", match_score: "", capacity_Fit: "" };
    offer.next_options = [];
    offer.split_plan = [];
    offer.ruled_out = [];
  }
  applyLive(offer, q);
}

function customPostingBody(offer) {
  return {
    posting_text: offer.posting_text,
    required_storage: offer.required_storage,
    pallets: offer.pallets_num,
    hours_remaining: Math.max(0.25, (offer.deadline_at - Date.now()) / 3600000),
  };
}

function postingRef(offer) {
  return offer.custom
    ? customPostingBody(offer)
    : { offer_key: offer.key, offer_code: offer.server_code };
}

let syncChannel = null;
try {
  if (typeof BroadcastChannel !== "undefined") {
    syncChannel = new BroadcastChannel(CHANNEL_NAME);
  }
} catch (_) {}

export let APP_STATE = null;

export function saveBrokerState(state, broadcast = true) {
  state.updated_at = new Date().toISOString();
  APP_STATE = state;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
  if (broadcast && syncChannel) {
    try {
      syncChannel.postMessage({ type: "STATE_UPDATED", state });
    } catch (_) {}
  }
}

export function loadBrokerState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.offers && parsed.offers.spinach && parsed.offers.deli) {
        return parsed;
      }
    }
  } catch (_) {}

  const initial = {
    version: 2,
    updated_at: new Date().toISOString(),
    active_zone_filter: "All Zones",
    search_query: "",
    sort_mode: "urgency",
    offers_order: ["deli", "spinach", "dairy", "bread"],
    offers: deepClone(DEFAULT_OFFERS_CATALOG),
    audit_log: SERVED
      ? []
      : [
          {
            time: "2:12 PM",
            text: "Grocer posted #ATL-8904 (40 trays blast-chilled rotisserie chicken & veg, Little Five Points).",
            type: "urgent",
          },
          {
            time: "2:06 PM",
            text: "Vector search + constraint filter matched #ATL-8842 (10 crates baby spinach) \u2192 Food Flow (98%).",
            type: "ready",
          },
          {
            time: "1:50 PM",
            text: "Dispatched SMS offer for #ATL-8828 (6 pallets dairy) to Atlanta Community Food Bank.",
            type: "awaiting",
          },
          {
            time: "1:15 PM",
            text: "Decatur Emergency Assistance Ministry accepted #ATL-8791 (150 loaves bread) \u00b7 pickup 5:15 PM.",
            type: "accepted",
          },
        ],
  };
  saveBrokerState(initial, false);
  return initial;
}

APP_STATE = loadBrokerState();

if (syncChannel) {
  syncChannel.onmessage = (event) => {
    if (event.data && event.data.type === "STATE_UPDATED" && event.data.state) {
      APP_STATE = event.data.state;
      refreshCurrentView();
    }
  };
}
window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY && e.newValue) {
    try {
      APP_STATE = JSON.parse(e.newValue);
      refreshCurrentView();
    } catch (_) {}
  }
});

export function addAuditLog(text, type = "info") {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  APP_STATE.audit_log = APP_STATE.audit_log || [];
  APP_STATE.audit_log.unshift({ time: timeStr, text, type });
  if (APP_STATE.audit_log.length > 25) {
    APP_STATE.audit_log.length = 25;
  }
}

export async function syncQueue() {
  const queue = await api("/api/queue");
  if (!queue) return false;
  (queue.offers || []).forEach((q) => {
    const offer = APP_STATE.offers[q.offer_key];
    if (offer) applyQueueEntry(offer, q);
  });
  APP_STATE.offer_state_live = (queue.offers || []).some((q) => q.live);
  APP_STATE.synced_at = new Date().toISOString();
  return true;
}

export async function syncMatch(offerKey) {
  const offer = APP_STATE.offers[offerKey];
  if (!offer) return false;
  const data = offer.custom
    ? await api("/api/match", customPostingBody(offer))
    : await api(`/api/match?offer=${encodeURIComponent(offerKey)}`);
  if (!data) return false;
  applyMatch(offer, data);
  return true;
}

export async function resync(offerKey) {
  await syncQueue();
  await syncMatch(offerKey);
  saveBrokerState(APP_STATE, true);
  refreshCurrentView();
}

function liveSignature(offer) {
  return JSON.stringify(
    ((offer && offer.live && offer.live.offers) || []).map((o) => [o.recipient_id, o.status])
  );
}

export async function poll() {
  if (document.hidden) return;
  const keys = Object.keys(APP_STATE.offers);
  const before = Object.fromEntries(keys.map((k) => [k, liveSignature(APP_STATE.offers[k])]));
  if (!(await syncQueue())) return;
  const changed = keys.filter((k) => liveSignature(APP_STATE.offers[k]) !== before[k]);
  const briefKey = isMatchBriefPage() ? getActiveOfferKey(APP_STATE.offers) : null;
  for (const k of changed) {
    if (isQueuePage() || k === briefKey) await syncMatch(k);
  }
  saveBrokerState(APP_STATE, false);
  refreshCurrentView();
}

export async function resetBrokerState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
  APP_STATE = loadBrokerState();
  if (!demoMode) {
    await syncQueue();
    await Promise.all(Object.keys(APP_STATE.offers).map(syncMatch));
  }
  addAuditLog("Cleared this browser's copy of the queue.", "info");
  saveBrokerState(APP_STATE, true);
  refreshCurrentView();
  showToast(demoMode ? "Demo state reset" : "Reloaded the queue from server.py", "restart_alt");
}

export function sourceLabel() {
  if (demoMode) return "Demo data · server.py not reachable";
  const live = Object.values(APP_STATE.offers).some((o) => o.data_source === "live_bigquery");
  return `${live ? "BigQuery a4i_food (live)" : "BigQuery snapshot"} · ${
    APP_STATE.offer_state_live ? "offers saved" : "offers not saved"
  }`;
}

export function demoNotice() {
  showToast(
    demoMode
      ? "Demo mode: server.py isn't reachable, so this stays in this browser"
      : "Not saved: server.py has no offer-state service (STATE_SERVICE_URL)",
    "cloud_off"
  );
}

export function recipientsFor(offer, statuses) {
  const hits = ((offer.live && offer.live.offers) || [])
    .filter((o) => statuses.includes(o.status))
    .map((o) => ({
      recipient_id: o.recipient_id,
      name: o.recipient_name || `Recipient #${o.recipient_id}`,
    }));
  if (hits.length) return hits;
  if (offer.active_split_mode && offer.split_plan && offer.split_plan.length) {
    return offer.split_plan.map((s) => ({ recipient_id: s.recipient_id, name: s.name }));
  }
  return [{ recipient_id: offer.primary_match.recipient_id, name: offer.primary_match.name }];
}

async function dispatchAction(route, body) {
  if (demoMode || !body.recipient_id) return "demo";
  const res = await api(`/api/dispatches/${route}`, body);
  if (!res || res.status === "unavailable") return "demo";
  if (res.status !== "ok") {
    showToast(detailText(res.detail) || "The offer-state service refused that", "error");
    return "refused";
  }
  if (res.claimed_entry && res.claimed_entry.offer_code && !APP_STATE.offers[body.offer_key]) {
    const offer = Object.values(APP_STATE.offers).find(
      (o) => o.custom && o.posting_text === body.posting_text
    );
    if (offer) offer.offer_code = res.claimed_entry.offer_code;
  }
  return "saved";
}

async function dispatchEach(route, offer, recipients, extra) {
  let outcome = "saved";
  for (const r of recipients) {
    const result = await dispatchAction(route, {
      ...postingRef(offer),
      recipient_id: r.recipient_id,
      recipient_name: r.name,
      ...(typeof extra === "function" ? extra(r) : extra),
    });
    if (result !== "saved") outcome = result;
    if (result === "refused") break;
  }
  return outcome;
}

function getClaimedRecipients(excludeOfferKey) {
  const claimed = new Map();
  Object.values(APP_STATE.offers).forEach((offer) => {
    if (offer.key === excludeOfferKey) return;
    if (offer.status === "awaiting" || offer.status === "accepted") {
      claimed.set(offer.primary_match.name, offer.offer_code);
    }
  });
  return claimed;
}

export async function markOfferSent(offerKey, customSms) {
  const offer = APP_STATE.offers[offerKey];
  if (!offer) return;
  if (customSms) {
    offer.primary_match.sms = customSms;
  }
  const pm = offer.primary_match;
  if (!demoMode && !pm.recipient_id) {
    showToast("Nobody left to send it to. Ask the agent to widen the search.", "warning");
    return;
  }
  const outcome = await dispatchEach(
    "claim",
    offer,
    [{ recipient_id: pm.recipient_id, name: pm.name }],
    {}
  );
  if (outcome === "refused") return;
  if (outcome === "saved") {
    addAuditLog(`Sent ${offer.offer_code} to ${pm.name} (awaiting reply).`, "awaiting");
    await resync(offerKey);
    showToast(
      `${offer.offer_code} offered to ${pm.name}. Others leave them out until they answer.`,
      "send"
    );
    return;
  }
  demoNotice();
  offer.local_status = true;
  offer.status = "awaiting";
  offer.active_split_mode = false;
  offer.status_label = `Offered to ${offer.primary_match.name}, awaiting reply`;
  addAuditLog(
    `Sent dispatch SMS for ${offer.offer_code} to ${offer.primary_match.name} (awaiting reply).`,
    "awaiting"
  );
  saveBrokerState(APP_STATE, true);
  refreshCurrentView();
}

export async function activateSplitPlan(offerKey) {
  const offer = APP_STATE.offers[offerKey];
  if (!offer || !offer.split_plan || offer.split_plan.length === 0) {
    showToast("No multi-stop split plan required for this load size", "info");
    return;
  }
  const combinedSms = offer.split_plan
    .map((s) => `[${s.stop} \u2014 ${s.name} (${s.share})]:\n${s.sms}`)
    .join("\n\n");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(combinedSms).catch(() => {});
  }
  const stopNames = offer.split_plan.map((s) => s.name).join(" + ");
  const outcome = await dispatchEach(
    "claim",
    offer,
    offer.split_plan.map((s) => ({
      recipient_id: s.recipient_id,
      name: s.name,
      share: s.share_pallets,
    })),
    (r) => ({ pallets_claimed: r.share })
  );
  if (outcome === "refused") return;
  if (outcome === "saved") {
    addAuditLog(`Split ${offer.offer_code} across ${stopNames} (awaiting replies).`, "awaiting");
    await resync(offerKey);
    const smsBox = document.getElementById("dispatch-sms");
    if (smsBox) smsBox.value = combinedSms;
    showToast(`Split offered to ${stopNames}. Messages copied.`, "call_split");
    return;
  }
  demoNotice();
  offer.local_status = true;
  offer.status = "awaiting";
  offer.active_split_mode = true;
  offer.status_label = `Split offered: ${stopNames} (awaiting reply)`;
  const smsBox = document.getElementById("dispatch-sms");
  if (smsBox) smsBox.value = combinedSms;
  addAuditLog(
    `Activated 2-stop split plan for ${offer.offer_code}: ${stopNames}. Both SMS messages copied.`,
    "awaiting"
  );
  saveBrokerState(APP_STATE, true);
  refreshCurrentView();
}

export async function recordDecline(offerKey) {
  const offer = APP_STATE.offers[offerKey];
  if (!offer) return;
  const who = recipientsFor(offer, ["sent", "expired"]);
  const outcome = await dispatchEach("release", offer, who, { reason: "declined" });
  if (outcome === "refused") return;
  if (outcome === "demo") {
    demoNotice();
    rotateToNextOption(offerKey, 0);
    return;
  }
  offer.pinned_recipient_id = null;
  const names = who.map((r) => r.name).join(" + ");
  addAuditLog(`${names} said no to ${offer.offer_code}.`, "ready");
  await resync(offerKey);
  showToast(`Recorded the no from ${names}. Next: ${offer.primary_match.name}`, "swap_horiz");
}

export async function switchToOption(offerKey, idx) {
  const offer = APP_STATE.offers[offerKey];
  const chosen = offer && offer.next_options && offer.next_options[idx];
  if (!chosen || !chosen.candidate) {
    rotateToNextOption(offerKey, idx);
    return;
  }
  if (offer.status === "awaiting") {
    const outcome = await dispatchEach(
      "release",
      offer,
      recipientsFor(offer, ["sent", "expired"]),
      { reason: "withdrawn" }
    );
    if (outcome === "refused") return;
  }
  offer.pinned_recipient_id = chosen.recipient_id;
  addAuditLog(`Switched ${offer.offer_code} to ${chosen.name}.`, "ready");
  if (demoMode) {
    rotateToNextOption(offerKey, idx);
    return;
  }
  await resync(offerKey);
  showToast(`Switched ${offer.offer_code} to ${chosen.name}`, "swap_horiz");
}

export function rotateToNextOption(offerKey, targetIndex = 0) {
  const offer = APP_STATE.offers[offerKey];
  if (!offer || !offer.next_options || offer.next_options.length === 0) {
    showToast("No additional standby options available", "warning");
    return;
  }
  const prevPrimary = deepClone(offer.primary_match);
  const chosen = offer.next_options.splice(targetIndex, 1)[0];

  const claimed = getClaimedRecipients(offerKey);
  const claimConflict = claimed.get(chosen.name);

  offer.primary_match = chosen.candidate
    ? toPrimaryMatch(chosen.candidate, { dock_shutoff: offer.shutoff_time })
    : {
        name: chosen.name,
        archetype: chosen.archetype || "VERIFIED RECIPIENT PANTRY",
        match_score: chosen.score || "92% Match",
        address: chosen.address || "Atlanta Metro Area",
        reason:
          chosen.reason ||
          `Promoted from Standby after ${prevPrimary.name} was unavailable. Verified cold chain and capacity fit.`,
        window: chosen.window || prevPrimary.window,
        window_note: chosen.warning || "Standby promoted to Primary",
        capacity_Fit: prevPrimary.capacity_Fit,
        equipment: prevPrimary.equipment,
        pickup_eta: prevPrimary.pickup_eta,
        buffer_mins: Math.max(30, (prevPrimary.buffer_mins || 90) - 15),
        buffer_pct: Math.max(25, (prevPrimary.buffer_pct || 65) - 10),
        warning_title: claimConflict
          ? `Notice: ${chosen.name} also has active offer ${claimConflict}`
          : prevPrimary.warning_title,
        warning_body: prevPrimary.warning_body,
        insecurity_rate: chosen.insecurity || prevPrimary.insecurity_rate,
        insecurity_note: prevPrimary.insecurity_note,
        no_vehicle_rate: prevPrimary.no_vehicle_rate,
        poverty_rate: prevPrimary.poverty_rate,
        tract_id: prevPrimary.tract_id,
        sms: `Hi ${chosen.name} team, this is the Atlanta food rescue desk. We have ${offer.pallets} of ${offer.category} (${offer.storage_short}) at ${offer.donor.split("\u00b7")[0].trim()} that must be picked up by ${offer.shutoff_time}. Can you accept this load today? Reply YES to confirm.`,
      };

  offer.next_options.push({
    rank: offer.next_options.length + 2,
    recipient_id: prevPrimary.recipient_id,
    name: prevPrimary.name,
    archetype: "PREVIOUSLY CONTACTED \u00b7 DECLINED/UNAVAILABLE",
    score: prevPrimary.match_score,
    address: String(prevPrimary.address || "").split("\u00b7")[0].trim(),
    window: prevPrimary.window,
    warning: "Rotated to standby",
    insecurity: prevPrimary.insecurity_rate,
    reason: prevPrimary.reason,
  });

  offer.local_status = true;
  offer.status = "ready";
  offer.active_split_mode = false;
  offer.status_label = `Match ready: ${offer.primary_match.name}`;

  addAuditLog(
    `${prevPrimary.name} unavailable for ${offer.offer_code} \u2192 Promoted ${offer.primary_match.name} (${offer.primary_match.match_score}).`,
    "ready"
  );
  saveBrokerState(APP_STATE, true);
  refreshCurrentView();
  showToast(
    `Promoted ${offer.primary_match.name} (${offer.primary_match.match_score}) to Primary Match`,
    "swap_horiz"
  );
}

export async function markOfferAccepted(offerKey) {
  const offer = APP_STATE.offers[offerKey];
  if (!offer) return;
  const who = recipientsFor(offer, ["sent", "expired"]);
  const recipientName = who.map((r) => r.name).join(" + ");
  const outcome = await dispatchEach("claim", offer, who, { status: "accepted" });
  if (outcome === "refused") return;
  if (outcome === "saved") {
    addAuditLog(`${recipientName} accepted ${offer.offer_code}.`, "accepted");
    await resync(offerKey);
    showToast(`${offer.offer_code} accepted by ${recipientName}`, "check_circle");
    return;
  }
  demoNotice();
  offer.local_status = true;
  offer.status = "accepted";
  offer.driver_status = "requested";
  offer.status_label = `Accepted by ${recipientName} \u00b7 pickup ${offer.shutoff_time}`;
  addAuditLog(`${recipientName} accepted ${offer.offer_code} (${offer.pallets}).`, "accepted");
  saveBrokerState(APP_STATE, true);
  refreshCurrentView();
}

export async function markOfferDonated(offerKey) {
  const offer = APP_STATE.offers[offerKey];
  if (!offer) return;
  const who = recipientsFor(offer, ["accepted"]);
  const recipientName = who.map((r) => r.name).join(" + ");
  const outcome = await dispatchEach("claim", offer, who, { status: "picked_up" });
  if (outcome === "refused") return;
  if (outcome === "saved") {
    addAuditLog(`${offer.offer_code} picked up by ${recipientName}.`, "donated");
    await resync(offerKey);
    showToast(`${offer.offer_code} picked up by ${recipientName}`, "verified");
    return;
  }
  demoNotice();
  offer.local_status = true;
  offer.status = "donated";
  offer.driver_status = "delivered";
  offer.time_left = "COMPLETED";
  offer.status_label = `Donated to ${recipientName} \u00b7 verified delivery`;
  addAuditLog(
    `COMPLETED: ${offer.offer_code} (${offer.pallets}) delivered & donated to ${recipientName}.`,
    "donated"
  );
  saveBrokerState(APP_STATE, true);
  refreshCurrentView();
}

export async function createNewSurplusOffer(fields) {
  if (demoMode) return createDemoSurplusOffer(fields);
  const { donorName, neighborhood, zone, category, quote, palletsNum, storage, deadlineHours } =
    fields;
  const key = "custom_" + Date.now().toString(36);
  const text = String(quote)
    .replace(/^["“]|["”]$/g, "")
    .trim();
  const mins = Math.round((parseFloat(deadlineHours) || 4) * 60);
  const deadline = new Date(Date.now() + mins * 60000);
  const requiredStorage = /frozen/i.test(storage)
    ? "frozen"
    : /refrigerat|cold|cooler/i.test(storage)
    ? "refrigerated"
    : "shelf-stable";
  const offer = {
    key,
    custom: true,
    offer_code: "NEW",
    title: `${category} · ${donorName} · ${neighborhood}`,
    quote: `“${text}”`,
    donor: `${donorName} · ${neighborhood} · Posted just now`,
    donor_short: `${donorName} · ${neighborhood}`,
    zone: zone || "Midtown",
    category,
    storage,
    storage_short:
      requiredStorage === "shelf-stable"
        ? "Shelf-stable"
        : requiredStorage === "frozen"
        ? "Frozen"
        : "Refrigerated",
    pallets: `${palletsNum} pallet${palletsNum === 1 ? "" : "s"}`,
    pallets_num: palletsNum,
    posting_text: text,
    required_storage: requiredStorage,
    deadline_at: deadline.getTime(),
    time_left: `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m LEFT`,
    urgency_minutes: mins,
    shutoff_time: deadline.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    status: "ready",
    status_label: "Match ready",
    brief_url: `match-brief-spinach.html?offer=${key}`,
    primary_match: { name: "" },
    next_options: [],
    split_plan: [],
    ruled_out: [],
  };
  APP_STATE.offers[key] = offer;
  if (!(await syncMatch(key))) {
    delete APP_STATE.offers[key];
    showToast("server.py couldn't rank that posting. Try again.", "error");
    return null;
  }
  if (offer.status === "ready") offer.status_label = `Match ready: ${offer.primary_match.name}`;
  APP_STATE.offers_order.unshift(key);
  addAuditLog(
    `New posting from ${donorName}: ranked, top match ${offer.primary_match.name}.`,
    "ready"
  );
  saveBrokerState(APP_STATE, true);
  return offer;
}

function createDemoSurplusOffer({
  donorName,
  neighborhood,
  zone,
  category,
  quote,
  palletsNum,
  storage,
  deadlineHours,
}) {
  const key = "custom_" + Date.now().toString(36);
  const codeNum = Math.floor(8910 + Math.random() * 90);
  const offerCode = `#ATL-${codeNum}`;
  const isCold = /refrigerat|cold|cooler|frozen|36|38/i.test(storage);
  const hrs = parseFloat(deadlineHours) || 4;
  const mins = Math.round(hrs * 60);
  const hPart = Math.floor(mins / 60);
  const mPart = mins % 60;

  const baseTemplate =
    palletsNum >= 5
      ? deepClone(DEFAULT_OFFERS_CATALOG.dairy)
      : isCold
      ? deepClone(DEFAULT_OFFERS_CATALOG.spinach)
      : deepClone(DEFAULT_OFFERS_CATALOG.bread);

  const newOffer = {
    ...baseTemplate,
    key,
    id: `SP-ATL-${codeNum}`,
    offer_code: offerCode,
    title: `${category} \u00b7 ${donorName} \u00b7 ${neighborhood}`,
    quote: `\u201c${quote.replace(/^["\u201c]|["\u201d]$/g, "")}\u201d`,
    donor: `${donorName} \u00b7 ${neighborhood} \u00b7 Posted just now`,
    donor_short: `Grocery store \u00b7 ${neighborhood} \u00b7 ${palletsNum} pallet${
      palletsNum > 1 ? "s" : ""
    }`,
    zone: zone || "Midtown",
    category,
    storage: storage || "Refrigerated (38\u00b0F)",
    storage_short: isCold ? "Refrigerated" : "Shelf-stable",
    pallets: `${palletsNum} Pallet${palletsNum > 1 ? "s" : ""}`,
    pallets_num: palletsNum,
    time_left: `${hPart}h ${mPart < 10 ? "0" + mPart : mPart}m LEFT`,
    urgency_minutes: mins,
    shutoff_time: "7:30 PM",
    status: "ready",
    status_label: `Match ready: ${baseTemplate.primary_match.name}`,
    driver_status: "unassigned",
    brief_url: `match-brief-spinach.html?offer=${key}`,
  };

  newOffer.primary_match.sms = `Hi ${newOffer.primary_match.name} team, this is the Atlanta food rescue desk. ${donorName} (${neighborhood}) just posted: "${quote}" (${palletsNum} pallet${palletsNum > 1 ? "s" : ""}, ${newOffer.storage_short}). Can you collect within ${hrs} hours? Reply YES to confirm.`;

  APP_STATE.offers[key] = newOffer;
  APP_STATE.offers_order.unshift(key);
  addAuditLog(
    `New surplus posted: ${offerCode} (${category}, ${palletsNum} pallets at ${donorName}) \u2192 Matched with ${newOffer.primary_match.name}.`,
    "ready"
  );
  saveBrokerState(APP_STATE, true);
  return newOffer;
}
