-- Search follows a namespace's new name. tools_fts copies the namespace's name into each of its tools' rows, and its
-- triggers fired only on changes to tools, so renaming a namespace left the old name searchable and the new one not.

CREATE TRIGGER tools_fts_namespace_rename AFTER UPDATE OF name ON namespaces WHEN old.name IS NOT new.name BEGIN
  DELETE FROM tools_fts WHERE rowid IN (SELECT rowid FROM tools WHERE namespace_id = new.id);
  INSERT INTO tools_fts (rowid, namespace, name, summary, tags, body)
  SELECT rowid, new.name, name, summary, tags, readme_text FROM tools WHERE namespace_id = new.id;
END;
