/**
 * Atlanta Food Rescue — Surplus Broker Interactive Controller (Phase 1 + State Engine)
 * Connects the Google Stitch Coordinator Console (queue.html, match-brief-spinach.html,
 * match-brief-deli.html) and role views (grocer-post.html, pantry-offer.html, driver-request.html)
 * to real Atlanta BigQuery data (a4i_food), cross-tab stateful persistence, and the live
 * Cloud Run ADK Agent (https://food-rescue-agent-2u2wh53apa-uc.a.run.app).
 */
(function () {
  "use strict";

  const CLOUD_RUN_AGENT_URL = "https://food-rescue-agent-2u2wh53apa-uc.a.run.app";
  const STORAGE_KEY = "surplus_broker_state_v2";
  const CHANNEL_NAME = "surplus_broker_sync_v2";

  // ---------------------------------------------------------------------------
  // 1. REAL BIGQUERY DATA CATALOG (qwiklabs-gcp-04-ef48e08bc216.a4i_food)
  // ---------------------------------------------------------------------------
  const DEFAULT_OFFERS_CATALOG = {
    deli: {
      key: "deli",
      id: "SP-ATL-004",
      offer_code: "#ATL-8904",
      title: "Deli · Grocery store · Little Five Points",
      quote:
        "\u201cClosing deli counter has 40 trays of assorted rotisserie chicken and roasted vegetables, hot-held until 45 minutes ago, now blast-chilled to 38F. Needs immediate pickup within 2 hours.\u201d",
      donor: "Moreland Ave Market \u00b7 Little Five Points \u00b7 Posted 12 mins ago",
      donor_short: "Grocery store \u00b7 Little Five Points \u00b7 2 pallets",
      zone: "Downtown",
      category: "Prepared Meals",
      storage: "Refrigerated (38\u00b0F)",
      storage_short: "Refrigerated",
      pallets: "2 Pallets (40 Trays)",
      pallets_num: 2,
      time_left: "1h 30m LEFT",
      urgency_minutes: 90,
      shutoff_time: "3:45 PM",
      status: "urgent",
      status_label: "Needs a match",
      driver_status: "unassigned",
      driver_name: "Marcus V.",
      brief_url: "match-brief-deli.html?offer=deli",
      pipeline: { semantic: 60, feasible: 14, recommended: 3 },
      primary_match: {
        name: "Sweet Auburn Rescue Mobile",
        archetype: "MOBILE PANTRY \u00b7 HOT/CHILLED PREPARED",
        match_score: "96% Match",
        address: "320 Irwin St NE, Atlanta, GA 30312 \u00b7 1.4 mi from donor",
        reason:
          "Operates an insulated refrigerated sprinter van 1.4 miles from Little Five Points with immediate hot/chilled meal distribution in Sweet Auburn (34.2% poverty rate, 29.8% no-vehicle households). Can arrive in 25 minutes\u2014well inside the strict 2-hour blast-chilled safety window.",
        window: "12:00 PM \u2013 6:00 PM",
        window_note: "Rapid mobile dispatch team on standby",
        capacity_Fit: "Fits 3 pallets (100% of load)",
        equipment: "Insulated Refrigerated Van + Cambro Carriers",
        pickup_eta: "2:40 PM (25 mins)",
        buffer_mins: 65,
        buffer_pct: 68,
        warning_title: "Strict 2-Hour Prepared Food Safety Window (USDA FoodKeeper)",
        warning_body:
          "Blast-chilled rotisserie chicken and roasted vegetables at 38\u00b0F must be transferred to continuous cold chain before 3:45 PM. Sweet Auburn Rescue Mobile's 25-minute ETA leaves a 1h 05m safety margin.",
        insecurity_rate: "31.4%",
        insecurity_note: "Above metro avg (12.8%)",
        no_vehicle_rate: "29.8%",
        poverty_rate: "34.2%",
        tract_id: "13121003500",
        sms: "Hi Sweet Auburn Rescue Mobile team, this is the Atlanta food rescue desk. Moreland Ave Market in Little Five Points has 40 trays (2 pallets) of blast-chilled rotisserie chicken & roasted vegetables (38F) that must be picked up by 3:45 PM. Your refrigerated van is 1.4 mi away. Can you dispatch now for pickup by 2:45 PM? Reply YES to confirm.",
      },
      split_plan: [],
      next_options: [
        {
          rank: 2,
          name: "Peachtree Street Fridge Network",
          archetype: "COMMUNITY FRIDGE NETWORK",
          score: "89% Match",
          address: "450 Edgewood Ave SE \u00b7 1.9 mi away",
          window: "10:00 AM \u2013 8:00 PM",
          warning: "45m margin (Tight)",
          insecurity: "27.1%",
          reason:
            "Commercial glass-door reach-in coolers across 3 Edgewood/Old Fourth Ward locations can absorb all 40 single-serve trays immediately.",
        },
        {
          rank: 3,
          name: "Grant Park Pantry Network",
          archetype: "NEIGHBORHOOD PANTRY",
          score: "84% Match",
          address: "515 Boulevard SE \u00b7 2.3 mi away",
          window: "1:00 PM \u2013 5:00 PM",
          warning: "35m margin",
          insecurity: "22.6%",
          reason:
            "Walk-in cooler available and volunteer driver on shift, though slightly further south than Sweet Auburn Rescue Mobile.",
        },
      ],
      ruled_out: [
        {
          name: "Harborview Neighbors Trust",
          tag: "Contradictory Profile",
          detail:
            "Claims walk-in freezer in sentence 1, but states 'single cupboard shelf, no freezer or cooler' in sentence 2 (Tier-0 Integrity Block)",
          icon: "warning",
          color: "error",
        },
        {
          name: "Greenline Community Pantry",
          tag: "No Cold Storage",
          detail: "Cold storage = 'none' (Planted semantic decoy \u00b7 0.214 cosine distance)",
          icon: "ac_unit",
          color: "error",
        },
        {
          name: "Westside Table Cooperative",
          tag: "Pickup Too Slow",
          detail: "Requires 3.5h notice > 1.5h remaining shelf-life window",
          icon: "schedule",
          color: "error",
        },
        {
          name: "Buckhead Parish Cupboard",
          tag: "Dry Goods Only",
          detail: "Cannot accept prepared/blast-chilled trays",
          icon: "block",
          color: "outline",
        },
        {
          name: "Kirkwood Youth Meal Site",
          tag: "Closed Now",
          detail: "Receiving window closes at 1:30 PM on weekdays",
          icon: "door_front",
          color: "outline",
        },
      ],
    },

    spinach: {
      key: "spinach",
      id: "SP-ATL-001",
      offer_code: "#ATL-8842",
      title: "Spinach \u00b7 Grocery store \u00b7 Midtown",
      quote:
        "\u201c10 crates of triple-washed baby spinach, harvested yesterday, walk-in cooler failed two hours ago. Must leave dock by 8pm.\u201d",
      donor: "Midtown Fresh Market \u00b7 Midtown \u00b7 Posted 18 mins ago",
      donor_short: "Grocery store \u00b7 Midtown \u00b7 2 pallets",
      zone: "Midtown",
      category: "Produce (Leafy Greens)",
      storage: "Refrigerated (Cold Chain Required)",
      storage_short: "Refrigerated",
      pallets: "10 Crates (2 Pallets)",
      pallets_num: 2,
      time_left: "5h 50m LEFT",
      urgency_minutes: 350,
      shutoff_time: "8:10 PM",
      status: "ready",
      status_label: "Match ready: Food Flow",
      driver_status: "requested",
      driver_name: "Marcus V.",
      brief_url: "match-brief-spinach.html?offer=spinach",
      pipeline: { semantic: 60, feasible: 20, recommended: 3 },
      primary_match: {
        name: "Food Flow",
        archetype: "MOBILE RESCUE HUB \u00b7 PRODUCE",
        match_score: "98% Match",
        address: "712 Peachtree St NE, Atlanta, GA 30308 \u00b7 1.2 mi from donor",
        reason:
          "Food Flow is a high-velocity produce rescue hub in Midtown with a refrigerated box truck and walk-in cooler capacity for 4 pallets. Ranked #1 after eliminating Greenline Community Pantry (planted near-miss decoy at 0.198 cosine distance with cold_storage = 'none') and Harborview Neighbors Trust (profile contradiction).",
        window: "9:00 AM \u2013 8:30 PM",
        window_note: "Open for evening dock rescues",
        capacity_Fit: "Fits 4 pallets (Takes all 10 crates)",
        equipment: "Walk-in Cooler + Refrigerated Box Truck",
        pickup_eta: "4:15 PM (1h 55m)",
        buffer_mins: 235,
        buffer_pct: 66,
        warning_title: "USDA FoodKeeper: Lettuce / Spinach, Leaf Greens (Cooler Failure)",
        warning_body:
          "Because the donor walk-in cooler failed 2 hours ago, effective window is capped by donor_deadline_hours (6.0h vs 120h normal refrigerated shelf life). Pickup must occur before 8:10 PM.",
        insecurity_rate: "24.2%",
        insecurity_note: "Above metro avg (12.8%)",
        no_vehicle_rate: "26.4%",
        poverty_rate: "28.9%",
        tract_id: "13121001900",
        sms: "Hi Food Flow team, this is the Atlanta food rescue desk. A Midtown grocer has 10 crates of spinach, harvested yesterday, that must stay cold and leave their dock by 8:10 PM tonight. Your refrigerated van and same-day distribution make you our best fit. Can you divert to collect before 8? Reply YES and I'll send the pickup address and contact.",
      },
      split_plan: [
        {
          stop: "Stop 1",
          name: "House Of Serenity",
          share: "5 crates (1 pallet)",
          address: "890 Juniper St NE \u00b7 0.9 mi",
          sms: "Hi House Of Serenity, can you take 5 crates of fresh spinach from a Midtown grocer before 8 PM tonight? Reply YES to confirm.",
        },
        {
          stop: "Stop 2",
          name: "St. Mark AME Community Fridge",
          share: "5 crates (1 pallet)",
          address: "364 Boulevard NE \u00b7 1.7 mi",
          sms: "Hi St. Mark AME team, can you take the remaining 5 crates of fresh baby spinach from our Midtown split route before 8 PM? Reply YES.",
        },
      ],
      next_options: [
        {
          rank: 2,
          name: "Cedar Street Produce Alliance",
          archetype: "PRODUCE PANTRY \u00b7 EQUITY TIE-BREAKER WINNER",
          score: "94% Match",
          address: "214 Cedar St NW, Atlanta, GA 30314 \u00b7 2.1 mi away",
          window: "10:00 AM \u2013 7:30 PM",
          warning: "Won tie via Tract Need (31.8% no-vehicle)",
          insecurity: "33.5%",
          reason:
            "Tied operationally with Maple Street Produce Alliance (identical cold storage & 2-pallet capacity); ranked higher via ACS Census Tract 13121002500 equity tie-breaker (31.8% no-vehicle vs 11.2%).",
        },
        {
          rank: 3,
          name: "Maple Street Produce Alliance",
          archetype: "PRODUCE PANTRY \u00b7 STANDBY",
          score: "91% Match",
          address: "880 Maple St NE, Atlanta, GA 30309 \u00b7 2.1 mi away",
          window: "10:00 AM \u2013 7:30 PM",
          warning: "Lower tract need than Cedar St (11.2% no-vehicle)",
          insecurity: "14.1%",
          reason:
            "Identical operational specs and cosine similarity to Cedar Street Produce Alliance, placed #3 after ACS census tract equity tie-breaking.",
        },
      ],
      ruled_out: [
        {
          name: "Greenline Community Pantry",
          tag: "No Cold Storage (Planted Decoy)",
          detail:
            "Ranked #2 semantically (distance 0.198) because profile asks for fresh greens, but cold_storage = 'none'",
          icon: "ac_unit",
          color: "error",
        },
        {
          name: "Harborview Neighbors Trust",
          tag: "Profile Contradiction",
          detail:
            "Claims walk-in freezer in sentence 1 and single cupboard shelf with no freezer in sentence 2",
          icon: "warning",
          color: "error",
        },
        {
          name: "Southside Dry Pantry",
          tag: "Ambient Only",
          detail: "Cannot store perishable leafy greens requiring 36\u201340\u00b0F",
          icon: "thermostat",
          color: "error",
        },
        {
          name: "Cobb Senior Meal Kitchen",
          tag: "Pickup Window > Deadline",
          detail: "Needs 8h lead time > 5.8h effective hours remaining",
          icon: "schedule",
          color: "outline",
        },
        {
          name: "East Point Micro-Fridge",
          tag: "Max 0.5 Pallets",
          detail: "Capacity below single-stop threshold (10 crates / 2 pallets)",
          icon: "inventory_2",
          color: "outline",
        },
      ],
    },

    dairy: {
      key: "dairy",
      id: "SP-ATL-002",
      offer_code: "#ATL-8828",
      title: "Dairy \u00b7 Grocery store \u00b7 Downtown",
      quote:
        "\u201c6 pallets of Greek yogurt and milk gallons, sell-by tomorrow, kept at 36F in main dairy cooler. Needs dock-height truck or split pickup.\u201d",
      donor: "Peachtree Center Grocer \u00b7 Downtown \u00b7 Posted 34 mins ago",
      donor_short: "Grocery store \u00b7 Downtown \u00b7 6 pallets",
      zone: "Downtown",
      category: "Dairy (Milk & Yogurt)",
      storage: "Refrigerated (36\u00b0F Cold Chain)",
      storage_short: "Refrigerated",
      pallets: "6 Pallets (High Volume)",
      pallets_num: 6,
      time_left: "6h 00m LEFT",
      urgency_minutes: 360,
      shutoff_time: "8:30 PM",
      status: "awaiting",
      status_label: "Offered to Atlanta Community Food Bank, awaiting reply",
      driver_status: "unassigned",
      driver_name: "Marcus V.",
      brief_url: "match-brief-spinach.html?offer=dairy",
      pipeline: { semantic: 60, feasible: 9, recommended: 3 },
      primary_match: {
        name: "Atlanta Community Food Bank",
        archetype: "REGIONAL DISTRIBUTION HUB \u00b7 DOCK-HEIGHT",
        match_score: "97% Match",
        address: "3400 N Desert Dr, Atlanta, GA 30344 \u00b7 5.8 mi from donor",
        reason:
          "Only regional hub with dock-height refrigerated liftgate trucks and 10+ pallet walk-in dairy cooler capacity able to absorb all 6 pallets in a single stop, or split across 2 Midtown/Downtown pantries via split_large_load.",
        window: "7:00 AM \u2013 7:00 PM",
        window_note: "Dock-height reefer fleet active",
        capacity_Fit: "Fits 12 pallets (Takes all 6 pallets)",
        equipment: "Dock-Height Reefer Truck + Industrial Walk-in Cooler",
        pickup_eta: "4:30 PM (2h 00m)",
        buffer_mins: 240,
        buffer_pct: 67,
        warning_title: "High-Volume Load (6 Pallets) \u2014 Dock-Height or Split Required",
        warning_body:
          "Most neighborhood pantries top out at 2\u20133 pallets. If Atlanta Community Food Bank declines, activate the 2-stop Split Plan below (3 pallets each to Midtown Assistance Center & Hosea Helps).",
        insecurity_rate: "28.7%",
        insecurity_note: "High-need distribution network",
        no_vehicle_rate: "24.9%",
        poverty_rate: "30.1%",
        tract_id: "13121007800",
        sms: "Hi Atlanta Community Food Bank dispatch, this is the Atlanta food rescue desk. Peachtree Center Grocer Downtown has 6 pallets of Greek yogurt and milk gallons (36F, sell-by tomorrow) ready at their loading dock until 8:30 PM. Can your dock-height reefer truck take all 6 pallets today? Reply YES to confirm.",
      },
      split_plan: [
        {
          stop: "Stop 1",
          name: "Midtown Assistance Center",
          share: "3 pallets (50% of load)",
          address: "30 Porter Pl NE \u00b7 0.8 mi",
          sms: "Hi Midtown Assistance Center, can you accept 3 pallets of refrigerated Greek yogurt and milk gallons from Downtown before 8 PM via our split load route? Reply YES.",
        },
        {
          stop: "Stop 2",
          name: "Hosea Helps Distribution Hub",
          share: "3 pallets (50% of load)",
          address: "2545 Forrest Hills Dr SW \u00b7 4.2 mi",
          sms: "Hi Hosea Helps team, can you accept the second half (3 pallets) of refrigerated Greek yogurt and milk gallons from Downtown before 8 PM today? Reply YES.",
        },
      ],
      next_options: [
        {
          rank: 2,
          name: "Midtown Assistance Center",
          archetype: "EMERGENCY FOOD PANTRY \u00b7 SPLIT LEAD",
          score: "92% Match",
          address: "30 Porter Pl NE, Atlanta, GA 30308 \u00b7 0.8 mi away",
          window: "9:00 AM \u2013 6:30 PM",
          warning: "Max 3 pallets (Requires Split)",
          insecurity: "25.4%",
          reason:
            "Closest walk-in dairy cooler to Downtown (0.8 mi); can absorb 3 of the 6 pallets immediately while Hosea Helps takes the remaining 3 pallets.",
        },
        {
          rank: 3,
          name: "Vine City Pantry Network",
          archetype: "HIGH-EQUITY COMMUNITY HUB",
          score: "89% Match",
          address: "640 Magnolia St NW, Atlanta, GA 30314 \u00b7 1.6 mi away",
          window: "10:00 AM \u2013 7:00 PM",
          warning: "Max 2 pallets (Partial load)",
          insecurity: "36.2%",
          reason:
            "Located in one of Atlanta's highest food-insecurity census tracts (36.2%, 33.4% no-vehicle households) with commercial dairy coolers for 2 pallets.",
        },
      ],
      ruled_out: [
        {
          name: "Greenline Community Pantry",
          tag: "No Cold Storage",
          detail: "Cold storage = 'none'; cannot hold 36\u00b0F dairy",
          icon: "ac_unit",
          color: "error",
        },
        {
          name: "Harborview Neighbors Trust",
          tag: "Contradictory Profile",
          detail: "Flagged for conflicting walk-in freezer vs cupboard-only claim",
          icon: "warning",
          color: "error",
        },
        {
          name: "Inman Park Church Fridge",
          tag: "Capacity Exceeded (Max 1 Pallet)",
          detail: "Cannot absorb 6-pallet bulk dairy load without 6-way split",
          icon: "inventory_2",
          color: "outline",
        },
      ],
    },

    bread: {
      key: "bread",
      id: "SP-ATL-003",
      offer_code: "#ATL-8791",
      title: "Bakery \u00b7 Grocery store \u00b7 Decatur",
      quote:
        "\u201c150 loaves of artisan sourdough and multigrain bread baked this morning, bagged and boxed on 1 pallet. Room temp.\u201d",
      donor: "Decatur Square Bakery & Market \u00b7 Decatur \u00b7 Posted 1 hr ago",
      donor_short: "Grocery store \u00b7 Decatur \u00b7 1 pallet",
      zone: "Decatur",
      category: "Bakery (Ambient Bread)",
      storage: "Shelf-Stable / Ambient",
      storage_short: "Shelf-stable",
      pallets: "1 Pallet (150 Loaves)",
      pallets_num: 1,
      time_left: "8h 00m LEFT",
      urgency_minutes: 480,
      shutoff_time: "5:15 PM",
      status: "accepted",
      status_label: "Accepted by Decatur Emergency Assistance Ministry \u00b7 pickup 5:15 PM",
      driver_status: "en_route",
      driver_name: "Elena R.",
      brief_url: "match-brief-spinach.html?offer=bread",
      pipeline: { semantic: 60, feasible: 42, recommended: 3 },
      primary_match: {
        name: "Decatur Emergency Assistance Ministry",
        archetype: "COMMUNITY FOOD PANTRY \u00b7 DECATUR",
        match_score: "99% Match",
        address: "515 E Ponce de Leon Ave, Decatur, GA 30030 \u00b7 0.6 mi from donor",
        reason:
          "Located 0.6 miles from the Decatur donor with immediate shelf-stable bakery distribution to 220+ households daily. Accepted offer and scheduled volunteer van pickup for 5:15 PM.",
        window: "9:00 AM \u2013 6:00 PM",
        window_note: "Confirmed 5:15 PM dock pickup",
        capacity_Fit: "Fits 3 pallets (Takes full 1-pallet load)",
        equipment: "Cargo Van + Dry Pallet Staging",
        pickup_eta: "5:15 PM (Confirmed)",
        buffer_mins: 315,
        buffer_pct: 82,
        warning_title: "USDA FoodKeeper: Commercial Bread / Artisan Loaves (Ambient)",
        warning_body:
          "Room-temperature artisan bread holds peak quality for 48\u201396 hours, capped by donor dock closing at 10:30 PM. Pickup confirmed for 5:15 PM today.",
        insecurity_rate: "19.8%",
        insecurity_note: "Above metro avg (12.8%)",
        no_vehicle_rate: "18.4%",
        poverty_rate: "21.5%",
        tract_id: "13089022500",
        sms: "CONFIRMED: Decatur Emergency Assistance Ministry has accepted 150 loaves (1 pallet) of artisan sourdough & multigrain bread. Driver Elena R. is scheduled for 5:15 PM dock pickup at Decatur Square Bakery & Market.",
      },
      split_plan: [],
      next_options: [
        {
          rank: 2,
          name: "Oakhurst Community Fridge",
          archetype: "NEIGHBORHOOD FRIDGE & DRY PANTRY",
          score: "93% Match",
          address: "630 East Lake Dr, Decatur, GA 30030 \u00b7 1.4 mi away",
          window: "24/7 Open Access",
          warning: "Standby ready",
          insecurity: "18.2%",
          reason:
            "Weatherproof dry bread boxes adjacent to community fridge can take 150 bagged loaves within 20 minutes.",
        },
        {
          rank: 3,
          name: "East Lake Neighbor Pantry",
          archetype: "FAMILY SUPPORT PANTRY",
          score: "90% Match",
          address: "2400 Hosea L Williams Dr NE \u00b7 2.2 mi away",
          window: "10:00 AM \u2013 7:00 PM",
          warning: "Standby ready",
          insecurity: "26.9%",
          reason:
            "Serves high-need East Lake families with afternoon bread and produce distributions.",
        },
      ],
      ruled_out: [
        {
          name: "Harborview Neighbors Trust",
          tag: "Contradictory Profile",
          detail: "Excluded globally due to conflicting facility storage statements",
          icon: "warning",
          color: "error",
        },
      ],
    },
  };

  const EQUITY_AUDIT_DATA = {
    metro: "Atlanta, GA (Fulton & DeKalb Counties)",
    dataset: "qwiklabs-gcp-04-ef48e08bc216.a4i_food",
    embeddings_model: "gemini-embedding-2 (3072 dims, COSINE brute-force)",
    total_recipients: 127,
    tracts_joined: 127,
    high_need_share: "78.4%",
    avg_no_vehicle_rate: "26.8%",
    avg_poverty_rate: "28.7%",
    metro_baseline_insecurity: "12.8%",
    tie_breaker_highlight: {
      winner: "Cedar Street Produce Alliance (Tract 13121002500)",
      runner_up: "Maple Street Produce Alliance (Tract 13121001400)",
      metric: "31.8% no-vehicle & 33.5% poverty vs. 11.2% no-vehicle & 14.1% poverty",
    },
    guardrails_triggered: [
      {
        recipient: "Greenline Community Pantry",
        rule: "Near-Miss Semantic Decoy Filter",
        detail:
          "Ranked #2 by vector similarity (distance 0.198) on baby spinach because its text profile requests leafy greens, but hard-filtered out because cold_storage = 'none'.",
      },
      {
        recipient: "Harborview Neighbors Trust",
        rule: "Contradiction Integrity Guardrail",
        detail:
          "Claims 'commercial walk-in freezer' in sentence 1 and 'only a single cupboard shelf with no freezer' in sentence 2. Flagged & excluded.",
      },
    ],
  };

  // ---------------------------------------------------------------------------
  // 2. STATEFUL STORE (localStorage + BroadcastChannel + /api/* Sync)
  // ---------------------------------------------------------------------------
  let syncChannel = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      syncChannel = new BroadcastChannel(CHANNEL_NAME);
    }
  } catch (_) {}

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  let APP_STATE = null;

  function saveBrokerState(state, broadcast = true) {
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

  function loadBrokerState() {
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
      sort_mode: "urgency", // urgency | pallets | status
      offers_order: ["deli", "spinach", "dairy", "bread"],
      offers: deepClone(DEFAULT_OFFERS_CATALOG),
      audit_log: [
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

  function addAuditLog(text, type = "info") {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    APP_STATE.audit_log = APP_STATE.audit_log || [];
    APP_STATE.audit_log.unshift({ time: timeStr, text, type });
    if (APP_STATE.audit_log.length > 25) {
      APP_STATE.audit_log.length = 25;
    }
  }

  function resetBrokerState() {
    localStorage.removeItem(STORAGE_KEY);
    APP_STATE = loadBrokerState();
    addAuditLog("Demo state reset to initial Atlanta BigQuery snapshot.", "info");
    saveBrokerState(APP_STATE, true);
    refreshCurrentView();
    showToast("Demo state reset to initial BigQuery snapshot", "restart_alt");
  }

  // Listen for cross-tab state changes (e.g. Grocer posts or Pantry accepts in another tab)
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

  // ---------------------------------------------------------------------------
  // 3. STATE MUTATION ACTIONS (Dispatch, Decline/Rotate, Accept, Split, Donate)
  // ---------------------------------------------------------------------------
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

  function markOfferSent(offerKey, customSms) {
    const offer = APP_STATE.offers[offerKey];
    if (!offer) return;
    if (customSms) {
      offer.primary_match.sms = customSms;
    }
    offer.status = "awaiting";
    offer.active_split_mode = false;
    offer.status_label = `Offered to ${offer.primary_match.name}, awaiting reply`;
    addAuditLog(
      `Sent dispatch SMS for ${offer.offer_code} to ${offer.primary_match.name} (awaiting reply).`,
      "awaiting"
    );
    saveBrokerState(APP_STATE, true);
    syncDispatchToServer(offerKey, offer.primary_match.name, "awaiting", offer.primary_match.sms);
    refreshCurrentView();
    showToast(`Offer ${offer.offer_code} marked as sent to ${offer.primary_match.name}`, "send");
  }

  function activateSplitPlan(offerKey) {
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
    syncDispatchToServer(offerKey, stopNames, "awaiting", combinedSms);
    refreshCurrentView();
    showToast(`Split plan activated (${stopNames}) & both SMS messages copied!`, "call_split");
  }

  function rotateToNextOption(offerKey, targetIndex = 0) {
    const offer = APP_STATE.offers[offerKey];
    if (!offer || !offer.next_options || offer.next_options.length === 0) {
      showToast("No additional standby options available", "warning");
      return;
    }
    const prevPrimary = deepClone(offer.primary_match);
    const chosen = offer.next_options.splice(targetIndex, 1)[0];

    // Check anti-double-match lock
    const claimed = getClaimedRecipients(offerKey);
    const claimConflict = claimed.get(chosen.name);

    offer.primary_match = {
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

    // Put previous primary at end of standby list
    offer.next_options.push({
      rank: offer.next_options.length + 2,
      name: prevPrimary.name,
      archetype: "PREVIOUSLY CONTACTED \u00b7 DECLINED/UNAVAILABLE",
      score: prevPrimary.match_score,
      address: prevPrimary.address.split("\u00b7")[0].trim(),
      window: prevPrimary.window,
      warning: "Rotated to standby",
      insecurity: prevPrimary.insecurity_rate,
      reason: prevPrimary.reason,
    });

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

  function markOfferAccepted(offerKey) {
    const offer = APP_STATE.offers[offerKey];
    if (!offer) return;
    const recipientName = offer.active_split_mode
      ? offer.split_plan.map((s) => s.name).join(" + ")
      : offer.primary_match.name;
    offer.status = "accepted";
    offer.driver_status = "requested";
    offer.status_label = `Accepted by ${recipientName} \u00b7 pickup ${offer.shutoff_time}`;
    addAuditLog(
      `${recipientName} ACCEPTED ${offer.offer_code} (${offer.pallets}). Driver dispatch requested.`,
      "accepted"
    );
    saveBrokerState(APP_STATE, true);
    syncDispatchToServer(offerKey, recipientName, "accepted", offer.primary_match.sms);
    refreshCurrentView();
    showToast(`${offer.offer_code} accepted by ${recipientName}! Route queued for driver.`, "check_circle");
  }

  function markOfferDonated(offerKey) {
    const offer = APP_STATE.offers[offerKey];
    if (!offer) return;
    const recipientName = offer.active_split_mode
      ? offer.split_plan.map((s) => s.name).join(" + ")
      : offer.primary_match.name;
    offer.status = "donated";
    offer.driver_status = "delivered";
    offer.time_left = "COMPLETED";
    offer.status_label = `Donated to ${recipientName} \u00b7 verified delivery`;
    addAuditLog(
      `COMPLETED: ${offer.offer_code} (${offer.pallets}) delivered & donated to ${recipientName}.`,
      "donated"
    );
    saveBrokerState(APP_STATE, true);
    syncDispatchToServer(offerKey, recipientName, "donated", "DELIVERED");
    refreshCurrentView();
    showToast(`${offer.offer_code} marked as Donated & Completed!`, "verified");
  }

  function createNewSurplusOffer({ donorName, neighborhood, zone, category, quote, palletsNum, storage, deadlineHours }) {
    const key = "custom_" + Date.now().toString(36);
    const codeNum = Math.floor(8910 + Math.random() * 90);
    const offerCode = `#ATL-${codeNum}`;
    const isCold = /refrigerat|cold|cooler|frozen|36|38/i.test(storage);
    const hrs = parseFloat(deadlineHours) || 4;
    const mins = Math.round(hrs * 60);
    const hPart = Math.floor(mins / 60);
    const mPart = mins % 60;

    // Pick best initial match based on storage & pallet count
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
      donor_short: `Grocery store \u00b7 ${neighborhood} \u00b7 ${palletsNum} pallet${palletsNum > 1 ? "s" : ""}`,
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

  function syncDispatchToServer(offerKey, recipient, status, sms) {
    fetch("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offer: offerKey, recipient, status, sms }),
    }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // 4. LIVE CLOUD RUN ADK AGENT CLIENT (https://food-rescue-agent-2u2wh53apa-uc.a.run.app)
  // ---------------------------------------------------------------------------
  let adkSessionId = null;
  const adkUserId = "broker_console_" + Math.random().toString(36).slice(2, 8);

  async function ensureAdkSession(baseUrl = CLOUD_RUN_AGENT_URL) {
    if (adkSessionId) return adkSessionId;
    const res = await fetch(`${baseUrl}/apps/agent/users/${adkUserId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Session creation failed (${res.status})`);
    const data = await res.json();
    adkSessionId = data.id;
    return adkSessionId;
  }

  async function callCloudRunAgent(promptText, onProgress) {
    const baseUrl = CLOUD_RUN_AGENT_URL;
    if (onProgress) onProgress("Connecting to Cloud Run ADK Agent session...");
    const sessionId = await ensureAdkSession(baseUrl);
    if (onProgress) onProgress("Running BigQuery VECTOR_SEARCH + USDA FoodKeeper + ACS Equity tools...");

    const res = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: "agent",
        userId: adkUserId,
        sessionId,
        newMessage: {
          role: "user",
          parts: [{ text: promptText }],
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Cloud Run Agent returned HTTP ${res.status}`);
    }
    const events = await res.json();
    const toolCalls = [];
    const toolResponses = [];
    let finalReply = "";

    if (Array.isArray(events)) {
      events.forEach((ev) => {
        const parts = (ev.content && ev.content.parts) || [];
        parts.forEach((p) => {
          if (p.functionCall) {
            toolCalls.push({
              name: p.functionCall.name,
              args: p.functionCall.args || {},
            });
          }
          if (p.functionResponse) {
            toolResponses.push({
              name: p.functionResponse.name,
              response: p.functionResponse.response || {},
            });
          }
          if (p.text) {
            finalReply += (finalReply ? "\n\n" : "") + p.text;
          }
        });
      });
    }

    return {
      sessionId,
      toolCalls,
      toolResponses,
      finalReply: finalReply || "Agent completed tool execution.",
    };
  }

  function applyLiveAgentMatchToOffer(offerKey, matchToolResponse) {
    const offer = APP_STATE.offers[offerKey];
    if (!offer || !matchToolResponse) return false;
    const ranked = matchToolResponse.ranked_matches || [];
    if (ranked.length === 0) return false;

    const top = ranked[0];
    const scorePct = top.cosine_distance
      ? `${Math.min(99, Math.max(80, Math.round((1 - Number(top.cosine_distance)) * 115)))}% Match`
      : "97% Match";

    offer.primary_match = {
      ...offer.primary_match,
      name: top.organization_name || top.name || offer.primary_match.name,
      archetype: `${(top.Cold_storage || top.cold_storage || "VERIFIED").toString().toUpperCase()} \u00b7 TIER ${top.rank_tier || 1}`,
      match_score: scorePct,
      address: `${top.address || top.neighborhood || "Atlanta, GA"} \u00b7 Live BigQuery Match`,
      reason:
        top.match_rationale ||
        `Live BigQuery VECTOR_SEARCH #1 rank (cosine distance ${Number(top.cosine_distance || 0.19).toFixed(3)}, Tier ${top.rank_tier || 1}). Cold storage: ${top.cold_storage || "verified"}, capacity: ${top.max_pallets || 4} pallets, pickup window: ${top.pickup_window_hours || 2}h.`,
      capacity_Fit: `Fits ${top.max_pallets || 4} pallets`,
      insecurity_rate: top.poverty_rate
        ? `${(Number(top.poverty_rate) * (Number(top.poverty_rate) <= 1 ? 100 : 1)).toFixed(1)}%`
        : offer.primary_match.insecurity_rate,
      no_vehicle_rate: top.no_vehicle_rate
        ? `${(Number(top.no_vehicle_rate) * (Number(top.no_vehicle_rate) <= 1 ? 100 : 1)).toFixed(1)}%`
        : offer.primary_match.no_vehicle_rate,
      sms: `Hi ${top.organization_name || top.name} team, this is the Atlanta food rescue desk. We have ${offer.pallets} of ${offer.category} (${offer. quote.slice(1, 70)}...) needing pickup by ${offer.shutoff_time}. Can you accept? Reply YES to confirm.`,
    };

    if (ranked.length > 1) {
      offer.next_options = ranked.slice(1, 3).map((cand, idx) => ({
        rank: idx + 2,
        name: cand.organization_name || cand.name || `Standby Option ${idx + 2}`,
        archetype: `TIER ${cand.rank_tier || idx + 2} \u00b7 ${(cand.cold_storage || "COLD CHAIN").toString().toUpperCase()}`,
        score: cand.cosine_distance
          ? `${Math.min(96, Math.max(78, Math.round((1 - Number(cand.cosine_distance)) * 112)))}% Match`
          : `${92 - idx * 3}% Match`,
        address: cand.address || cand.neighborhood || "Atlanta, GA",
        window: `${cand.pickup_window_hours || 2}h pickup window`,
        warning: cand.margin_warning || "Live BQ Candidate",
        insecurity: cand.poverty_rate
          ? `${(Number(cand.poverty_rate) * (Number(cand.poverty_rate) <= 1 ? 100 : 1)).toFixed(1)}%`
          : "24.5%",
        reason: `Live BigQuery candidate (cosine distance ${Number(cand.cosine_distance || 0.21).toFixed(3)}).`,
      }));
    }

    const nearMisses = matchToolResponse.eliminated_near_misses || [];
    const contradictions = matchToolResponse.flagged_contradictions || [];
    if (nearMisses.length > 0 || contradictions.length > 0) {
      const liveRuledOut = [];
      contradictions.forEach((c) => {
        liveRuledOut.push({
          name: c.organization_name || c.name || "Harborview Neighbors Trust",
          tag: "Contradictory Profile",
          detail: c.contradiction_reason || c.reason || "Excluded due to conflicting cold storage claims",
          icon: "warning",
          color: "error",
        });
      });
      nearMisses.forEach((m) => {
        liveRuledOut.push({
          name: m.organization_name || m.name || "Near-Miss Candidate",
          tag: m.elimination_reason || "Constraint Filter",
          detail: `Cosine distance ${Number(m.cosine_distance || 0.2).toFixed(3)} \u00b7 ${m.elimination_reason || "Failed cold storage / window check"}`,
          icon: "ac_unit",
          color: "error",
        });
      });
      if (liveRuledOut.length > 0) {
        offer.ruled_out = liveRuledOut.slice(0, 8);
      }
    }

    offer.status = "ready";
    offer.status_label = `Match ready: ${offer.primary_match.name} (Live AI)`;
    addAuditLog(
      `Live Cloud Run Agent updated ${offer.offer_code} via BigQuery VECTOR_SEARCH \u2192 #1 ${offer.primary_match.name}.`,
      "ready"
    );
    saveBrokerState(APP_STATE, true);
    refreshCurrentView();
    return true;
  }

  // ---------------------------------------------------------------------------
  // 5. DYNAMIC QUEUE.HTML RENDERER & CONTROLLER
  // ---------------------------------------------------------------------------
  function isQueuePage() {
    const p = window.location.pathname.toLowerCase();
    return p.endsWith("queue.html") || p.endsWith("/frontend/") || p === "/" || p === "";
  }

  function isMatchBriefPage() {
    const p = window.location.pathname.toLowerCase();
    return p.includes("match-brief-spinach") || p.includes("match-brief-deli");
  }

  function getActiveOfferKey() {
    const params = new URLSearchParams(window.location.search);
    const paramOffer = (params.get("offer") || "").toLowerCase();
    if (paramOffer && APP_STATE.offers[paramOffer]) {
      return paramOffer;
    }
    const p = window.location.pathname.toLowerCase();
    if (p.includes("match-brief-deli")) return "deli";
    if (p.includes("match-brief-spinach")) return "spinach";
    return "spinach";
  }

  function updateSidebarBadge() {
    const allOffers = Object.values(APP_STATE.offers);
    const activeCount = allOffers.filter((o) => o.status !== "donated").length;
    const routesCount = allOffers.filter(
      (o) => o.status === "awaiting" || o.status === "accepted"
    ).length;

    document.querySelectorAll("aside nav a").forEach((link) => {
      const text = link.textContent || "";
      if (text.includes("Live Queue")) {
        const badge = link.querySelector("span:last-child");
        if (badge && !badge.classList.contains("material-symbols-outlined")) {
          badge.textContent = String(activeCount);
        }
      } else if (text.includes("Active Routes")) {
        let badge = link.querySelector("[data-routes-badge]");
        if (!badge) {
          badge = link.querySelector("span:last-child");
        }
        if (badge && !badge.classList.contains("material-symbols-outlined") && badge.textContent.trim() !== "Active Routes") {
          badge.textContent = String(routesCount);
        }
      }
    });
  }

  function renderQueuePage() {
    if (!isQueuePage()) return;
    updateSidebarBadge();

    const allOffers = APP_STATE.offers_order
      .map((k) => APP_STATE.offers[k])
      .filter(Boolean);

    // 1. Update 4 Top Metric Cards (matches queue.html .text-headline-md & .text-body-sm)
    const counts = {
      urgent: allOffers.filter((o) => o.status === "urgent").length,
      ready: allOffers.filter((o) => o.status === "ready").length,
      awaiting: allOffers.filter((o) => o.status === "awaiting").length,
      accepted: allOffers.filter((o) => o.status === "accepted").length,
      donated: allOffers.filter((o) => o.status === "donated").length,
      completed: allOffers.filter((o) => o.status === "accepted" || o.status === "donated").length,
    };

    const metricSection = document.querySelector("main section.grid.grid-cols-4");
    if (metricSection) {
      const cards = metricSection.children;
      if (cards[0]) {
        const headline = cards[0].querySelector(".text-headline-md, .text-3xl");
        if (headline) {
          headline.textContent =
            counts.urgent === 1 ? "1 needs a match" : `${counts.urgent} need a match`;
        }
      }
      if (cards[1]) {
        const headline = cards[1].querySelector(".text-headline-md, .text-3xl");
        if (headline) {
          headline.textContent =
            counts.ready === 1 ? "1 match ready" : `${counts.ready} matches ready`;
        }
      }
      if (cards[2]) {
        const headline = cards[2].querySelector(".text-headline-md, .text-3xl");
        if (headline) {
          headline.textContent = `${counts.awaiting} awaiting reply`;
        }
      }
      if (cards[3]) {
        const headline = cards[3].querySelector(".text-headline-md, .text-3xl");
        const subEl = cards[3].querySelector(".text-body-sm, .text-\\[11px\\]");
        if (headline) {
          headline.textContent =
            counts.donated > 0
              ? `${counts.completed} secured (${counts.donated} donated)`
              : `${counts.accepted} accepted`;
        }
        if (subEl) {
          subEl.textContent =
            counts.donated > 0
              ? `${counts.donated} rescue completed \u00b7 ${counts.accepted} en route`
              : "Scheduled for pickup window";
        }
      }
    }

    // 2. Filter and Sort Offers
    const zoneFilter = APP_STATE.active_zone_filter || "All Zones";
    const query = (APP_STATE.search_query || "").trim().toLowerCase();

    let filtered = allOffers.filter((offer) => {
      if (zoneFilter !== "All Zones" && offer.zone.toLowerCase() !== zoneFilter.toLowerCase()) {
        return false;
      }
      if (query) {
        const haystack = [
          offer.offer_code,
          offer.title,
          offer.quote,
          offer.donor,
          offer.category,
          offer.storage,
          offer.primary_match && offer.primary_match.name,
          offer.status_label,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const statusPriority = { urgent: 1, ready: 2, awaiting: 3, accepted: 4, donated: 5 };
    filtered.sort((a, b) => {
      if (APP_STATE.sort_mode === "pallets") {
        return (b.pallets_num || 0) - (a.pallets_num || 0);
      }
      if (APP_STATE.sort_mode === "status") {
        return (statusPriority[a.status] || 9) - (statusPriority[b.status] || 9);
      }
      if ((a.status === "donated") !== (b.status === "donated")) {
        return a.status === "donated" ? 1 : -1;
      }
      return (a.urgency_minutes || 999) - (b.urgency_minutes || 999);
    });

    // 3. Render Queue Header Strip + Offer Cards in Left Column (.col-span-8)
    const listContainer = document.querySelector("main .grid.grid-cols-12 > .col-span-8");
    if (!listContainer) return;

    const headerStripHtml = `
      <div class="flex items-center justify-between pb-1 border-b border-outline-variant">
        <div class="flex items-center gap-2.5">
          <h1 class="text-headline-lg font-headline-lg font-bold text-on-surface tracking-tight">Today's queue</h1>
          <span class="text-body-sm font-body-sm text-on-surface-variant">\u00b7 ${filtered.length} of ${allOffers.length} offers (${escapeHtml(zoneFilter)}) \u00b7 sorted by ${escapeHtml(APP_STATE.sort_mode || "urgency")}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="flex items-center gap-1 text-label-badge font-label-badge px-2 py-0.5 rounded bg-surface-container border border-outline-variant text-on-surface-variant">
            <span class="material-symbols-outlined text-[13px] text-primary">database</span>
            <span>BigQuery a4i_food \u00b7 Live State</span>
          </span>
          <button id="queue-sort-cycle-btn" class="px-2.5 py-1 rounded hover:bg-surface-container text-on-surface-variant border border-outline-variant text-xs font-semibold flex items-center gap-1 cursor-pointer" title="Cycle sort order">
            <span class="material-symbols-outlined text-[15px]">sort</span>
            <span>Sort: ${escapeHtml((APP_STATE.sort_mode || "urgency").toUpperCase())}</span>
          </button>
        </div>
      </div>
    `;

    if (filtered.length === 0) {
      listContainer.innerHTML =
        headerStripHtml +
        `
        <div class="bg-surface-container-lowest border border-outline-variant rounded p-8 text-center space-y-3">
          <span class="material-symbols-outlined text-3xl text-outline">search_off</span>
          <p class="text-body-md font-semibold text-on-surface">No surplus offers match your current filter</p>
          <p class="text-body-sm text-on-surface-variant">Zone: ${escapeHtml(zoneFilter)} \u00b7 Search: "${escapeHtml(query || "none")}"</p>
          <button id="clear-queue-filters-btn" class="px-3.5 py-1.5 bg-primary text-on-primary rounded text-body-sm font-semibold cursor-pointer">
            Reset Filters
          </button>
        </div>
      `;
      const clearBtn = document.getElementById("clear-queue-filters-btn");
      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          APP_STATE.active_zone_filter = "All Zones";
          APP_STATE.search_query = "";
          const searchInput = document.querySelector('header input[type="text"]');
          if (searchInput) searchInput.value = "";
          saveBrokerState(APP_STATE, false);
          updateZoneFilterButtons();
          renderQueuePage();
        });
      }
      return;
    }

    listContainer.innerHTML =
      headerStripHtml + filtered.map((offer) => buildQueueCardHtml(offer)).join("\n");

    const sortBtn = document.getElementById("queue-sort-cycle-btn");
    if (sortBtn) {
      sortBtn.addEventListener("click", () => {
        const modes = ["urgency", "pallets", "status"];
        const nextIdx = (modes.indexOf(APP_STATE.sort_mode || "urgency") + 1) % modes.length;
        APP_STATE.sort_mode = modes[nextIdx];
        saveBrokerState(APP_STATE, false);
        renderQueuePage();
        showToast(`Sorted queue by: ${APP_STATE.sort_mode.toUpperCase()}`, "sort");
      });
    }

    // 4. Wire Event Listeners on Newly Rendered Queue Cards
    listContainer.querySelectorAll("[data-queue-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = btn.getAttribute("data-queue-action");
        const key = btn.getAttribute("data-offer-key");
        if (!key || !APP_STATE.offers[key]) return;

        if (action === "decline-next") {
          rotateToNextOption(key, 0);
        } else if (action === "quick-send") {
          markOfferSent(key);
        } else if (action === "mark-accepted") {
          markOfferAccepted(key);
        } else if (action === "mark-donated") {
          markOfferDonated(key);
        } else if (action === "live-ai-match") {
          openAgentDrawerForOffer(key);
        }
      });
    });
  }

  function buildQueueCardHtml(offer) {
    const key = escapeHtml(offer.key);
    const code = escapeHtml(offer.offer_code);
    const quote = escapeHtml(offer.quote);
    const donorShort = escapeHtml(offer.donor_short || offer.donor);
    const storageShort = escapeHtml(offer.storage_short || offer.storage);
    const timeLeft = escapeHtml(offer.time_left);
    const statusLabel = escapeHtml(offer.status_label);
    const briefUrl = escapeHtml(offer.brief_url || `match-brief-spinach.html?offer=${offer.key}`);
    const storageIcon = /shelf|ambient|room/i.test(storageShort) ? "inventory_2" : "ac_unit";

    if (offer.status === "urgent") {
      return `
        <div class="bg-surface-container-lowest border border-outline-variant border-l-4 border-l-error rounded p-4 shadow-xs hover:border-outline transition-all" data-offer-card="${key}">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-2 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
                <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
                <span class="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-container-high text-on-surface px-2 py-0.5 rounded">
                  <span class="material-symbols-outlined text-xs text-primary">${storageIcon}</span> ${storageShort}
                </span>
              </div>
              <p class="font-serif-quote italic text-base text-on-surface leading-snug bg-surface-container-low p-3 rounded border-l-2 border-outline">
                ${quote}
              </p>
            </div>
            <div class="text-right flex flex-col items-end shrink-0">
              <div class="inline-flex items-center gap-1.5 bg-error-container text-on-error-container px-2.5 py-1 rounded font-mono text-xs font-bold">
                <span class="material-symbols-outlined text-xs" style="font-variation-settings: 'FILL' 1;">timer</span>
                ${timeLeft}
              </div>
            </div>
          </div>
          <div class="mt-3 pt-3 border-t border-outline-variant/50 flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-error animate-pulse"></span>
              <span class="text-body-sm font-bold text-error">${statusLabel}</span>
              <span class="text-xs text-on-surface-variant ml-1">\u00b7 Top candidate: <strong class="text-on-surface">${escapeHtml(offer.primary_match.name)}</strong> (${escapeHtml(offer.primary_match.match_score)})</span>
            </div>
            <div class="flex items-center gap-2">
              <button data-queue-action="live-ai-match" data-offer-key="${key}" class="px-2.5 py-1.5 rounded border border-primary/40 text-primary hover:bg-primary/5 text-xs font-semibold flex items-center gap-1 cursor-pointer" title="Query live Cloud Run Agent">
                <span class="material-symbols-outlined text-xs">smart_toy</span> Live AI Match
              </button>
              <a class="bg-primary hover:bg-primary-container text-on-primary font-semibold text-xs px-4 py-2 rounded transition-colors flex items-center gap-1.5 shadow-xs" href="${briefUrl}">
                Find recipients
                <span class="material-symbols-outlined text-sm">arrow_forward</span>
              </a>
            </div>
          </div>
        </div>
      `;
    }

    if (offer.status === "ready") {
      return `
        <div class="bg-surface-container-lowest border border-outline-variant border-l-4 border-l-primary rounded p-4 shadow-xs hover:border-outline transition-all" data-offer-card="${key}">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-2 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
                <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
                <span class="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-container-high text-on-surface px-2 py-0.5 rounded">
                  <span class="material-symbols-outlined text-xs text-primary">${storageIcon}</span> ${storageShort}
                </span>
              </div>
              <p class="font-serif-quote italic text-base text-on-surface leading-snug bg-surface-container-low p-3 rounded border-l-2 border-outline">
                ${quote}
              </p>
            </div>
            <div class="text-right flex flex-col items-end shrink-0">
              <div class="inline-flex items-center gap-1.5 bg-tertiary-fixed text-on-tertiary-fixed-variant px-2.5 py-1 rounded font-mono text-xs font-bold">
                <span class="material-symbols-outlined text-xs">schedule</span>
                ${timeLeft}
              </div>
            </div>
          </div>
          <div class="mt-3 pt-3 border-t border-outline-variant/50 flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-primary text-base" style="font-variation-settings: 'FILL' 1;">check_circle</span>
              <span class="text-body-sm font-bold text-primary">${statusLabel}</span>
              <span class="text-xs text-on-surface-variant ml-1">\u00b7 ${escapeHtml(offer.primary_match.match_score)} \u00b7 ${escapeHtml(offer.primary_match.capacity_Fit)}</span>
            </div>
            <div class="flex items-center gap-2">
              <button data-queue-action="quick-send" data-offer-key="${key}" class="px-3 py-1.5 rounded border border-outline-variant hover:bg-surface-container text-on-surface text-xs font-semibold flex items-center gap-1 cursor-pointer">
                <span class="material-symbols-outlined text-xs">send</span> Send SMS
              </button>
              <a class="bg-primary hover:bg-primary-container text-on-primary font-semibold text-xs px-4 py-2 rounded transition-colors flex items-center gap-1.5 shadow-xs" href="${briefUrl}">
                Review match brief
                <span class="material-symbols-outlined text-sm">arrow_forward</span>
              </a>
            </div>
          </div>
        </div>
      `;
    }

    if (offer.status === "awaiting") {
      return `
        <div class="bg-surface-container-lowest border border-outline-variant border-l-4 border-l-tertiary-container rounded p-4 shadow-xs hover:border-outline transition-all" data-offer-card="${key}">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-2 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
                <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
                <span class="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-container-high text-on-surface px-2 py-0.5 rounded">
                  <span class="material-symbols-outlined text-xs text-primary">${storageIcon}</span> ${storageShort}
                </span>
              </div>
              <p class="font-serif-quote italic text-base text-on-surface leading-snug bg-surface-container-low p-3 rounded border-l-2 border-outline">
                ${quote}
              </p>
            </div>
            <div class="text-right flex flex-col items-end shrink-0">
              <div class="inline-flex items-center gap-1.5 bg-surface-container-high text-on-surface-variant px-2.5 py-1 rounded font-mono text-xs font-bold">
                <span class="material-symbols-outlined text-xs">schedule</span>
                ${timeLeft}
              </div>
            </div>
          </div>
          <div class="mt-3 pt-3 border-t border-outline-variant/50 flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-tertiary-container text-base">hourglass_top</span>
              <span class="text-body-sm font-bold text-tertiary">${statusLabel}</span>
            </div>
            <div class="flex items-center gap-2">
              <button data-queue-action="decline-next" data-offer-key="${key}" class="border border-outline-variant bg-surface-container-low hover:bg-surface-container-high text-on-surface font-semibold text-xs px-3 py-1.5 rounded transition-colors cursor-pointer">
                They said no \u2192 next
              </button>
              <button data-queue-action="mark-accepted" data-offer-key="${key}" class="bg-primary text-on-primary hover:bg-primary-container font-semibold text-xs px-3 py-1.5 rounded transition-colors cursor-pointer flex items-center gap-1">
                <span class="material-symbols-outlined text-xs">check</span> Mark Accepted
              </button>
              <a class="text-primary hover:underline font-semibold text-xs px-2 py-1.5" href="${briefUrl}">
                View
              </a>
            </div>
          </div>
        </div>
      `;
    }

    if (offer.status === "accepted") {
      return `
        <div class="bg-surface-container-low/70 border border-outline-variant border-l-4 border-l-secondary rounded p-4 hover:opacity-100 transition-all" data-offer-card="${key}">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-1.5 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
                <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
                <span class="inline-flex items-center gap-1 text-[11px] font-medium bg-surface-container text-on-surface-variant px-2 py-0.5 rounded">
                  <span class="material-symbols-outlined text-xs">${storageIcon}</span> ${storageShort}
                </span>
              </div>
              <p class="font-serif-quote italic text-sm text-on-surface-variant leading-snug pl-2 border-l-2 border-outline-variant">
                ${quote}
              </p>
            </div>
            <div class="text-right flex flex-col items-end shrink-0">
              <div class="inline-flex items-center gap-1.5 bg-secondary-container text-on-secondary-container px-2.5 py-1 rounded font-mono text-xs font-bold">
                <span class="material-symbols-outlined text-xs">local_shipping</span>
                EN ROUTE \u00b7 ${escapeHtml(offer.shutoff_time)}
              </div>
            </div>
          </div>
          <div class="mt-2.5 pt-2.5 border-t border-outline-variant/40 flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-secondary text-base" style="font-variation-settings: 'FILL' 1;">verified</span>
              <span class="text-xs font-bold text-secondary">${statusLabel}</span>
            </div>
            <div class="flex items-center gap-2">
              <button data-queue-action="mark-donated" data-offer-key="${key}" class="bg-primary text-on-primary hover:bg-primary-container font-semibold text-xs px-3 py-1.5 rounded transition-colors cursor-pointer flex items-center gap-1">
                <span class="material-symbols-outlined text-xs">task_alt</span> Mark Donated
              </button>
              <a class="text-on-surface-variant hover:text-on-surface font-semibold text-xs px-2 py-1 rounded hover:bg-surface-container" href="${briefUrl}">
                View
              </a>
            </div>
          </div>
        </div>
      `;
    }

    // status === "donated"
    return `
      <div class="bg-surface-container-low/50 border border-outline-variant rounded p-4 opacity-80 hover:opacity-100 transition-opacity" data-offer-card="${key}">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1.5 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">${code}</span>
              <span class="text-xs font-semibold text-on-surface-variant">${donorShort}</span>
              <span class="inline-flex items-center gap-1 text-[11px] font-bold bg-primary/15 text-primary px-2 py-0.5 rounded">
                <span class="material-symbols-outlined text-xs">verified</span> DONATED & COMPLETED
              </span>
            </div>
            <p class="font-serif-quote italic text-sm text-on-surface-variant leading-snug pl-2 border-l-2 border-outline-variant">
              ${quote}
            </p>
          </div>
          <div class="text-right flex flex-col items-end shrink-0">
            <div class="inline-flex items-center gap-1.5 bg-primary/15 text-primary px-2.5 py-0.5 rounded font-mono text-xs font-bold">
              RESCUED
            </div>
          </div>
        </div>
        <div class="mt-2.5 pt-2.5 border-t border-outline-variant/40 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary text-base" style="font-variation-settings: 'FILL' 1;">workspace_premium</span>
            <span class="text-xs font-bold text-primary">${statusLabel}</span>
          </div>
          <a class="text-on-surface-variant hover:text-on-surface font-semibold text-xs px-2 py-1 rounded hover:bg-surface-container" href="${briefUrl}">
            View Audit
          </a>
        </div>
      </div>
    `;
  }

  function updateZoneFilterButtons() {
    const activeZone = APP_STATE.active_zone_filter || "All Zones";
    // Header zone tabs in queue.html, match-brief-spinach.html, match-brief-deli.html
    document.querySelectorAll("[data-zone-btn]").forEach((el) => {
      const z = el.getAttribute("data-zone-btn");
      if (z === activeZone) {
        el.className =
          "text-primary dark:text-inverse-primary font-headline-sm border-b-2 border-primary pb-1 cursor-pointer";
      } else {
        el.className =
          "text-on-surface-variant dark:text-outline-variant font-body-md hover:text-on-surface cursor-pointer";
      }
    });
  }

  function wireQueueControls() {
    if (!isQueuePage()) return;

    // Wire Zone filter tabs in Top Header (All Zones, Downtown, Midtown, Decatur)
    const headerZoneContainer = document.querySelector("header .hidden.lg\\:flex.items-center.gap-4");
    if (headerZoneContainer && !headerZoneContainer.hasAttribute("data-wired")) {
      headerZoneContainer.setAttribute("data-wired", "1");
      headerZoneContainer.querySelectorAll("span, a, button").forEach((el) => {
        const text = el.textContent.trim();
        if (["All Zones", "Downtown", "Midtown", "Decatur"].includes(text)) {
          el.setAttribute("data-zone-btn", text);
          el.addEventListener("click", (e) => {
            e.preventDefault();
            APP_STATE.active_zone_filter = text;
            saveBrokerState(APP_STATE, false);
            updateZoneFilterButtons();
            renderQueuePage();
          });
        }
      });
      updateZoneFilterButtons();
    }

    // Wire Search Input
    const searchInput = document.querySelector('header input[type="text"]');
    if (searchInput && !searchInput.hasAttribute("data-wired")) {
      searchInput.setAttribute("data-wired", "1");
      searchInput.value = APP_STATE.search_query || "";
      searchInput.addEventListener("input", () => {
        APP_STATE.search_query = searchInput.value;
        saveBrokerState(APP_STATE, false);
        renderQueuePage();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 6. DYNAMIC MATCH BRIEF RENDERER (match-brief-spinach.html & match-brief-deli.html)
  // ---------------------------------------------------------------------------
  function renderMatchBriefPage() {
    if (!isMatchBriefPage()) return;
    updateSidebarBadge();

    const offerKey = getActiveOfferKey();
    const offer = APP_STATE.offers[offerKey];
    if (!offer || !offer.primary_match) return;
    const pm = offer.primary_match;

    document.title = `${offer.offer_code} ${offer.title} \u2014 Atlanta Surplus Broker`;

    // 1. Header Section: Breadcrumb, Quote, Donor, Tags, Countdown Box
    // Supports both match-brief-spinach.html (main > div:first-of-type) and match-brief-deli.html (main > section:first-of-type)
    const headerSec =
      document.querySelector("main > section:first-of-type") ||
      document.querySelector("main > div.bg-surface-container-lowest:first-of-type");
    if (headerSec) {
      const breadcrumbSpans = headerSec.querySelectorAll(
        "div.flex.items-center.gap-2 > span"
      );
      if (breadcrumbSpans.length >= 2) {
        breadcrumbSpans[breadcrumbSpans.length - 1].textContent = `${offer.title} \u00b7 Offer ${offer.offer_code}`;
      }

      const quoteHeading = headerSec.querySelector("h1, h2");
      if (quoteHeading) quoteHeading.textContent = offer.quote;

      const metaSpans = headerSec.querySelectorAll(
        ".flex.items-center.gap-2.flex-wrap > span, .flex.flex-wrap.items-center.gap-2 > span"
      );
      if (metaSpans.length >= 5) {
        metaSpans[0].innerHTML = `<span class="material-symbols-outlined text-[15px] text-outline">storefront</span> ${escapeHtml(offer.donor)}`;
        const icon = /shelf|ambient|room/i.test(offer.storage) ? "inventory_2" : "ac_unit";
        if (metaSpans[2]) {
          metaSpans[2].innerHTML = `<span class="material-symbols-outlined text-[14px] text-primary">${icon}</span> ${escapeHtml(offer.storage)}`;
        }
        if (metaSpans[4]) {
          metaSpans[4].innerHTML = `<span class="material-symbols-outlined text-[14px] text-outline">pallet</span> ${escapeHtml(offer.pallets)}`;
        }
      }

      const countdownBox = headerSec.querySelector(
        ".min-w-\\[220px\\], .min-w-\\[240px\\]"
      );
      if (countdownBox) {
        const timeEl = countdownBox.querySelector(
          ".text-tabular-data-lg, .font-tabular-data-lg, .text-2xl"
        );
        const subEl = countdownBox.querySelector(
          "p.text-body-sm, span.text-body-sm:last-child, .text-\\[11px\\]"
        );
        if (timeEl) {
          timeEl.textContent =
            offer.status === "donated"
              ? "DONATED \u00b7 COMPLETED"
              : `${offer.time_left} \u00b7 leaves dock by ${offer.shutoff_time}`;
        }
        if (subEl) {
          subEl.textContent =
            offer.status === "donated"
              ? "Verified delivery completed"
              : `USDA FoodKeeper verified \u00b7 ${offer.status_label}`;
        }
      }
    }

    // 2. Pipeline Strip Counts
    const pipeSec =
      document.querySelectorAll("main > section")[1] ||
      document.querySelectorAll("main > div.bg-surface-container-lowest")[1];
    if (pipeSec && offer.pipeline) {
      const stepLabels = pipeSec.querySelectorAll(
        ".font-headline-sm, .font-medium.text-on-surface-variant, .font-semibold.text-on-secondary-container"
      );
      if (stepLabels[0]) {
        stepLabels[0].textContent = `1. Vector Search (${offer.pipeline.semantic || 60} similar profiles)`;
      }
      if (stepLabels[1]) {
        stepLabels[1].textContent = `2. Constraint Filter (${offer.pipeline.feasible || 20} can take it in time)`;
      }
      if (stepLabels[2]) {
        stepLabels[2].textContent = `3. Ranked Top ${offer.pipeline.recommended || 3}`;
      }
    }

    // 3. Primary Recommended Match Card (.border-l-4.border-l-primary)
    const primaryCard = document.querySelector(".border-l-4.border-l-primary");
    if (primaryCard) {
      // A. Top Live Offer State Banner
      let statusBanner = document.getElementById("live-offer-state-banner");
      if (!statusBanner) {
        statusBanner = document.createElement("div");
        statusBanner.id = "live-offer-state-banner";
        primaryCard.insertBefore(statusBanner, primaryCard.firstChild);
      }
      statusBanner.innerHTML = buildMatchBriefStateBannerHtml(offer);
      wireStateBannerActions(statusBanner, offer.key);

      // B. Recipient Name (h3 on spinach, h2 on deli)
      const nameHeading = primaryCard.querySelector("h2, h3");
      if (nameHeading) nameHeading.textContent = pm.name;

      // C. Archetype Badge
      const archBadge = primaryCard.querySelector(
        "span.bg-tertiary-fixed, span.text-on-surface-variant.border.border-outline-variant"
      );
      if (archBadge) archBadge.textContent = pm.archetype || "VERIFIED RECIPIENT";

      // D. Address
      const addrEl =
        primaryCard.querySelector("p.text-outline") ||
        primaryCard.querySelector("div.flex.items-center.gap-1.text-on-surface-variant");
      if (addrEl) {
        addrEl.innerHTML = `<span class="material-symbols-outlined text-[15px] align-text-bottom">location_on</span> ${escapeHtml(pm.address)}`;
      }

      // E. 2-Column Info Boxes: WHY THEM & WHAT THEY CAN TAKE
      const infoBoxes = primaryCard.querySelectorAll(
        ".grid.grid-cols-1.md\\:grid-cols-2.gap-4 > div"
      );
      if (infoBoxes[0]) {
        const whyP = infoBoxes[0].querySelector("p");
        if (whyP) whyP.textContent = pm.reason;
      }
      if (infoBoxes[1]) {
        const takeP = infoBoxes[1].querySelector("p");
        if (takeP) {
          takeP.textContent = `${pm.equipment || "Verified Cold Chain"} \u00b7 ${pm.capacity_Fit || "Fits full load"} \u00b7 Receiving window: ${pm.window || "9:00 AM \u2013 7:00 PM"} (${pm.window_note || "Open now"}).`;
        }
      }

      // F. The Clock / Timeline Box
      const clockStatusRight = primaryCard.querySelector(
        ".text-label-badge.text-primary.font-semibold, .font-tabular-data-sm.text-primary.font-semibold"
      );
      if (clockStatusRight) {
        clockStatusRight.textContent = `Est. pickup ${pm.pickup_eta || "4:15 PM"} \u00b7 ${pm.buffer_mins || 90}m safety buffer before ${offer.shutoff_time}`;
      }

      // G. Who It Helps (Equity & Impact)
      const allBoxes = Array.from(primaryCard.querySelectorAll("div.bg-surface.border"));
      const equityBox = allBoxes.find((b) => b.textContent.includes("WHO IT HELPS"));
      if (equityBox) {
        const eqP = equityBox.querySelector("p");
        if (eqP) {
          eqP.innerHTML = `Census Tract <strong>${escapeHtml(pm.tract_id || "13121001900")}</strong> \u00b7 <strong>${escapeHtml(pm.insecurity_rate || "24.2%")}</strong> food insecurity (${escapeHtml(pm.insecurity_note || "above 12.8% metro avg")}), <strong>${escapeHtml(pm.no_vehicle_rate || "26.4%")}</strong> households without a vehicle, and <strong>${escapeHtml(pm.poverty_rate || "28.9%")}</strong> poverty rate.`;
        }
      }

      // H. SMS Textarea (works on both spinach #dispatch-sms and deli readonly textarea)
      const smsBox = primaryCard.querySelector("textarea");
      if (smsBox) {
        smsBox.id = "dispatch-sms";
        smsBox.removeAttribute("readonly");
        if (! offer.active_split_mode) {
          smsBox.value = pm.sms || "";
        }
      }

      // I. Update the "Mark as sent" button & Inline Dispatch Lifecycle Bar RIGHT AT THE BUTTON
      updatePrimaryActionButtonBar(primaryCard, offer);
    }

    // 4. Split Load Card ("Or split it" on match-brief-spinach.html)
    renderSplitLoadSection(offer);

    // 5. Standby Options 2 & 3
    renderStandbyOptionsSection(offer);

    // 6. Ruled Out Right Column
    renderRuledOutSection(offer);
  }

  function updatePrimaryActionButtonBar(primaryCard, offer) {
    const buttons = Array.from(primaryCard.querySelectorAll("button"));
    const markSentBtn = buttons.find(
      (b) =>
        b.getAttribute("data-role") === "mark-sent-btn" ||
        b.textContent.includes("Mark as sent") ||
        b.textContent.includes("Sent \u00b7 Awaiting") ||
        b.textContent.includes("Accepted by") ||
        b.textContent.includes("Donated & Verified")
    );

    if (markSentBtn) {
      markSentBtn.setAttribute("data-role", "mark-sent-btn");
      if (offer.status === "awaiting") {
        markSentBtn.className =
          "h-9 px-4 bg-tertiary-fixed text-on-tertiary-fixed border border-tertiary-container rounded font-headline-sm text-headline-sm font-bold flex items-center gap-1.5 cursor-pointer shadow-xs";
        markSentBtn.innerHTML = `<span class="material-symbols-outlined text-[16px]">schedule_send</span><span>Sent \u00b7 Awaiting Reply</span>`;
      } else if (offer.status === "accepted") {
        markSentBtn.className =
          "h-9 px-4 bg-secondary-container text-on-secondary-container border border-secondary rounded font-headline-sm text-headline-sm font-bold flex items-center gap-1.5 cursor-pointer shadow-xs";
        markSentBtn.innerHTML = `<span class="material-symbols-outlined text-[16px]">local_shipping</span><span>Accepted \u00b7 Driver En Route</span>`;
      } else if (offer.status === "donated") {
        markSentBtn.className =
          "h-9 px-4 bg-primary/15 text-primary border border-primary rounded font-headline-sm text-headline-sm font-bold flex items-center gap-1.5 cursor-pointer";
        markSentBtn.innerHTML = `<span class="material-symbols-outlined text-[16px]">verified</span><span>Donated & Verified</span>`;
      } else {
        markSentBtn.className =
          "h-9 px-4 bg-primary-container hover:bg-secondary text-on-primary rounded font-headline-sm text-headline-sm font-semibold flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors";
        markSentBtn.innerHTML = `<span class="material-symbols-outlined text-[16px]" data-icon="check">check</span><span>Mark as sent</span>`;
      }
    }

    // Inject/update inline workflow bar directly below the button bar so the user sees it immediately without scrolling
    let inlineBar = document.getElementById("inline-dispatch-workflow-bar");
    if (!inlineBar) {
      inlineBar = document.createElement("div");
      inlineBar.id = "inline-dispatch-workflow-bar";
      primaryCard.appendChild(inlineBar);
    }
    inlineBar.innerHTML = buildMatchBriefStateBannerHtml(offer);
    wireStateBannerActions(inlineBar, offer.key);
  }

  function buildMatchBriefStateBannerHtml(offer) {
    const recipient = escapeHtml(
      offer.active_split_mode && offer.split_plan && offer.split_plan.length
        ? offer.split_plan.map((s) => s.name).join(" + ")
        : offer.primary_match.name
    );

    if (offer.status === "awaiting") {
      return `
        <div class="my-2 p-3 rounded bg-tertiary-fixed/60 border-2 border-tertiary-container flex flex-wrap items-center justify-between gap-3 shadow-xs">
          <div class="flex items-center gap-2.5">
            <span class="material-symbols-outlined text-tertiary text-xl">hourglass_top</span>
            <div>
              <p class="text-xs font-bold uppercase tracking-wider text-tertiary">DISPATCH SENT TO ${recipient} \u00b7 AWAITING PANTRY REPLY</p>
              <p class="text-xs text-on-surface">Next step: Confirm when ${recipient} replies YES (or rotate if they decline).</p>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <button data-banner-action="accept" class="px-3.5 py-1.5 rounded bg-primary text-on-primary text-xs font-bold hover:bg-primary-container cursor-pointer flex items-center gap-1 shadow-xs">
              <span class="material-symbols-outlined text-sm">check_circle</span> Pantry Replied YES (Mark Accepted)
            </button>
            <button data-banner-action="decline" class="px-3 py-1.5 rounded border border-outline-variant bg-surface-container-lowest text-on-surface text-xs font-semibold hover:bg-surface-container cursor-pointer">
              They Declined \u2192 Next Option
            </button>
          </div>
        </div>
      `;
    }

    if (offer.status === "accepted") {
      return `
        <div class="my-2 p-3 rounded bg-secondary-container/80 border-2 border-secondary flex flex-wrap items-center justify-between gap-3 shadow-xs">
          <div class="flex items-center gap-2.5">
            <span class="material-symbols-outlined text-secondary text-xl" style="font-variation-settings: 'FILL' 1;">local_shipping</span>
            <div>
              <p class="text-xs font-bold uppercase tracking-wider text-on-secondary-container">ACCEPTED BY ${recipient} \u00b7 PICKUP SCHEDULED (${escapeHtml(offer.shutoff_time)})</p>
              <p class="text-xs text-on-secondary-container">Volunteer driver ${escapeHtml(offer.driver_name || "Marcus V.")} dispatched. Mark as Donated once delivered.</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button data-banner-action="donated" class="px-3.5 py-1.5 rounded bg-primary text-on-primary text-xs font-bold hover:bg-primary-container cursor-pointer flex items-center gap-1 shadow-xs">
              <span class="material-symbols-outlined text-sm">verified</span> Mark as Donated & Completed
            </button>
          </div>
        </div>
      `;
    }

    if (offer.status === "donated") {
      return `
        <div class="my-2 p-3 rounded bg-primary/15 border-2 border-primary flex flex-wrap items-center justify-between gap-3 shadow-xs">
          <div class="flex items-center gap-2.5">
            <span class="material-symbols-outlined text-primary text-xl" style="font-variation-settings: 'FILL' 1;">workspace_premium</span>
            <div>
              <p class="text-xs font-bold uppercase tracking-wider text-primary">DONATED & VERIFIED \u00b7 RESCUE COMPLETED</p>
              <p class="text-xs text-on-surface">${escapeHtml(offer.pallets)} of ${escapeHtml(offer.category)} rescued and delivered to <strong>${recipient}</strong>.</p>
            </div>
          </div>
          <a href="queue.html" class="px-3.5 py-1.5 rounded bg-primary text-on-primary text-xs font-bold hover:bg-primary-container flex items-center gap-1">
            <span class="material-symbols-outlined text-sm">arrow_back</span> Return to Live Queue
          </a>
        </div>
      `;
    }

    // urgent or ready
    return `
      <div class="my-2 p-2.5 rounded bg-surface-container-low border border-outline-variant/60 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 text-xs text-on-surface-variant">
          <span class="w-2 h-2 rounded-full ${offer.status === "urgent" ? "bg-error animate-pulse" : "bg-primary"}"></span>
          <span>Live Status: <strong class="text-on-surface">${escapeHtml(offer.status_label)}</strong> \u00b7 BigQuery <code>VECTOR_SEARCH</code> + USDA FoodKeeper + ACS Equity Verified</span>
        </div>
        <button data-banner-action="live-ai" class="px-2.5 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 text-xs font-semibold flex items-center gap-1 cursor-pointer">
          <span class="material-symbols-outlined text-xs">smart_toy</span> Query Live Cloud Run Agent
        </button>
      </div>
    `;
  }

  function wireStateBannerActions(bannerEl, offerKey) {
    bannerEl.querySelectorAll("[data-banner-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const act = btn.getAttribute("data-banner-action");
        if (act === "accept") markOfferAccepted(offerKey);
        else if (act === "decline") rotateToNextOption(offerKey, 0);
        else if (act === "donated") markOfferDonated(offerKey);
        else if (act === "live-ai") openAgentDrawerForOffer(offerKey);
      });
    });
  }

  function renderSplitLoadSection(offer) {
    const splitHeader = Array.from(document.querySelectorAll("h3, h4")).find((el) =>
      el.textContent.includes("Or split it")
    );
    const splitCard = splitHeader && splitHeader.closest(".bg-surface-container-lowest");
    if (!splitCard) return;

    if (!offer.split_plan || offer.split_plan.length < 2) {
      splitCard.style.display = "none";
      return;
    }
    splitCard.style.display = "";

    const stop1 = offer.split_plan[0];
    const stop2 = offer.split_plan[1];
    const stopCards = splitCard.querySelectorAll(".grid.grid-cols-1.md\\:grid-cols-2 > div");
    if (stopCards[0] && stop1) {
      const h4 = stopCards[0].querySelector("h4, h5");
      const sharePill = stopCards[0].querySelector("span.bg-secondary-container, .font-mono.font-bold.text-primary");
      if (h4) h4.textContent = `1. ${stop1.name}`;
      if (sharePill) sharePill.textContent = stop1.share;
    }
    if (stopCards[1] && stop2) {
      const h4 = stopCards[1].querySelector("h4, h5");
      const sharePill = stopCards[1].querySelector("span.bg-secondary-container, .font-mono.font-bold.text-primary");
      if (h4) h4.textContent = `2. ${stop2.name}`;
      if (sharePill) sharePill.textContent = stop2.share;
    }
  }

  function renderStandbyOptionsSection(offer) {
    const standbyHeader = Array.from(document.querySelectorAll("h3, h4")).find((el) =>
      el.textContent.includes("Next options")
    );
    const container = standbyHeader && standbyHeader.parentElement;
    if (!container || !offer.next_options) return;

    const cards = container.querySelectorAll(".grid > div");
    offer.next_options.slice(0, 2).forEach((opt, idx) => {
      const card = cards[idx];
      if (!card) return;
      card.setAttribute("data-standby-index", String(idx));

      const titleEl = card.querySelector("h4, h5");
      if (titleEl) titleEl.textContent = opt.name;

      const addrEl =
        card.querySelector("p.text-outline") ||
        card.querySelector("div.flex.items-center.gap-1 > span:last-child") ||
        card.querySelector("p.text-\\[12px\\], p.text-xs");
      if (addrEl) {
        addrEl.textContent = opt.address;
      }

      const reasonBox = card.querySelector("div.bg-surface.border p, p.text-on-surface.pt-0\\.5");
      if (reasonBox && opt.reason) {
        reasonBox.textContent = opt.reason;
      }
    });
  }

  function renderRuledOutSection(offer) {
    if (!offer.ruled_out) return;
    const ruledHeader = Array.from(document.querySelectorAll("h3")).find((el) =>
      el.textContent.includes("Ruled out")
    );
    const ruledCol = ruledHeader && ruledHeader.closest("aside, .lg\\:col-span-4, .col-span-12");
    if (!ruledCol) return;

    const totalRuledOut =
      (offer.pipeline && (offer.pipeline.semantic || 60) - (offer.pipeline.feasible || 20)) ||
      offer.ruled_out.length;

    const countBadge = ruledHeader.querySelector("span:nth-child(2)");
    if (countBadge) {
      countBadge.textContent = String(totalRuledOut);
    }

    const listEl = ruledCol.querySelector(".divide-y, .space-y-3");
    if (listEl) {
      listEl.innerHTML = offer.ruled_out
        .slice(0, 5)
        .map(
          (item) => `
          <div class="p-3 rounded bg-surface border border-outline-variant/80 space-y-1.5">
            <div class="flex items-start justify-between gap-2">
              <span class="font-semibold text-body-sm text-on-surface line-through decoration-outline">${escapeHtml(item.name)}</span>
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold ${
                item.color === "error"
                  ? "bg-error-container text-on-error-container"
                  : "bg-surface-container-high text-on-surface-variant"
              } shrink-0">
                <span class="material-symbols-outlined text-[12px]">${escapeHtml(item.icon || "block")}</span>
                ${escapeHtml(item.tag)}
              </span>
            </div>
            <p class="text-[12px] text-on-surface-variant leading-snug">${escapeHtml(item.detail)}</p>
          </div>
        `
        )
        .join("\n");
    }
  }

  // ---------------------------------------------------------------------------
  // 7. MATCH BRIEF BUTTON WIRING & NAVIGATION
  // ---------------------------------------------------------------------------
  function wireMatchBriefButtons() {
    if (!isMatchBriefPage()) return;
    const offerKey = getActiveOfferKey();

    document.querySelectorAll("button, a").forEach((btn) => {
      if (btn.hasAttribute("data-mb-wired")) return;
      const text = (btn.textContent || "").trim();

      if (text.includes("Copy message")) {
        btn.setAttribute("data-mb-wired", "1");
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const smsBox = document.getElementById("dispatch-sms") || document.querySelector("textarea");
          const msg = smsBox ? smsBox.value : "";
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(msg).catch(() => {});
          }
          showToast("Dispatch SMS copied to clipboard!", "content_copy");
        });
      } else if (
        text.includes("Mark as sent") ||
        btn.getAttribute("data-role") === "mark-sent-btn"
      ) {
        btn.setAttribute("data-mb-wired", "1");
        btn.setAttribute("data-role", "mark-sent-btn");
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const currentOffer = APP_STATE.offers[offerKey];
          if (currentOffer && currentOffer.status === "awaiting") {
            markOfferAccepted(offerKey);
            return;
          }
          if (currentOffer && currentOffer.status === "accepted") {
            markOfferDonated(offerKey);
            return;
          }
          const smsBox = document.getElementById("dispatch-sms") || document.querySelector("textarea");
          markOfferSent(offerKey, smsBox ? smsBox.value : undefined);
        });
      } else if (text.includes("Use split plan")) {
        btn.setAttribute("data-mb-wired", "1");
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          activateSplitPlan(offerKey);
        });
      } else if (text.includes("They said no")) {
        btn.setAttribute("data-mb-wired", "1");
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          rotateToNextOption(offerKey, 0);
        });
      } else if (text.includes("Switch to this match") || text.includes("Inspect route")) {
        btn.setAttribute("data-mb-wired", "1");
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const parentCard = btn.closest("[data-standby-index], .bg-surface-container-lowest");
          const idx = parentCard && parentCard.hasAttribute("data-standby-index")
            ? Number(parentCard.getAttribute("data-standby-index"))
            : 0;
          rotateToNextOption(offerKey, idx);
        });
      } else if (text.includes("ruled out agencies")) {
        btn.setAttribute("data-mb-wired", "1");
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          openRuledOutModal(APP_STATE.offers[offerKey]);
        });
      }
    });

    // Wire Back Arrow & Live Queue links in Breadcrumb
    document.querySelectorAll('[data-icon="arrow_back"]').forEach((icon) => {
      if (icon.hasAttribute("data-mb-wired")) return;
      icon.setAttribute("data-mb-wired", "1");
      icon.addEventListener("click", () => {
        window.location.href = "queue.html";
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 8. LIVE CLOUD RUN ADK AGENT SLIDE-OUT DRAWER
  // ---------------------------------------------------------------------------
  function ensureAgentLauncherButton() {
    if (document.getElementById("adk-agent-launcher")) return;
    const launcher = document.createElement("button");
    launcher.id = "adk-agent-launcher";
    launcher.type = "button";
    launcher.className =
      "fixed bottom-5 right-5 z-40 bg-primary hover:bg-primary-container text-on-primary px-4 py-2.5 rounded-full shadow-lg flex items-center gap-2 text-xs font-bold tracking-wide transition-all border border-on-primary/20 cursor-pointer";
    launcher.innerHTML = `
      <span class="w-2 h-2 rounded-full bg-emerald-300 animate-pulse"></span>
      <span class="material-symbols-outlined text-base">smart_toy</span>
      <span>Ask Broker Agent (Live Cloud Run AI)</span>
    `;
    launcher.addEventListener("click", () => {
      const offerKey = isMatchBriefPage() ? getActiveOfferKey() : null;
      openAgentDrawerForOffer(offerKey);
    });
    document.body.appendChild(launcher);
  }

  function buildDynamicAgentSuggestions(offerKey) {
    const mapCtx = window.__BROKER_LATEST_MAP_DATA;
    if (mapCtx && window.location.pathname.includes("map")) {
      const selected = mapCtx.selected_posting;
      const postings = mapCtx.postings || [];
      const visible = mapCtx.visibleRecipients || mapCtx.recipients || [];
      const allRecs = mapCtx.all_recipients || visible;
      const track = mapCtx.activeTrack || mapCtx.track || "RETAIL";

      const topViable = visible.find((r) => r.viable) || allRecs.find((r) => r.viable);
      const secondViable =
        visible.filter((r) => r.viable)[1] || allRecs.filter((r) => r.viable)[1];
      const topRuledOut =
        visible.find((r) => !r.viable || r.status_category === "ruled_out") ||
        allRecs.find((r) => !r.viable || r.status_category === "ruled_out");
      const firstPost = selected || postings[0];
      const secondPost = postings.find((p) => !firstPost || p.posting_id !== firstPost.posting_id) || postings[1];

      const suggestions = [];

      if (firstPost) {
        const hrs = Number(firstPost.hours_remaining ?? firstPost.hours_available ?? 6);
        suggestions.push({
          label: `🎯 Match #${firstPost.posting_id} (${firstPost.track} · ${hrs}h): ${firstPost.posting_text.slice(0, 28)}...`,
          prompt: `Match surplus posting #${firstPost.posting_id} ("${firstPost.posting_text}", storage: ${firstPost.storage_state}, window: ${hrs}h${firstPost.request_id ? ", request_id: " + firstPost.request_id : ""}) and rank the top viable recipients.`,
        });
      }

      if (topViable && topRuledOut) {
        suggestions.push({
          label: `🔍 Why ${topViable.name.slice(0, 18)} vs. ${topRuledOut.name.slice(0, 16)}?`,
          prompt: `For ${firstPost ? `"${firstPost.posting_text}"` : `the ${track} track`}, explain why "${topViable.name}" (${topViable.cold_storage} storage, ${topViable.max_pallets}p max, ${topViable.pickup_window_hours}h window) is a fit while "${topRuledOut.name}" (${topRuledOut.ruled_out_reason || topRuledOut.cold_storage}) is ruled out.`,
        });
      } else if (secondPost) {
        const hrs2 = Number(secondPost.hours_remaining ?? secondPost.hours_available ?? 8);
        suggestions.push({
          label: `📦 Match #${secondPost.posting_id} (${secondPost.track} · ${hrs2}h): ${secondPost.posting_text.slice(0, 26)}...`,
          prompt: `Match surplus posting #${secondPost.posting_id} ("${secondPost.posting_text}", storage: ${secondPost.storage_state}, window: ${hrs2}h) and rank the top viable recipients.`,
        });
      }

      if (topViable) {
        suggestions.push({
          label: `⚖️ Tract Equity: ${topViable.name.slice(0, 22)}`,
          prompt: `Call get_recipient_tract_equity for "${topViable.name}"${secondViable ? ` and compare its census tract poverty_rate, no_vehicle_rate, and assistance_rate against "${secondViable.name}"` : ""} relative to the Atlanta metro baseline.`,
        });
      }

      if (firstPost) {
        suggestions.push({
          label: `⏱️ Shelf Life & Split Plan (#${firstPost.posting_id})`,
          prompt: `Check USDA FoodKeeper shelf life for "${firstPost.foodkeeper_product || firstPost.posting_text}" (${firstPost.storage_state}, ${firstPost.hours_remaining}h donor deadline) and propose a multi-stop split plan if needed.`,
        });
      } else if (postings.length > 0) {
        suggestions.push({
          label: `📋 Recommend Across ${postings.length} ${track} Postings`,
          prompt: `Call recommend_open_postings and tell me who should get each open ${track} posting first and whether any two postings share the same #1 pick.`,
        });
      }

      return {
        contextLabel: selected
          ? `Suggested from Posting #${selected.posting_id} (${visible.length} recipients on map)`
          : `Suggested from live ${track} API response (${postings.length} postings · ${visible.length} recipients)`,
        defaultPrompt: suggestions[0]?.prompt || "What should we do with today's open postings?",
        suggestions,
      };
    }

    // Queue / Match Brief context from APP_STATE
    const offer = offerKey ? APP_STATE.offers[offerKey] : null;
    const offersList = Object.values(APP_STATE.offers || {});
    const primaryOffer = offer || offersList[0];
    const suggestions = [];

    if (primaryOffer) {
      suggestions.push({
        label: `🎯 Match ${primaryOffer.offer_code} (${primaryOffer.category})`,
        prompt: `Match this Atlanta surplus posting and check shelf life & census tract equity: ${primaryOffer.quote} (Category: ${primaryOffer.category}, Storage: ${primaryOffer.storage}, Volume: ${primaryOffer.pallets}, Donor: ${primaryOffer.donor})`,
      });
      if (primaryOffer.primary_match && primaryOffer.ruled_out?.[0]) {
        suggestions.push({
          label: `🔍 Why ${primaryOffer.primary_match.name.slice(0, 18)} vs. ${primaryOffer.ruled_out[0].name.slice(0, 16)}?`,
          prompt: `Why is "${primaryOffer.primary_match.name}" recommended for ${primaryOffer.offer_code} while "${primaryOffer.ruled_out[0].name}" was ruled out?`,
        });
      }
      if (primaryOffer.primary_match) {
        suggestions.push({
          label: `⚖️ Equity Audit: ${primaryOffer.primary_match.name.slice(0, 20)}`,
          prompt: `Call get_recipient_tract_equity for "${primaryOffer.primary_match.name}" and report its poverty_rate, no_vehicle_rate, and assistance_rate vs. the Atlanta metro baseline.`,
        });
      }
    }
    suggestions.push({
      label: `📋 Recommend All Open Postings`,
      prompt: `Call recommend_open_postings and list the top recommended recipient, collection mode, and hours remaining for each open posting.`,
    });

    return {
      contextLabel: primaryOffer
        ? `Suggested from ${primaryOffer.offer_code} API state`
        : "Suggested from live Queue API state",
      defaultPrompt: suggestions[0]?.prompt || "What should we do with today's open postings?",
      suggestions,
    };
  }

  function renderAgentSuggestionChips(drawer, offerKey) {
    const container = drawer?.querySelector("#agent-dynamic-suggestions");
    const labelEl = drawer?.querySelector("#agent-suggestions-label");
    if (!container) return;

    const { contextLabel, defaultPrompt, suggestions } = buildDynamicAgentSuggestions(offerKey);
    if (labelEl) labelEl.textContent = contextLabel;

    const input = drawer.querySelector("#agent-prompt-input");
    if (input && !input.dataset.userEdited) {
      input.value = defaultPrompt;
    }

    container.innerHTML = suggestions
      .map(
        (s, idx) => `
        <button type="button" data-dynamic-prompt-idx="${idx}" class="px-2.5 py-1 rounded bg-surface-container-lowest border border-outline-variant hover:border-primary hover:bg-surface text-[11px] font-medium text-on-surface cursor-pointer text-left transition-colors">
          ${escapeHtml(s.label)}
        </button>
      `
      )
      .join("");

    container.querySelectorAll("[data-dynamic-prompt-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-dynamic-prompt-idx"));
        const chosen = suggestions[idx];
        if (!chosen) return;
        const promptInput = drawer.querySelector("#agent-prompt-input");
        if (promptInput) {
          promptInput.value = chosen.prompt;
          drawer.querySelector("#agent-chat-form")?.dispatchEvent(new Event("submit"));
        }
      });
    });
  }

  window.addEventListener("broker-map:context-updated", () => {
    const drawer = document.getElementById("cloud-run-agent-drawer");
    if (drawer) {
      renderAgentSuggestionChips(drawer, null);
    }
  });

  function openAgentDrawerForOffer(offerKey) {
    let drawer = document.getElementById("cloud-run-agent-drawer");
    if (!drawer) {
      drawer = document.createElement("div");
      drawer.id = "cloud-run-agent-drawer";
      drawer.className =
        "fixed inset-y-0 right-0 z-50 w-full max-w-xl bg-surface-container-lowest border-l border-outline-variant shadow-2xl flex flex-col";
      document.body.appendChild(drawer);
    }

    const { contextLabel, defaultPrompt } = buildDynamicAgentSuggestions(offerKey);

    drawer.innerHTML = `
      <div class="p-4 bg-primary text-on-primary flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <span class="material-symbols-outlined text-xl">smart_toy</span>
          <div>
            <div class="flex items-center gap-2">
              <h3 class="font-bold text-sm tracking-wide">Resilient Food Equity & Surplus Broker Agent</h3>
              <span class="px-1.5 py-0.5 text-[10px] font-mono bg-emerald-400/20 text-emerald-100 rounded border border-emerald-300/30">LIVE CLOUD RUN</span>
            </div>
            <p class="text-[11px] text-on-primary/80 font-mono">gemini-3.8-flash \u00b7 BigQuery a4i_food \u00b7 VECTOR_SEARCH</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <a href="${CLOUD_RUN_AGENT_URL}/dev-ui/?app=agent" target="_blank" rel="noopener" class="px-2 py-1 rounded bg-on-primary/10 hover:bg-on-primary/20 text-[11px] font-semibold flex items-center gap-1 text-on-primary" title="Open full ADK Developer UI on Cloud Run">
            <span>ADK UI</span>
            <span class="material-symbols-outlined text-xs">open_in_new</span>
          </a>
          <button id="close-agent-drawer-btn" class="p-1 rounded hover:bg-on-primary/10 text-on-primary cursor-pointer">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>

      <div class="p-3 bg-surface-container-low border-b border-outline-variant space-y-2">
        <div class="flex items-center justify-between">
          <p id="agent-suggestions-label" class="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">${escapeHtml(contextLabel)}</p>
          <span class="font-mono text-[10px] text-primary">Click to run</span>
        </div>
        <div id="agent-dynamic-suggestions" class="flex flex-wrap gap-1.5"></div>
      </div>

      <div id="agent-chat-messages" class="flex-1 overflow-y-auto p-4 space-y-3 bg-background">
        <div class="bg-surface-container-lowest border border-outline-variant rounded p-3 text-xs space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="font-bold text-primary">Connected to Cloud Run ADK Endpoint</span>
            <span class="font-mono text-[10px] text-on-surface-variant">${CLOUD_RUN_AGENT_URL.replace("https://", "")}</span>
          </div>
          <p class="text-on-surface-variant leading-relaxed">
            Suggested queries above update automatically from the current API response. Click any chip or type below to run live BigQuery tool calls.
          </p>
        </div>
      </div>

      <form id="agent-chat-form" class="p-3 bg-surface-container-lowest border-t border-outline-variant space-y-2">
        <textarea id="agent-prompt-input" rows="3" class="w-full bg-background border border-outline-variant rounded p-2.5 text-xs text-on-surface focus:border-primary focus:outline-none font-mono" placeholder="Ask the Atlanta Food Rescue Broker Agent...">${escapeHtml(defaultPrompt)}</textarea>
        <div class="flex items-center justify-between">
          <span id="agent-status-indicator" class="text-[11px] text-on-surface-variant font-mono">Ready</span>
          <button type="submit" id="agent-send-btn" class="bg-primary hover:bg-primary-container text-on-primary px-4 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 cursor-pointer">
            <span class="material-symbols-outlined text-sm">send</span>
            <span>Run Live Agent Query</span>
          </button>
        </div>
      </form>
    `;

    document.getElementById("close-agent-drawer-btn").addEventListener("click", () => {
      drawer.remove();
    });

    const promptInputEl = document.getElementById("agent-prompt-input");
    promptInputEl?.addEventListener("input", () => {
      promptInputEl.dataset.userEdited = "true";
    });

    renderAgentSuggestionChips(drawer, offerKey);

    const form = document.getElementById("agent-chat-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("agent-prompt-input");
      const statusEl = document.getElementById("agent-status-indicator");
      const sendBtn = document.getElementById("agent-send-btn");
      const chatBox = document.getElementById("agent-chat-messages");
      const text = (input.value || "").trim();
      if (!text) return;

      // Append user message
      const userBubble = document.createElement("div");
      userBubble.className = "bg-primary/10 border border-primary/30 rounded p-3 text-xs text-on-surface ml-6";
      userBubble.innerHTML = `<p class="font-bold text-[10px] uppercase text-primary mb-1">Coordinator Query</p><p>${escapeHtml(text)}</p>`;
      chatBox.appendChild(userBubble);
      chatBox.scrollTop = chatBox.scrollHeight;

      sendBtn.disabled = true;
      sendBtn.classList.add("opacity-60");

      try {
        const result = await callCloudRunAgent(text, (msg) => {
          statusEl.textContent = msg;
        });

        const botBubble = document.createElement("div");
        botBubble.className = "bg-surface-container-lowest border border-outline-variant rounded p-3.5 text-xs space-y-2.5 mr-2 shadow-xs";

        let toolsHtml = "";
        if (result.toolCalls.length > 0) {
          toolsHtml = `
            <div class="flex flex-wrap gap-1 pb-2 border-b border-outline-variant/50">
              ${result.toolCalls
                .map(
                  (tc) =>
                    `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container font-mono text-[10px] font-bold">
                      <span class="material-symbols-outlined text-[11px]">database</span> ${escapeHtml(tc.name)}()
                    </span>`
                )
                .join("")}
            </div>
          `;
        }

        // Check if match_surplus_posting returned live candidates we can apply
        const matchResp = result.toolResponses.find((tr) => tr.name === "match_surplus_posting");
        const targetKey = offerKey || (text.toLowerCase().includes("deli") ? "deli" : text.toLowerCase().includes("dairy") ? "dairy" : "spinach");

        let applyBtnHtml = "";
        const followUps = [];
        if (matchResp && matchResp.response && Array.isArray(matchResp.response.ranked_matches)) {
          const ranked = matchResp.response.ranked_matches;
          const elims = matchResp.response.eliminated_near_misses || [];
          const top1 = ranked[0];
          const top2 = ranked[1];
          const elim1 = elims[0];

          const btnLabel = window.location.pathname.includes("map")
            ? "Focus Matches on Map"
            : `Apply Live Match to ${APP_STATE.offers[targetKey]?.offer_code || "Offer"}`;

          applyBtnHtml = `
            <div class="pt-2 border-t border-outline-variant/50 flex items-center justify-between">
              <span class="text-[11px] text-primary font-semibold">Live BigQuery returned ${ranked.length} ranked matches</span>
              <button type="button" class="apply-live-bq-btn px-3 py-1 rounded bg-primary text-on-primary text-[11px] font-bold cursor-pointer hover:bg-primary-container">
                ${escapeHtml(btnLabel)}
              </button>
            </div>
          `;

          if (top1) {
            followUps.push({
              label: `❌ ${top1.name.slice(0, 18)} said no → Who's next?`,
              prompt: `"${top1.name}" (recipient_id ${top1.recipient_id}) declined. Record the decline and run match_surplus_posting excluding recipient_id ${top1.recipient_id} to promote #2${top2 ? ` ("${top2.name}")` : ""}.`,
            });
            followUps.push({
              label: `⚖️ Neighborhood Equity: ${top1.name.slice(0, 20)}`,
              prompt: `Call get_recipient_tract_equity for "${top1.name}" (recipient_id ${top1.recipient_id}) and compare its tract poverty_rate and no_vehicle_rate to the Atlanta metro average.`,
            });
          }
          if (elim1) {
            followUps.push({
              label: `🚫 Why not ${elim1.name.slice(0, 20)}?`,
              prompt: `Why was "${elim1.name}" ruled out for "${matchResp.response.posting_text}" despite ranking #${elim1.raw_vector_rank} in semantic search?`,
            });
          }
        }

        const followUpHtml =
          followUps.length > 0
            ? `
          <div class="pt-2 border-t border-outline-variant/50 space-y-1.5">
            <div class="text-[10px] font-mono font-bold uppercase text-on-surface-variant">Suggested Follow-Up Queries</div>
            <div class="flex flex-wrap gap-1.5">
              ${followUps
                .map(
                  (f, i) => `
                <button type="button" data-followup-idx="${i}" class="px-2 py-1 rounded bg-surface border border-outline-variant hover:border-primary text-[11px] font-medium text-on-surface cursor-pointer">
                  ${escapeHtml(f.label)}
                </button>`
                )
                .join("")}
            </div>
          </div>`
            : "";

        botBubble.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="font-bold text-primary flex items-center gap-1">
              <span class="material-symbols-outlined text-sm">verified</span> Broker Agent Response
            </span>
            <span class="font-mono text-[10px] text-on-surface-variant">Session ${escapeHtml((result.sessionId || "").slice(0, 8))}</span>
          </div>
          ${toolsHtml}
          <div class="text-on-surface leading-relaxed whitespace-pre-wrap font-sans">${formatAgentMarkdown(result.finalReply)}</div>
          ${applyBtnHtml}
          ${followUpHtml}
        `;
        chatBox.appendChild(botBubble);
        chatBox.scrollTop = chatBox.scrollHeight;

        botBubble.querySelectorAll("[data-followup-idx]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const idx = Number(btn.getAttribute("data-followup-idx"));
            const f = followUps[idx];
            if (!f) return;
            input.value = f.prompt;
            form.dispatchEvent(new Event("submit"));
          });
        });

        // Notify the Map View (if open on map.html) so it immediately plots & focuses the Agent's matches
        window.dispatchEvent(
          new CustomEvent("broker-agent:result", {
            detail: {
              promptText: text,
              result,
              matchResponse: matchResp ? matchResp.response : null,
              applied: false,
            },
          })
        );

        const applyBtn = botBubble.querySelector(".apply-live-bq-btn");
        if (applyBtn && matchResp) {
          applyBtn.addEventListener("click", () => {
            applyLiveAgentMatchToOffer(targetKey, matchResp.response);
            window.dispatchEvent(
              new CustomEvent("broker-agent:result", {
                detail: {
                  promptText: text,
                  result,
                  matchResponse: matchResp.response,
                  applied: true,
                },
              })
            );
            showToast(`Applied live BigQuery match results to ${APP_STATE.offers[targetKey]?.offer_code || "Map"}`, "database");
          });
        }

        statusEl.textContent = "Completed via Cloud Run ADK + BigQuery";
      } catch (err) {
        const errBubble = document.createElement("div");
        errBubble.className = "bg-error-container/40 border border-error rounded p-3 text-xs text-on-error-container";
        errBubble.innerHTML = `<p class="font-bold">Cloud Run Agent Connection Notice</p><p class="mt-1">${escapeHtml(err.message)}. Using cached BigQuery a4i_food snapshot.</p>`;
        chatBox.appendChild(errBubble);
        statusEl.textContent = "Ready (Fallback active)";
      } finally {
        sendBtn.disabled = false;
        sendBtn.classList.remove("opacity-60");
      }
    });
  }

  function formatAgentMarkdown(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, '<code class="bg-surface-container px-1 rounded font-mono text-[11px]">$1</code>');
  }

  // ---------------------------------------------------------------------------
  // 9. MODALS: POST SURPLUS, RULED OUT, DIRECTORY, ROUTES, EQUITY AUDIT, HANDOVER
  // ---------------------------------------------------------------------------
  function openPostSurplusModal() {
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
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const created = createNewSurplusOffer({
          donorName: fd.get("donorName"),
          neighborhood: fd.get("zone"),
          zone: fd.get("zone"),
          category: fd.get("category"),
          storage: fd.get("storage"),
          palletsNum: Number(fd.get("palletsNum")) || 2,
          quote: fd.get("quote"),
          deadlineHours: 3,
        });
        closeModal();
        refreshCurrentView();
        showToast(`Posted ${created.offer_code} and matched to ${created.primary_match.name}`, "add_task");
      });
    }
  }

  function openRuledOutModal(offer) {
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
          BigQuery <code>VECTOR_SEARCH</code> retrieved <strong>${offer.pipeline?.semantic || 60}</strong> semantic candidates using <code>gemini-embedding-2</code> (3072 dims). Hard operational guardrails filtered out <strong>${(offer.pipeline?.semantic || 60) - (offer.pipeline?.feasible || 20)}</strong> agencies:
        </p>
        <div class="space-y-2 max-h-80 overflow-y-auto pr-1">${rows}</div>
      </div>
      `
    );
  }

  function openEquityAuditModal() {
    const logHtml = (APP_STATE.audit_log || [])
      .slice(0, 8)
      .map(
        (entry) => `
        <div class="flex items-start gap-2.5 py-1.5 border-b border-outline-variant/40 text-xs">
          <span class="font-mono text-[11px] text-on-surface-variant shrink-0">${escapeHtml(entry.time)}</span>
          <span class="text-on-surface">${escapeHtml(entry.text)}</span>
        </div>
      `
      )
      .join("");

    showModal(
      "Atlanta Metro Equity Audit & Live Session Log",
      `
      <div class="space-y-4 text-xs">
        <div class="grid grid-cols-3 gap-2.5">
          <div class="p-3 rounded bg-surface-container-low border border-outline-variant">
            <p class="text-[10px] font-mono uppercase text-on-surface-variant">High-Need Dispatch Share</p>
            <p class="text-xl font-bold text-primary mt-0.5">${EQUITY_AUDIT_DATA.high_need_share}</p>
            <p class="text-[11px] text-on-surface-variant">Tracts >20% poverty rate</p>
          </div>
          <div class="p-3 rounded bg-surface-container-low border border-outline-variant">
            <p class="text-[10px] font-mono uppercase text-on-surface-variant">Avg No-Vehicle Rate</p>
            <p class="text-xl font-bold text-on-surface mt-0.5">${EQUITY_AUDIT_DATA.avg_no_vehicle_rate}</p>
            <p class="text-[11px] text-on-surface-variant">vs 12.8% Atlanta baseline</p>
          </div>
          <div class="p-3 rounded bg-surface-container-low border border-outline-variant">
            <p class="text-[10px] font-mono uppercase text-on-surface-variant">Verified Recipients</p>
            <p class="text-xl font-bold text-on-surface mt-0.5">${EQUITY_AUDIT_DATA.total_recipients}</p>
            <p class="text-[11px] text-on-surface-variant">Joined via LPAD(geo_id, 11, '0')</p>
          </div>
        </div>

        <div class="p-3 rounded bg-secondary-container/40 border border-secondary/40 space-y-1">
          <p class="font-bold text-on-surface">ACS Census Tract Tie-Breaker Highlight</p>
          <p class="text-on-surface-variant">
            <strong>${EQUITY_AUDIT_DATA.tie_breaker_highlight.winner}</strong> ranked ahead of <strong>${EQUITY_AUDIT_DATA.tie_breaker_highlight.runner_up}</strong> on identical operational specs (${EQUITY_AUDIT_DATA.tie_breaker_highlight.metric}).
          </p>
        </div>

        <div>
          <p class="font-bold uppercase text-[10px] tracking-wider text-on-surface-variant mb-1.5">Live Coordinator State Audit Log</p>
          <div class="bg-surface-container-low border border-outline-variant rounded p-2.5 max-h-44 overflow-y-auto">
            ${logHtml}
          </div>
        </div>
      </div>
      `
    );
  }

  function openActiveRoutesModal() {
    const offers = APP_STATE.offers_order.map((k) => APP_STATE.offers[k]).filter(Boolean);
    const rowsHtml = offers
      .map(
        (o) => `
        <div class="p-3 rounded border border-outline-variant bg-surface-container-low flex items-center justify-between gap-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-mono font-bold text-xs text-primary">${escapeHtml(o.offer_code)}</span>
              <span class="font-bold text-xs text-on-surface">${escapeHtml(o.title)}</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-surface-container-high">${escapeHtml(o.status)}</span>
            </div>
            <p class="text-[11px] text-on-surface-variant mt-0.5">
              Recipient: <strong>${escapeHtml(o.primary_match.name)}</strong> \u00b7 Driver: ${escapeHtml(o.driver_name || "Marcus V.")}
            </p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${
              o.status !== "donated"
                ? `<button data-route-donate="${escapeHtml(o.key)}" class="px-2.5 py-1 rounded bg-primary text-on-primary text-[11px] font-semibold cursor-pointer">Mark Donated</button>`
                : `<span class="text-xs font-bold text-primary flex items-center gap-1"><span class="material-symbols-outlined text-sm">verified</span> Completed</span>`
            }
          </div>
        </div>
      `
      )
      .join("");

    showModal(
      "Active Volunteer Driver Routes & Role Portals",
      `
      <div class="space-y-4 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded bg-surface-container border border-outline-variant">
          <span class="font-semibold text-on-surface">Open Companion Role Portals (Synced via Live State):</span>
          <div class="flex items-center gap-2">
            <a href="grocer-post.html" class="px-2.5 py-1 rounded bg-surface-container-lowest border border-outline-variant hover:border-primary font-semibold">1. Grocer Post</a>
            <a href="pantry-offer.html" class="px-2.5 py-1 rounded bg-surface-container-lowest border border-outline-variant hover:border-primary font-semibold">2. Pantry Offer</a>
            <a href="driver-request.html" class="px-2.5 py-1 rounded bg-surface-container-lowest border border-outline-variant hover:border-primary font-semibold">3. Driver Route</a>
          </div>
        </div>
        <div class="space-y-2 max-h-72 overflow-y-auto">${rowsHtml}</div>
      </div>
      `
    );

    document.querySelectorAll("[data-route-donate]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.getAttribute("data-route-donate");
        markOfferDonated(k);
        closeModal();
      });
    });
  }

  function openShiftHandoverModal() {
    showModal(
      "Shift Handover & Demo State Controls",
      `
      <div class="space-y-4 text-xs">
        <p class="text-on-surface-variant">
          All dispatch actions, standby rotations, split-load activations, and completed donations are persisted across tabs in real time.
        </p>
        <div class="p-3 rounded bg-surface-container-low border border-outline-variant flex items-center justify-between">
          <div>
            <p class="font-bold text-on-surface">Reset Demo to Initial BigQuery Snapshot</p>
            <p class="text-[11px] text-on-surface-variant">Restores #ATL-8904 (Urgent), #ATL-8842 (Ready), #ATL-8828 (Awaiting), and #ATL-8791 (Accepted).</p>
          </div>
          <button id="modal-reset-demo-btn" class="px-3.5 py-2 rounded bg-error text-on-error font-bold cursor-pointer hover:opacity-90 flex items-center gap-1 shrink-0">
            <span class="material-symbols-outlined text-sm">restart_alt</span> Reset State
          </button>
        </div>
      </div>
      `
    );
    const resetBtn = document.getElementById("modal-reset-demo-btn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        closeModal();
        resetBrokerState();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 10. COMPANION ROLE PAGES WIRING (grocer-post, pantry-offer, driver-request)
  // ---------------------------------------------------------------------------
  function wireCompanionRolePages() {
    const path = window.location.pathname.toLowerCase();

    // A. Grocer Post View (grocer-post.html)
    if (path.includes("grocer-post")) {
      document.querySelectorAll("button").forEach((btn) => {
        if (
          btn.textContent.includes("Find a recipient") ||
          btn.textContent.includes("Post") ||
          btn.textContent.includes("Submit")
        ) {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            const textarea = document.querySelector("textarea");
            const quoteText =
              (textarea && textarea.value.trim()) ||
              "10 crates of triple-washed baby spinach, walk-in cooler failed two hours ago. Must leave dock by 8pm.";
            const created = createNewSurplusOffer({
              donorName: "Midtown Fresh Grocer",
              neighborhood: "Midtown",
              zone: "Midtown",
              category: "Produce (Grocer Post)",
              storage: "Refrigerated (38°F)",
              palletsNum: 2,
              quote: quoteText,
              deadlineHours: 4,
            });
            showToast(`Posted ${created.offer_code}! Redirecting to Broker Match Brief...`, "check_circle");
            setTimeout(() => {
              window.location.href = created.brief_url;
            }, 900);
          });
        }
      });
    }

    // B. Pantry Offer View (pantry-offer.html)
    if (path.includes("pantry-offer")) {
      const offerKey = getActiveOfferKey() || "spinach";
      document.querySelectorAll("button").forEach((btn) => {
        const t = btn.textContent.trim();
        if (t.includes("Yes, we can take it") || t.includes("Accept")) {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            markOfferAccepted(offerKey);
            btn.innerHTML = `<span class="material-symbols-outlined">verified</span> Accepted! Driver Notified`;
          });
        } else if (t.includes("Can't take") || t.includes("Pass") || t.includes("Decline")) {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            rotateToNextOption(offerKey, 0);
          });
        }
      });
    }

    // C. Volunteer Driver Request View (driver-request.html)
    if (path.includes("driver-request")) {
      const offerKey = getActiveOfferKey() || "spinach";
      document.querySelectorAll("button").forEach((btn) => {
        const t = btn.textContent.trim();
        if (t.includes("I can drive") || t.includes("Accept") || t.includes("Complete")) {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            markOfferDonated(offerKey);
            btn.innerHTML = `<span class="material-symbols-outlined">verified</span> Route Completed · Marked as Donated!`;
          });
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 11. SIDEBAR NAVIGATION & UI UTILITIES (Modal, Toast, Escape HTML)
  // ---------------------------------------------------------------------------
  function wireGlobalSidebarAndHeader() {
    // 1. Ensure "Active Routes" exists in <aside nav> on all broker views (queue.html & match-brief-spinach.html lacked it)
    const asideNav = document.querySelector("aside nav");
    if (asideNav) {
      const existingLinks = Array.from(asideNav.querySelectorAll("a"));
      const hasActiveRoutes = existingLinks.some((a) =>
        (a.textContent || "").includes("Active Routes")
      );
      if (!hasActiveRoutes) {
        const recipientsLink = existingLinks.find((a) =>
          (a.textContent || "").includes("Recipients") ||
          (a.textContent || "").includes("Recipient Directory")
        );
        const activeRoutesLink = document.createElement("a");
        activeRoutesLink.href = "#";
        activeRoutesLink.className =
          "text-stone-600 dark:text-stone-400 hover:bg-stone-200/50 dark:hover:bg-stone-800/50 hover:text-stone-900 dark:hover:text-stone-100 flex items-center gap-3 px-4 py-2 text-xs font-medium tracking-tight transition-colors duration-150";
        activeRoutesLink.innerHTML = `
          <span class="material-symbols-outlined text-lg">local_shipping</span>
          <span>Active Routes</span>
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

    // 2. Wire sidebar links
    document.querySelectorAll("aside nav a, aside div a").forEach((link) => {
      if (link.hasAttribute("data-nav-wired")) return;
      const text = link.textContent.trim();
      if (text.includes("Live Queue")) {
        link.setAttribute("href", "queue.html");
      } else if (text.includes("Recipient Directory") || text.includes("Recipients")) {
        link.setAttribute("data-nav-wired", "1");
        link.addEventListener("click", (e) => {
          e.preventDefault();
          openEquityAuditModal();
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

    // 3. Wire global "New Offer" and "Shift Handover" buttons across <aside> and <header>
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

  function showModal(title, bodyHtml) {
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
    document.getElementById("broker-modal-close").addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  function closeModal() {
    const existing = document.getElementById("broker-modal-overlay");
    if (existing) existing.remove();
  }

  function showToast(message, icon = "check_circle") {
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

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function refreshCurrentView() {
    wireGlobalSidebarAndHeader();
    updateSidebarBadge();
    if (isQueuePage()) {
      wireQueueControls();
      renderQueuePage();
    }
    if (isMatchBriefPage()) {
      renderMatchBriefPage();
      wireMatchBriefButtons();
    }
  }

  // ---------------------------------------------------------------------------
  // 12. INITIALIZATION ON DOM READY
  // ---------------------------------------------------------------------------
  function initBrokerConsole() {
    wireGlobalSidebarAndHeader();
    ensureAgentLauncherButton();
    wireCompanionRolePages();
    refreshCurrentView();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initBrokerConsole);
  } else {
    initBrokerConsole();
  }
})();
