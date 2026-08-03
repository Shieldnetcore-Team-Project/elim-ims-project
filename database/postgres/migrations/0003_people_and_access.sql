-- =============================================================================
-- 0003_people_and_access.sql
-- Staff, system accounts, RBAC roles and page-level access.
--
-- employees vs. users: an employee is a person on payroll; a user is a
-- system login. Not every employee has a login, and (in principle) a login
-- could belong to a non-employee (an external auditor). The FK direction is
-- therefore users.employee_id -> employees.id, nullable, unique (an employee
-- has at most one account).
-- =============================================================================

CREATE TABLE employees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,               -- e.g. 'EMP-0001'
  full_name     TEXT NOT NULL,
  department_id UUID REFERENCES departments(id),
  job_title_id  UUID REFERENCES job_titles(id),
  hire_date     DATE,                                -- replaces the free-text "tenure" string; tenure is derived, see v_employee_directory (0013)
  status        employee_status_enum NOT NULL DEFAULT 'ACTIVE',
  deleted_at    TIMESTAMPTZ,                          -- set by the deletion-approval workflow, see 0010/0014
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RBAC role definitions. `members` is intentionally NOT a stored column —
-- it's COUNT(users WHERE role_id = ...), a value fully determined by the
-- users table, and storing it here would just be a copy that drifts the
-- moment a user's role changes without this row being touched in lockstep.
-- Exposed instead via v_role_member_counts (0013).
CREATE TABLE app_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  scope       TEXT,
  status      role_status_enum NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,               -- e.g. 'USR-0001'
  employee_id    UUID UNIQUE REFERENCES employees(id),
  full_name      TEXT NOT NULL,
  email          CITEXT UNIQUE,
  role_id        UUID REFERENCES app_roles(id),
  status         user_status_enum NOT NULL DEFAULT 'ACTIVE',
  last_active_at TIMESTAMPTZ,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_format CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Baseline permissions granted to everyone holding a role.
CREATE TABLE role_page_access (
  role_id  UUID NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  page_key TEXT NOT NULL REFERENCES pages(page_key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, page_key)
);

-- Per-user grants layered on top of the role baseline (a user's effective
-- access is the union of both — see v_effective_page_access, 0015). No row
-- for a (user, page) pair in either table = no access; dashboard access and
-- System admin bypass this entirely (enforced at the application layer).
CREATE TABLE user_page_access (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_key   TEXT NOT NULL REFERENCES pages(page_key) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_key)
);
