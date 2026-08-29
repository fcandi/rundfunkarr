-- Drop the unique constraint on GeneratedRuleset.topic in favor of a composite
-- unique key on (topic, tvdbId): broadcasters that run every series of a slot
-- under one collective topic ("Fernsehfilme und Serien - Serien" at ARTE) need
-- one ruleset per show on the same topic, each scoped by a title filter.
--
-- Databases bootstrapped by init-db.sql (the container path) are migrated by
-- entrypoint.sh instead; this migration keeps `prisma migrate` based setups in
-- sync with schema.prisma.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GeneratedRuleset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topic" TEXT NOT NULL,
    "tvdbId" INTEGER NOT NULL,
    "showName" TEXT NOT NULL,
    "germanName" TEXT,
    "matchingStrategy" TEXT NOT NULL DEFAULT 'SeasonAndEpisodeNumber',
    "filters" TEXT NOT NULL DEFAULT '[{"attribute":"duration","type":"GreaterThan","value":"15"}]',
    "episodeRegex" TEXT NOT NULL DEFAULT '(?<=[E/])(\d{2})(?=\))',
    "seasonRegex" TEXT NOT NULL DEFAULT '(?<=[S(])(\d{2})(?=[/E])',
    "titleRegexRules" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GeneratedRuleset" ("id", "topic", "tvdbId", "showName", "germanName", "matchingStrategy", "filters", "episodeRegex", "seasonRegex", "titleRegexRules", "createdAt", "updatedAt")
SELECT "id", "topic", "tvdbId", "showName", "germanName", "matchingStrategy", "filters", "episodeRegex", "seasonRegex", "titleRegexRules", "createdAt", "updatedAt" FROM "GeneratedRuleset";
DROP TABLE "GeneratedRuleset";
ALTER TABLE "new_GeneratedRuleset" RENAME TO "GeneratedRuleset";
CREATE INDEX "GeneratedRuleset_tvdbId_idx" ON "GeneratedRuleset"("tvdbId");
CREATE UNIQUE INDEX "GeneratedRuleset_topic_tvdbId_key" ON "GeneratedRuleset"("topic", "tvdbId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
