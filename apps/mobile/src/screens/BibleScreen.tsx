import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  SafeAreaView,
  Switch,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { State, usePlaybackState } from 'react-native-track-player';
import { playReading, pauseReading, resumeReading, stopReading, setSkipHandlers } from '../audio/bibleAudioPlayer';
import { fetchBibleTextFromApi } from '../api/client';
import { BIBLE_OT_BOOKS as OT_BOOKS, BIBLE_NT_BOOKS as NT_BOOKS, BIBLE_TRANSLATIONS as TRANSLATIONS, BIBLE_COPYRIGHT } from '@churchkit/config/bible';
import { YEAR_1_PLAN, YEAR_2_PLAN, type DayPlan } from '../data/readingPlan.generated';
import { Colors, Fonts, FontSizes, Spacing, Radius, Shadow } from '../constants/theme';
import { SectionLabel } from '../components/shared';

// ── Bible text ────────────────────────────────────────────────────────────────
// All translation text comes from the worker, which prefers Bible Brain and
// falls back to API.Bible per-translation when Bible Brain doesn't carry it
// — see the API's fetchPassageText. Audio (ESV only) is separate;
// see bibleAudioPlayer.ts. The book list, translation list and copyright
// notices live in @churchkit/config/bible, shared with apps/admin's
// sermon-notes scripture picker — see that package for why.

type TranslationLabel = string;
const TRANSLATION_KEY = 'bible_translation';

// ── Bible audio settings (narration style + download size) ───────────────────
// Two independent choices, both Bible Brain filesets rather than anything we
// transcode ourselves — see the API's bibleBrain.ts for the fileset IDs.
type AudioStyle = 'dramatized' | 'narrator';
type AudioQuality = 'standard' | 'dataSaver';

const AUDIO_STYLES: { value: AudioStyle; label: string; hint: string }[] = [
  { value: 'dramatized', label: 'Full Cast', hint: 'Multiple voice actors and music, like a radio drama' },
  { value: 'narrator', label: 'Single Narrator', hint: 'One person reading, no music or sound effects' },
];
const AUDIO_QUALITIES: { value: AudioQuality; label: string; hint: string }[] = [
  { value: 'standard', label: 'Standard', hint: 'Best sound, uses more data' },
  { value: 'dataSaver', label: 'Data Saver', hint: 'Smaller download, sounds almost the same for speech' },
];
const AUDIO_STYLE_KEY = 'bible_audio_style';
const AUDIO_QUALITY_KEY = 'bible_audio_quality';

// ── Local Bible state (translation, auto-advance, reading progress) ──────────
//
// AsyncStorage, not SecureStore. SecureStore caps a value at 2048 bytes, and
// the completed-days list grows by ~18 bytes per day ("Sun Aug 30 2026" plus
// JSON punctuation) — so it crossed the limit after roughly four months of
// daily use and quietly stopped saving, on the feature people open every
// day. None of this is sensitive, it just has to persist, so all three keys
// live in the same place rather than splitting across two stores.
//
// Values written by earlier builds are read from SecureStore once and moved
// across, so nobody loses the streak or the translation they had chosen.
async function readStored(key: string): Promise<string | null> {
  try {
    const current = await AsyncStorage.getItem(key);
    if (current !== null) return current;

    const legacy = await SecureStore.getItemAsync(key);
    if (legacy === null) return null;
    await AsyncStorage.setItem(key, legacy);
    await SecureStore.deleteItemAsync(key).catch(() => {});
    return legacy;
  } catch {
    return null;
  }
}

async function writeStored(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    // A failed write must not surface as an unhandled rejection from a
    // checkbox or picker handler — losing one tick is recoverable, a crash
    // in the middle of a reading is not.
  }
}

function fetchChapterText(
  translation: TranslationLabel,
  usfm: string,
  chapter: number,
  startVerse?: number,
  endVerse?: number
): Promise<string> {
  return fetchBibleTextFromApi(translation, usfm, chapter, startVerse, endVerse);
}

// ── 2-Year Bible Reading Plan (M'Cheyne) ─────────────────────────────────────
// Sourced from the plan XML (see scripts/generate-reading-plan.mjs) — 2
// daily passages per day, Jan 1 = day 1. Even calendar years run Year 2,
// odd years run Year 1.

interface Book { name: string; usfm: string; chapters: number; startChapter?: number }

// Used by the "Open a Passage" manual browser/reader (single whole chapter),
// distinct from the reading-plan's PlanPage below.
interface Reading { name: string; chapter: number; usfm: string }

const PLAN_BY_YEAR: Record<1 | 2, DayPlan[]> = { 1: YEAR_1_PLAN, 2: YEAR_2_PLAN };

function getActivePlanYear(date: Date): 1 | 2 {
  return date.getFullYear() % 2 === 0 ? 2 : 1;
}

function getDayPlan(date: Date): DayPlan {
  const dayOfYear = getDayOfYear(date);
  // The plan is exactly 365 days; Dec 31 of a leap year (day 366) wraps back
  // to day 1 rather than getting its own entry.
  const index = (dayOfYear - 1) % 365;
  return PLAN_BY_YEAR[getActivePlanYear(date)][index];
}

