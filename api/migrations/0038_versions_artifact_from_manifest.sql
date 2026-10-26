-- A version re-released after a rejection reused its row but kept the runtime and artifact of the rejected release;
-- processJob (src/publish.ts) now takes them from the new manifest. Two published versions had drifted:
-- osintverse-community/naminter 1.0.9 (a pipx wheel at first, a Docker image when it passed) and octosuite 5.1.0 (a
-- rebuilt image). Sets both columns from the manifest wherever they differ. Data only; no schema change.

UPDATE versions
SET runtime_kind = json_extract(manifest_json, '$.runtime.kind'),
    artifact_ref = COALESCE(json_extract(manifest_json, '$.runtime.image'), 'sha256:' || json_extract(manifest_json, '$.runtime.wheel_sha256'))
WHERE json_extract(manifest_json, '$.runtime') IS NOT NULL
  AND (runtime_kind IS NOT json_extract(manifest_json, '$.runtime.kind')
    OR artifact_ref IS NOT COALESCE(json_extract(manifest_json, '$.runtime.image'), 'sha256:' || json_extract(manifest_json, '$.runtime.wheel_sha256')));
