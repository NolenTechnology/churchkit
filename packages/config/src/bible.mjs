/**
 * Static Bible reference data — book names, USFM codes, chapter counts,
 * translation labels, and the per-translation copyright notice required
 * when displaying fetched text (verbatim from each publisher's permissions
 * page: Crossway, Biblica, Tyndale, Holman, Thomas Nelson).
 *
 * Used by apps/mobile's Bible reader to resolve a tapped book/chapter into
 * the usfm/chapter the API's /api/bible/text expects, and by apps/admin's
 * sermon-notes scripture picker to resolve a typed reference ("John 3:16")
 * the same way. Both need the same 66-book list; this is the one copy.
 */

export const BIBLE_OT_BOOKS = [
	{ name: 'Genesis', usfm: 'GEN', chapters: 50 },
	{ name: 'Exodus', usfm: 'EXO', chapters: 40 },
	{ name: 'Leviticus', usfm: 'LEV', chapters: 27 },
	{ name: 'Numbers', usfm: 'NUM', chapters: 36 },
	{ name: 'Deuteronomy', usfm: 'DEU', chapters: 34 },
	{ name: 'Joshua', usfm: 'JOS', chapters: 24 },
	{ name: 'Judges', usfm: 'JDG', chapters: 21 },
	{ name: 'Ruth', usfm: 'RUT', chapters: 4 },
	{ name: '1 Samuel', usfm: '1SA', chapters: 31 },
	{ name: '2 Samuel', usfm: '2SA', chapters: 24 },
	{ name: '1 Kings', usfm: '1KI', chapters: 22 },
	{ name: '2 Kings', usfm: '2KI', chapters: 25 },
	{ name: '1 Chronicles', usfm: '1CH', chapters: 29 },
	{ name: '2 Chronicles', usfm: '2CH', chapters: 36 },
	{ name: 'Ezra', usfm: 'EZR', chapters: 10 },
	{ name: 'Nehemiah', usfm: 'NEH', chapters: 13 },
	{ name: 'Esther', usfm: 'EST', chapters: 10 },
	{ name: 'Job', usfm: 'JOB', chapters: 42 },
	{ name: 'Psalms', usfm: 'PSA', chapters: 150 },
	{ name: 'Proverbs', usfm: 'PRO', chapters: 31 },
	{ name: 'Ecclesiastes', usfm: 'ECC', chapters: 12 },
	{ name: 'Song of Solomon', usfm: 'SNG', chapters: 8 },
	{ name: 'Isaiah', usfm: 'ISA', chapters: 66 },
	{ name: 'Jeremiah', usfm: 'JER', chapters: 52 },
	{ name: 'Lamentations', usfm: 'LAM', chapters: 5 },
	{ name: 'Ezekiel', usfm: 'EZK', chapters: 48 },
	{ name: 'Daniel', usfm: 'DAN', chapters: 12 },
	{ name: 'Hosea', usfm: 'HOS', chapters: 14 },
	{ name: 'Joel', usfm: 'JOL', chapters: 3 },
	{ name: 'Amos', usfm: 'AMO', chapters: 9 },
	{ name: 'Obadiah', usfm: 'OBA', chapters: 1 },
	{ name: 'Jonah', usfm: 'JON', chapters: 4 },
	{ name: 'Micah', usfm: 'MIC', chapters: 7 },
	{ name: 'Nahum', usfm: 'NAM', chapters: 3 },
	{ name: 'Habakkuk', usfm: 'HAB', chapters: 3 },
	{ name: 'Zephaniah', usfm: 'ZEP', chapters: 3 },
	{ name: 'Haggai', usfm: 'HAG', chapters: 2 },
	{ name: 'Zechariah', usfm: 'ZEC', chapters: 14 },
	{ name: 'Malachi', usfm: 'MAL', chapters: 4 },
];

export const BIBLE_NT_BOOKS = [
	{ name: 'Matthew', usfm: 'MAT', chapters: 28 },
	{ name: 'Mark', usfm: 'MRK', chapters: 16 },
	{ name: 'Luke', usfm: 'LUK', chapters: 24 },
	{ name: 'John', usfm: 'JHN', chapters: 21 },
	{ name: 'Acts', usfm: 'ACT', chapters: 28 },
	{ name: 'Romans', usfm: 'ROM', chapters: 16 },
	{ name: '1 Corinthians', usfm: '1CO', chapters: 16 },
	{ name: '2 Corinthians', usfm: '2CO', chapters: 13 },
	{ name: 'Galatians', usfm: 'GAL', chapters: 6 },
	{ name: 'Ephesians', usfm: 'EPH', chapters: 6 },
	{ name: 'Philippians', usfm: 'PHP', chapters: 4 },
	{ name: 'Colossians', usfm: 'COL', chapters: 4 },
	{ name: '1 Thessalonians', usfm: '1TH', chapters: 5 },
	{ name: '2 Thessalonians', usfm: '2TH', chapters: 3 },
	{ name: '1 Timothy', usfm: '1TI', chapters: 6 },
	{ name: '2 Timothy', usfm: '2TI', chapters: 4 },
	{ name: 'Titus', usfm: 'TIT', chapters: 3 },
	{ name: 'Philemon', usfm: 'PHM', chapters: 1 },
	{ name: 'Hebrews', usfm: 'HEB', chapters: 13 },
	{ name: 'James', usfm: 'JAS', chapters: 5 },
	{ name: '1 Peter', usfm: '1PE', chapters: 5 },
	{ name: '2 Peter', usfm: '2PE', chapters: 3 },
	{ name: '1 John', usfm: '1JN', chapters: 5 },
	{ name: '2 John', usfm: '2JN', chapters: 1 },
	{ name: '3 John', usfm: '3JN', chapters: 1 },
	{ name: 'Jude', usfm: 'JUD', chapters: 1 },
	{ name: 'Revelation', usfm: 'REV', chapters: 22 },
];

