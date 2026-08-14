
-- General Inventory spec distinguishes "Stock Issued" from "Stock Used for Production" as
-- separate transaction types. Today issue_raw_material() always records 'issued', so the
-- two are indistinguishable in the movement history. Add a dedicated enum value; the RPC
-- update that starts using it lives in the next migration (a new enum value can't be
-- referenced in the same transaction that creates it).
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'used_for_production';
