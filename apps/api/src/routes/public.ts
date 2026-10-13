import type { Env } from '../types';
import { json, err, CORS_HEADERS } from '../lib/response';
import { capabilities } from '../lib/capabilities';
import { renderSermonNotesDocument } from '@churchkit/config/sermon-notes';
import {
	getSettings,
	getFeaturedEvent,
	getLiveStream,
	getNextEvent,
	getMergedSermons,
	getLatestSermon,
	getLatestSermonWithVideo,
	getPastSermons,
	getRegistrationSignups,
	getFutureEventInstances,
	parsePcoRegistrations,
	parsePcoCalendar,
	sortByDate,
} from '../lib/data';

// Ministries are not a fixed list. Any published page flagged is_ministry
// appears here, ordered by its own sort_order — so a church adds, removes
// or reorders its ministries in the admin panel rather than in this file.

export async function handleHome(env: Env): Promise<Response> {
	const settings = await getSettings(env);

	const [mergedSermons, featuredEvent, liveStream] = await Promise.allSettled([
		getMergedSermons(env),
		getFeaturedEvent(settings.featured_event_id || null, env),
		getLiveStream(env),
	]);

	const resolvedSermons = mergedSermons.status === 'fulfilled' ? mergedSermons.value : [];
	const resolvedFeaturedEvent = featuredEvent.status === 'fulfilled' ? featuredEvent.value : null;

	const nextEvent = await getNextEvent(resolvedFeaturedEvent?.id || null, env).catch(() => null);

	return json({
		settings,
		latestSermon: getLatestSermon(resolvedSermons),
		latestSermonWithVideo: getLatestSermonWithVideo(resolvedSermons),
		featuredEvent: resolvedFeaturedEvent,
		liveStream: liveStream.status === 'fulfilled' ? liveStream.value : null,
		nextEvent,
	}, 200, 60);
}

export async function handleSermons(env: Env, limit?: number): Promise<Response> {
	// getMergedSermons always fetches the same fixed set upstream (one
	// shared, consistently-cache-warmed YouTube query for every caller) —
	// limit only trims the response here, after the fact.
	//
	// The future-scheduled PCO plans getMergedSermons includes are there for
	// the admin's notes-prep workflow; a service that hasn't happened yet is
	// not media. Leaving them in put them at the top of this newest-first
	// list, so a client asking for the first N got upcoming, video-less
	// plans and — once it filtered for something playable — almost nothing.
	// /api/admin/sermons still sees the full set.
	const sermons = getPastSermons(await getMergedSermons(env));
	return json({ data: limit ? sermons.slice(0, limit) : sermons }, 200, 120);
}

export async function handleGetNotes(planId: string, env: Env): Promise<Response> {
	const row = await env.DB.prepare(
		'SELECT html, published FROM sermon_notes WHERE pco_plan_id = ?'
	).bind(planId).first<{ html: string; published: number }>();

	if (!row || !row.published) return err('Notes not found', 404);

	// The stored html is a bare content fragment from the admin's WYSIWYG
	// editor (no <html>/<head>, no font styling of its own — the editor and
	// its "Phone Preview" only look right there because they set the font on
	// their own wrapping element). renderSermonNotesDocument wraps it in a
	// real document with a mobile viewport, the editor's font, and the
	// hidden-blank/scripture-overlay behavior those two authoring tools
	// produce — shared with apps/admin's Phone Preview so both render the
	// same thing. See packages/config/src/sermon-notes.mjs.
	const document = renderSermonNotesDocument(row.html);

	return new Response(document, {
		headers: {
			...CORS_HEADERS,
			'Content-Type': 'text/html',
			'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
		},
	});
}

export async function handleEvents(env: Env): Promise<Response> {
	// Both sources are Planning Center. With no PCO credentials bound, each
	// settles rejected and this answers an empty list — a church that keeps
	// its calendar elsewhere gets an empty events page, not an error.
	const [registrationsResult, calendarResult] = await Promise.allSettled([
		getRegistrationSignups(env),
		getFutureEventInstances(env),
	]);

	const events: any[] = [];

	if (registrationsResult.status === 'fulfilled') {
		const { data: signups = [], included = [] } = registrationsResult.value;
		events.push(...parsePcoRegistrations(signups, included));
	} else {
		console.error('Events: Registrations API failed:', (registrationsResult as any).reason?.message);
	}

	if (calendarResult.status === 'fulfilled') {
		const { data: instances = [], included = [] } = calendarResult.value;
		events.push(...parsePcoCalendar(instances, included));
	} else {
		console.error('Events: Calendar API failed:', (calendarResult as any).reason?.message);
	}

	return json({ data: sortByDate(events) }, 200, 120);
}

export async function handleStaff(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT id, name, title, email, photo_url, bio, sort_order FROM staff WHERE active = 1 ORDER BY sort_order ASC'
	).all();
	return json({ data: results }, 200, 600);
}

export async function handlePage(slug: string, env: Env): Promise<Response> {
	const row = await env.DB.prepare(
		'SELECT slug, title, sub_title, subtext, content_html, image_url, image_focal_x, image_focal_y, gallery_image_1, gallery_image_2, gallery_image_3, status, updated_at FROM pages WHERE slug = ?'
	).bind(slug).first();
	if (!row) return err('Page not found', 404);
	return json({ data: row }, 200, 60);
}

export async function handleSettings(env: Env): Promise<Response> {
	return json({ data: await getSettings(env) }, 200, 3600);
}

export async function handleCarousel(env: Env): Promise<Response> {
	const now = new Date().toISOString();
	const { results } = await env.DB.prepare(
		`SELECT id, image_url, headline, subtext, button_label, button_link, sort_order
		 FROM carousel_slides
		 WHERE active = 1
		   AND (starts_at IS NULL OR starts_at <= ?)
		   AND (ends_at IS NULL OR ends_at >= ?)
		 ORDER BY sort_order ASC`
	).bind(now, now).all();
	return json({ data: results }, 200, 300);
}

export async function handleMinistries(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT slug, title, sub_title, subtext, image_url, image_focal_x, image_focal_y
		 FROM pages
		 WHERE is_ministry = 1 AND status = 'published'
		 ORDER BY sort_order ASC, title ASC`
	).all();
	return json({ data: results }, 200, 3600);
}

/**
 * What this deployment can actually serve, so the website and mobile app
 * can hide what this church does not use. See lib/capabilities.ts.
 */
export function handleCapabilities(env: Env): Response {
	return json({ data: capabilities(env) }, 200, 300);
}
