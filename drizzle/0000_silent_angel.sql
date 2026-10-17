CREATE TABLE `sona_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`message` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sona_challenges_expires` ON `sona_challenges` (`expires`);--> statement-breakpoint
CREATE TABLE `sona_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sona_limits_window` ON `sona_limits` (`window`);--> statement-breakpoint
CREATE TABLE `sona_records` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sona_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sona_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sona_sessions_expires` ON `sona_sessions` (`expires`);