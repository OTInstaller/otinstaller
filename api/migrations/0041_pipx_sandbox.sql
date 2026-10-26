-- pipx tools no longer resolve their dependencies on every install. The scanner pins them once (python_lock: one
-- "name==version --hash=sha256:..." line per dependency, with every file PyPI has for that version), builds the
-- sandbox image from that lock, scans it, and pushes it to the mirror signed by the scan workflow (sandbox_image,
-- <mirror host>/<ns>/<name>@sha256:...). The manifest response hands both to ot: it pulls the image by digest, or
-- builds locally from the lock. Older versions have neither and install as before. See scans.ts and backups.ts.

ALTER TABLE versions ADD COLUMN python_lock TEXT;
ALTER TABLE versions ADD COLUMN sandbox_image TEXT;
