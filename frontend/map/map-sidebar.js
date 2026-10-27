/**
 * @module map/map-sidebar
 * Reusable sidebar inspector component for Surplus Postings and Matching Recipients.
 * Uses `DocumentFragment`, delegated DOM events, and `CustomEvent` dispatching.
 */

import {
  buildGoogleMapsUrl,
  formatHours,
  formatRecipientSubtitle,
  resolveRecipientTheme,
} from "./map-api.js";

export class MapSidebarView extends EventTarget {
  #postingsEl;
  #recipientsEl;
  #countEl;
  #headingEl;
  #clearBtn;

  constructor({ postingsEl, recipientsEl, countEl, headingEl, clearBtn }) {
    super();
    this.#postingsEl = postingsEl;
    this.#recipientsEl = recipientsEl;
    this.#countEl = countEl;
    this.#headingEl = headingEl;
    this.#clearBtn = clearBtn;
    this.#bindDelegatedEvents();
  }

  #bindDelegatedEvents() {
    this.#postingsEl?.addEventListener("click", (e) => {
      const card = e.target.closest("[data-posting-id]");
      if (!card) return;
      this.dispatchEvent(
        new CustomEvent("posting-select", {
          detail: { postingId: card.dataset.postingId },
        })
      );
    });

    this.#recipientsEl?.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const card = e.target.closest("[data-recipient-id]");
      if (!card) return;
      this.dispatchEvent(
        new CustomEvent("recipient-focus", {
          detail: { recipientId: Number(card.dataset.recipientId) },
        })
      );
    });

    this.#clearBtn?.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("posting-select", { detail: { postingId: "" } })
      );
    });
  }

  render(data, visibleRecipients) {
    const postings = data.postings ?? [];
    const recipients = visibleRecipients ?? data.recipients ?? [];
    const selectedPosting = data.selected_posting ?? null;

    if (this.#clearBtn) {
      this.#clearBtn.classList.toggle("hidden", !selectedPosting);
    }
    if (this.#countEl) {
      this.#countEl.textContent = `${postings.length} post${postings.length === 1 ? "" : "s"} · ${recipients.length} org${recipients.length === 1 ? "" : "s"}`;
    }
    if (this.#headingEl) {
      this.#headingEl.textContent = selectedPosting
        ? `Recipients for Posting #${selectedPosting.posting_id} (${recipients.length})`
        : `Matching Recipients (${recipients.length})`;
    }

    this.#renderPostings(
      selectedPosting ? [selectedPosting] : postings,
      selectedPosting
    );
    this.#renderRecipients(recipients);
  }

  #renderPostings(postings, selectedPosting) {
    if (!this.#postingsEl) return;
    if (postings.length === 0) {
      const empty = document.createElement("div");
      empty.className =
        "p-2.5 rounded bg-surface border border-outline-variant text-xs text-on-surface-variant";
      empty.textContent = "No surplus postings match this filter.";
      this.#postingsEl.replaceChildren(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const p of postings) {
      const isSelected =
        selectedPosting &&
        String(selectedPosting.posting_id) === String(p.posting_id);
      const hrs = Number(p.hours_remaining ?? p.hours_available ?? 0);
      const palText =
        p.unclaimed_pallets != null
          ? `${p.unclaimed_pallets}p unclaimed`
          : p.pallets
          ? `${p.pallets}p`
          : "";

      const card = document.createElement("div");
      card.className = "posting-card space-y-1";
      card.dataset.postingId = String(p.posting_id);
      card.dataset.selected = isSelected ? "true" : "false";

      const topRow = document.createElement("div");
      topRow.className = "flex items-center justify-between gap-2";

      const leftMeta = document.createElement("div");
      leftMeta.className = "flex items-center gap-1.5";

      const idSpan = document.createElement("span");
      idSpan.className = "font-mono text-[10.5px] font-bold text-primary";
      idSpan.textContent = `#${p.posting_id} · ${p.track}`;

      const stBadge = document.createElement("span");
      stBadge.className =
        p.storage_state === "refrigerated"
          ? "bg-blue-50 text-blue-800 border border-blue-200 px-1.5 py-0.2 rounded font-mono text-[10px]"
          : "bg-surface-container text-on-surface-variant px-1.5 py-0.2 rounded font-mono text-[10px]";
      stBadge.textContent = p.storage_state;

      leftMeta.append(idSpan, stBadge);

      const clockSpan = document.createElement("span");
      clockSpan.className = `font-mono text-[10.5px] font-semibold ${hrs <= 6 ? "text-error" : "text-on-surface-variant"}`;
      clockSpan.textContent = `${formatHours(hrs)} left${palText ? ` · ${palText}` : ""}`;

      topRow.append(leftMeta, clockSpan);

      const quote = document.createElement("div");
      quote.className = "text-xs font-medium text-on-surface leading-snug";
      quote.textContent = `“${p.posting_text}”`;

      card.append(topRow, quote);
      frag.append(card);
    }

    this.#postingsEl.replaceChildren(frag);
  }

  #renderRecipients(recipients) {
    if (!this.#recipientsEl) return;
    if (recipients.length === 0) {
      const empty = document.createElement("div");
      empty.className =
        "p-3 rounded bg-surface border border-outline-variant text-xs text-on-surface-variant";
      empty.textContent =
        "No recipients match this surplus & recipient filter.";
      this.#recipientsEl.replaceChildren(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const r of recipients) {
      const theme = resolveRecipientTheme(r);
      const statusKey =
        !r.viable || r.status_category === "ruled_out"
          ? "ruled_out"
          : r.status_category || "viable";

      const card = document.createElement("div");
      card.className = "recipient-card space-y-1";
      card.dataset.recipientId = String(r.recipient_id);

      const topRow = document.createElement("div");
      topRow.className = "flex items-center justify-between gap-2";

      const nameEl = document.createElement("span");
      nameEl.className = "text-xs font-bold text-on-surface truncate";
      nameEl.textContent = r.name;

      const badgeEl = document.createElement("span");
      badgeEl.className = "broker-badge shrink-0";
      badgeEl.dataset.status = statusKey;
      badgeEl.textContent = theme.badge;

      topRow.append(nameEl, badgeEl);

      const subRow = document.createElement("div");
      subRow.className = `text-[11.5px] truncate ${r.ruled_out_reason ? "text-error font-medium" : "text-on-surface-variant"}`;
      subRow.textContent = formatRecipientSubtitle(r);

      const bottomRow = document.createElement("div");
      bottomRow.className =
        "flex items-center justify-between text-[11px] text-outline pt-0.5";

      const addrEl = document.createElement("span");
      addrEl.className = "truncate";
      addrEl.textContent = r.address;

      const gmapsLink = document.createElement("a");
      gmapsLink.href = buildGoogleMapsUrl(r);
      gmapsLink.target = "_blank";
      gmapsLink.rel = "noopener";
      gmapsLink.className =
        "text-primary hover:underline font-semibold shrink-0 ml-2";
      gmapsLink.textContent = "Google Maps ↗";

      bottomRow.append(addrEl, gmapsLink);
      card.append(topRow, subRow, bottomRow);
      frag.append(card);
    }

    this.#recipientsEl.replaceChildren(frag);
  }
}
