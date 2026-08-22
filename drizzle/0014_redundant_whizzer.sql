CREATE TABLE `image_update_state` (
	`stack` text NOT NULL,
	`image` text NOT NULL,
	`local_digest` text,
	`remote_digest` text,
	`has_update` integer DEFAULT false NOT NULL,
	`error` text,
	`skipped_reason` text,
	`first_seen_at` integer,
	`checked_at` integer DEFAULT (unixepoch()) NOT NULL,
	`run_id` integer,
	PRIMARY KEY(`stack`, `image`)
);
--> statement-breakpoint
CREATE TABLE `update_check_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`updates_found` integer DEFAULT 0 NOT NULL,
	`get_fallbacks` integer DEFAULT 0 NOT NULL,
	`auto` integer DEFAULT false NOT NULL,
	`error` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`progress_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer
);
