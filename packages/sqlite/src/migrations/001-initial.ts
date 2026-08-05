export const NOVAWING_SCHEMA_VERSION = 1

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nw_meta (
  key TEXT PRIMARY KEY,
  integer_value INTEGER,
  text_value TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (integer_value IS NOT NULL AND text_value IS NULL)
    OR (integer_value IS NULL AND text_value IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS nw_proposals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('set', 'deprecate')),
  memory_key TEXT NOT NULL CHECK (
    length(memory_key) <= 100
    AND (
      memory_key GLOB 'global.*'
      OR memory_key GLOB 'career.*'
    )
  ),
  category TEXT NOT NULL CHECK (
    category IN ('phase', 'priority', 'principle', 'constraint', 'decision')
  ),
  assertion_type TEXT NOT NULL CHECK (
    assertion_type IN ('user_decision', 'confirmed_fact', 'working_hypothesis')
  ),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'career')),
  proposed_statement TEXT,
  edited_statement TEXT,
  final_statement TEXT,
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  evidence_summary TEXT NOT NULL CHECK (
    length(trim(evidence_summary)) BETWEEN 1 AND 4000
  ),
  source_type TEXT NOT NULL CHECK (source_type IN ('host', 'manual')),
  source_system TEXT,
  source_ref TEXT,
  base_core_revision INTEGER CHECK (
    base_core_revision IS NULL OR base_core_revision >= 0
  ),
  base_target_entry_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'pending', 'approved', 'rejected')
  ),
  review_note TEXT,
  applied_core_revision INTEGER UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (base_target_entry_id) REFERENCES nw_mainline_entries(id),
  CHECK (
    (action = 'set' AND proposed_statement IS NOT NULL
      AND length(trim(proposed_statement)) BETWEEN 1 AND 4000)
    OR (action = 'deprecate' AND proposed_statement IS NULL)
  ),
  CHECK (
    (action = 'set' AND (edited_statement IS NULL
      OR length(trim(edited_statement)) BETWEEN 1 AND 4000))
    OR (action = 'deprecate' AND edited_statement IS NULL)
  ),
  CHECK (
    (source_type = 'host' AND source_system IS NOT NULL
      AND length(trim(source_system)) BETWEEN 1 AND 100)
    OR (source_type = 'manual' AND source_system IS NULL)
  ),
  CHECK (
    (status = 'draft'
      AND base_core_revision IS NULL
      AND reviewed_at IS NULL
      AND applied_core_revision IS NULL
      AND final_statement IS NULL)
    OR (status = 'pending'
      AND base_core_revision IS NOT NULL
      AND reviewed_at IS NULL
      AND applied_core_revision IS NULL
      AND final_statement IS NULL)
    OR (status = 'approved'
      AND base_core_revision IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND applied_core_revision IS NOT NULL
      AND ((action = 'set' AND final_statement IS NOT NULL
        AND length(trim(final_statement)) BETWEEN 1 AND 4000)
        OR (action = 'deprecate' AND final_statement IS NULL)))
    OR (status = 'rejected'
      AND base_core_revision IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND applied_core_revision IS NULL
      AND final_statement IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS nw_mainline_entries (
  id TEXT PRIMARY KEY,
  memory_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('set', 'deprecate')),
  category TEXT NOT NULL CHECK (
    category IN ('phase', 'priority', 'principle', 'constraint', 'decision')
  ),
  assertion_type TEXT NOT NULL CHECK (
    assertion_type IN ('user_decision', 'confirmed_fact', 'working_hypothesis')
  ),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'career')),
  statement TEXT,
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  supersedes_entry_id TEXT,
  source_proposal_id TEXT NOT NULL UNIQUE,
  core_revision INTEGER NOT NULL UNIQUE CHECK (core_revision > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (supersedes_entry_id) REFERENCES nw_mainline_entries(id),
  FOREIGN KEY (source_proposal_id) REFERENCES nw_proposals(id),
  CHECK (
    (operation = 'set' AND statement IS NOT NULL
      AND length(trim(statement)) BETWEEN 1 AND 4000)
    OR (operation = 'deprecate' AND statement IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS nw_idx_entries_memory_revision
  ON nw_mainline_entries(memory_key, core_revision DESC);

CREATE INDEX IF NOT EXISTS nw_idx_entries_scope_revision
  ON nw_mainline_entries(scope, core_revision DESC);

CREATE INDEX IF NOT EXISTS nw_idx_proposals_status_created
  ON nw_proposals(status, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS nw_trg_entries_no_update
BEFORE UPDATE ON nw_mainline_entries
BEGIN
  SELECT RAISE(ABORT, 'nw_mainline_entries is append-only');
END;

CREATE TRIGGER IF NOT EXISTS nw_trg_entries_no_delete
BEFORE DELETE ON nw_mainline_entries
BEGIN
  SELECT RAISE(ABORT, 'nw_mainline_entries is append-only');
END;

CREATE TRIGGER IF NOT EXISTS nw_trg_entries_same_memory_key
BEFORE INSERT ON nw_mainline_entries
WHEN NEW.supersedes_entry_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM nw_mainline_entries
    WHERE id = NEW.supersedes_entry_id
      AND memory_key = NEW.memory_key
  )
BEGIN
  SELECT RAISE(ABORT, 'superseded entry must use the same memory_key');
END;

CREATE TRIGGER IF NOT EXISTS nw_trg_proposals_legal_status_transition
BEFORE UPDATE OF status ON nw_proposals
WHEN OLD.status <> NEW.status
  AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'pending')
    OR (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
  )
BEGIN
  SELECT RAISE(ABORT, 'illegal proposal status transition');
END;

CREATE TRIGGER IF NOT EXISTS nw_trg_proposals_terminal_immutable
BEFORE UPDATE ON nw_proposals
WHEN OLD.status IN ('approved', 'rejected')
BEGIN
  SELECT RAISE(ABORT, 'terminal proposal is immutable');
END;
`
