-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0008: attachment_metadata
--
-- Source: architecturefinal-v4.5.1.md §6, entity 13; Attachment
-- Retention & Purge Safety callout.

create table attachment_metadata (
    id              uuid primary key not null default gen_random_uuid(),
    transaction_id  uuid not null references transactions(id) on delete restrict,
    file_name       text not null,
    mime_type       text not null,
    file_size_bytes integer not null check (file_size_bytes > 0),
    storage_key     text,
    checksum_sha256 text not null,
    is_purged       boolean not null default false,
    purged_at       timestamptz,
    created_at      timestamptz not null
);

create index idx_attachment_tx on attachment_metadata(transaction_id);

comment on table attachment_metadata is
    'Retained permanently for traceability even after the underlying Supabase Storage file is purged (~3-year retention). Purge sets is_purged/purged_at only -- it never deletes this row, the parent transaction, or any derived financial calculation (§6 Attachment Retention & Purge Safety, §13 Invariant 41).';
