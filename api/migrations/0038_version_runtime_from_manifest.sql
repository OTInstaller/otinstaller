-- A version re-tagged after a rejection reused its row but kept the rejected attempt's runtime_kind and artifact_ref
-- (src/publish.ts now refreshes both). osintverse-community/naminter 1.0.9, first tagged as a pipx package and then
-- rebuilt as a Docker image, was listed as pipx, left out of runtime=docker searches and the build watcher, and its
-- image looked unused to the mirror sweep. Set both from the manifest the row holds, as publishing does.

UPDATE versions
SET runtime_kind = json_extract(manifest_json, '$.runtime.kind'),
    artifact_ref = COALESCE(json_extract(manifest_json, '$.runtime.image'), 'sha256:' || json_extract(manifest_json, '$.runtime.wheel_sha256'))
WHERE json_extract(manifest_json, '$.runtime.kind') IS NOT NULL
  AND (runtime_kind IS NOT json_extract(manifest_json, '$.runtime.kind')
    OR artifact_ref IS NOT COALESCE(json_extract(manifest_json, '$.runtime.image'), 'sha256:' || json_extract(manifest_json, '$.runtime.wheel_sha256')));
