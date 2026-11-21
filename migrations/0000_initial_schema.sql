CREATE TABLE `action_items` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`insight_id` text NOT NULL,
	`priority` integer NOT NULL,
	`title` text NOT NULL,
	`why` text NOT NULL,
	`expected_impact` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`done_at` integer,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`insight_id`) REFERENCES `insights`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_insight_idx` ON `action_items` (`insight_id`);--> statement-breakpoint
CREATE INDEX `ai_agency_idx` ON `action_items` (`agency_id`);--> statement-breakpoint
CREATE TABLE `agencies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`logo_file_id` text,
	`brand_color` text DEFAULT '#4f46e5' NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`slides_template_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`website_url` text NOT NULL,
	`contact_email` text NOT NULL,
	`gsc_site_url` text,
	`ga4_property_id` text,
	`status` text DEFAULT 'not_connected' NOT NULL,
	`assigned_user_id` text,
	`auto_send_report` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `clients_agency_idx` ON `clients` (`agency_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`kind` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`data_base64` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `files_agency_idx` ON `files` (`agency_id`);--> statement-breakpoint
CREATE TABLE `google_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text,
	`purpose` text NOT NULL,
	`google_email` text NOT NULL,
	`scopes` text NOT NULL,
	`encrypted_refresh_token` text NOT NULL,
	`connected_by_user_id` text,
	`connected_at` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gconn_agency_idx` ON `google_connections` (`agency_id`);--> statement-breakpoint
CREATE INDEX `gconn_client_idx` ON `google_connections` (`client_id`);--> statement-breakpoint
CREATE TABLE `health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`run_at` integer NOT NULL,
	`gsc_json` text,
	`ga4_json` text,
	`pagespeed_json` text,
	`score` integer,
	`score_breakdown_json` text,
	`status` text NOT NULL,
	`errors_json` text,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hc_client_run_idx` ON `health_checks` (`client_id`,`run_at`);--> statement-breakpoint
CREATE INDEX `hc_agency_idx` ON `health_checks` (`agency_id`);--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`health_check_id` text NOT NULL,
	`summary` text NOT NULL,
	`summary_hinglish` text,
	`model_used` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`health_check_id`) REFERENCES `health_checks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insights_hc_uq` ON `insights` (`health_check_id`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text,
	`type` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_agency_created_idx` ON `job_runs` (`agency_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`month` text NOT NULL,
	`slides_file_id` text,
	`pdf_kv_key` text,
	`share_token` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_share_token_uq` ON `reports` (`share_token`);--> statement-breakpoint
CREATE INDEX `reports_client_month_idx` ON `reports` (`client_id`,`month`);--> statement-breakpoint
CREATE INDEX `reports_agency_idx` ON `reports` (`agency_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`picture_url` text,
	`role` text DEFAULT 'owner' NOT NULL,
	`google_sub` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_uq` ON `users` (`google_sub`);--> statement-breakpoint
CREATE INDEX `users_agency_idx` ON `users` (`agency_id`);