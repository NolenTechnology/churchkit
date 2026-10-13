import type { Env } from '../types';
import { json, err, notConfigured } from '../lib/response';
import { pcoFetch } from '../lib/pco';
import { sendPush } from '../lib/push';
import { getSettings, getMergedSermons, getSermonsForNotesPrep, ensureDeviceTokensColumns } from '../lib/data';
import { runHealthChecks } from '../lib/health';
import { getChurchDetails } from '../lib/template';
import { changePassword } from '../platform/localAuth';
export { verifyAccessJWT } from '../lib/access-jwt';

/**
 * Seed slides for a carousel that has never been edited.
 *
 * Built from the church's own settings rather than fixed copy: a slide
 * asserting a service time or an invitation this church did not write would
 * be published to its visitors as though it had. What is left is a prompt
 * to edit, which is the honest thing for an unconfigured carousel to say.
 */
async function defaultCarouselSlides(env: Env): Promise<
	{ headline: string; subtext: string; button_label: string; button_link: string }[]
> {
	const church = await getChurchDetails(env);
	return [
		{
			headline: church.church_name,
			subtext: church.tagline || 'Add your own slides in the admin panel.',
			button_label: 'Plan Your Visit',
			button_link: '/im-new',
		},
	];
}

async function ensureCarouselDateColumns(env: Env): Promise<void> {
	const { results } = await env.DB.prepare('PRAGMA table_info(carousel_slides)').all();
	const cols = new Set((results as any[]).map(r => r.name));
	const stmts: any[] = [];
	if (!cols.has('starts_at')) stmts.push(env.DB.prepare('ALTER TABLE carousel_slides ADD COLUMN starts_at TEXT'));
	if (!cols.has('ends_at')) stmts.push(env.DB.prepare('ALTER TABLE carousel_slides ADD COLUMN ends_at TEXT'));
	if (stmts.length) await env.DB.batch(stmts);
}

async function ensurePagesImageColumn(env: Env): Promise<void> {
	const { results } = await env.DB.prepare('PRAGMA table_info(pages)').all();
	const cols = new Set((results as any[]).map(r => r.name));
	const stmts: any[] = [];
	if (!cols.has('image_url')) stmts.push(env.DB.prepare('ALTER TABLE pages ADD COLUMN image_url TEXT'));
	if (!cols.has('image_focal_x')) stmts.push(env.DB.prepare('ALTER TABLE pages ADD COLUMN image_focal_x REAL'));
	if (!cols.has('image_focal_y')) stmts.push(env.DB.prepare('ALTER TABLE pages ADD COLUMN image_focal_y REAL'));
	if (!cols.has('gallery_image_1')) stmts.push(env.DB.prepare('ALTER TABLE pages ADD COLUMN gallery_image_1 TEXT'));
	if (!cols.has('gallery_image_2')) stmts.push(env.DB.prepare('ALTER TABLE pages ADD COLUMN gallery_image_2 TEXT'));
	if (!cols.has('gallery_image_3')) stmts.push(env.DB.prepare('ALTER TABLE pages ADD COLUMN gallery_image_3 TEXT'));
	// Which pages are ministries, and in what order — a church's own choice
	// rather than a list fixed in code. See routes/public.ts handleMinistries.
	if (!cols.has('is_ministry')) stmts.push(env.DB.prepare('ALTER TABLE pages ADD COLUMN is_ministry INTEGER DEFAULT 0'));
	if (!cols.has('sort_order')) stmts.push(env.DB.prepare('ALTER TABLE pages ADD COLUMN sort_order INTEGER DEFAULT 0'));
	if (stmts.length) await env.DB.batch(stmts);
}

