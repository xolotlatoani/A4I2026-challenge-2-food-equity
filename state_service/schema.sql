-- Offer state for the food rescue broker, in Cloud SQL for PostgreSQL.
--
-- BigQuery knows the recipients and ranks them (sql/03_filter_and_rank.sql). This database
-- remembers what happened after: the grocer requests that came in, who each one was offered
-- to, and what they said. Before every match the agent asks it who to leave out, how much of
-- the load is still unclaimed, and how many hours are left, and passes those to sql/03.
--
-- Safe to re-run: tables are IF NOT EXISTS, columns added later are ADD COLUMN IF NOT EXISTS,
-- and the views, which hold no data, are dropped and rebuilt. Apply with apply_schema.py, which
-- runs it all in one transaction.
--
-- Judgment calls, written down so they can be argued with:
--   * A decline leaves that recipient out of that request only. Small, high-need pantries
--     decline most often for lack of room, so a standing blocklist would quietly steer food
--     away from the tracts the matcher weights up. Longer outages go in recipient_holds, which
--     always end.
--   * A live offer ties a recipient up everywhere else: one waiting on a reply, or accepted and
--     not yet picked up, on a request whose deadline hasn't passed. Other requests leave that
--     recipient out, so two grocers never book the same van or fridge at once. It lifts by
--     itself when the offer expires, is declined or picked up, or that deadline passes. It is
--     all or nothing for now: a 10-pallet walk-in holding 0.25 pallets of spinach is left out
--     of the milk too.
--   * Nobody runs a job to expire things. An offer still 'sent' after reply_by reads as
--     'expired', and an open request past deadline_at reads as 'expired', in the views below.
--   * A pending offer holds its share of the load until reply_by, so a split never offers the
--     same pallets twice.

-- A surplus posting as it came in from a grocer. Not a4i_food.surplus_postings: load.sh
-- replaces that table on every run.
CREATE TABLE IF NOT EXISTS grocer_requests (
  request_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metro             TEXT NOT NULL,
  donor_name        TEXT,
  posting_text      TEXT NOT NULL,
  food_item         TEXT,
  required_storage  TEXT NOT NULL
                    CHECK (required_storage IN ('refrigerated', 'frozen', 'shelf-stable')),
  -- Pallets, as given, or read from the posting's own words when it came in (pallets.py):
  -- postings say "10 crates", never pallets. quantity_text is the words read.
  pallets           NUMERIC(7, 3) NOT NULL CHECK (pallets > 0),
  quantity_text     TEXT,
  pallets_source    TEXT CHECK (pallets_source IN ('given', 'read', 'guessed')),
  pallets_basis     TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When the food has to be placed by: the donor's deadline, or sooner if FoodKeeper says it
  -- spoils first. A time rather than a number of hours, so a rerun two hours later sees two
  -- hours less clock.
  deadline_at       TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'fulfilled', 'cancelled')),
  source_posting_id INT,   -- a4i_food.surplus_postings.posting_id, when replaying a seed posting
  offer_code        TEXT,  -- the coordinator console's label, e.g. 'OFFER #ATL-8830'
  CHECK (deadline_at > received_at)
);
-- For databases created before these columns existed.
ALTER TABLE grocer_requests ADD COLUMN IF NOT EXISTS offer_code TEXT;
ALTER TABLE grocer_requests ADD COLUMN IF NOT EXISTS quantity_text TEXT;
ALTER TABLE grocer_requests ADD COLUMN IF NOT EXISTS pallets_source TEXT
  CHECK (pallets_source IN ('given', 'read', 'guessed'));
ALTER TABLE grocer_requests ADD COLUMN IF NOT EXISTS pallets_basis TEXT;

-- Every time the matcher ran for a request: what it knew and what it ranked, so "who's next?"
-- and "why did we offer it to them?" can be answered as of that moment.
CREATE TABLE IF NOT EXISTS match_runs (
  match_run_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES grocer_requests (request_id),
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  hours_remaining NUMERIC(7, 2) NOT NULL,
  pallets         NUMERIC(7, 3) NOT NULL,
  excluded_ids    INT[] NOT NULL DEFAULT '{}',
  ranked          JSONB NOT NULL   -- ranked matches, split plan and eliminations, trimmed
);

