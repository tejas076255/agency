CREATE TABLE `competitors` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`place_id` text NOT NULL,
	`label` text NOT NULL,
	`is_client` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitors_client_place_uq` ON `competitors` (`client_id`,`place_id`);--> statement-breakpoint
CREATE TABLE `integration_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`source` text NOT NULL,
	`run_at` integer NOT NULL,
	`status` text NOT NULL,
	`data_json` text,
	`error` text,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snap_client_source_idx` ON `integration_snapshots` (`client_id`,`source`,`run_at`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_uq` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_agency_idx` ON `invitations` (`agency_id`);--> statement-breakpoint
CREATE TABLE `review_sentiments` (
	`review_id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`score_x100` integer NOT NULL,
	`magnitude_x100` integer NOT NULL,
	`label` text NOT NULL,
	`entities_json` text,
	`provider` text NOT NULL,
	`analyzed_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`google_review_name` text NOT NULL,
	`reviewer_name` text,
	`star_rating` integer,
	`comment` text,
	`review_created_at` integer,
	`reply_comment` text,
	`reply_updated_at` integer,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_google_name_uq` ON `reviews` (`google_review_name`);--> statement-breakpoint
CREATE INDEX `reviews_client_idx` ON `reviews` (`client_id`,`review_created_at`);--> statement-breakpoint
CREATE TABLE `sheets_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`spreadsheet_id` text,
	`url` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sheets_client_idx` ON `sheets_exports` (`client_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `clients` ADD `gbp_account_name` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `gbp_location_name` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `ads_customer_id` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `youtube_channel_id` text;