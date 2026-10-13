import type { Env } from '../types';
import { pcoFetch, pcoFetchRaw, PCO_BASE } from './pco';
import { ytFetch, ytVideoDetails } from './youtube';
import { cachedJson } from './cache';

// PCO's rate limits are far more generous than YouTube's, so this is purely
// about speed, not avoiding a quota — no dailyCallCap needed. 5 min matches
// the cache-warming cron cadence for these.
const EVENTS_TTL_SECONDS = 5 * 60;

function cachedPco(path: string, env: Env): Promise<any> {
	return cachedJson(env, `${PCO_BASE}${path}`, EVENTS_TTL_SECONDS, () => pcoFetchRaw(path, env));
}

// Every caller that wants "the upcoming registrations/calendar events" used
// to fetch its own differently-sized page of the same two PCO endpoints
// (per_page 5, 10, 25, 50 depending on the caller) — same fragmentation
// problem the YouTube caching hit: each variant was its own independent
// cache entry with its own miss timing. Fetch the one generous size every
// caller can slice from instead.
export function getRegistrationSignups(env: Env): Promise<any> {
	return cachedPco('/registrations/v2/signups?per_page=50&include=next_signup_time', env);
}

export function getFutureEventInstances(env: Env): Promise<any> {
	return cachedPco('/calendar/v2/event_instances?filter=future&order=starts_at&per_page=50&include=event', env);
}

export function parseTitleDate(title: string): string | null {
	// Matches M.D.YYYY / MM.DD.YYYY and the same with - or / separators.
	// Month and day accept a single digit: requiring two silently dropped
	// videos titled the natural way ("Sunday Worship 9.7.2026").
	//
	// Every candidate in the title is checked, not just the first, so a
	// title that leads with something date-shaped but invalid ("Acts
	// 20.15.2026") doesn't lose the real date further along.
	for (const match of title.matchAll(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/g)) {
		const month = Number(match[1]);
		const day = Number(match[2]);
		if (month < 1 || month > 12 || day < 1 || day > 31) continue;
		return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	}
	return null;
}

export async function getSettings(env: Env): Promise<Record<string, any>> {
	const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
	const map: Record<string, any> = {};
	results.forEach((r: any) => { map[r.key] = r.value; });
	if (map.service_times) {
		try { map.service_times = JSON.parse(map.service_times); } catch {}
	}
	if (map.service_notes) {
		try { map.service_notes = JSON.parse(map.service_notes); } catch {}
	}
	if (map.social) {
		try { map.social = JSON.parse(map.social); } catch {}
	}
	return map;
}

/**
 * Church Center link for a calendar event.
 *
 * Planning Center's calendar API returns no public URL for an event, so it
 * has to be composed from the church's own Church Center subdomain. That
 * lives in the `church_center_url` setting; a church that has not set one
 * (or does not use Church Center) gets a null link, and clients render the
 * event without a registration button rather than a broken one.
 */
export async function churchCenterEventUrl(eventId: string, env: Env): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT value FROM settings WHERE key = 'church_center_url'"
	).first<{ value: string }>();
	const base = row?.value?.trim().replace(/\/+$/, '');
	return base ? `${base}/calendar/event/${eventId}` : null;
}

// A service can run long, and YouTube's liveStreamingDetails.actualEndTime is
// sometimes never reported, so once a broadcast's start time has passed we
// only treat it as live for this long before requiring a real end time.
const ASSUMED_STREAM_DURATION_MS = 3 * 60 * 60 * 1000;
// How far ahead of its scheduled start a not-yet-live broadcast is surfaced
// as "starting soon".
const UPCOMING_WINDOW_MS = 2 * 60 * 60 * 1000;

