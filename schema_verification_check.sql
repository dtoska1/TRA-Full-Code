-- schema_verification_check.sql
BEGIN;

-- 1) UUID defaults: insert without id should return generated UUIDs
DO $$
DECLARE m_id uuid;
DECLARE u_id uuid;
DECLARE i_id uuid;
BEGIN
  INSERT INTO municipalities (name_sq)
  VALUES ('Bashkia Schema Test 1')
  RETURNING id INTO m_id;

  IF m_id IS NULL THEN
    RAISE EXCEPTION 'UUID default failed for municipalities.id';
  END IF;

  INSERT INTO users (email, display_name, password_hash)
  VALUES ('schema_test1@example.com', 'Schema Test User 1', 'x')
  RETURNING id INTO u_id;

  IF u_id IS NULL THEN
    RAISE EXCEPTION 'UUID default failed for users.id';
  END IF;

  INSERT INTO items (
    municipality_id, category, title, title_normalized, status, dedup_key
  ) VALUES (
    m_id, 'Vendime', 'UUID default item', 'uuid default item', 'draft', 'dedup:uuid-default'
  ) RETURNING id INTO i_id;

  IF i_id IS NULL THEN
    RAISE EXCEPTION 'UUID default failed for items.id';
  END IF;
END $$;

-- Create a dedicated municipality for the rest of the tests
DO $$
DECLARE mid uuid;
BEGIN
  INSERT INTO municipalities (name_sq)
  VALUES ('Bashkia Schema Test 2')
  RETURNING id INTO mid;

  IF mid IS NULL THEN
    RAISE EXCEPTION 'Failed to create test municipality';
  END IF;
END $$;

-- 2) Draft can have missing dates: status='draft' allows published_date NULL even if date_unknown=false
DO $$
DECLARE m_id uuid;
BEGIN
  SELECT id INTO m_id
  FROM municipalities
  WHERE name_sq = 'Bashkia Schema Test 2'
  LIMIT 1;

  INSERT INTO items (
    municipality_id, category, title, title_normalized,
    status, date_unknown, published_date, dedup_key
  ) VALUES (
    m_id, 'Prokurime', 'Draft missing date', 'draft missing date',
    'draft', FALSE, NULL, 'dedup:draft-missing-date'
  );
END $$;

-- 3) Published date rules enforced: two invalid publish inserts must fail (catch exceptions)

-- 3a) status='published' AND date_unknown=false AND published_date NULL must fail
DO $$
DECLARE m_id uuid;
BEGIN
  SELECT id INTO m_id
  FROM municipalities
  WHERE name_sq = 'Bashkia Schema Test 2'
  LIMIT 1;

  BEGIN
    INSERT INTO items (
      municipality_id, category, title, title_normalized,
      status, date_unknown, published_date, dedup_key,
      ingestion_method, collected_at, source_url
    ) VALUES (
      m_id, 'Vendime', 'Invalid published (missing date)', 'invalid published missing date',
      'published', FALSE, NULL, 'dedup:invalid-pub-1',
      'manual', clock_timestamp(), 'https://example.org/schema-test/pub-invalid-1'
    );

    RAISE EXCEPTION 'Expected failure did not occur for invalid published insert 3a';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

-- 3b) status='published' AND date_unknown=true AND published_date NOT NULL must fail
DO $$
DECLARE m_id uuid;
BEGIN
  SELECT id INTO m_id
  FROM municipalities
  WHERE name_sq = 'Bashkia Schema Test 2'
  LIMIT 1;

  BEGIN
    INSERT INTO items (
      municipality_id, category, title, title_normalized,
      status, date_unknown, published_date, dedup_key,
      ingestion_method, collected_at, source_url
    ) VALUES (
      m_id, 'Vendime', 'Invalid published (date_unknown true but has date)', 'invalid published date_unknown has date',
      'published', TRUE, CURRENT_DATE, 'dedup:invalid-pub-2',
      'manual', clock_timestamp(), 'https://example.org/schema-test/pub-invalid-2'
    );

    RAISE EXCEPTION 'Expected failure did not occur for invalid published insert 3b';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

