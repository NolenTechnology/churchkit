import { describe, it, expect } from 'vitest';
import { handleGetNotes } from '../src/routes/public';
import type { Env } from '../src/types';

/** Minimal D1 stand-in returning one sermon_notes row. */
function envWithNotes(row: { html: string; published: number } | null): Env {
	return {
		DB: {
			prepare: () => ({
				bind: () => ({
					first: async () => row,
				}),
			}),
		},
	} as unknown as Env;
}

describe('handleGetNotes', () => {
	it('404s when there is no row', async () => {
		const res = await handleGetNotes('plan-1', envWithNotes(null));
		expect(res.status).toBe(404);
	});

	it('404s when the row exists but is unpublished', async () => {
		const res = await handleGetNotes('plan-1', envWithNotes({ html: '<p>hi</p>', published: 0 }));
		expect(res.status).toBe(404);
	});

	it('wraps published html in a document with the blank/scripture behavior injected', async () => {
		const html = '<span class="sn-blank" data-answer="grace">grace</span> <a class="sn-scripture" data-usfm="JHN" data-chapter="3">John 3:16</a>';
		const res = await handleGetNotes('plan-1', envWithNotes({ html, published: 1 }));
		expect(res.status).toBe(200);

		const body = await res.text();
		// The real content passes through untouched — masking happens at
		// view time in the browser, not on the server.
		expect(body).toContain('data-answer="grace"');
		expect(body).toContain('data-usfm="JHN"');
		// The shared renderer's interactive layer is present.
		expect(body).toContain('sn-blank');
		expect(body).toContain('sn-modal-backdrop');
		expect(body).toContain('/api/bible/text');
	});
});
