import { describe, it, expect } from 'vitest';
import { parseTitleDate, sortByDate, churchCenterEventUrl, getSermonsForNotesPrep } from '../src/lib/data';
import type { Env } from '../src/types';

/** Minimal D1 stand-in returning one settings row. */
function envWithSetting(value: string | null): Env {
	return {
		DB: {
			prepare: () => ({
				first: async () => (value === null ? null : { value }),
			}),
		},
	} as unknown as Env;
}

describe('churchCenterEventUrl', () => {
	it('composes a link from the configured subdomain', async () => {
		const env = envWithSetting('https://example.churchcenter.com');
		expect(await churchCenterEventUrl('42', env)).toBe('https://example.churchcenter.com/calendar/event/42');
	});

	it('tolerates a trailing slash', async () => {
		const env = envWithSetting('https://example.churchcenter.com/');
		expect(await churchCenterEventUrl('42', env)).toBe('https://example.churchcenter.com/calendar/event/42');
	});

	it('returns null when the church does not use Church Center', async () => {
		expect(await churchCenterEventUrl('42', envWithSetting(''))).toBeNull();
		expect(await churchCenterEventUrl('42', envWithSetting('   '))).toBeNull();
		expect(await churchCenterEventUrl('42', envWithSetting(null))).toBeNull();
	});
});

describe('parseTitleDate', () => {
	it('accepts single-digit month and day', () => {
		expect(parseTitleDate('Sunday Worship 9.7.2026')).toBe('2026-09-07');
	});

	it('accepts dot, dash and slash separators', () => {
		expect(parseTitleDate('Service 12-25-2025')).toBe('2025-12-25');
		expect(parseTitleDate('Service 12/25/2025')).toBe('2025-12-25');
	});

	it('skips a date-shaped scripture reference and finds the real date', () => {
		expect(parseTitleDate('Acts 20.15.2026 — Worship 3.1.2026')).toBe('2026-03-01');
	});

	it('returns null when there is no date', () => {
		expect(parseTitleDate('Christmas Eve Candlelight Service')).toBeNull();
	});
});

describe('sortByDate', () => {
	it('orders events oldest first', () => {
		const sorted = sortByDate([
			{ name: 'later', starts_at: '2026-06-01T10:00:00Z' },
			{ name: 'earlier', starts_at: '2026-01-01T10:00:00Z' },
		]);
		expect(sorted.map((e) => e.name)).toEqual(['earlier', 'later']);
	});
});

describe('getSermonsForNotesPrep', () => {
	const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
	const daysAhead = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

	it('keeps sermons within two months back and one month ahead', () => {
		const sermons = [
			{ id: 'too-old', date: daysAgo(75) },
			{ id: 'in-window-past', date: daysAgo(10) },
			{ id: 'today', date: daysAgo(0) },
			{ id: 'in-window-future', date: daysAhead(10) },
			{ id: 'too-future', date: daysAhead(45) },
		];
		expect(getSermonsForNotesPrep(sermons).map(s => s.id)).toEqual([
			'in-window-past',
			'today',
			'in-window-future',
		]);
	});
});
