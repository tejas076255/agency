CREATE TABLE `profile_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`run_at` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`score` integer,
	`projected_score` integer,
	`items_json` text,
	`facts_json` text,
	`error` text,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_scans_client_idx` ON `profile_scans` (`client_id`,`run_at`);--> statement-breakpoint
ALTER TABLE `reviews` ADD `ai_draft_reply` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `ai_draft_at` integer;