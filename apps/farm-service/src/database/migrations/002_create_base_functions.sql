-- Migration: 002_create_base_functions
-- Description: Base utility functions for farm module
-- Date: 2024-11-29

-- =====================================================
-- TENANT CONTEXT FUNCTIONS
-- =====================================================

-- Get current tenant from session
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant', true), '')::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Set current tenant for session
CREATE OR REPLACE FUNCTION set_tenant_id(p_tenant_id uuid)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.current_tenant', p_tenant_id::text, false);
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- AUDIT TRIGGER FUNCTION
-- =====================================================

-- Generic audit trigger function
CREATE OR REPLACE FUNCTION audit_trigger_func()
RETURNS TRIGGER AS $$
DECLARE
  v_old_data JSONB;
  v_new_data JSONB;
  v_changed_fields TEXT[];
  v_action TEXT;
BEGIN
  -- Determine action
  IF TG_OP = 'DELETE' THEN
    v_action := 'DELETE';
    v_old_data := to_jsonb(OLD);
    v_new_data := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'UPDATE';
    v_old_data := to_jsonb(OLD);
    v_new_data := to_jsonb(NEW);

    -- Find changed fields
    SELECT array_agg(key) INTO v_changed_fields
    FROM (
      SELECT key
      FROM jsonb_each(v_old_data)
      WHERE key NOT IN ('updated_at', 'version', 'created_at')
      EXCEPT
      SELECT key
      FROM jsonb_each(v_new_data)
      WHERE key NOT IN ('updated_at', 'version', 'created_at')
      UNION
      SELECT key
      FROM jsonb_each(v_new_data)
      WHERE key NOT IN ('updated_at', 'version', 'created_at')
        AND v_old_data->key IS DISTINCT FROM v_new_data->key
    ) AS changed;

  ELSIF TG_OP = 'INSERT' THEN
    v_action := 'CREATE';
    v_old_data := NULL;
    v_new_data := to_jsonb(NEW);
  END IF;

  -- Insert audit log
  INSERT INTO audit_logs (
    id,
    tenant_id,
    entity_type,
    entity_id,
    action,
    user_id,
    changes,
    created_at
  ) VALUES (
    uuid_generate_v4(),
    COALESCE(
      CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END,
      current_tenant_id()
    ),
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
    v_action,
    NULLIF(current_setting('app.current_user', true), '')::uuid,
    jsonb_build_object(
      'before', v_old_data,
      'after', v_new_data,
      'changedFields', v_changed_fields
    ),
    NOW()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- SOFT DELETE FUNCTIONS
-- =====================================================

-- Soft delete function
CREATE OR REPLACE FUNCTION soft_delete_func()
RETURNS TRIGGER AS $$
BEGIN
  -- Instead of deleting, update is_deleted flag
  UPDATE ONLY TG_TABLE_SCHEMA.TG_TABLE_NAME
  SET
    is_deleted = true,
    deleted_at = NOW(),
    deleted_by = NULLIF(current_setting('app.current_user', true), '')::uuid
  WHERE id = OLD.id;

  RETURN NULL; -- Prevent actual delete
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- UPDATED_AT TRIGGER FUNCTION
-- =====================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- CODE GENERATION HELPER
-- =====================================================

-- Generate next sequence for entity codes
CREATE OR REPLACE FUNCTION generate_entity_code(
  p_tenant_id uuid,
  p_entity_type varchar,
  p_prefix varchar,
  p_year int DEFAULT NULL
)
RETURNS varchar AS $$
DECLARE
  v_year int;
  v_next_seq int;
  v_code varchar;
BEGIN
  v_year := COALESCE(p_year, EXTRACT(YEAR FROM NOW())::int);

  -- Get next sequence with lock
  INSERT INTO code_sequences (id, tenant_id, entity_type, prefix, year, last_sequence, created_at, updated_at)
  VALUES (uuid_generate_v4(), p_tenant_id, p_entity_type, p_prefix, v_year, 1, NOW(), NOW())
  ON CONFLICT (tenant_id, entity_type, year)
  DO UPDATE SET
    last_sequence = code_sequences.last_sequence + 1,
    last_generated_at = NOW(),
    updated_at = NOW()
  RETURNING last_sequence INTO v_next_seq;

  -- Format code: PREFIX-YEAR-SEQUENCE
  v_code := p_prefix || '-' || v_year::varchar || '-' || LPAD(v_next_seq::varchar, 5, '0');

  RETURN v_code;
END;
$$ LANGUAGE plpgsql;
