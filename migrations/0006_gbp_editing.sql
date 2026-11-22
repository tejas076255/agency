CREATE TABLE `gbp_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`location_name` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text NOT NULL,
	`error` text,
	`created_by_user_id` text,
	`applied_by_user_id` text,
	`applied_at` integer,
	`reverts_change_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`applied_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gbp_changes_client_idx` ON `gbp_changes` (`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `gbp_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`summary` text NOT NULL,
	`action_type` text,
	`action_url` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_for` integer,
	`google_post_name` text,
	`search_url` text,
	`error` text,
	`created_by_user_id` text,
	`approved_by_user_id` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gbp_posts_client_idx` ON `gbp_posts` (`client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `gbp_posts_due_idx` ON `gbp_posts` (`status`,`scheduled_for`);