-- release-phase: expand
-- Proposals need the core-computed provenance/taint context until the owner
-- decides. It is intentionally separate from payload_json: model input cannot
-- forge or overwrite it through proposals.create.

ALTER TABLE proposals ADD COLUMN context_json TEXT;