export const BIBLE_BOOKS = [...BIBLE_OT_BOOKS, ...BIBLE_NT_BOOKS];

export const BIBLE_TRANSLATIONS = [
	{ label: 'ASV', name: 'American Standard Version' },
	{ label: 'ESV', name: 'English Standard Version' },
	{ label: 'NIV', name: 'New International Version' },
	{ label: 'NLT', name: 'New Living Translation' },
	{ label: 'CSB', name: 'Christian Standard Bible' },
	{ label: 'KJV', name: 'King James Version' },
	{ label: 'RVA', name: 'Reina-Valera Antigua' },
	{ label: 'NKJV', name: 'New King James Version' },
	{ label: 'NVI', name: 'Nueva Versión Internacional' },
];

// Public-domain translations don't legally require one; given a plain
// attribution anyway for clarity.
export const BIBLE_COPYRIGHT = {
	ASV: 'American Standard Version (1901) — Public Domain.',
	RVA: '1602 Reina-Valera Antigua — Public Domain.',
	KJV: 'King James Version — Public Domain (Crown Copyright applies in the United Kingdom).',
	ESV: 'Scripture quotations are from the ESV® Bible (The Holy Bible, English Standard Version®), © 2001 by Crossway, a publishing ministry of Good News Publishers. Used by permission. All rights reserved.',
	NIV: 'Scripture quotations taken from The Holy Bible, New International Version® NIV® Copyright © 1973, 1978, 1984, 2011 by Biblica, Inc.™ Used by permission. All rights reserved worldwide.',
	NLT: 'Scripture quotations are taken from the Holy Bible, New Living Translation, copyright © 1996, 2004, 2015 by Tyndale House Foundation. Used by permission of Tyndale House Publishers, Inc., Carol Stream, Illinois 60188. All rights reserved.',
	CSB: 'Scripture quotations marked CSB have been taken from the Christian Standard Bible®, Copyright © 2017 by Holman Bible Publishers. Used by permission. Christian Standard Bible® and CSB® are federally registered trademarks of Holman Bible Publishers.',
	NKJV: 'Unless otherwise noted, all Scripture is from the New King James Version®. Copyright © 1982 by Thomas Nelson, Inc. Used by permission. All rights reserved.',
	NVI: 'La Santa Biblia, Nueva Versión Internacional® NVI® · Copyright © 1999, 2015, 2022 by Biblica, Inc.® Usado con permiso. Todos los derechos reservados en todo el mundo.',
};

/**
 * Resolves a human-typed reference ("John 3:16", "1 John 2:3-5", "Jude 3")
 * against BIBLE_BOOKS. Returns null on no match rather than guessing — an
 * unrecognized reference should insert nothing, not something wrong.
 */
export function parseBibleReference(ref) {
	const trimmed = (ref || '').trim();
	const match = trimmed.match(/^(.+?)\s+(\d+)(?::(\d+)(?:-(\d+))?)?$/);
	if (!match) return null;

	const [, rawName, chapterStr, startStr, endStr] = match;
	const needle = rawName.trim().toLowerCase();
	const book = BIBLE_BOOKS.find((b) => b.name.toLowerCase() === needle);
	if (!book) return null;

	// Single-chapter books (Obadiah, Philemon, Jude, 2 John, 3 John) are
	// conventionally cited without a chapter — "Jude 3" means chapter 1,
	// verse 3, not chapter 3 (which that book doesn't have).
	if (book.chapters === 1 && startStr === undefined) {
		const verse = Number(chapterStr);
		if (!Number.isInteger(verse) || verse < 1) return null;
		return { book, chapter: 1, startVerse: verse, endVerse: undefined };
	}

	const chapter = Number(chapterStr);
	if (!Number.isInteger(chapter) || chapter < 1 || chapter > book.chapters) return null;

	const startVerse = startStr !== undefined ? Number(startStr) : undefined;
	const endVerse = endStr !== undefined ? Number(endStr) : undefined;
	if (startVerse !== undefined && (!Number.isInteger(startVerse) || startVerse < 1)) return null;
	if (endVerse !== undefined && (!Number.isInteger(endVerse) || endVerse < startVerse)) return null;

	return { book, chapter, startVerse, endVerse };
}
