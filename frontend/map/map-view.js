/**
 * @module map/map-view
 * Reusable interactive map component (`BrokerMapView` and `<broker-map>` Custom Element).
 * Uses `ResizeObserver`, `CustomEvent`, and safe DOM construction (zero inline styles).
 */

import {
  STORAGE_LABELS,
  buildGoogleMapsUrl,
  formatPercent,
  resolveRecipientTheme,
} from "./map-api.js";

export class BrokerMapView extends EventTarget {
  #container;
  #leafletMap = null;
  #layerGroup = null;
  #markersById = new Map();
  #resizeObserver = null;

  constructor(container, { center = [33.755, -84.388], zoom = 11 } = {}) {
    super();
    this.#container = container;
    this.#initMap(center, zoom);
  }

  #initMap(center, zoom) {
    const L = window.L;
    if (!L || !this.#container) return;

    this.#leafletMap = L.map(this.#container, {
      center,
      zoom,
      zoomControl: true,
    });

    const googleRoads = L.tileLayer(
      "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
      {
        maxZoom: 20,
        attribution: "Map data &copy; Google Maps",
      }
    );
    const osm = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }
    );

    googleRoads.addTo(this.#leafletMap);
    L.control
      .layers(
        { "Google Maps": googleRoads, OpenStreetMap: osm },
        {},
        { position: "topright" }
      )
      .addTo(this.#leafletMap);

    this.#layerGroup = L.layerGroup().addTo(this.#leafletMap);

    if (typeof ResizeObserver === "function") {
      this.#resizeObserver = new ResizeObserver(() => {
        this.#leafletMap?.invalidateSize();
      });
      this.#resizeObserver.observe(this.#container);
    }
  }

  #createPopupNode(r, theme) {
    const statusKey =
      !r.viable || r.status_category === "ruled_out"
        ? "ruled_out"
        : r.status_category || "viable";

    const root = document.createElement("div");
    root.className = "broker-popup";

    const eyebrow = document.createElement("div");
    eyebrow.className = "broker-popup__eyebrow";
    eyebrow.dataset.status = statusKey;
    eyebrow.textContent = `${theme.badge} · Tract ${r.tract_geo_id || "—"}`;

    const title = document.createElement("div");
    title.className = "broker-popup__title";
    title.textContent = r.name;

    const addr = document.createElement("div");
    addr.className = "broker-popup__address";
    addr.textContent = r.address;

    root.append(eyebrow, title, addr);

    if (r.ruled_out_reason) {
      const errBox = document.createElement("div");
      errBox.className = "broker-popup__reason-error";
      errBox.textContent = r.ruled_out_reason;
      root.append(errBox);
    } else {
      const metaBox = document.createElement("div");
      metaBox.className = "broker-popup__meta-box";

      const capLine = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = STORAGE_LABELS[r.cold_storage] ?? r.cold_storage;
      capLine.append(
        strong,
        ` · up to ${r.max_pallets} pallet(s) · ${r.pickup_window_hours}h window`
      );
      metaBox.append(capLine);

      const pov = formatPercent(r.poverty_rate);
      const noCar = formatPercent(r.no_vehicle_rate);
      const equityParts = [
        pov ? `${pov} poverty` : "",
        noCar ? `${noCar} no car` : "",
      ].filter(Boolean);

      if (equityParts.length > 0) {
        const eqLine = document.createElement("div");
        eqLine.className = "broker-popup__equity";
        eqLine.textContent = `Neighborhood: ${equityParts.join(" · ")}`;
        metaBox.append(eqLine);
      }

      root.append(metaBox);
    }

    const cta = document.createElement("a");
    cta.className = "broker-popup__cta";
    cta.href = buildGoogleMapsUrl(r);
    cta.target = "_blank";
    cta.rel = "noopener";
    cta.textContent = "Open in Google Maps ↗";
    root.append(cta);

    return root;
  }

  setRecipients(recipients = []) {
    const L = window.L;
    if (!L || !this.#leafletMap || !this.#layerGroup) return;

    this.#layerGroup.clearLayers();
    this.#markersById.clear();
    const bounds = [];

    for (const r of recipients) {
      if (r.latitude == null || r.longitude == null) continue;
      const theme = resolveRecipientTheme(r);
      const statusKey =
        !r.viable || r.status_category === "ruled_out"
          ? "ruled_out"
          : r.status_category || "viable";
      const isTop =
        r.status_category === "recommended" ||
        r.status_category === "split_partner";
      const size = isTop ? 22 : 16;

      const marker = L.marker([r.latitude, r.longitude], {
        zIndexOffset: isTop ? 500 : 100,
        icon: L.divIcon({
          className: "clean-recipient-pin",
          html: `<div class="broker-pin ${isTop ? "broker-pin--top" : ""}" data-status="${statusKey}"></div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
          popupAnchor: [0, -size / 2],
        }),
      });

      marker.bindPopup(this.#createPopupNode(r, theme), { maxWidth: 290 });
      marker.on("click", () => {
        this.dispatchEvent(new CustomEvent("recipient-select", { detail: r }));
      });

      this.#layerGroup.addLayer(marker);
      this.#markersById.set(Number(r.recipient_id), { marker, record: r });
      bounds.push([r.latitude, r.longitude]);
    }

    if (bounds.length > 1) {
      this.#leafletMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 13 });
    } else if (bounds.length === 1) {
      this.#leafletMap.setView(bounds[0], 13);
    }
  }

  focusRecipient(recipientId) {
    const entry = this.#markersById.get(Number(recipientId));
    if (!entry || !this.#leafletMap) return;
    const { marker, record } = entry;
    this.#leafletMap.setView([record.latitude, record.longitude], 14, {
      animate: true,
    });
    marker.openPopup();
  }

  destroy() {
    this.#resizeObserver?.disconnect();
    this.#leafletMap?.remove();
    this.#leafletMap = null;
  }
}

export class BrokerMapElement extends HTMLElement {
  #mapView = null;

  connectedCallback() {
    if (!this.#mapView) {
      this.style.display = "block";
      this.#mapView = new BrokerMapView(this);
    }
  }

  disconnectedCallback() {
    this.#mapView?.destroy();
    this.#mapView = null;
  }

  get mapView() {
    return this.#mapView;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("broker-map")) {
  customElements.define("broker-map", BrokerMapElement);
}