export async function handleAdmin(
	path: string,
	method: string,
	request: Request,
	env: Env
): Promise<Response> {

	// ── Sermons ────────────────────────────────────────────────
	if (path === '/api/admin/sermons' && method === 'GET') {
		const sermons = getSermonsForNotesPrep(await getMergedSermons(env));
		const { results } = await env.DB.prepare('SELECT pco_plan_id, published FROM sermon_notes').all();
		const notesMap = new Map(results.map((n: any) => [n.pco_plan_id, n.published]));
		return json({
			data: sermons.map(s => ({
				...s,
				has_notes: notesMap.has(s.id),
				notes_published: notesMap.get(s.id) === 1,
			})),
		});
	}

	const notesMatch = path.match(/^\/api\/admin\/sermons\/([^/]+)\/notes$/);
	if (notesMatch) {
		if (method === 'GET') {
			const row = await env.DB.prepare(
				'SELECT pco_plan_id, html, published, updated_at FROM sermon_notes WHERE pco_plan_id = ?'
			).bind(notesMatch[1]).first();
			if (!row) return err('Notes not found', 404);
			return json({ data: row });
		}
		if (method === 'POST') {
			const { html, published } = await request.json() as any;
			await env.DB.prepare(
				`INSERT OR REPLACE INTO sermon_notes (pco_plan_id, html, published, updated_at)
				 VALUES (?, ?, ?, unixepoch())`
			).bind(notesMatch[1], html, published ? 1 : 0).run();
			return json({ success: true });
		}
	}

	// ── Media Upload ───────────────────────────────────────────
	if (path === '/api/admin/upload' && method === 'POST') {
		// A deployment with no R2 bucket bound (or no public host serving it)
		// says so, rather than throwing on an undefined binding. The rest of
		// the admin panel keeps working; only uploads are unavailable.
		if (!env.MEDIA || !env.MEDIA_PUBLIC_URL) return notConfigured('mediaUploads');

		const formData = await request.formData();
		// formData.get returns string | File | null; a text field posted under
		// the same name must not be treated as an upload.
		const file = formData.get('file') as unknown;
		if (!file || typeof file === 'string') return err('No file provided');
		const upload = file as File;
		const ext = upload.name.split('.').pop()?.toLowerCase() || 'jpg';
		const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
		await env.MEDIA.put(key, upload.stream(), { httpMetadata: { contentType: upload.type } });
		const base = env.MEDIA_PUBLIC_URL.trim().replace(/\/+$/, '');
		return json({ success: true, url: `${base}/${key}`, key });
	}

	// ── Staff ──────────────────────────────────────────────────
	if (path === '/api/admin/staff') {
		if (method === 'GET') {
			const { results } = await env.DB.prepare('SELECT * FROM staff ORDER BY sort_order ASC').all();
			return json({ data: results });
		}
		if (method === 'POST') {
			const { name, title, email, photo_url, bio, sort_order } = await request.json() as any;
			const result = await env.DB.prepare(
				`INSERT INTO staff (name, title, email, photo_url, bio, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
			).bind(name, title, email, photo_url, bio, sort_order ?? 99).run();
			return json({ success: true, id: result.meta.last_row_id });
		}
	}

	const staffMatch = path.match(/^\/api\/admin\/staff\/(\d+)$/);
	if (staffMatch) {
		if (method === 'PUT') {
			const { name, title, email, photo_url, bio, sort_order, active } = await request.json() as any;
			await env.DB.prepare(
				`UPDATE staff SET name=?, title=?, email=?, photo_url=?, bio=?, sort_order=?, active=? WHERE id=?`
			).bind(name, title, email, photo_url, bio, sort_order, active !== false ? 1 : 0, staffMatch[1]).run();
			return json({ success: true });
		}
		if (method === 'DELETE') {
			await env.DB.prepare('UPDATE staff SET active = 0 WHERE id = ?').bind(staffMatch[1]).run();
			return json({ success: true });
		}
	}

	// ── Local-login password change ─────────────────────────────
	// Only meaningful under `local` mode; under cloudflare-access there is no
	// local password to change. Re-verifies the current request's own
	// session to learn *who* is changing it, rather than threading the
	// already-verified identity through every handleAdmin call for the sake
	// of this one route.
	if (path === '/api/admin/password' && method === 'POST') {
		if (env.ADMIN_AUTH?.name !== 'local') return notConfigured('admin', 'Password change is only available under local login.');
		const who = await env.ADMIN_AUTH.verify(request);
		if (!who.ok || !who.email) return err('Unauthorized', 401);
		const { currentPassword, newPassword } = await request.json() as any;
		if (!currentPassword || !newPassword) return err('currentPassword and newPassword are required', 400);
		const result = await changePassword(env, who.email, currentPassword, newPassword);
		if (!result.ok) return err(result.reason || 'Could not change password', 400);
		return json({ success: true });
	}

	// ── Pages ──────────────────────────────────────────────────
	if (path === '/api/admin/pages' && method === 'GET') {
		await ensurePagesImageColumn(env);
		const { results } = await env.DB.prepare(
			'SELECT slug, title, sub_title, subtext, image_url, image_focal_x, image_focal_y, is_ministry, sort_order, status, updated_at FROM pages ORDER BY sort_order ASC, slug ASC'
		).all();
		return json({ data: results });
	}

	const pageMatch = path.match(/^\/api\/admin\/pages\/([^/]+)$/);
	if (pageMatch) {
		if (method === 'GET') {
			await ensurePagesImageColumn(env);
			const row = await env.DB.prepare('SELECT * FROM pages WHERE slug = ?').bind(pageMatch[1]).first();
			if (!row) return err('Page not found', 404);
			return json({ data: row });
		}
		if (method === 'POST') {
			await ensurePagesImageColumn(env);
			const body = await request.json() as any;
			const title = body.title ?? null;
			const sub_title = body.sub_title ?? null;
			const subtext = body.subtext ?? null;
			const content_html = body.content_html ?? body.contentHtml ?? body.content ?? body.html ?? null;
			const image_url = body.image_url ?? null;
			const image_focal_x = body.image_focal_x ?? null;
			const image_focal_y = body.image_focal_y ?? null;
			const gallery_image_1 = body.gallery_image_1 ?? null;
			const gallery_image_2 = body.gallery_image_2 ?? null;
			const gallery_image_3 = body.gallery_image_3 ?? null;
			const is_ministry = body.is_ministry ? 1 : 0;
			const sort_order = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;
			const status = body.status ?? 'published';

			// A slug becomes a public URL, so keep it to something that can
			// safely be one. Which slugs the website's own routes reserve is
			// enforced by the admin panel, which knows that route table.
			if (!/^[a-z0-9][a-z0-9-]*$/.test(pageMatch[1])) {
				return err('Slug may contain only lowercase letters, numbers and hyphens');
			}

			// INSERT OR REPLACE writes a whole row: every column the editor
			// does not send would be reset to its default. is_ministry and
			// sort_order are listed here for exactly that reason — omitting
			// them would silently un-flag a ministry on every save.
			await env.DB.prepare(
				`INSERT OR REPLACE INTO pages (slug, title, sub_title, subtext, content_html, image_url, image_focal_x, image_focal_y, gallery_image_1, gallery_image_2, gallery_image_3, is_ministry, sort_order, status, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
			).bind(pageMatch[1], title, sub_title, subtext, content_html, image_url, image_focal_x, image_focal_y, gallery_image_1, gallery_image_2, gallery_image_3, is_ministry, sort_order, status).run();
			return json({ success: true });
		}
		if (method === 'DELETE') {
			await env.DB.prepare('DELETE FROM pages WHERE slug = ?').bind(pageMatch[1]).run();
			return json({ success: true });
		}
	}

	// ── Settings ───────────────────────────────────────────────
	if (path === '/api/admin/settings') {
		if (method === 'GET') {
			return json({ data: await getSettings(env) });
		}
		if (method === 'POST') {
			const updates = await request.json() as Record<string, string>;
			const stmt = env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())`);
			await env.DB.batch(Object.entries(updates).map(([k, v]) => stmt.bind(k, v)));
			return json({ success: true });
		}
	}

	if (path === '/api/admin/featured-event' && method === 'POST') {
		const { featured_event_id } = await request.json() as any;
		await env.DB.prepare(
			`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('featured_event_id', ?, unixepoch())`
		).bind(featured_event_id ?? null).run();
		return json({ success: true });
	}

	// ── Carousel ───────────────────────────────────────────────
	if (path === '/api/admin/carousel') {
		await ensureCarouselDateColumns(env);
		if (method === 'GET') {
			let { results } = await env.DB.prepare(
				'SELECT id, image_url, headline, subtext, button_label, button_link, starts_at, ends_at, sort_order FROM carousel_slides WHERE active = 1 ORDER BY sort_order ASC'
			).all();
			if (results.length === 0) {
				const stmt = env.DB.prepare(
					`INSERT OR IGNORE INTO carousel_slides (id, headline, subtext, button_label, button_link, sort_order, active)
					 VALUES (?, ?, ?, ?, ?, ?, 1)`
				);
				await env.DB.batch(
					(await defaultCarouselSlides(env)).map((s, i) =>
						stmt.bind(i + 1, s.headline, s.subtext, s.button_label, s.button_link, i)
					)
				);
				({ results } = await env.DB.prepare(
					'SELECT id, image_url, headline, subtext, button_label, button_link, starts_at, ends_at, sort_order FROM carousel_slides WHERE active = 1 ORDER BY sort_order ASC'
				).all());
			}
			return json({ data: results });
		}
		if (method === 'POST') {
			const { slides } = await request.json() as any;
			const deleteStmt = env.DB.prepare('DELETE FROM carousel_slides');
			if (!slides?.length) {
				await deleteStmt.run();
			} else {
				const insertStmt = env.DB.prepare(
					`INSERT INTO carousel_slides (image_url, headline, subtext, button_label, button_link, starts_at, ends_at, sort_order, active)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
				);
				await env.DB.batch([
					deleteStmt,
					...slides.map((s: any, i: number) =>
						insertStmt.bind(
							s.image_url || null, s.headline, s.subtext || null,
							s.button_label || null, s.button_link || null,
							s.starts_at || null, s.ends_at || null, i
						)
					),
				]);
			}
			return json({ success: true });
		}
	}

	// ── Push Notifications ─────────────────────────────────────
	if (path === '/api/admin/notifications') {
		if (method === 'GET') {
			const { results } = await env.DB.prepare(
				'SELECT * FROM push_notifications ORDER BY created_at DESC LIMIT 50'
			).all();
			return json({ data: results });
		}
	}

	if (path === '/api/admin/notifications/send' && method === 'POST') {
		const { title, body, audience, send_after, group_member_ids } = await request.json() as any;
		if (!title || !body) return err('Title and body are required');
		const result = await sendPush(env, {
			title, body,
			segment: audience === 'all' ? 'All' : undefined,
			externalIds: group_member_ids,
			sendAfter: send_after,
		});
		await env.DB.prepare(
			`INSERT INTO push_notifications (title, body, audience, status, sent_at)
			 VALUES (?, ?, ?, 'sent', unixepoch())`
		).bind(title, body, audience).run();
		return json({ success: true, result });
	}

	// Sends to exactly one already-registered device, never touching real
	// subscribers — for confirming push actually reaches a phone (a fresh
	// local build, say) without paging everyone who has the app installed.
	// Not written to push_notifications: that history is for what a church
	// actually told its people, not for a developer's own test pings.
	if (path === '/api/admin/notifications/test' && method === 'POST') {
		const { player_id } = await request.json() as any;
		if (!player_id) return err('player_id is required');
		const result = await sendPush(env, {
			title: 'Test Notification',
			body: 'This is a test push from the admin panel — sent to this device only.',
			playerIds: [player_id],
		});
		if (!result) return err('Push is not configured, or OneSignal rejected the request', 502);
		return json({ success: true, result });
	}

	// ── Device Stats ───────────────────────────────────────────
	if (path === '/api/admin/device-stats' && method === 'GET') {
		await ensureDeviceTokensColumns(env);
		const [totalRow, iosRow, androidRow, recentRows] = await Promise.all([
			env.DB.prepare('SELECT COUNT(*) as count FROM device_tokens').first<{ count: number }>(),
			env.DB.prepare("SELECT COUNT(*) as count FROM device_tokens WHERE platform = 'ios'").first<{ count: number }>(),
			env.DB.prepare("SELECT COUNT(*) as count FROM device_tokens WHERE platform = 'android'").first<{ count: number }>(),
			env.DB.prepare(
				'SELECT onesignal_player_id, platform, app_version, pco_person_id, created_at, last_seen_at FROM device_tokens ORDER BY last_seen_at DESC LIMIT 20'
			).all(),
		]);
		return json({
			data: {
				total: totalRow?.count ?? 0,
				ios: iosRow?.count ?? 0,
				android: androidRow?.count ?? 0,
				recent: recentRows.results,
			},
		});
	}

	// ── Health ───────────────────────────────────────────────────
	// Whether each configured credential actually authenticates, not just
	// whether the env var is non-empty — see lib/health.ts for why that
	// distinction needs a real call per integration.
	if (path === '/api/admin/health' && method === 'GET') {
		return json({ data: await runHealthChecks(env) });
	}

	// ── Form Submissions ───────────────────────────────────────
	if (path === '/api/admin/submissions' && method === 'GET') {
		const { results } = await env.DB.prepare(
			`SELECT id, form_type, data, pco_person_id, pco_error, submitted_at, emailed
			 FROM form_submissions ORDER BY submitted_at DESC LIMIT 100`
		).all();
		return json({
			data: results.map((r: any) => ({ ...r, data: JSON.parse(r.data || '{}') })),
		});
	}

	// ── PCO Events ─────────────────────────────────────────────
	if (path === '/api/admin/pco-events' && method === 'GET') {
		const [registrationsResult, calendarResult] = await Promise.allSettled([
			pcoFetch('/registrations/v2/signups?per_page=50&include=next_signup_time', env),
			pcoFetch('/calendar/v2/event_instances?filter=future&order=starts_at&per_page=25&include=event', env),
		]);
		const events: any[] = [];
		if (registrationsResult.status === 'fulfilled') {
			const { data: signups = [], included = [] } = registrationsResult.value;
			const timeMap = new Map(included.map((i: any) => [i.id, i]));
			for (const e of signups) {
				if (e.attributes.archived || e.attributes.closed) continue;
				const timeId = e.relationships?.next_signup_time?.data?.id;
				const time: any = timeMap.get(timeId);
				events.push({
					id: `reg:${e.id}`,
					name: e.attributes.name,
					starts_at: time?.attributes?.starts_at || null,
					registration_url: e.attributes.new_registration_url,
					source: 'registrations',
				});
			}
		}
		if (calendarResult.status === 'fulfilled') {
			const { data: instances = [], included = [] } = calendarResult.value;
			const eventMap = new Map(
				included.filter((i: any) => i.type === 'Event').map((e: any) => [e.id, e])
			);
			const seen = new Set<string>();
			for (const instance of instances) {
				const eventId = instance.relationships?.event?.data?.id;
				if (seen.has(eventId)) continue;
				seen.add(eventId);
				const event: any = eventMap.get(eventId);
				events.push({
					id: `cal:${eventId || instance.id}`,
					name: event?.attributes?.name || 'Event',
					starts_at: instance.attributes.starts_at,
					registration_url: null,
					source: 'calendar',
				});
			}
		}
		events.sort((a, b) => {
			if (!a.starts_at) return -1;
			if (!b.starts_at) return 1;
			return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
		});
		return json({ data: events });
	}

	return err('Admin route not found', 404);
}
