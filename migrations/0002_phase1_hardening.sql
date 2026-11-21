CREATE TABLE `api_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text,
	`api` text NOT NULL,
	`day` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`quota_errors` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_agency_api_day_uq` ON `api_usage` (`agency_id`,`api`,`day`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text,
	`user_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`ip_hash` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_agency_created_idx` ON `audit_logs` (`agency_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `report_settings` (
	`agency_id` text PRIMARY KEY NOT NULL,
	`email_subject` text,
	`email_message` text,
	`cc_agency` integer DEFAULT false NOT NULL,
	`include_hinglish` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `action_items` ADD `description` text;--> statement-breakpoint
ALTER TABLE `action_items` ADD `supporting_metrics_json` text;--> statement-breakpoint
ALTER TABLE `health_checks` ADD `formula_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_uq` ON `job_runs` (`dedupe_key`);--> statement-breakpoint
ALTER TABLE `users` ADD `session_version` integer DEFAULT 0 NOT NULL;