-- One row per recipient a request was offered to. The row holds the latest status;
-- offer_events holds how it got there.
CREATE TABLE IF NOT EXISTS offers (
  offer_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES grocer_requests (request_id),
  recipient_id    INT NOT NULL,    -- a4i_food.recipients.recipient_id, in BigQuery
  recipient_name  TEXT,            -- as offered, so the queue reads without BigQuery
  match_run_id    UUID REFERENCES match_runs (match_run_id),
  offered_pallets NUMERIC(7, 3) NOT NULL CHECK (offered_pallets > 0),
  status          TEXT NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('sent', 'accepted', 'declined', 'withdrawn', 'picked_up')),
  reason_code     TEXT CHECK (reason_code IN ('no_capacity_today', 'wrong_food', 'storage_down',
                                              'closed', 'no_transport', 'other')),
  reason_text     TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reply_by        TIMESTAMPTZ NOT NULL,
  responded_at    TIMESTAMPTZ,
  UNIQUE (request_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS offer_events (
  event_id    BIGSERIAL PRIMARY KEY,
  offer_id    UUID NOT NULL REFERENCES offers (offer_id),
  status      TEXT NOT NULL,
  reason_code TEXT,
  reason_text TEXT,
  actor       TEXT,                -- agent, coordinator or recipient
  event_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A recipient that should not get offers for a while, across every request: "our walk-in is
-- down until Friday". storage_scope NULL means no offers at all, otherwise only offers that
-- need that kind of storage.
CREATE TABLE IF NOT EXISTS recipient_holds (
  hold_id       BIGSERIAL PRIMARY KEY,
  recipient_id  INT NOT NULL,
  storage_scope TEXT CHECK (storage_scope IN ('refrigerated', 'frozen', 'shelf-stable')),
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at       TIMESTAMPTZ NOT NULL,
  reason        TEXT NOT NULL,
  created_by    TEXT,
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS offers_request_idx ON offers (request_id);
CREATE INDEX IF NOT EXISTS offer_events_offer_idx ON offer_events (offer_id);
CREATE INDEX IF NOT EXISTS match_runs_request_idx ON match_runs (request_id);
CREATE INDEX IF NOT EXISTS recipient_holds_ends_idx ON recipient_holds (ends_at);
CREATE INDEX IF NOT EXISTS grocer_requests_open_idx ON grocer_requests (deadline_at)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS grocer_requests_offer_code_idx ON grocer_requests (offer_code);
CREATE INDEX IF NOT EXISTS offers_recipient_idx ON offers (recipient_id);

DROP VIEW IF EXISTS request_status;
DROP VIEW IF EXISTS live_offers;
DROP VIEW IF EXISTS offer_status;

CREATE VIEW offer_status AS
SELECT
  o.*,
  CASE WHEN o.status = 'sent' AND o.reply_by <= now() THEN 'expired' ELSE o.status END
    AS current_status
FROM offers o;

-- Offers that still tie a recipient up: waiting on a reply, or accepted and not yet picked up,
-- on a request that isn't cancelled and whose deadline hasn't passed.
CREATE VIEW live_offers AS
SELECT
  o.*,
  r.posting_text,
  r.offer_code,
  r.required_storage,
  r.deadline_at
FROM offer_status o
JOIN grocer_requests r USING (request_id)
WHERE o.current_status IN ('sent', 'accepted')
  AND r.status <> 'cancelled'
  AND r.deadline_at > now();

-- One row per request with everything the matcher needs before it runs.
CREATE VIEW request_status AS
SELECT
  r.*,
  CASE WHEN r.status = 'open' AND r.deadline_at <= now() THEN 'expired' ELSE r.status END
    AS current_status,
  ROUND(GREATEST(0, EXTRACT(EPOCH FROM r.deadline_at - now()) / 3600), 2) AS hours_remaining,
  COALESCE(SUM(o.offered_pallets)
           FILTER (WHERE o.current_status IN ('accepted', 'picked_up')), 0) AS accepted_pallets,
  COALESCE(SUM(o.offered_pallets) FILTER (WHERE o.current_status = 'sent'), 0)
    AS pending_pallets,
  GREATEST(0, r.pallets
              - COALESCE(SUM(o.offered_pallets)
                         FILTER (WHERE o.current_status IN ('sent', 'accepted', 'picked_up')), 0))
    AS unclaimed_pallets,
  -- Everyone already asked, whatever they said. Withdrawn offers can be made again.
  COALESCE(ARRAY_AGG(o.recipient_id ORDER BY o.recipient_id)
           FILTER (WHERE o.current_status <> 'withdrawn'), '{}') AS offered_ids,
  ARRAY(
    SELECT DISTINCT h.recipient_id
    FROM recipient_holds h
    WHERE now() >= h.starts_at AND now() < h.ends_at
      AND (h.storage_scope IS NULL OR h.storage_scope = r.required_storage)
    ORDER BY h.recipient_id
  ) AS held_ids,
  -- Tied up by a live offer on some other request.
  ARRAY(
    SELECT DISTINCT l.recipient_id
    FROM live_offers l
    WHERE l.request_id <> r.request_id
    ORDER BY l.recipient_id
  ) AS busy_ids
FROM grocer_requests r
LEFT JOIN offer_status o USING (request_id)
GROUP BY r.request_id;
