-- Stars were planned (0001) but no route ever recorded one, so tools.stars_count was 0 for every tool in production
-- and the stars table was empty. Search ranking no longer reads them; API responses keep "stars": 0 for older clients,
-- and sort=stars sorts by relevance.
--
-- Nothing references stars, and no index, trigger or view reads tools.stars_count, so both can go without rebuilding a
-- table. (The repository's own stars, sources.stars, stay: sync writes them.)

DROP TABLE stars;
ALTER TABLE tools DROP COLUMN stars_count;
