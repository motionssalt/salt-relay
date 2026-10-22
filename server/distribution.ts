import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface PlatformCapability {
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

export interface MediaAsset {
  id: string;
  file_type: 'image' | 'video';
  asset_download_url: string;
  filename: string;
}

export interface TargetDestination {
  id: string; // db account id
  platform: string;
  platform_account_id: string;
  key_id: string;
}

export interface PlannedPost {
  job_id: string;
  account_id: string;
  platform: string;
  key_id: string;
  post_type: 'feed' | 'story';
  media_group_id: string;
  media_urls: string[];
  caption: string;
  idempotency_key: string;
  status: 'pending' | 'skipped';
  skip_reason?: string;
}

export function loadCapabilities(): Record<string, PlatformCapability> {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), 'capabilities.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.platforms || {};
  } catch (e) {
    console.warn('Failed to load capabilities.json, using defaults');
    return {};
  }
}

export function formatCaptionForPlatform(caption: string, hashtags: string, limit: number): string {
  const cleanCaption = (caption || '').trim();
  const cleanTags = (hashtags || '').trim();

  let combined = cleanCaption;
  if (cleanTags) {
    combined = combined ? `${combined}\n\n${cleanTags}` : cleanTags;
  }

  if (combined.length <= limit) {
    return combined;
  }

  // Truncate caption to leave room for hashtags if possible
  if (cleanTags) {
    const spaceForCaption = limit - cleanTags.length - 5;
    if (spaceForCaption > 20) {
      const truncatedCaption = cleanCaption.slice(0, spaceForCaption) + '...';
      return `${truncatedCaption}\n\n${cleanTags}`;
    }
  }

  return combined.slice(0, limit - 3) + '...';
}

