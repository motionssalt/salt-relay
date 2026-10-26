export interface ZernioKey {
  id: string;
  label: string;
  masked_key: string;
  is_active: boolean;
  created_at: string;
  connected_accounts_count?: number;
}

export interface ConnectedAccount {
  id: string;
  platform: 'tiktok' | 'youtube' | 'threads' | 'instagram' | 'twitter' | 'telegram' | 'pinterest';
  platform_account_id: string;
  name: string;
  username: string;
  avatar_url?: string;
  key_id: string;
  key_label: string;
  is_active: boolean;
  last_synced_at: string;
}

export interface JobDestination {
  id: string;
  job_id: string;
  account_id: string;
  platform: string;
  post_type: 'feed' | 'story';
  status: 'pending' | 'publishing' | 'published' | 'skipped' | 'failed';
  external_post_id?: string;
  external_post_url?: string;
  error_message?: string;
  attempts: number;
  last_attempt_at?: string;
}

export interface JobSource {
  id?: string;
  job_id?: string;
  position: number;
  source_url: string;
  source_kind: 'direct_url' | 'drive_file' | 'drive_folder';
  created_at?: string;
}

export interface JobMedia {
  id: string;
  job_id: string;
  source_url: string;
  source_type: 'direct' | 'drive';
  file_type: 'image' | 'video' | 'unknown';
  filename?: string;
  mime_type?: string;
  file_size?: number;
  width?: number;
  height?: number;
  duration_sec?: number;
  release_tag?: string;
  asset_id?: string;
  asset_name?: string;
  asset_download_url?: string;
  sha256?: string;
  status: 'pending' | 'processed' | 'failed';
  error?: string;
}

export interface JobEvent {
  id: string;
  job_id: string;
  stage: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  details_json?: string;
  created_at: string;
}

export interface Job {
  id: string;
  caption: string;
  hashtags: string;
  raw_links_json: string;
  sources_json?: string;
  publish_mode: 'now' | 'queue' | 'schedule';
  status: 'pending' | 'processing' | 'scheduled' | 'publishing' | 'published' | 'partially_published' | 'failed' | 'cancelled';
  story_enabled: number;
  scheduled_at?: string;
  published_at?: string;
  timezone: string;
  attempt_count?: number;
  dry_run?: number;
  error_message?: string;
  workflow_run_id?: string;
  workflow_run_url?: string;
  created_at: string;
  updated_at: string;
  sources?: JobSource[];
  destinations?: JobDestination[];
  media?: JobMedia[];
  events?: JobEvent[];
}

export interface QueueConfig {
  posts_per_day: number;
  daily_times: string[];
  timezone: string;
  is_active: boolean;
}

export interface PlatformCapability {
  name: string;
  slug: string;
  supported_media: string[];
  allow_mixed_media: boolean;
  max_carousel_items: number;
  caption_limit: number;
  title_limit?: number;
  story_support: boolean;
  scheduling_support: boolean;
}