// A day's passages, flattened to one page per segment — e.g. a passage
// spanning "Genesis 9-10" becomes two pages, one per chapter — so each is
// independently navigable and fetchable as its own (possibly verse-bounded)
// whole-chapter request.
interface PlanPage {
  passageIndex: number;
  book: string;
  usfm: string;
  chapter: number;
  startVerse?: number;
  endVerse?: number;
}

function flattenPages(dayPlan: DayPlan): PlanPage[] {
  return dayPlan.passages.flatMap((passage, passageIndex) =>
    passage.segments.map(seg => ({
      passageIndex,
      book: passage.book,
      usfm: passage.usfm,
      chapter: seg.chapter,
      startVerse: seg.startVerse,
      endVerse: seg.endVerse,
    }))
  );
}

// Verse bounds are only ever partial on one side within a single chapter —
// the plan never gives us both ends of a whole book's worth of verses to
// guess at, so an open bound just means "to/from the edge of this chapter".
function pageLabel(page: PlanPage): string {
  if (page.startVerse !== undefined && page.endVerse !== undefined) {
    return `${page.book} ${page.chapter}:${page.startVerse}-${page.endVerse}`;
  }
  if (page.startVerse !== undefined) return `${page.book} ${page.chapter}:${page.startVerse}-end`;
  if (page.endVerse !== undefined) return `${page.book} ${page.chapter}:1-${page.endVerse}`;
  return `${page.book} ${page.chapter}`;
}

