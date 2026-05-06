CREATE TABLE `stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`icon` text,
	`tagline` text,
	`port_map` text,
	`scheme` text DEFAULT 'http',
	`index_path` text DEFAULT '/',
	`main_service` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
