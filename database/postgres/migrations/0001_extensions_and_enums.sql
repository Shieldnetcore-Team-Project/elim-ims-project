-- =============================================================================
-- 0001_extensions_and_enums.sql
-- Elim Water Factory ERP — PostgreSQL schema
--
-- Extensions and every closed-set status/category as a native ENUM. A column
-- gets an ENUM here only when its value set is fixed by the business process
-- (a workflow status, a channel, a direction). Open-ended, growable
-- categories (departments, locations, item categories, ...) are lookup
-- tables instead — see 0002_lookup_tables.sql — because ENUM values require
-- a schema migration to extend, and these are expected to grow over time.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email comparisons/uniqueness

-- ---- Masters -----------------------------------------------------------
CREATE TYPE item_type_enum        AS ENUM ('RAW_MATERIAL','PACKAGING','CONSUMABLE','FINISHED_GOOD');
CREATE TYPE employee_status_enum  AS ENUM ('ACTIVE','INVITED','INACTIVE');
CREATE TYPE user_status_enum      AS ENUM ('ACTIVE','INVITED','SUSPENDED');
CREATE TYPE role_status_enum      AS ENUM ('ACTIVE','DRAFT');
CREATE TYPE vehicle_status_enum   AS ENUM ('ACTIVE','SCHEDULED','SUSPENDED');
CREATE TYPE asset_status_enum     AS ENUM ('ACTIVE','SCHEDULED','SUSPENDED');
CREATE TYPE setting_status_enum   AS ENUM ('ACTIVE','DRAFT');
CREATE TYPE water_run_status_enum AS ENUM ('PASS','IN_PROGRESS','FAIL');

-- ---- Procurement / receiving / QC --------------------------------------
CREATE TYPE po_status_enum   AS ENUM ('DRAFT','AWAITING_APPROVAL','APPROVED','REJECTED','RECEIVED');
CREATE TYPE grn_status_enum  AS ENUM ('PENDING_QC','PASSED','FAILED');
CREATE TYPE qc_ref_type_enum AS ENUM ('GOODS_RECEIVED','PRODUCTION_BATCH');
CREATE TYPE qc_verdict_enum  AS ENUM ('PASS','FAIL');

-- ---- Inventory / warehouse / production --------------------------------
CREATE TYPE inventory_direction_enum      AS ENUM ('IN','OUT');
CREATE TYPE inventory_source_enum         AS ENUM ('PURCHASE','PRODUCTION','SALES','MATERIAL_ISSUE','ADJUSTMENT');
CREATE TYPE requisition_status_enum       AS ENUM ('PENDING','APPROVED','ISSUED','REJECTED');
CREATE TYPE priority_enum                 AS ENUM ('LOW','MEDIUM','HIGH','URGENT');
CREATE TYPE material_request_status_enum  AS ENUM ('PENDING','ISSUED','REJECTED');
CREATE TYPE batch_status_enum             AS ENUM ('IN_PROGRESS','COMPLETED','FAILED');

-- ---- Sales / fleet -------------------------------------------------------
CREATE TYPE sales_channel_enum  AS ENUM ('INVOICE','POS');
CREATE TYPE sales_status_enum   AS ENUM ('PENDING','PROCESSING','DELIVERED','CANCELLED','PAID');
CREATE TYPE delivery_status_enum AS ENUM ('SCHEDULED','ACTIVE','DELIVERED');

-- ---- Finance ---------------------------------------------------------
CREATE TYPE finance_ref_type_enum  AS ENUM ('PURCHASE_ORDER','SALES_ORDER','PAYROLL_RUN','GOODS_RECEIVED','EXPENSE','OTHER');
CREATE TYPE payment_method_enum    AS ENUM ('CASH','BANK_TRANSFER','CHEQUE','POS_CARD','MOBILE_MONEY');
CREATE TYPE payment_status_enum    AS ENUM ('CLEARED','PENDING','OVERDUE');
CREATE TYPE counterparty_type_enum AS ENUM ('SUPPLIER','CUSTOMER','EMPLOYEE','OTHER');
CREATE TYPE payroll_status_enum    AS ENUM ('PAID','SCHEDULED','ON_HOLD');

-- ---- Reports / audit / governance --------------------------------------
CREATE TYPE report_status_enum   AS ENUM ('COMPLETED','RUNNING','FAILED');
CREATE TYPE deletion_status_enum AS ENUM ('PENDING','APPROVED','REJECTED');
