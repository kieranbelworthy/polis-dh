-- PostgreSQL-backed automatic Delphi theme analysis.
--
-- The external API creates managed job rows. After registration, this comments
-- trigger owns the source revision. Ordinary Pol.is conversations without a
-- managed row are untouched, keeping this workload isolated from the standard
-- application. A worker only processes a job when source_revision is greater
-- than completed_revision, so polling and API reads cannot create duplicate
-- analysis runs when no source data has changed.

CREATE TABLE IF NOT EXISTS delphi_theme_jobs (
  zid INTEGER PRIMARY KEY REFERENCES conversations(zid) ON DELETE CASCADE,
  source_revision BIGINT NOT NULL DEFAULT 1,
  completed_revision BIGINT NOT NULL DEFAULT 0,
  processing_revision BIGINT,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  dirty_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dirty_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  not_before TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_trigger_reason TEXT,
  last_error TEXT,
  CONSTRAINT delphi_theme_jobs_revision_order
    CHECK (source_revision >= completed_revision),
  CONSTRAINT delphi_theme_jobs_status
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS delphi_theme_jobs_due_idx
  ON delphi_theme_jobs (status, dirty_at)
  WHERE source_revision > completed_revision;

CREATE TABLE IF NOT EXISTS delphi_theme_runs (
  run_id TEXT PRIMARY KEY,
  zid INTEGER NOT NULL REFERENCES conversations(zid) ON DELETE CASCADE,
  source_revision BIGINT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding_model TEXT NOT NULL,
  label_method TEXT NOT NULL,
  UNIQUE (zid, source_revision)
);

CREATE INDEX IF NOT EXISTS delphi_theme_runs_latest_idx
  ON delphi_theme_runs (zid, generated_at DESC);

CREATE TABLE IF NOT EXISTS delphi_themes (
  run_id TEXT NOT NULL REFERENCES delphi_theme_runs(run_id) ON DELETE CASCADE,
  layer_id INTEGER NOT NULL,
  cluster_id INTEGER NOT NULL,
  topic_name TEXT NOT NULL,
  model_name TEXT,
  PRIMARY KEY (run_id, layer_id, cluster_id)
);

CREATE TABLE IF NOT EXISTS delphi_theme_assignments (
  run_id TEXT NOT NULL REFERENCES delphi_theme_runs(run_id) ON DELETE CASCADE,
  tid INTEGER NOT NULL,
  layer_id INTEGER NOT NULL,
  cluster_id INTEGER NOT NULL,
  confidence DOUBLE PRECISION,
  distance_to_centroid DOUBLE PRECISION,
  PRIMARY KEY (run_id, tid, layer_id)
);

CREATE INDEX IF NOT EXISTS delphi_theme_assignments_cluster_idx
  ON delphi_theme_assignments (run_id, layer_id, cluster_id);

CREATE OR REPLACE FUNCTION mark_delphi_theme_job_dirty()
RETURNS TRIGGER AS $$
DECLARE
  target_zid INTEGER;
  trigger_reason TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.is_meta OR COALESCE(NEW.mod, 0) <= -1) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (OLD.is_meta OR COALESCE(OLD.mod, 0) <= -1) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND
     (OLD.is_meta OR COALESCE(OLD.mod, 0) <= -1) AND
     (NEW.is_meta OR COALESCE(NEW.mod, 0) <= -1) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND
     ROW(NEW.txt, NEW.active, NEW.mod, NEW.is_meta) IS NOT DISTINCT FROM
     ROW(OLD.txt, OLD.active, OLD.mod, OLD.is_meta) THEN
    RETURN NEW;
  END IF;

  target_zid := CASE WHEN TG_OP = 'DELETE' THEN OLD.zid ELSE NEW.zid END;
  trigger_reason := CASE
    WHEN TG_OP = 'INSERT' THEN 'comment_created'
    WHEN TG_OP = 'DELETE' THEN 'comment_deleted'
    ELSE 'comment_changed'
  END;

  UPDATE delphi_theme_jobs SET
    source_revision = source_revision + 1,
    status = CASE
      WHEN status = 'processing' THEN 'processing'
      ELSE 'pending'
    END,
    dirty_at = NOW(),
    dirty_since = CASE
      WHEN source_revision = completed_revision
        THEN NOW()
      ELSE dirty_since
    END,
    not_before = NULL,
    updated_at = NOW(),
    last_trigger_reason = trigger_reason,
    attempts = CASE
      WHEN status = 'processing' THEN attempts
      ELSE 0
    END,
    last_error = NULL
  WHERE zid = target_zid;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS comments_mark_delphi_theme_dirty ON comments;
CREATE TRIGGER comments_mark_delphi_theme_dirty
AFTER INSERT OR DELETE OR UPDATE OF txt, active, mod, is_meta
ON comments
FOR EACH ROW EXECUTE FUNCTION mark_delphi_theme_job_dirty();
