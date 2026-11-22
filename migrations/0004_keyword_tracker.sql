CREATE TABLE `keyword_rankings` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`keyword_id` text NOT NULL,
	`period_end` text NOT NULL,
	`position` real,
	`clicks` integer DEFAULT 0 NOT NULL,
	`impressions` integer DEFAULT 0 NOT NULL,
	`top_page` text,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`keyword_id`) REFERENCES `tracked_keywords`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kw_rank_keyword_period_uq` ON `keyword_rankings` (`keyword_id`,`period_end`);--> statement-breakpoint
CREATE TABLE `tracked_keywords` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`keyword` text NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_kw_client_keyword_uq` ON `tracked_keywords` (`client_id`,`keyword`);--> statement-breakpoint
CREATE INDEX `tracked_kw_agency_idx` ON `tracked_keywords` (`agency_id`);