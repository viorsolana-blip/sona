CREATE TABLE `sona_records` (
  `kind` TEXT NOT NULL,
  `id` TEXT NOT NULL,
  `body` TEXT NOT NULL,
  PRIMARY KEY (`kind`, `id`)
);
CREATE TABLE `sona_revisions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `revision` INTEGER NOT NULL
);
CREATE TABLE `sona_challenges` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `address` TEXT NOT NULL,
  `message` TEXT NOT NULL,
  `expires` INTEGER NOT NULL
);
CREATE INDEX `sona_challenges_expires` ON `sona_challenges` (`expires`);
CREATE TABLE `sona_sessions` (
  `hash` TEXT PRIMARY KEY NOT NULL,
  `address` TEXT NOT NULL,
  `expires` INTEGER NOT NULL
);
CREATE INDEX `sona_sessions_expires` ON `sona_sessions` (`expires`);
CREATE TABLE `sona_limits` (
  `key` TEXT PRIMARY KEY NOT NULL,
  `window` INTEGER NOT NULL,
  `count` INTEGER NOT NULL
);
CREATE INDEX `sona_limits_window` ON `sona_limits` (`window`);
