-- Release notes: where a version's `changelog` came from. 'release' is the host's release for the tag (read when the
-- release is published, or from the release webhook); 'file' is the version's section of CHANGELOG.md at the tagged
-- commit, used when there is no release. Notes are stored as Markdown and rendered when served.
ALTER TABLE versions ADD COLUMN changelog_source TEXT CHECK (changelog_source IN ('release', 'file'));

-- Notes recorded so far all came from release webhooks.
UPDATE versions SET changelog_source = 'release' WHERE changelog IS NOT NULL AND changelog != '';
