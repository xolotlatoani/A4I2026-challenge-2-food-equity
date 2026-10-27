/**
 * @module console/ui-utils
 * Shared DOM helpers, HTML escaping, modals, toast notifications, and page route checks.
 */

export function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function pct(rate) {
  return rate == null || rate === "" ? "" : `${(Number(rate) * 100).toFixed(1)}%`;
}

export function scoreLabel(c) {
  return `Tier ${c.tier} · score ${Number(c.score || 0).toFixed(2)}`;
}

export function detailText(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  return detail.message || JSON.stringify(detail);
}

export function isQueuePage() {
  const p = window.location.pathname.toLowerCase();
  return p.endsWith("queue.html") || p.endsWith("/frontend/") || p === "/" || p === "";
}

export function isMatchBriefPage() {
  const p = window.location.pathname.toLowerCase();
  return p.includes("match-brief-spinach") || p.includes("match-brief-deli");
}

export function getActiveOfferKey(offersMap) {
  const params = new URLSearchParams(window.location.search);
  const paramOffer = (params.get("offer") || "").toLowerCase();
  if (paramOffer && offersMap && offersMap[paramOffer]) {
    return paramOffer;
  }
  const p = window.location.pathname.toLowerCase();
  if (p.includes("match-brief-deli")) return "deli";
  if (p.includes("match-brief-spinach")) return "spinach";
  return "spinach";
}

export function showModal(title, bodyHtml) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.id = "broker-modal-overlay";
  overlay.className =
    "fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant rounded-lg max-w-xl w-full shadow-2xl overflow-hidden">
      <div class="px-5 py-3.5 bg-surface-container border-b border-outline-variant flex items-center justify-between">
        <h3 class="font-bold text-sm text-on-surface">${escapeHtml(title)}</h3>
        <button id="broker-modal-close" class="text-on-surface-variant hover:text-on-surface cursor-pointer">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
      <div class="p-5">${bodyHtml}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById("broker-modal-close")?.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
}

export function closeModal() {
  const existing = document.getElementById("broker-modal-overlay");
  if (existing) existing.remove();
}

export function showToast(message, icon = "check_circle") {
  const existing = document.getElementById("broker-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "broker-toast";
  toast.className =
    "fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-on-surface text-surface px-4 py-2.5 rounded shadow-xl flex items-center gap-2 text-xs font-semibold border border-outline-variant";
  toast.innerHTML = `
    <span class="material-symbols-outlined text-emerald-400 text-base">${escapeHtml(icon)}</span>
    <span>${escapeHtml(message)}</span>
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 3600);
}