export async function getLiveStream(env: Env): Promise<any> {
	if (!env.YOUTUBE_API_KEY || !env.YOUTUBE_CHANNEL_ID) return null;

	try {
		// No separate eventType=live/eventType=upcoming search.list calls —
		// those cost 100 quota units each and YouTube's eventType flag is
		// driven by its search index anyway, which can lag several minutes
		// behind a broadcast actually starting (or ending), plus it misses a
		// stream whose scheduled time has passed without actually starting
		// (invisible to both eventType filters at that point). The time math
		// below is what actually decides liveness, and it can run against
		// any recent video — so just reuse getMergedSermons's one shared,
		// already cache-warmed uploads query (1 unit, and coalesced with
		// getMergedSermons's own call for the same key) and check every
		// candidate's liveStreamingDetails via the 1-unit videos.list below.
		const items = (await ytFetch(env, 50))?.items || [];
		const videoIds = [...new Set(items.map(v => v.id))];
		if (!videoIds.length) return null;

		const detailData: any = await ytVideoDetails(env, videoIds);
		if (!detailData) return null;

		const now = Date.now();
		let soonest: { startMs: number; video: any; scheduledStart?: string } | null = null;

		for (const video of detailData.items || []) {
			const details = video.liveStreamingDetails;
			if (!details || details.actualEndTime) continue;

			const startSource = details.actualStartTime || details.scheduledStartTime;
			if (!startSource) continue;
			const startMs = new Date(startSource).getTime();

			if (now >= startMs && now < startMs + ASSUMED_STREAM_DURATION_MS) {
				return {
					url: `https://www.youtube.com/watch?v=${video.id}`,
					title: video.snippet.title,
					isLive: true,
				};
			}

			if (startMs > now && (!soonest || startMs < soonest.startMs)) {
				soonest = { startMs, video, scheduledStart: details.scheduledStartTime };
			}
		}

		if (soonest && soonest.startMs - now <= UPCOMING_WINDOW_MS) {
			return {
				url: `https://www.youtube.com/watch?v=${soonest.video.id}`,
				title: soonest.video.snippet.title,
				isLive: false,
				scheduledStart: soonest.scheduledStart,
			};
		}
	} catch (e) {
		console.error('getLiveStream error:', e);
	}

	return null;
}

export async function getNextEvent(featuredEventId: string | null, env: Env): Promise<any> {
	const [regResult, calResult] = await Promise.allSettled([
		getRegistrationSignups(env),
		getFutureEventInstances(env),
	]);

	const events: any[] = [];

	if (regResult.status === 'fulfilled') {
		events.push(...parsePcoRegistrations(regResult.value.data || [], regResult.value.included || [], 'reg:'));
	}
	if (calResult.status === 'fulfilled') {
		events.push(...parsePcoCalendar(calResult.value.data || [], calResult.value.included || [], 'cal:'));
	}

	const withDate = sortByDate(events.filter(e => e.starts_at));
	return withDate.find(e => e.id !== featuredEventId) ?? null;
}

export async function getFeaturedEvent(featuredId: string | null, env: Env): Promise<any> {
	if (!featuredId) return getAutoFeaturedEvent(env);

	const colonIdx = featuredId.indexOf(':');
	const source = colonIdx > -1 ? featuredId.slice(0, colonIdx) : 'reg';
	const id = colonIdx > -1 ? featuredId.slice(colonIdx + 1) : featuredId;

	try {
		if (source === 'cal') {
			const [eventRes, instancesRes] = await Promise.allSettled([
				cachedPco(`/calendar/v2/events/${id}`, env),
				cachedPco(`/calendar/v2/events/${id}/event_instances?filter=future&order=starts_at&per_page=1`, env),
			]);
			if (eventRes.status !== 'fulfilled') return null;
			const e = eventRes.value.data;
			if (!e) return null;
			const nextInstance = instancesRes.status === 'fulfilled' ? instancesRes.value.data?.[0] : null;
			return {
				id: featuredId,
				name: e.attributes.name,
				starts_at: nextInstance?.attributes?.starts_at || null,
				registration_url: await churchCenterEventUrl(id, env),
				source: 'calendar',
			};
		} else {
			const data = await cachedPco(`/registrations/v2/signups/${id}?include=next_signup_time`, env);
			const e = data.data;
			if (!e) return null;
			const time = data.included?.[0];
			return {
				id: featuredId,
				name: e.attributes.name,
				starts_at: time?.attributes?.starts_at || null,
				registration_url: e.attributes.new_registration_url,
				source: 'registrations',
			};
		}
	} catch {
		return null;
	}
}

