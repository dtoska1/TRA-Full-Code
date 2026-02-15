BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS municipalities (
id UUID PRIMARY KEY,
name_sq TEXT NOT NULL UNIQUE,
name_en TEXT,
county TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
id UUID PRIMARY KEY,
email CITEXT NOT NULL UNIQUE,
display_name TEXT NOT NULL,
password_hash TEXT,
is_active BOOLEAN NOT NULL DEFAULT TRUE,
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
id SMALLINT PRIMARY KEY,
name TEXT NOT NULL UNIQUE
);

INSERT INTO roles (id, name)
VALUES (1, 'Admin'), (2, 'Editor'), (3, 'Publisher')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_roles (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
role_id SMALLINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS source_registry (
id UUID PRIMARY KEY,
municipality_id UUID NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,

source_type TEXT NOT NULL DEFAULT 'MUNICIPAL_SITE',
is_primary BOOLEAN NOT NULL DEFAULT FALSE,

base_url TEXT NOT NULL,
final_url TEXT,

data_tier TEXT NOT NULL DEFAULT 'TBD',

verification_status TEXT NOT NULL DEFAULT 'UNCHECKED',
homepage_status TEXT NOT NULL DEFAULT 'UNCHECKED',
attempt_count INTEGER NOT NULL DEFAULT 0,
first_seen_utc TIMESTAMPTZ,
last_checked_utc TIMESTAMPTZ,
last_seen_utc TIMESTAMPTZ,
last_error_type TEXT,
cooldown_until_utc TIMESTAMPTZ,
hour_buckets_seen TEXT,

vendime_url TEXT,
vendime_confidence REAL,
prokurime_url TEXT,
prokurime_confidence REAL,
konsultime_url TEXT,
konsultime_confidence REAL,

robots_respected TEXT NOT NULL DEFAULT 'UNKNOWN',
feasibility TEXT NOT NULL DEFAULT 'TBD',
classification_confidence REAL NOT NULL DEFAULT 0.0,
crawl_notes TEXT,

updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

CONSTRAINT ck_source_registry_source_type
CHECK (source_type IN ('MUNICIPAL_SITE','TRANSPARENCY_SECTION','EXTERNAL_OFFICIAL')),

CONSTRAINT ck_source_registry_verification_status
CHECK (verification_status IN ('CHECKED','UNCHECKED')),

CONSTRAINT ck_source_registry_robots_respected
CHECK (robots_respected IN ('TRUE','FALSE','UNKNOWN')),

CONSTRAINT ck_source_registry_feasibility
CHECK (feasibility IN ('A','B','C','TBD')),

CONSTRAINT ck_source_registry_data_tier
CHECK (data_tier IN ('Tier 1','Tier 2','Tier 3','TBD'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_source_registry_one_primary
ON source_registry (municipality_id)
WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS ix_source_registry_municipality
ON source_registry (municipality_id);

CREATE INDEX IF NOT EXISTS ix_source_registry_cooldown
ON source_registry (cooldown_until_utc);

CREATE INDEX IF NOT EXISTS ix_source_registry_feasibility
ON source_registry (feasibility);

CREATE TABLE IF NOT EXISTS items (
id UUID PRIMARY KEY,
municipality_id UUID NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
category TEXT NOT NULL,

title TEXT NOT NULL,
title_normalized TEXT NOT NULL,
summary TEXT,

published_date DATE,
date_unknown BOOLEAN NOT NULL DEFAULT FALSE,
date_source TEXT,

source_url TEXT,
source_url_missing_reason TEXT,

collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),

ingestion_method TEXT,
dedup_key TEXT NOT NULL,

possible_duplicate BOOLEAN NOT NULL DEFAULT FALSE,

status TEXT NOT NULL DEFAULT 'draft',

created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

CONSTRAINT ck_items_category
CHECK (category IN ('Vendime','Prokurime','Konsultime publike')),

CONSTRAINT ck_items_status
CHECK (status IN ('draft','published','archived')),

CONSTRAINT ck_items_ingestion_method
CHECK (ingestion_method IS NULL OR ingestion_method IN ('scrape','semi','manual')),

CONSTRAINT ck_items_date_unknown_published_date
CHECK (
(date_unknown = TRUE AND published_date IS NULL)
OR
(date_unknown = FALSE AND published_date IS NOT NULL)
),

CONSTRAINT ck_items_published_requires_provenance
CHECK (
status <> 'published'
OR (
(source_url IS NOT NULL OR source_url_missing_reason IS NOT NULL)
AND ingestion_method IS NOT NULL
AND collected_at IS NOT NULL
)
)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_items_source_url_not_null
ON items (source_url)
WHERE source_url IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_items_muni_cat_dedup
ON items (municipality_id, category, dedup_key);

CREATE INDEX IF NOT EXISTS ix_items_public_filters
ON items (status, municipality_id, category, published_date DESC);

CREATE INDEX IF NOT EXISTS ix_items_title_norm
ON items (title_normalized);

CREATE TABLE IF NOT EXISTS attachments (
id UUID PRIMARY KEY,
item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,

file_name TEXT NOT NULL,
mime_type TEXT NOT NULL,
size_bytes BIGINT NOT NULL,
storage_uri TEXT NOT NULL,

sha256 TEXT NOT NULL,
source_url TEXT,

created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_attachments_item_sha256
ON attachments (item_id, sha256);

CREATE INDEX IF NOT EXISTS ix_attachments_sha256
ON attachments (sha256);

CREATE INDEX IF NOT EXISTS ix_attachments_item_id
ON attachments (item_id);

CREATE TABLE IF NOT EXISTS item_revisions (
id UUID PRIMARY KEY,
item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
edited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
edited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
change_summary TEXT,

snapshot_json JSONB NOT NULL,
snapshot_sha256 TEXT
);

CREATE INDEX IF NOT EXISTS ix_item_revisions_item_time
ON item_revisions (item_id, edited_at DESC);

CREATE TABLE IF NOT EXISTS publish_events (
id UUID PRIMARY KEY,
item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
publisher_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
action TEXT NOT NULL,
note TEXT,

CONSTRAINT ck_publish_events_action
CHECK (action IN ('publish','unpublish','archive'))
);

CREATE INDEX IF NOT EXISTS ix_publish_events_item_time
ON publish_events (item_id, published_at DESC);

CREATE TABLE IF NOT EXISTS security_events (
id UUID PRIMARY KEY,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
event_type TEXT NOT NULL,
user_id UUID REFERENCES users(id) ON DELETE SET NULL,
ip INET,
user_agent TEXT,
details_json JSONB
);

CREATE INDEX IF NOT EXISTS ix_security_events_time
ON security_events (created_at DESC);

COMMIT;