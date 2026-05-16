CREATE TABLE `samba_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`browseable` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `samba_shares_name_unique` ON `samba_shares` (`name`);