ALTER TABLE `reports` ADD `health_check_id` text REFERENCES health_checks(id);--> statement-breakpoint
ALTER TABLE `reports` ADD `data_json` text;