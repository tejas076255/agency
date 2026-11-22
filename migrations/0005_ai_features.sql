CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`health_check_id` text,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`details_json` text,
	`explanation` text,
	`explanation_source` text,
	`emailed_at` integer,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`health_check_id`) REFERENCES `health_checks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alerts_agency_created_idx` ON `alerts` (`agency_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alerts_client_idx` ON `alerts` (`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `prospect_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`created_by_user_id` text,
	`url` text NOT NULL,
	`business_name` text,
	`status` text NOT NULL,
	`checks_json` text,
	`report_json` text,
	`report_source` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `prospect_agency_idx` ON `prospect_audits` (`agency_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `clients` ADD `auto_reply_min_stars` integer;--> statement-breakpoint
ALTER TABLE `clients` ADD `auto_reply_language` text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `auto_replied` integer DEFAULT false NOT NULL;