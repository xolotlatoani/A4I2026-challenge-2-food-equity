/**
 * @module map/map-api
 * Data client (`GET /map/data`, `/map/postings`, `/map/recipients`, `/map/match/{id}`),
 * instant client-side recipient filter helper, and formatting utilities.
 */

const pctFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0,
});

const hoursFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

export const STORAGE_LABELS = Object.freeze({
  vehicle: "Refrigerated van",
  "walk-in": "Walk-in cooler",
  commercial: "Commercial kitchen fridge",
  domestic: "Household fridge",
  medical: "Medical fridge only",
  none: "No refrigeration",
});

export const PIN_THEMES = Object.freeze({
  ruled_out: Object.freeze({
    color: "#ba1a1a",
    bg: "#ffdad6",
    badge: "Ruled Out",
  }),
  split_partner: Object.freeze({
    color: "#d97706",
    bg: "#fef3c7",
    badge: "Split Stop",
  }),
  recommended: Object.freeze({
    color: "#006032",
    bg: "#dcfce7",
    badge: "Top Match",
  }),
  viable: Object.freeze({
    color: "#005e57",
    bg: "#e0f2fe",
    badge: "Viable",
  }),
});

/**
 * Resolve the visual theme and badge label for a recipient record.
 * @param {object} recipient
 */
export function resolveRecipientTheme(recipient) {
  if (!recipient.viable || recipient.status_category === "ruled_out") {
    return PIN_THEMES.ruled_out;
  }
  if (recipient.status_category === "split_partner") {
    return PIN_THEMES.split_partner;
  }
  if (recipient.status_category === "recommended") {
    return {
      ...PIN_THEMES.recommended,
      badge: recipient.rank
        ? `#${recipient.rank} Match`
        : STORAGE_LABELS[recipient.cold_storage] ?? "Top Match",
    };
  }
  return {
    ...PIN_THEMES.viable,
    badge: recipient.rank
      ? `#${recipient.rank} Viable`
      : STORAGE_LABELS[recipient.cold_storage] ?? "Viable",
  };
}

export function formatPercent(rate) {
  return rate != null && Number.isFinite(Number(rate))
    ? pctFormatter.format(Number(rate))
    : "";
}

export function formatHours(hours) {
  return hours != null && Number.isFinite(Number(hours))
    ? `${hoursFormatter.format(Number(hours))}h`
    : "—";
}

export function buildGoogleMapsUrl({ address, latitude, longitude }) {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", address || `${latitude},${longitude}`);
  return url.toString();
}

export function formatRecipientSubtitle(r) {
  if (r.ruled_out_reason) {
    return r.ruled_out_reason;
  }
  const storageText = STORAGE_LABELS[r.cold_storage] ?? r.cold_storage;
  const winText = r.can_self_collect
    ? `Collects in ${r.pickup_window_hours}h`
    : `${r.pickup_window_hours}h window (needs driver)`;
  const povText = r.poverty_rate != null ? `${formatPercent(r.poverty_rate)} poverty` : "";
  return [storageText, `${r.max_pallets}p max`, winText, povText]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Filter already-fetched `all_recipients` in <1ms when switching recipient preset pills or search.
 * @param {Array<object>} allRecipients
 * @param {object} options
 */
export function filterRecipientsClientSide(allRecipients = [], { preset = "recommended", q = "" } = {}) {
  const pf = (preset || "recommended").toLowerCase();
  let filtered = allRecipients;

  if (pf === "recommended") {
    filtered = filtered.filter((r) =>
      r.status_category === "recommended" || r.status_category === "split_partner"
    );
  } else if (pf === "self_collect") {
    filtered = filtered.filter((r) => r.viable && r.can_self_collect);
  } else if (pf === "real_cold") {
    filtered = filtered.filter(
      (r) =>
        ["walk-in", "commercial", "vehicle"].includes(r.cold_storage) && r.viable
    );
  } else if (pf === "split_partner") {
    filtered = filtered.filter(
      (r) => r.status_category === "split_partner" && r.viable
    );
  } else if (pf === "high_need") {
    filtered = filtered.filter(
      (r) => (r.need_score ?? 0) >= 0.7 && r.viable
    );
  } else if (pf === "ruled_out") {
    filtered = filtered.filter(
      (r) => !r.viable || r.status_category === "ruled_out"
    );
  }

  const ql = (q || "").trim().toLowerCase();
  if (ql) {
    filtered = filtered.filter(
      (r) =>
        r.name.toLowerCase().includes(ql) ||
        r.address.toLowerCase().includes(ql) ||
        (r.zip_code || "").toLowerCase().includes(ql) ||
        (r.cold_storage || "").toLowerCase().includes(ql) ||
        (r.archetype_label || "").toLowerCase().includes(ql)
    );
  }

  return filtered;
}

/**
 * Stateful API client calling `/map/data` with automatic `AbortController` cancellation.
 */
export class MapApiClient {
  #apiBase;
  #activeController = null;

  constructor(apiBase = "") {
    this.#apiBase =
      apiBase ||
      document.querySelector('meta[name="broker-api-base"]')?.content ||
      "";
  }

  async fetchMapData({ track = "RETAIL", storageFilter = "all", postingId = "", preset = "recommended", q = "" } = {}) {
    this.#activeController?.abort();
    const controller = new AbortController();
    this.#activeController = controller;

    const signal =
      typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)])
        : controller.signal;

    const params = new URLSearchParams({
      track,
      storage_filter: storageFilter,
      preset,
      q,
    });
    if (postingId) {
      params.set("posting_id", String(postingId));
    }

    const response = await fetch(`${this.#apiBase}/map/data?${params.toString()}`, {
      signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from /map/data`);
    }
    return await response.json();
  }

  abort() {
    this.#activeController?.abort();
    this.#activeController = null;
  }
}
