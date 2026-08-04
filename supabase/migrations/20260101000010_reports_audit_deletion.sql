-- Originally authored as database/postgres/migrations/0010_reports_audit_deletion.sql — copied here verbatim as the canonical, Supabase-CLI-managed migration history (see supabase/migrations/README.md).
-- =============================================================================
-- 0010_reports_audit_deletion.sql
-- Saved reports, the audit trail, and the delete-by-approval workflow.
-- =============================================================================

CREATE TABLE reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,               -- e.g. 'RPT-001'
  name             TEXT NOT NULL,
  scope            TEXT,
  owner_employee_id UUID REFERENCES employees(id),
  status           report_status_enum NOT NULL DEFAULT 'COMPLETED',
  last_run_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The audit trail: every service call in the application layer appends
-- here. Append-only — enforced by trg_activity_log_append_only (0012).
CREATE TABLE activity_log (
  id             BIGSERIAL PRIMARY KEY,
  actor_user_id  UUID REFERENCES users(id),
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  summary        TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nothing in this app is ever hard-deleted. A delete action anywhere creates
-- a PENDING row here instead; a super admin's APPROVED review is what
-- actually hides the record — trg_deletion_requests_apply (0012) stamps
-- deleted_at on the target row (looked up generically via
-- deletable_entities, 0002) the moment status flips to APPROVED.
CREATE TABLE deletion_requests (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type            TEXT NOT NULL REFERENCES deletable_entities(entity_type),
  entity_id              UUID NOT NULL,
  entity_label           TEXT,
  requested_by_user_id   UUID NOT NULL REFERENCES users(id),
  reason                 TEXT NOT NULL,
  status                 deletion_status_enum NOT NULL DEFAULT 'PENDING',
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by_user_id    UUID REFERENCES users(id),
  reviewed_at            TIMESTAMPTZ,
  review_note            TEXT,
  CONSTRAINT deletion_requests_reviewed_after_requested CHECK (reviewed_at IS NULL OR reviewed_at >= requested_at)
);
