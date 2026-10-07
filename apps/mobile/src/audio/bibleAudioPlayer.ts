import TrackPlayer, { Capability, Event, State } from 'react-native-track-player';
import { bibleAudioUrl } from '../api/client';

let setupPromise: Promise<void> | null = null;
let endListeners: { remove: () => void }[] = [];

type SkipHandlers = { next?: () => void; previous?: () => void };
let skipHandlers: SkipHandlers = {};

// The lock screen / car Bluetooth skip buttons don't know about "readings" —
// the screen that owns the reading list registers handlers here so
// PlaybackService can route RemoteNext/RemotePrevious into it.
export function setSkipHandlers(handlers: SkipHandlers): void {
  skipHandlers = handlers;
}

export function skipToNext(): void {
  skipHandlers.next?.();
}

export function skipToPrevious(): void {
  skipHandlers.previous?.();
}

async function ensureSetup(): Promise<void> {
  if (!setupPromise) {
    setupPromise = (async () => {
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        capabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
          Capability.Stop,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious],
      });
    })().catch(e => {
      setupPromise = null;
      throw e;
    });
  }
  return setupPromise;
}

function clearEndListener() {
  endListeners.forEach(l => l.remove());
  endListeners = [];
}

export async function playReading(
  usfm: string,
  chapter: number,
  title: string,
  style: 'dramatized' | 'narrator',
  quality: 'standard' | 'dataSaver',
  onEnd: () => void
): Promise<void> {
  await ensureSetup();
  clearEndListener();
  await TrackPlayer.reset();
  await TrackPlayer.add({
    // style/quality in the id too, so switching either while a reading is
    // loaded (but paused) doesn't silently resume the stale audio.
    id: `${usfm}-${chapter}-${style}-${quality}`,
    url: bibleAudioUrl(usfm, chapter, style, quality),
    title,
    artist: 'Daily Bible Reading',
  });
  // Event.PlaybackQueueEnded is unreliable for a single-track queue on some
  // devices (the native "queue ended" check that gates it doesn't always
  // fire — see doublesymmetry/react-native-track-player#1369), which is why
  // auto-advance would silently stall at the end of a reading. The
  // PlaybackState transition to State.Ended comes from the same underlying
  // event and isn't gated by that check, so listen for both and advance on
  // whichever fires first.
  let ended = false;
  const fireOnce = () => {
    if (ended) return;
    ended = true;
    clearEndListener();
    onEnd();
  };
  endListeners = [
    TrackPlayer.addEventListener(Event.PlaybackQueueEnded, fireOnce),
    TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
      if (state === State.Ended) fireOnce();
    }),
  ];
  await TrackPlayer.play();
}

export async function pauseReading(): Promise<void> {
  await TrackPlayer.pause();
}

export async function resumeReading(): Promise<void> {
  await TrackPlayer.play();
}

export async function stopReading(): Promise<void> {
  clearEndListener();
  // Nothing was ever set up (e.g. prev/next tapped before play, or an
  // unmount racing a setup that failed) — there's no player to reset.
  if (!setupPromise) return;
  await setupPromise;
  await TrackPlayer.reset();
}
