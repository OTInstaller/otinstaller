-- Search filtered and summarised every candidate by parsing its latest version's manifest (json_extract on
-- versions.manifest_json for passive_only, level, format, lang, and nine summary fields per row). Those fields now live
-- on tools, written by latestMetadata whenever the latest version changes (SEARCH_FIELDS in src/catalog.ts). This
-- fills them for every tool from its current latest version, with the same expressions.
-- (tool_io, which the input and output filters read, already has the index tool_io_lookup.)

ALTER TABLE tools ADD COLUMN title TEXT;
ALTER TABLE tools ADD COLUMN level TEXT;
ALTER TABLE tools ADD COLUMN format TEXT;
ALTER TABLE tools ADD COLUMN language TEXT;
ALTER TABLE tools ADD COLUMN touches_target INTEGER;
ALTER TABLE tools ADD COLUMN auth_required INTEGER;
ALTER TABLE tools ADD COLUMN collects_personal_data INTEGER;
ALTER TABLE tools ADD COLUMN notifies_target INTEGER;
ALTER TABLE tools ADD COLUMN egress INTEGER;

UPDATE tools SET title = json_extract(v.manifest_json, '$.title'), level = json_extract(v.manifest_json, '$.level'),
  format = json_extract(v.manifest_json, '$.format'), language = json_extract(v.manifest_json, '$.language'),
  touches_target = json_extract(v.manifest_json, '$.ethics.touches_target'), auth_required = json_extract(v.manifest_json, '$.ethics.auth_required'),
  collects_personal_data = json_extract(v.manifest_json, '$.ethics.collects_personal_data'),
  notifies_target = json_extract(v.manifest_json, '$.ethics.notifies_target'), egress = json_extract(v.manifest_json, '$.network.egress')
FROM versions v WHERE v.id = tools.latest_version_id;