async function getAutoFeaturedEvent(env: Env): Promise<any> {
	const [regResult, calResult] = await Promise.allSettled([
		getRegistrationSignups(env),
		getFutureEventInstances(env),
	]);

	const events: any[] = [];

	if (regResult.status === 'fulfilled') {
		const { data: signups = [], included = [] } = regResult.value;
		events.push(...parsePcoRegistrations(signups, included, 'reg:'));
	}

	if (calResult.status === 'fulfilled') {
		const { data: instances = [], included = [] } = calResult.value;
		events.push(...parsePcoCalendar(instances, included, 'cal:'));
	}

	const withDate = events.filter(e => e.starts_at);
	const next = sortByDate(withDate)[0] ?? events[0] ?? null;
	if (!next) return null;

	return {
		id: next.id,
		name: next.name,
		starts_at: next.starts_at,
		ends_at: next.ends_at ?? null,
		registration_url: next.registration_url,
		source: next.source,
	};
}

export function parsePcoRegistrations(signups: any[], included: any[], idPrefix = 'reg-'): any[] {
	const timeMap = new Map(included.map((i: any) => [i.id, i]));
	const events: any[] = [];
	for (const e of signups) {
		if (e.attributes.archived || e.attributes.closed) continue;
		const timeId = e.relationships?.next_signup_time?.data?.id;
		const time: any = timeMap.get(timeId);
		events.push({
			id: `${idPrefix}${e.id}`,
			name: e.attributes.name,
			description: e.attributes.description || null,
			starts_at: time?.attributes?.starts_at || null,
			ends_at: time?.attributes?.ends_at || null,
			logo_url: e.attributes.logo_url || null,
			registration_url: e.attributes.new_registration_url,
			source: 'registrations',
		});
	}
	return events;
}

export function parsePcoCalendar(instances: any[], included: any[], idPrefix = 'cal-'): any[] {
	const eventMap = new Map(
		included.filter((i: any) => i.type === 'Event').map((e: any) => [e.id, e])
	);
	const events: any[] = [];
	for (const instance of instances) {
		const eventId = instance.relationships?.event?.data?.id;
		const event: any = eventMap.get(eventId);
		events.push({
			id: `${idPrefix}${instance.id}`,
			name: event?.attributes?.name || 'Event',
			description: event?.attributes?.description || null,
			starts_at: instance.attributes.starts_at,
			ends_at: instance.attributes.ends_at,
			logo_url: event?.attributes?.image_url || null,
			registration_url: null,
			source: 'calendar',
		});
	}
	return events;
}

export function sortByDate(events: any[]): any[] {
	return events.sort((a, b) => {
		if (!a.starts_at) return -1;
		if (!b.starts_at) return 1;
		return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
	});
}