-- 4) Dedup rules
DO $$
DECLARE m_id uuid;
BEGIN
  SELECT id INTO m_id
  FROM municipalities
  WHERE name_sq = 'Bashkia Schema Test 2'
  LIMIT 1;

  -- 4a) duplicate source_url (non-null) must fail
  INSERT INTO items (
    municipality_id, category, title, title_normalized,
    status, dedup_key, ingestion_method, source_url
  ) VALUES (
    m_id, 'Vendime', 'Source URL unique 1', 'source url unique 1',
    'draft', 'dedup:srcu-1', 'scrape', 'https://example.org/schema-test/source-url-unique'
  );

  BEGIN
    INSERT INTO items (
      municipality_id, category, title, title_normalized,
      status, dedup_key, ingestion_method, source_url
    ) VALUES (
      m_id, 'Vendime', 'Source URL unique 2', 'source url unique 2',
      'draft', 'dedup:srcu-2', 'scrape', 'https://example.org/schema-test/source-url-unique'
    );

    RAISE EXCEPTION 'Expected failure did not occur for duplicate source_url (4a)';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- 4b) duplicate (municipality_id, category, dedup_key) must fail only when source_url IS NULL
  INSERT INTO items (
    municipality_id, category, title, title_normalized,
    status, dedup_key, ingestion_method, source_url
  ) VALUES (
    m_id, 'Prokurime', 'No source dedup 1', 'no source dedup 1',
    'draft', 'dedup:nosrc-1', 'manual', NULL
  );

  BEGIN
    INSERT INTO items (
      municipality_id, category, title, title_normalized,
      status, dedup_key, ingestion_method, source_url
    ) VALUES (
      m_id, 'Prokurime', 'No source dedup 2', 'no source dedup 2',
      'draft', 'dedup:nosrc-1', 'manual', NULL
    );

    RAISE EXCEPTION 'Expected failure did not occur for duplicate dedup_key when source_url IS NULL (4b)';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- 4c) dedup_key collisions allowed when source_url IS NOT NULL (different source_url)
  INSERT INTO items (
    municipality_id, category, title, title_normalized,
    status, dedup_key, ingestion_method, source_url
  ) VALUES (
    m_id, 'Prokurime', 'Dedup collision allowed 1', 'dedup collision allowed 1',
    'draft', 'dedup:collision-1', 'scrape', 'https://example.org/schema-test/collision-1'
  );

  INSERT INTO items (
    municipality_id, category, title, title_normalized,
    status, dedup_key, ingestion_method, source_url
  ) VALUES (
    m_id, 'Prokurime', 'Dedup collision allowed 2', 'dedup collision allowed 2',
    'draft', 'dedup:collision-1', 'scrape', 'https://example.org/schema-test/collision-2'
  );
END $$;

-- 5) updated_at triggers work (clock_timestamp() invariant)
DO $$
DECLARE m_id uuid;
DECLARE item_id uuid;
DECLARE sr_id uuid;
DECLARE before_item timestamptz;
DECLARE after_item timestamptz;
DECLARE before_sr timestamptz;
DECLARE after_sr timestamptz;
BEGIN
  SELECT id INTO m_id
  FROM municipalities
  WHERE name_sq = 'Bashkia Schema Test 2'
  LIMIT 1;

  INSERT INTO items (
    municipality_id, category, title, title_normalized, status, dedup_key
  ) VALUES (
    m_id, 'Vendime', 'Updated-at test item', 'updated-at test item', 'draft', 'dedup:updated-at-item'
  ) RETURNING id INTO item_id;

  SELECT updated_at INTO before_item FROM items WHERE id = item_id;

  PERFORM pg_sleep(0.01);

  UPDATE items SET title = title || ' (edited)' WHERE id = item_id;

  SELECT updated_at INTO after_item FROM items WHERE id = item_id;

  IF after_item <= before_item THEN
    RAISE EXCEPTION 'items.updated_at did not advance (before=%, after=%)', before_item, after_item;
  END IF;

  INSERT INTO source_registry (
    municipality_id, base_url, is_primary, source_type
  ) VALUES (
    m_id, 'https://example.org/schema-test', TRUE, 'MUNICIPAL_SITE'
  ) RETURNING id INTO sr_id;

  SELECT updated_at INTO before_sr FROM source_registry WHERE id = sr_id;

  PERFORM pg_sleep(0.01);

  UPDATE source_registry SET crawl_notes = 'note' WHERE id = sr_id;

  SELECT updated_at INTO after_sr FROM source_registry WHERE id = sr_id;

  IF after_sr <= before_sr THEN
    RAISE EXCEPTION 'source_registry.updated_at did not advance (before=%, after=%)', before_sr, after_sr;
  END IF;
END $$;

-- 6) source_registry multi-source + only one primary
DO $$
DECLARE m_id uuid;
BEGIN
  SELECT id INTO m_id
  FROM municipalities
  WHERE name_sq = 'Bashkia Schema Test 2'
  LIMIT 1;

  -- second source, not primary: should succeed
  INSERT INTO source_registry (
    municipality_id, base_url, is_primary, source_type
  ) VALUES (
    m_id, 'https://example.org/schema-test/transparency', FALSE, 'TRANSPARENCY_SECTION'
  );

  -- second primary: must fail
  BEGIN
    INSERT INTO source_registry (
      municipality_id, base_url, is_primary, source_type
    ) VALUES (
      m_id, 'https://example.org/schema-test/another-primary', TRUE, 'MUNICIPAL_SITE'
    );

    RAISE EXCEPTION 'Expected failure did not occur for second primary source_registry row (6)';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