export function planJobDestinations(
  jobId: string,
  caption: string,
  hashtags: string,
  mediaAssets: MediaAsset[],
  destinations: TargetDestination[],
  storyEnabled: boolean
): PlannedPost[] {
  const capabilities = loadCapabilities();
  const plans: PlannedPost[] = [];

  const images = mediaAssets.filter(m => m.file_type === 'image');
  const videos = mediaAssets.filter(m => m.file_type === 'video');

  for (const dest of destinations) {
    const cap = capabilities[dest.platform] || {
      name: dest.platform,
      slug: dest.platform,
      supported_media: ['image', 'video'],
      allow_mixed_media: true,
      max_carousel_items: 10,
      caption_limit: 1000,
      story_support: false,
      scheduling_support: true
    };

    const supportsImages = cap.supported_media.includes('image');
    const supportsVideos = cap.supported_media.includes('video');

    // 1. Plan Feed Posts
    let eligibleAssets: MediaAsset[] = [];
    if (supportsImages && supportsVideos) {
      eligibleAssets = [...mediaAssets];
    } else if (supportsVideos && !supportsImages) {
      eligibleAssets = [...videos];
    } else if (supportsImages && !supportsVideos) {
      eligibleAssets = [...images];
    }

    if (eligibleAssets.length === 0 && mediaAssets.length > 0) {
      // Skipped destination due to media incompatibility
      plans.push({
        job_id: jobId,
        account_id: dest.id,
        platform: dest.platform,
        key_id: dest.key_id,
        post_type: 'feed',
        media_group_id: 'none',
        media_urls: [],
        caption: '',
        idempotency_key: `skip_${jobId}_${dest.id}_feed`,
        status: 'skipped',
        skip_reason: `Platform ${cap.name} only supports ${cap.supported_media.join('/')}, but none provided.`
      });
    } else if (eligibleAssets.length === 0 && mediaAssets.length === 0) {
      // Text-only post
      const formattedCaption = formatCaptionForPlatform(caption, hashtags, cap.caption_limit);
      const idempotency = crypto.createHash('sha256')
        .update(`${jobId}:${dest.id}:feed:text`)
        .digest('hex').slice(0, 32);

      plans.push({
        job_id: jobId,
        account_id: dest.id,
        platform: dest.platform,
        key_id: dest.key_id,
        post_type: 'feed',
        media_group_id: 'text_only',
        media_urls: [],
        caption: formattedCaption,
        idempotency_key: idempotency,
        status: 'pending'
      });
    } else {
      // Media grouping logic
      const formattedCaption = formatCaptionForPlatform(caption, hashtags, cap.caption_limit);

      if (cap.allow_mixed_media) {
        // Platform supports mixed carousels (e.g. Instagram, Threads, Telegram)
        const chunks: MediaAsset[][] = [];
        for (let i = 0; i < eligibleAssets.length; i += cap.max_carousel_items) {
          chunks.push(eligibleAssets.slice(i, i + cap.max_carousel_items));
        }

        chunks.forEach((chunk, chunkIdx) => {
          const groupId = `feed_grp_${chunkIdx}`;
          const idempotency = crypto.createHash('sha256')
            .update(`${jobId}:${dest.id}:feed:${groupId}:${chunk.map(c => c.id).join(',')}`)
            .digest('hex').slice(0, 32);

          plans.push({
            job_id: jobId,
            account_id: dest.id,
            platform: dest.platform,
            key_id: dest.key_id,
            post_type: 'feed',
            media_group_id: groupId,
            media_urls: chunk.map(c => c.asset_download_url),
            caption: formattedCaption,
            idempotency_key: idempotency,
            status: 'pending'
          });
        });
      } else {
        // Platform does NOT allow mixed media (e.g. X/Twitter, TikTok, YouTube, Pinterest)
        // Separate images and videos
        const chunkList: Array<{ type: string; assets: MediaAsset[] }> = [];

        // Image chunks
        const eligibleImages = eligibleAssets.filter(a => a.file_type === 'image');
        for (let i = 0; i < eligibleImages.length; i += cap.max_carousel_items) {
          chunkList.push({ type: 'image', assets: eligibleImages.slice(i, i + cap.max_carousel_items) });
        }

        // Video chunks (videos are single-item posts on non-mixed platforms)
        const eligibleVideos = eligibleAssets.filter(a => a.file_type === 'video');
        for (const vid of eligibleVideos) {
          chunkList.push({ type: 'video', assets: [vid] });
        }

        chunkList.forEach((chunk, chunkIdx) => {
          const groupId = `feed_sep_${chunkIdx}`;
          const idempotency = crypto.createHash('sha256')
            .update(`${jobId}:${dest.id}:feed:${groupId}:${chunk.assets.map(c => c.id).join(',')}`)
            .digest('hex').slice(0, 32);

          plans.push({
            job_id: jobId,
            account_id: dest.id,
            platform: dest.platform,
            key_id: dest.key_id,
            post_type: 'feed',
            media_group_id: groupId,
            media_urls: chunk.assets.map(c => c.asset_download_url),
            caption: formattedCaption,
            idempotency_key: idempotency,
            status: 'pending'
          });
        });
      }
    }

    // 2. Plan Story Posts (if Story toggle enabled)
    if (storyEnabled) {
      if (!cap.story_support) {
        plans.push({
          job_id: jobId,
          account_id: dest.id,
          platform: dest.platform,
          key_id: dest.key_id,
          post_type: 'story',
          media_group_id: 'story_unsupported',
          media_urls: [],
          caption: '',
          idempotency_key: `skip_${jobId}_${dest.id}_story`,
          status: 'skipped',
          skip_reason: `Platform ${cap.name} does not support Stories via API.`
        });
      } else {
        // Story requires at least 1 image or video
        const storyAssets = eligibleAssets.length > 0 ? eligibleAssets : mediaAssets;
        if (storyAssets.length === 0) {
          plans.push({
            job_id: jobId,
            account_id: dest.id,
            platform: dest.platform,
            key_id: dest.key_id,
            post_type: 'story',
            media_group_id: 'story_no_media',
            media_urls: [],
            caption: '',
            idempotency_key: `skip_${jobId}_${dest.id}_story_nomedia`,
            status: 'skipped',
            skip_reason: 'Stories require visual media (image or video).'
          });
        } else {
          // Stories are posted individually per asset
          storyAssets.forEach((asset, idx) => {
            const groupId = `story_${idx}`;
            const idempotency = crypto.createHash('sha256')
              .update(`${jobId}:${dest.id}:story:${groupId}:${asset.id}`)
              .digest('hex').slice(0, 32);

            plans.push({
              job_id: jobId,
              account_id: dest.id,
              platform: dest.platform,
              key_id: dest.key_id,
              post_type: 'story',
              media_group_id: groupId,
              media_urls: [asset.asset_download_url],
              caption: formatCaptionForPlatform(caption, hashtags, cap.caption_limit),
              idempotency_key: idempotency,
              status: 'pending'
            });
          });
        }
      }
    }
  }

  return plans;
}