function getDayOfYear(date?: Date): number {
  const d = date ?? new Date();
  // Compare calendar dates via Date.UTC (not local ms timestamps) so a DST
  // shift between Jan 1 and today can't shift the day count by an hour and
  // flip the floor/round to a different day than a midnight-based Date for
  // the same calendar day would give.
  const utcDay = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const utcStart = Date.UTC(d.getFullYear(), 0, 1);
  return Math.round((utcDay - utcStart) / 86400000) + 1;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function makeReaderHtml(title: string, body: string, copyright?: string): string {
  const footer = copyright
    ? `<p class="copyright">${copyright}</p>`
    : '';
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:Georgia,serif;background:#f8f5ef;color:#2d2d2d;padding:20px 16px 60px;line-height:1.9;font-size:17px}
  h1{font-size:20px;color:#2e5c3e;margin-bottom:20px;font-family:Georgia,serif}
  p{margin:0 0 6px;white-space:pre-wrap}
  .copyright{margin-top:24px;padding-top:12px;border-top:1px solid #ddd6c8;font-size:12px;line-height:1.5;color:#8a8478;font-family:sans-serif;white-space:normal}
</style></head><body><h1>${title}</h1><p>${body}</p>${footer}</body></html>`;
}

// ── Fallback VOTD ─────────────────────────────────────────────────────────────

const FALLBACK_VERSES = [
  { ref: 'Psalm 46:10', text: '"Be still, and know that I am God."' },
  { ref: 'Jeremiah 29:11', text: '"For I know the plans I have for you," declares the Lord.' },
  { ref: 'Philippians 4:13', text: '"I can do all things through Christ who strengthens me."' },
  { ref: 'Romans 8:28', text: '"We know that in all things God works for the good of those who love him."' },
  { ref: 'Proverbs 3:5–6', text: '"Trust in the Lord with all your heart and lean not on your own understanding."' },
  { ref: 'Isaiah 40:31', text: '"Those who hope in the Lord will renew their strength."' },
  { ref: 'Matthew 11:28', text: '"Come to me, all you who are weary and burdened, and I will give you rest."' },
];

// ── In-App Bible Reader Modal ─────────────────────────────────────────────────

interface ReaderProps {
  reading: Reading | null;
  translation: TranslationLabel;
  onClose: () => void;
}

function BibleReaderModal({ reading, translation, onClose }: ReaderProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!reading) return;
    setHtml(null);
    setLoading(true);

    fetchChapterText(translation, reading.usfm, reading.chapter)
      .then(text => {
        setHtml(makeReaderHtml(`${reading.name} ${reading.chapter}`, text, BIBLE_COPYRIGHT[translation]));
      })
      .catch((err: Error) => {
        setHtml(makeReaderHtml(
          `${reading.name} ${reading.chapter}`,
          `Could not load passage.\n\n${err.message}`
        ));
      })
      .finally(() => setLoading(false));
  }, [reading?.usfm, reading?.chapter, translation]);

  return (
    <Modal visible={!!reading} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={readerStyles.container}>
        <View style={readerStyles.header}>
          <Text style={readerStyles.title} numberOfLines={1}>
            {reading ? `${reading.name} ${reading.chapter}` : ''}
          </Text>
          <TouchableOpacity onPress={onClose} style={readerStyles.closeBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={24} color={Colors.cream} />
          </TouchableOpacity>
        </View>
        {loading ? (
          <View style={readerStyles.loadingOverlay}>
            <ActivityIndicator color={Colors.gold} size="large" />
          </View>
        ) : html ? (
          <WebView
            source={{ html }}
            style={{ flex: 1 }}
            originWhitelist={['*']}
            showsVerticalScrollIndicator
          />
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

// ── Bible Launcher Modal ──────────────────────────────────────────────────────
// OT_BOOKS/NT_BOOKS imported above from @churchkit/config/bible, shared
// with apps/admin's sermon-notes scripture picker.

function BibleLauncherModal({ visible, onClose, onSelect }: {
  visible: boolean;
  onClose: () => void;
  onSelect: (r: Reading) => void;
}) {
  const [section, setSection] = useState<'OT' | 'NT'>('OT');
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const books = section === 'OT' ? OT_BOOKS : NT_BOOKS;

  function selectChapter(chapter: number) {
    if (!selectedBook) return;
    onSelect({ name: selectedBook.name, usfm: selectedBook.usfm, chapter });
    setSelectedBook(null);
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={launcherStyles.container}>
        <View style={launcherStyles.header}>
          <Text style={launcherStyles.title}>
            {selectedBook ? selectedBook.name : 'Open a Passage'}
          </Text>
          <TouchableOpacity onPress={selectedBook ? () => setSelectedBook(null) : onClose}
            style={launcherStyles.closeBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name={selectedBook ? 'arrow-back' : 'close'} size={24} color={Colors.cream} />
          </TouchableOpacity>
        </View>

        {!selectedBook ? (
          <>
            <View style={launcherStyles.tabs}>
              {(['OT', 'NT'] as const).map(s => (
                <TouchableOpacity key={s} style={[launcherStyles.tab, section === s && launcherStyles.tabActive]}
                  onPress={() => setSection(s)}>
                  <Text style={[launcherStyles.tabText, section === s && launcherStyles.tabTextActive]}>
                    {s === 'OT' ? 'Old Testament' : 'New Testament'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <ScrollView contentContainerStyle={launcherStyles.bookGrid}>
              {books.map(book => (
                <TouchableOpacity key={book.usfm} style={launcherStyles.bookBtn}
                  onPress={() => setSelectedBook(book)}>
                  <Text style={launcherStyles.bookName}>{book.name}</Text>
                  <Text style={launcherStyles.bookChCount}>{book.chapters} ch</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        ) : (
          <ScrollView contentContainerStyle={launcherStyles.chapterGrid}>
            {Array.from({ length: selectedBook.chapters }, (_, i) => i + 1).map(ch => (
              <TouchableOpacity key={ch} style={launcherStyles.chapterBtn} onPress={() => selectChapter(ch)}>
                <Text style={launcherStyles.chapterNum}>{ch}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ── Audio Settings Dropdown ───────────────────────────────────────────────────
// One button showing the current choice ("Full Cast · Standard"); tapping it
// opens a modal with both option lists. Two separate settings, but one
// control, so it reads as a single "audio settings" dropdown rather than two
// competing controls crowded into the player row.

function AudioSettingsModal({
  visible, onClose, style, quality, onSelectStyle, onSelectQuality,
}: {
  visible: boolean;
  onClose: () => void;
  style: AudioStyle;
  quality: AudioQuality;
  onSelectStyle: (s: AudioStyle) => void;
  onSelectQuality: (q: AudioQuality) => void;
}) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={audioModalStyles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={audioModalStyles.sheet} onPress={() => {}}>
          <Text style={audioModalStyles.sheetTitle}>Audio Settings</Text>

          <Text style={audioModalStyles.groupLabel}>Narration</Text>
          {AUDIO_STYLES.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={audioModalStyles.option}
              onPress={() => onSelectStyle(opt.value)}
            >
              <Ionicons
                name={style === opt.value ? 'radio-button-on' : 'radio-button-off'}
                size={20}
                color={style === opt.value ? Colors.gold : Colors.gray400}
              />
              <View style={audioModalStyles.optionText}>
                <Text style={audioModalStyles.optionLabel}>{opt.label}</Text>
                <Text style={audioModalStyles.optionHint}>{opt.hint}</Text>
              </View>
            </TouchableOpacity>
          ))}

          <Text style={audioModalStyles.groupLabel}>Download Size</Text>
          {AUDIO_QUALITIES.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={audioModalStyles.option}
              onPress={() => onSelectQuality(opt.value)}
            >
              <Ionicons
                name={quality === opt.value ? 'radio-button-on' : 'radio-button-off'}
                size={20}
                color={quality === opt.value ? Colors.gold : Colors.gray400}
              />
              <View style={audioModalStyles.optionText}>
                <Text style={audioModalStyles.optionLabel}>{opt.label}</Text>
                <Text style={audioModalStyles.optionHint}>{opt.hint}</Text>
              </View>
            </TouchableOpacity>
          ))}

          <TouchableOpacity style={audioModalStyles.doneBtn} onPress={onClose}>
            <Text style={audioModalStyles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const audioModalStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.white, borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg,
    padding: Spacing.md, paddingBottom: Spacing.xl,
  },
  sheetTitle: { fontFamily: Fonts.heading, fontSize: FontSizes.lg, color: Colors.cedar, marginBottom: Spacing.sm },
  groupLabel: {
    fontFamily: Fonts.bodyMedium, fontSize: FontSizes.xs, color: Colors.gray400,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: Spacing.md, marginBottom: 6,
  },
  option: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 8 },
  optionText: { flex: 1 },
  optionLabel: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.md, color: Colors.cedar },
  optionHint: { fontFamily: Fonts.body, fontSize: FontSizes.xs, color: Colors.gray400, marginTop: 1 },
  doneBtn: {
    marginTop: Spacing.lg, backgroundColor: Colors.gold, borderRadius: Radius.md,
    paddingVertical: 12, alignItems: 'center',
  },
  doneBtnText: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.md, color: Colors.cedar },
});

// ── Daily Reading + Listen Section ────────────────────────────────────────────

const AUTO_ADVANCE_KEY = 'bible_auto_advance';
const COMPLETED_DATES_KEY = 'bible_completed_dates';

async function loadCompletedDates(): Promise<Set<string>> {
  const raw = await readStored(COMPLETED_DATES_KEY);
  try {
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

async function saveCompletedDates(dates: Set<string>): Promise<void> {
  await writeStored(COMPLETED_DATES_KEY, JSON.stringify([...dates]));
}

const PLAN_LIST_INITIAL_DAYS = 30;
const PLAN_LIST_PAGE_DAYS = 30;
const PLAN_LIST_MAX_DAYS = 1825; // ~5 years back

function ReadingPlanListView({ onBack, onSelectDay }: {
  onBack: () => void;
  onSelectDay: (date: Date) => void;
}) {
  const insets = useSafeAreaInsets();
  const [count, setCount] = useState(PLAN_LIST_INITIAL_DAYS);
  const [completedDates, setCompletedDates] = useState<Set<string>>(new Set());
  const today = startOfToday();
  const days = Array.from({ length: count }, (_, i) => addDays(today, -i));

  // Re-loads on every mount, which happens whenever the user navigates back
  // from the detail view — so a completion toggled there shows up here.
  useEffect(() => {
    loadCompletedDates().then(setCompletedDates);
  }, []);

  return (
    <SafeAreaView style={planListStyles.container}>
      <View style={[planListStyles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="arrow-back" size={24} color={Colors.cream} />
        </TouchableOpacity>
        <Text style={planListStyles.headerTitle}>Reading Plan</Text>
        <View style={{ width: 24 }} />
      </View>
      <FlatList
        data={days}
        keyExtractor={d => d.toISOString()}
        renderItem={({ item, index }) => (
          <PlanDayRow
            date={item}
            isToday={index === 0}
            isComplete={completedDates.has(item.toDateString())}
            onPress={() => onSelectDay(item)}
          />
        )}
        onEndReached={() => setCount(c => Math.min(c + PLAN_LIST_PAGE_DAYS, PLAN_LIST_MAX_DAYS))}
        onEndReachedThreshold={0.4}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

function PlanDayRow({ date, isToday, isComplete, onPress }: {
  date: Date;
  isToday: boolean;
  isComplete: boolean;
  onPress: () => void;
}) {
  const summary = getDayPlan(date).passages.map(p => p.label).join(', ');
  const month = date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  const weekday = isToday ? 'Today' : date.toLocaleDateString('en-US', { weekday: 'long' });

  return (
    <TouchableOpacity style={planListStyles.row} onPress={onPress} activeOpacity={0.75}>
      <View style={planListStyles.dateBadge}>
        <Text style={planListStyles.dateMonth}>{month}</Text>
        <Text style={planListStyles.dateDay}>{date.getDate()}</Text>
      </View>
      <View style={planListStyles.rowMeta}>
        <Text style={planListStyles.rowWeekday}>{weekday}</Text>
        <Text style={planListStyles.rowSummary} numberOfLines={1}>{summary}</Text>
      </View>
      {isComplete && (
        <Ionicons name="checkmark-circle" size={20} color={Colors.gold} style={{ marginRight: Spacing.sm }} />
      )}
      <Ionicons name="chevron-forward" size={18} color={Colors.gray400} />
    </TouchableOpacity>
  );
}

const planListStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0ede6' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm,
    backgroundColor: Colors.cedar,
  },
  headerTitle: { fontFamily: Fonts.heading, fontSize: FontSizes.lg, color: Colors.cream },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
    backgroundColor: Colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.gray100,
  },
  dateBadge: { width: 44, alignItems: 'center', marginRight: Spacing.md },
  dateMonth: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.xs, color: Colors.gray400, letterSpacing: 0.5 },
  dateDay: { fontFamily: Fonts.heading, fontSize: FontSizes.xl, color: Colors.cedar },
  rowMeta: { flex: 1 },
  rowWeekday: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.md, color: Colors.cedar },
  rowSummary: { fontFamily: Fonts.body, fontSize: FontSizes.sm, color: Colors.gray400, marginTop: 2 },
});

// ── Reading Day Detail (single reading per page, with its own player) ────────

function ReadingDayDetailView({
  date, translation, audioStyle, audioQuality, onChangeAudioStyle, onChangeAudioQuality, onBack,
}: {
  date: Date;
  translation: TranslationLabel;
  audioStyle: AudioStyle;
  audioQuality: AudioQuality;
  onChangeAudioStyle: (s: AudioStyle) => void;
  onChangeAudioQuality: (q: AudioQuality) => void;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const pages = flattenPages(getDayPlan(date));
  const isToday = date.toDateString() === startOfToday().toDateString();
  const dateLabel = isToday
    ? 'Today'
    : date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const [readingIndex, setReadingIndex] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [panelText, setPanelText] = useState<string | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [audioSettingsVisible, setAudioSettingsVisible] = useState(false);
  const dateKey = date.toDateString();

  const textCache = useRef<Map<string, string>>(new Map());
  const indexRef = useRef(0);
  indexRef.current = readingIndex;
  const autoAdvanceRef = useRef(true);
  autoAdvanceRef.current = autoAdvance;
  // Which reading index (if any) currently has a track loaded in the player —
  // lets the play button resume in place instead of restarting from scratch.
  const loadedIndexRef = useRef<number | null>(null);
  // Tracks which of today's readings have been opened, so the day can be
  // auto-checked once all of them have. Fires at most once per mount, so it
  // won't fight a manual un-check made after the auto-check already ran.
  const visitedIndicesRef = useRef<Set<number>>(new Set());
  const autoCompletedRef = useRef(false);

  const playback = usePlaybackState();
  const isPlaying = playback.state === State.Playing;
  const isBuffering = playback.state === State.Buffering || playback.state === State.Connecting;

  useEffect(() => {
    readStored(AUTO_ADVANCE_KEY).then(val => {
      if (val === 'false') setAutoAdvance(false);
    });
  }, []);

  useEffect(() => {
    loadCompletedDates().then(set => setIsComplete(set.has(dateKey)));
  }, [dateKey]);

  // Auto-check the day once every reading in it has been opened.
  useEffect(() => {
    visitedIndicesRef.current.add(readingIndex);
    if (!autoCompletedRef.current && visitedIndicesRef.current.size >= pages.length) {
      autoCompletedRef.current = true;
      markComplete();
    }
  }, [readingIndex]);

  // Stop playback if this page unmounts (back button, or picking another day).
  useEffect(() => () => { stopReading(); }, []);

  // Changing style/quality mid-reading shouldn't silently resume the old
  // audio when play is next pressed — force the next press to fetch fresh.
  // No-op on mount: loadedIndexRef starts null, so nothing to stop yet.
  useEffect(() => {
    if (loadedIndexRef.current !== null) {
      stopReading();
      loadedIndexRef.current = null;
    }
  }, [audioStyle, audioQuality]);

  // Loading a page — on open, or via the prev/next arrows — only displays its
  // text. It never starts audio on its own; only the play button does that.
  useEffect(() => {
    const page = pages[readingIndex];
    if (!page) return;
    const cacheKey = `${translation}.${page.usfm}.${page.chapter}.${page.startVerse ?? ''}.${page.endVerse ?? ''}`;
    const cached = textCache.current.get(cacheKey);
    if (cached) {
      setPanelText(cached);
      setPanelError(false);
      return;
    }
    setPanelLoading(true);
    setPanelError(false);
    fetchChapterText(translation, page.usfm, page.chapter, page.startVerse, page.endVerse)
      .then(text => {
        textCache.current.set(cacheKey, text);
        if (indexRef.current === readingIndex) setPanelText(text);
      })
      .catch(() => {
        if (indexRef.current === readingIndex) setPanelError(true);
      })
      .finally(() => {
        if (indexRef.current === readingIndex) setPanelLoading(false);
      });
  }, [readingIndex, translation]);

  function toggleAutoAdvance() {
    const next = !autoAdvance;
    setAutoAdvance(next);
    writeStored(AUTO_ADVANCE_KEY, String(next));
  }

  async function markComplete() {
    const dates = await loadCompletedDates();
    if (dates.has(dateKey)) return;
    dates.add(dateKey);
    await saveCompletedDates(dates);
    setIsComplete(true);
  }

  async function toggleComplete() {
    const dates = await loadCompletedDates();
    if (dates.has(dateKey)) {
      dates.delete(dateKey);
    } else {
      dates.add(dateKey);
    }
    await saveCompletedDates(dates);
    setIsComplete(dates.has(dateKey));
  }

  function playIndex(i: number) {
    const page = pages[i];
    if (!page) return;
    setReadingIndex(i);
    loadedIndexRef.current = i;
    playReading(page.usfm, page.chapter, pageLabel(page), audioStyle, audioQuality, () => {
      if (autoAdvanceRef.current && i < pages.length - 1) {
        playIndex(i + 1);
      } else {
        loadedIndexRef.current = null;
      }
    });
  }

  function handlePlayPress() {
    if (isPlaying || isBuffering) {
      pauseReading();
    } else if (loadedIndexRef.current === readingIndex) {
      resumeReading();
    } else {
      playIndex(readingIndex);
    }
  }

  // Used by the on-screen prev/next arrows — only swaps which reading's text
  // is shown, it never starts audio itself (see the effect above).
  function goToReading(delta: number) {
    const next = readingIndex + delta;
    if (next < 0 || next >= pages.length) return;
    stopReading();
    loadedIndexRef.current = null;
    setReadingIndex(next);
  }

  // Used by the lock-screen / car Bluetooth skip buttons — unlike the on-screen
  // arrows, this keeps playing so a driver never has to touch the phone.
  function skipReading(delta: number) {
    const next = readingIndex + delta;
    if (next < 0 || next >= pages.length) return;
    playIndex(next);
  }

  useEffect(() => {
    setSkipHandlers({ next: () => skipReading(1), previous: () => skipReading(-1) });
    return () => setSkipHandlers({});
  }, [readingIndex, pages.length, audioStyle, audioQuality]);

  const current = pages[readingIndex];

  return (
    <SafeAreaView style={detailStyles.container}>
      <View style={[detailStyles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="arrow-back" size={24} color={Colors.cream} />
        </TouchableOpacity>
        <Text style={detailStyles.headerTitle}>{dateLabel}</Text>
        <TouchableOpacity onPress={toggleComplete} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons
            name={isComplete ? 'checkmark-circle' : 'checkmark-circle-outline'}
            size={24}
            color={isComplete ? Colors.gold : Colors.cream}
          />
        </TouchableOpacity>
      </View>

      <View style={detailStyles.navRow}>
        <TouchableOpacity
          style={[detailStyles.navBtn, readingIndex === 0 && detailStyles.navBtnDisabled]}
          onPress={() => goToReading(-1)}
          disabled={readingIndex === 0}
        >
          <Ionicons name="chevron-back" size={22} color={readingIndex === 0 ? Colors.gray400 : Colors.cedar} />
        </TouchableOpacity>
        <View style={detailStyles.navLabelWrap}>
          <Text style={detailStyles.navBook}>{current ? pageLabel(current) : ''}</Text>
          <Text style={detailStyles.navProgress}>
            {pages.length ? `${readingIndex + 1} of ${pages.length}` : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={[detailStyles.navBtn, readingIndex === pages.length - 1 && detailStyles.navBtnDisabled]}
          onPress={() => goToReading(1)}
          disabled={readingIndex === pages.length - 1}
        >
          <Ionicons
            name="chevron-forward"
            size={22}
            color={readingIndex === pages.length - 1 ? Colors.gray400 : Colors.cedar}
          />
        </TouchableOpacity>
      </View>

      <View style={detailStyles.playerRow}>
        <View style={detailStyles.playBtnWrap}>
          <TouchableOpacity style={detailStyles.playBtn} onPress={handlePlayPress}>
            {isBuffering ? (
              <ActivityIndicator color={Colors.cedar} />
            ) : (
              <Ionicons name={isPlaying ? 'pause' : 'play'} size={28} color={Colors.cedar} />
            )}
          </TouchableOpacity>
          {/* Narration is always the ESV recording, regardless of the translation shown above. */}
          <TouchableOpacity
            style={detailStyles.audioSettingsBtn}
            onPress={() => setAudioSettingsVisible(true)}
          >
            <Text style={detailStyles.audioSourceLabel}>
              ESV · {AUDIO_STYLES.find(s => s.value === audioStyle)?.label} · {AUDIO_QUALITIES.find(q => q.value === audioQuality)?.label}
            </Text>
            <Ionicons name="chevron-down" size={12} color={Colors.gray400} />
          </TouchableOpacity>
        </View>
        <View style={detailStyles.autoToggle}>
          <Text style={detailStyles.autoToggleLabel}>Auto-advance</Text>
          <Switch
            value={autoAdvance}
            onValueChange={toggleAutoAdvance}
            trackColor={{ false: Colors.gray200, true: Colors.gold }}
            thumbColor={Colors.white}
          />
        </View>
      </View>

      <ScrollView style={detailStyles.textPanel} contentContainerStyle={{ padding: Spacing.md }}>
        {panelLoading ? (
          <ActivityIndicator color={Colors.gold} style={{ marginTop: Spacing.lg }} />
        ) : panelError ? (
          <Text style={detailStyles.textError}>Could not load this passage.</Text>
        ) : (
          <>
            <Text style={detailStyles.textBody}>{panelText}</Text>
            {BIBLE_COPYRIGHT[translation] && (
              <Text style={detailStyles.copyrightText}>{BIBLE_COPYRIGHT[translation]}</Text>
            )}
          </>
        )}
      </ScrollView>

      <AudioSettingsModal
        visible={audioSettingsVisible}
        onClose={() => setAudioSettingsVisible(false)}
        style={audioStyle}
        quality={audioQuality}
        onSelectStyle={onChangeAudioStyle}
        onSelectQuality={onChangeAudioQuality}
      />
    </SafeAreaView>
  );
}

const detailStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f5ef' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm,
    backgroundColor: Colors.cedar,
  },
  headerTitle: { fontFamily: Fonts.heading, fontSize: FontSizes.lg, color: Colors.cream },
  navRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.sm,
    backgroundColor: Colors.cedarMid,
  },
  navBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.white, alignItems: 'center', justifyContent: 'center',
  },
  navBtnDisabled: { opacity: 0.4 },
  navLabelWrap: { flex: 1, alignItems: 'center' },
  navBook: { fontFamily: Fonts.heading, fontSize: FontSizes.lg, color: Colors.cream },
  navProgress: { fontFamily: Fonts.body, fontSize: FontSizes.xs, color: Colors.gold, marginTop: 2 },
  playerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    backgroundColor: Colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.gray100,
  },
  playBtnWrap: { alignItems: 'center', gap: 4 },
  playBtn: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.gold, alignItems: 'center', justifyContent: 'center',
    ...Shadow.sm,
  },
  audioSettingsBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  audioSourceLabel: { fontFamily: Fonts.body, fontSize: FontSizes.xs, color: Colors.gray400 },
  autoToggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  autoToggleLabel: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.sm, color: Colors.gray600 },
  textPanel: { flex: 1 },
  textBody: { fontFamily: Fonts.body, fontSize: FontSizes.base, color: Colors.gray600, lineHeight: 26 },
  textError: { fontFamily: Fonts.body, fontSize: FontSizes.sm, color: Colors.error, marginTop: Spacing.lg, textAlign: 'center' },
  copyrightText: {
    fontFamily: Fonts.body, fontSize: FontSizes.xs, color: Colors.gray400, lineHeight: 16,
    marginTop: Spacing.lg, paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.gray200,
  },
});

// ── Screen ────────────────────────────────────────────────────────────────────

export default function BibleScreen() {
  const insets = useSafeAreaInsets();

  const [screen, setScreen] = useState<'home' | 'list' | 'detail'>('home');
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [readerReading, setReaderReading] = useState<Reading | null>(null);
  const [launcherVisible, setLauncherVisible] = useState(false);
  const [translation, setTranslation] = useState<TranslationLabel>('NIV');
  const [audioStyle, setAudioStyle] = useState<AudioStyle>('narrator');
  const [audioQuality, setAudioQuality] = useState<AudioQuality>('standard');

  const activePlanYear = getActivePlanYear(new Date());
  const todaysSummary = getDayPlan(new Date()).passages.map(p => p.label).join(', ');

  const [votd, setVotd] = useState<{ ref: string; text: string } | null>(null);
  const [votdLoading, setVotdLoading] = useState(false);

  // Load saved translation
  useEffect(() => {
    readStored(TRANSLATION_KEY).then(val => {
      if (val && TRANSLATIONS.some(t => t.label === val)) {
        setTranslation(val as TranslationLabel);
      }
    });
  }, []);

  function selectTranslation(label: TranslationLabel) {
    setTranslation(label);
    writeStored(TRANSLATION_KEY, label);
  }

  // Load saved audio settings
  useEffect(() => {
    readStored(AUDIO_STYLE_KEY).then(val => {
      if (val && AUDIO_STYLES.some(s => s.value === val)) setAudioStyle(val as AudioStyle);
    });
    readStored(AUDIO_QUALITY_KEY).then(val => {
      if (val && AUDIO_QUALITIES.some(q => q.value === val)) setAudioQuality(val as AudioQuality);
    });
  }, []);

  function selectAudioStyle(value: AudioStyle) {
    setAudioStyle(value);
    writeStored(AUDIO_STYLE_KEY, value);
  }

  function selectAudioQuality(value: AudioQuality) {
    setAudioQuality(value);
    writeStored(AUDIO_QUALITY_KEY, value);
  }

  useEffect(() => {
    const todayDay = getDayOfYear();
    setVotdLoading(true);
    setVotd(null);
    const firstPage = flattenPages(getDayPlan(new Date()))[0];
    fetchChapterText(translation, firstPage.usfm, firstPage.chapter, firstPage.startVerse, firstPage.endVerse)
      .then(text => {
        setVotd(text
          ? { ref: pageLabel(firstPage), text: `"${text.slice(0, 220)}${text.length > 220 ? '…' : ''}"` }
          : FALLBACK_VERSES[todayDay % FALLBACK_VERSES.length]);
      })
      .catch(() => setVotd(FALLBACK_VERSES[todayDay % FALLBACK_VERSES.length]))
      .finally(() => setVotdLoading(false));
  }, [translation]);

  if (screen === 'list') {
    return (
      <ReadingPlanListView
        onBack={() => setScreen('home')}
        onSelectDay={date => { setSelectedDate(date); setScreen('detail'); }}
      />
    );
  }

  if (screen === 'detail' && selectedDate) {
    return (
      <ReadingDayDetailView
        key={selectedDate.toDateString()}
        date={selectedDate}
        translation={translation}
        audioStyle={audioStyle}
        audioQuality={audioQuality}
        onChangeAudioStyle={selectAudioStyle}
        onChangeAudioQuality={selectAudioQuality}
        onBack={() => setScreen('list')}
      />
    );
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: Spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + Spacing.md }]}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.headerTitle}>Bible</Text>
              <Text style={styles.headerSub}>2-Year Bible Reading Plan · Year {activePlanYear}</Text>
            </View>
            <TouchableOpacity style={styles.openBibleBtn} onPress={() => setLauncherVisible(true)}>
              <Ionicons name="book-outline" size={18} color={Colors.gold} />
              <Text style={styles.openBibleText}>Open Bible</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Translation Picker */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.translationRow}
          contentContainerStyle={styles.translationRowContent}
        >
          {TRANSLATIONS.map(t => (
            <TouchableOpacity
              key={t.label}
              style={[styles.translationChip, translation === t.label && styles.translationChipActive]}
              onPress={() => selectTranslation(t.label)}
            >
              <Text style={[styles.translationChipText, translation === t.label && styles.translationChipTextActive]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Daily Bible Reading */}
        <SectionLabel label="Daily Bible Reading" />
        <TouchableOpacity style={styles.planEntryCard} onPress={() => setScreen('list')} activeOpacity={0.85}>
          <View style={styles.planEntryIcon}>
            <Ionicons name="calendar-outline" size={22} color={Colors.gold} />
          </View>
          <View style={styles.planEntryMeta}>
            <Text style={styles.planEntryTitle}>Today's Reading</Text>
            <Text style={styles.planEntrySummary} numberOfLines={1}>{todaysSummary}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={Colors.gray400} />
        </TouchableOpacity>

        {/* Verse of the Day */}
        <SectionLabel label="Verse of the Day" />
        <View style={styles.votdCard}>
          {votdLoading ? (
            <ActivityIndicator color={Colors.gold} />
          ) : votd ? (
            <>
              <Text style={styles.votdRef}>{votd.ref}</Text>
              <Text style={styles.votdText}>{votd.text}</Text>
              <View style={styles.votdAccent} />
            </>
          ) : null}
        </View>

        {/* About */}
        <SectionLabel label="About This Plan" />
        <View style={styles.aboutCard}>
          <Text style={styles.aboutText}>
            This 2-year Bible reading plan (based on the classic M'Cheyne plan) takes you
            through the entire Bible with two daily readings. Year 1 covers Genesis–2
            Chronicles alongside the Gospels, Acts, the Epistles, and Psalms; Year 2 covers
            Ezra–Malachi while going back through the New Testament and Psalms again.
          </Text>
        </View>
      </ScrollView>

      <BibleReaderModal reading={readerReading} translation={translation} onClose={() => setReaderReading(null)} />
      <BibleLauncherModal
        visible={launcherVisible}
        onClose={() => setLauncherVisible(false)}
        onSelect={r => { setLauncherVisible(false); setReaderReading(r); }}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0ede6' },
  header: {
    backgroundColor: Colors.cedar,
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  headerTitle: { fontFamily: Fonts.heading, fontSize: FontSizes['2xl'], color: Colors.cream },
  headerSub: { fontFamily: Fonts.body, fontSize: FontSizes.sm, color: Colors.gold, marginTop: 2 },
  openBibleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: Colors.gold,
    paddingHorizontal: Spacing.sm + 2, paddingVertical: 6,
    borderRadius: Radius.full,
  },
  openBibleText: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.sm, color: Colors.gold },

  translationRow: {
    backgroundColor: Colors.cedar,
  },
  translationRowContent: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: 4,
  },
  translationChip: {
    paddingHorizontal: 16, paddingVertical: 6,
    borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.gold + '60',
  },
  translationChipActive: {
    backgroundColor: Colors.gold, borderColor: Colors.gold,
  },
  translationChipText: {
    fontFamily: Fonts.bodyMedium, fontSize: FontSizes.sm, color: Colors.gold,
  },
  translationChipTextActive: {
    color: Colors.cedar,
  },
  planEntryCard: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: Spacing.md, backgroundColor: Colors.white,
    borderRadius: Radius.md, padding: Spacing.md, ...Shadow.sm,
  },
  planEntryIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.cedar, alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.md,
  },
  planEntryMeta: { flex: 1 },
  planEntryTitle: { fontFamily: Fonts.heading, fontSize: FontSizes.md, color: Colors.cedar },
  planEntrySummary: { fontFamily: Fonts.body, fontSize: FontSizes.sm, color: Colors.gray400, marginTop: 2 },

  votdCard: {
    marginHorizontal: Spacing.md, backgroundColor: Colors.cedar,
    borderRadius: Radius.md, padding: Spacing.md, minHeight: 80,
    justifyContent: 'center', ...Shadow.sm,
  },
  votdRef: {
    fontFamily: Fonts.bodyBold, fontSize: FontSizes.sm,
    color: Colors.gold, letterSpacing: 0.5, marginBottom: Spacing.sm,
  },
  votdText: {
    fontFamily: Fonts.headingItalic, fontSize: FontSizes.xl, color: Colors.cream, lineHeight: 30,
  },
  votdAccent: {
    marginTop: Spacing.md, width: 32, height: 3,
    backgroundColor: Colors.gold, borderRadius: Radius.full,
  },

  aboutCard: {
    marginHorizontal: Spacing.md, backgroundColor: Colors.white,
    borderRadius: Radius.md, padding: Spacing.md, ...Shadow.sm,
  },
  aboutText: { fontFamily: Fonts.body, fontSize: FontSizes.sm, color: Colors.gray600, lineHeight: 22 },
});

const readerStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.cedar },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.cedar,
  },
  title: { fontFamily: Fonts.heading, fontSize: FontSizes.lg, color: Colors.cream, flex: 1 },
  closeBtn: { padding: 4, marginLeft: Spacing.sm },
  loadingOverlay: {
    flex: 1, backgroundColor: '#f8f5ef',
    alignItems: 'center', justifyContent: 'center',
  },
});

const launcherStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.cedar },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
  },
  title: { fontFamily: Fonts.heading, fontSize: FontSizes.lg, color: Colors.cream, flex: 1 },
  closeBtn: { padding: 4 },
  tabs: {
    flexDirection: 'row', backgroundColor: Colors.cedarMid,
    marginHorizontal: Spacing.md, marginVertical: Spacing.sm,
    borderRadius: Radius.md, overflow: 'hidden',
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { backgroundColor: Colors.gold },
  tabText: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.sm, color: Colors.cream },
  tabTextActive: { color: Colors.cedar },
  bookGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.xl, gap: 8,
  },
  bookBtn: {
    backgroundColor: Colors.cedarMid, borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm, paddingVertical: 8, minWidth: '30%',
  },
  bookName: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.sm, color: Colors.cream },
  bookChCount: { fontFamily: Fonts.body, fontSize: FontSizes.xs, color: Colors.gold, marginTop: 2 },
  chapterGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.xl, gap: 8,
  },
  chapterBtn: {
    width: 48, height: 48, borderRadius: Radius.sm,
    backgroundColor: Colors.cedarMid, alignItems: 'center', justifyContent: 'center',
  },
  chapterNum: { fontFamily: Fonts.bodyMedium, fontSize: FontSizes.md, color: Colors.cream },
});