export async function getMergedSermons(env: Env): Promise<any[]> {
	const results: any[] = [];

	// Always fetch the same fixed count regardless of what any particular
	// caller ultimately wants (handleSermons slices afterward for callers
	// that ask for fewer) — varying this per-caller fragments the YouTube
	// cache into multiple independent entries, each with its own miss timing
	// driven by whenever a user happened to make that specific request,
	// rather than the one shared entry every caller (and the cache-warming
	// cron) can consistently keep warm.
	const fetchCount = 50;

	const [pcoResult, ytResult] = await Promise.allSettled([
		env.PCO_SERVICE_TYPE_ID
			? pcoFetch(`/services/v2/service_types/${env.PCO_SERVICE_TYPE_ID}/plans?filter=public&order=-sort_date&per_page=${fetchCount}&include=series`, env)
			: Promise.resolve(null),
		(env.YOUTUBE_API_KEY && env.YOUTUBE_CHANNEL_ID)
			? ytFetch(env, fetchCount)
			: Promise.resolve(null),
	]);

	if (pcoResult.status === 'fulfilled' && pcoResult.value) {
		const pcoData = pcoResult.value;
		const seriesMap: Record<string, any> = {};
		(pcoData.included || []).forEach((item: any) => {
			if (item.type === 'Series') seriesMap[item.id] = item;
		});
		(pcoData.data || []).forEach((plan: any) => {
			const seriesRel = plan.relationships?.series?.data;
			const series = seriesRel ? seriesMap[seriesRel.id] : null;
			results.push({
				id: plan.id,
				source: 'pco',
				title: plan.attributes.title || null,
				date: plan.attributes.sort_date,
				series_title: plan.attributes.series_title || series?.attributes?.title || null,
				speaker: plan.attributes.public_summary || null,
				youtube_url: plan.attributes.custom_fields?.youtube_url || null,
				thumbnail: series?.attributes?.artwork_for_dashboard || null,
			});
		});
	} else if (pcoResult.status === 'rejected') {
		console.error('PCO sermons error:', pcoResult.reason?.message);
	}

	if (ytResult.status === 'fulfilled' && ytResult.value) {
		(ytResult.value.items || []).forEach(video => {
			const titleDate = parseTitleDate(video.title);
			// A date in the title is how a video gets merged onto its PCO plan
			// (picking up the plan's title, series and notes) — it is not what
			// makes the video a media item. Videos without one used to be
			// discarded outright, which loses every special service on the
			// channel — Holy Week, VBS, cantatas, funerals. Fall back to the
			// upload date.
			const matchingPlan = titleDate
				? results.find(s => s.date && s.date.substring(0, 10) === titleDate)
				: null;
			if (matchingPlan) {
				if (!matchingPlan.youtube_url) matchingPlan.youtube_url = `https://www.youtube.com/watch?v=${video.id}`;
				if (!matchingPlan.thumbnail) matchingPlan.thumbnail = video.thumbnail;
			} else {
				const date = titleDate ? `${titleDate}T10:05:00Z` : video.publishedAt;
				if (!date) return;
				results.push({
					id: video.id, source: 'youtube', title: video.title,
					date,
					series_title: null, speaker: null,
					youtube_url: `https://www.youtube.com/watch?v=${video.id}`,
					thumbnail: video.thumbnail,
				});
			}
		});
	} else if (ytResult.status === 'rejected') {
		console.error('YouTube sermons error:', ytResult.reason?.message);
	}

	return results
		.filter(s => s.title || s.youtube_url)
		.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function getPastSermons(sermons: any[]): any[] {
	// getMergedSermons includes future-scheduled PCO plans (for the admin's
	// notes-prep workflow), sorted newest-first — callers of "latest" always
	// need those excluded first.
	return sermons.filter(s => new Date(s.date).getTime() <= Date.now());
}

export function getLatestSermon(sermons: any[]): any {
	const pastSermons = getPastSermons(sermons);
	// Picked by date alone — today's if it's happened yet, otherwise the one
	// immediately before. Never an older sermon preferred just because it
	// already has a video attached (that's getLatestSermonWithVideo, below).
	return pastSermons[0] || null;
}

export function getLatestSermonWithVideo(sermons: any[]): any {
	const pastSermons = getPastSermons(sermons);
	// For callers that need a playable video (e.g. the website's homepage
	// "Watch Now" hero) and can't fall back to a notes-only sermon: the most
	// recent past sermon that actually has one, which may be older than
	// getLatestSermon() if today's video hasn't been uploaded yet.
	return pastSermons.find(s => s.youtube_url) || null;
}

// The Sermon Notes admin page's window: two months back (there's still
// notes to finish for a recent sermon) to one month ahead (far enough to
// prep, not so far it's mostly plans nobody's ready to write for yet).
// getMergedSermons's full set runs back for months and includes every
// future-scheduled plan — unwindowed, that buries this week's sermon in a
// list an admin has to scroll past to find it.
export function getSermonsForNotesPrep(sermons: any[]): any[] {
	const now = Date.now();
	const start = new Date(now);
	start.setMonth(start.getMonth() - 2);
	const end = new Date(now);
	end.setMonth(end.getMonth() + 1);
	return sermons.filter(s => {
		const t = new Date(s.date).getTime();
		return t >= start.getTime() && t <= end.getTime();
	});
}

/**
 * `app_version` was added to schema.sql after some deployments' D1
 * databases already existed with the older device_tokens shape — same
 * situation as pages' image columns (see admin.ts's ensurePagesImageColumn).
 * Both /api/push/register and the admin device-stats read need this column
 * to exist, so it's shared here rather than duplicated in each.
 */
export async function ensureDeviceTokensColumns(env: Env): Promise<void> {
	const { results } = await env.DB.prepare('PRAGMA table_info(device_tokens)').all();
	const cols = new Set((results as any[]).map(r => r.name));
	if (!cols.has('app_version')) {
		await env.DB.prepare('ALTER TABLE device_tokens ADD COLUMN app_version TEXT').run();
	}
}
