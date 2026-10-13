/**
 * Hand-written types for bible.mjs — see font-presets.d.ts for why this
 * package ships plain ESM instead of TypeScript.
 */

export interface BibleBook {
	name: string;
	usfm: string;
	chapters: number;
}

export interface BibleTranslation {
	label: string;
	name: string;
}

export interface ParsedBibleReference {
	book: BibleBook;
	chapter: number;
	startVerse?: number;
	endVerse?: number;
}

export const BIBLE_OT_BOOKS: BibleBook[];
export const BIBLE_NT_BOOKS: BibleBook[];
export const BIBLE_BOOKS: BibleBook[];
export const BIBLE_TRANSLATIONS: BibleTranslation[];
export const BIBLE_COPYRIGHT: Record<string, string>;
export function parseBibleReference(ref: string): ParsedBibleReference | null;
