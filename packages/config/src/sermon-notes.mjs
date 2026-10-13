/**
 * Wraps a sermon note's stored HTML fragment (from apps/admin's WYSIWYG
 * editor) into a full document with the viewport meta and font the
 * fragment itself has none of, plus the interactive layer two of the
 * editor's authoring conventions need at view time:
 *
 *   <span class="sn-blank" data-answer="grace">grace</span>
 *     A fill-in-the-blank. The real word is always present in the stored
 *     HTML — never a second, church-authored "fallback" value — and at
 *     render time becomes a real text input a reader types their own
 *     guess into, sized to the answer's length, plus a separate reveal
 *     toggle that shows the stored answer alongside it without touching
 *     whatever the reader typed. Each blank reveals independently; there
 *     is no "reveal all" and no ordering between blanks.
 *
 *   <a class="sn-scripture" data-translation="NIV" data-usfm="JHN"
 *      data-chapter="3" data-start-verse="16" data-end-verse="16">
 *     A scripture reference. No verse text is stored — the admin only
 *     supplies a reference, resolved to these lookup params by
 *     parseBibleReference() in bible.mjs. The text itself is fetched live
 *     from this same origin's /api/bible/text (apps/api/src/routes/
 *     bible.ts) every time it's tapped, via the relative URL below, so a
 *     translation never goes stale the way baked-in text would.
 *
 * Used both by apps/api's public /api/sermons/:id/notes (served into the
 * mobile app's WebView) and by apps/admin's Phone Preview (an iframe
 * srcDoc) — one renderer, so the preview shows exactly what the app does
 * instead of a second, approximate copy of this behavior.
 */

import { BIBLE_COPYRIGHT } from './bible.mjs';

const STYLE = `
  body { margin: 0; padding: 16px; font-family: Georgia, 'Times New Roman', serif; font-size: 18px; line-height: 1.6; color: #222; }
  img { max-width: 100%; height: auto; }
  .sn-blank-wrap { display: inline-flex; align-items: baseline; gap: 4px; }
  .sn-blank-input { border: none; border-bottom: 2px solid #2d4a2b; outline: none; background: transparent; font: inherit; color: inherit; padding: 2px 4px; }
  .sn-blank-reveal { border: none; background: none; cursor: pointer; font-size: 0.8em; padding: 0 2px; line-height: 1; opacity: 0.7; }
  .sn-blank-answer { font-style: italic; font-weight: 600; color: #2d4a2b; }
  .sn-blank-answer[hidden] { display: none; }
  .sn-scripture { display: inline-block; color: #2d4a2b; background: #f0f5f0; border: 1px solid #cfe0cf; border-radius: 12px; padding: 2px 10px; font-family: 'DM Sans', Georgia, sans-serif; font-size: 15px; text-decoration: none; cursor: pointer; }
  .sn-modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; padding: 20px; z-index: 1000; }
  .sn-modal-backdrop.open { display: flex; }
  .sn-modal-panel { background: #fff; border-radius: 10px; max-width: 420px; width: 100%; max-height: 80vh; overflow-y: auto; padding: 20px 22px; position: relative; box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
  .sn-modal-close { position: absolute; top: 10px; right: 14px; border: none; background: none; font-size: 22px; line-height: 1; color: #888; cursor: pointer; }
  .sn-modal-ref { font-family: 'DM Sans', Georgia, sans-serif; font-weight: 600; color: #2d4a2b; font-size: 14px; letter-spacing: 0.3px; text-transform: uppercase; margin-bottom: 10px; }
  .sn-modal-text { font-size: 18px; line-height: 1.6; }
  .sn-modal-copyright { margin-top: 14px; font-family: 'DM Sans', Georgia, sans-serif; font-size: 11px; color: #999; }
`;

// __API_BASE__ and __COPYRIGHT_JSON__ below are replaced with JSON-encoded
// values by renderSermonNotesDocument, not left as bare identifiers.
const SCRIPT = `
(function () {
  document.querySelectorAll('.sn-blank').forEach(function (el) {
    var answer = el.getAttribute('data-answer') || el.textContent;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'sn-blank-input';
    input.placeholder = '…';
    input.size = Math.max(3, answer.length);
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;

    var reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'sn-blank-reveal';
    reveal.textContent = '👁';
    reveal.setAttribute('aria-label', 'Reveal answer');

    var answerEl = document.createElement('span');
    answerEl.className = 'sn-blank-answer';
    answerEl.hidden = true;
    answerEl.textContent = answer;

    reveal.addEventListener('click', function () {
      answerEl.hidden = !answerEl.hidden;
    });

    var wrap = document.createElement('span');
    wrap.className = 'sn-blank-wrap';
    wrap.appendChild(input);
    wrap.appendChild(reveal);
    wrap.appendChild(answerEl);

    el.replaceWith(wrap);
  });

  var backdrop = document.createElement('div');
  backdrop.className = 'sn-modal-backdrop';
  backdrop.innerHTML =
    '<div class="sn-modal-panel">' +
      '<button class="sn-modal-close" aria-label="Close">\\u00D7</button>' +
      '<div class="sn-modal-ref"></div>' +
      '<div class="sn-modal-text"></div>' +
      '<div class="sn-modal-copyright"></div>' +
    '</div>';
  document.body.appendChild(backdrop);

  var modalRef = backdrop.querySelector('.sn-modal-ref');
  var modalText = backdrop.querySelector('.sn-modal-text');
  var modalCopyright = backdrop.querySelector('.sn-modal-copyright');

  function closeModal() { backdrop.classList.remove('open'); }
  backdrop.querySelector('.sn-modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });

  var COPYRIGHT = __COPYRIGHT_JSON__;

  document.querySelectorAll('.sn-scripture').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      var translation = el.getAttribute('data-translation') || 'NIV';
      var usfm = el.getAttribute('data-usfm');
      var chapter = el.getAttribute('data-chapter');
      var startVerse = el.getAttribute('data-start-verse');
      var endVerse = el.getAttribute('data-end-verse');
      var ref = el.getAttribute('data-ref') || el.textContent;

      modalRef.textContent = ref;
      modalText.textContent = 'Loading…';
      modalCopyright.textContent = '';
      backdrop.classList.add('open');

      var qs = 'translation=' + encodeURIComponent(translation) + '&usfm=' + encodeURIComponent(usfm) + '&chapter=' + encodeURIComponent(chapter);
      if (startVerse) qs += '&startVerse=' + encodeURIComponent(startVerse);
      if (endVerse) qs += '&endVerse=' + encodeURIComponent(endVerse);

      fetch(__API_BASE__ + '/api/bible/text?' + qs)
        .then(function (res) { if (!res.ok) throw new Error('fetch failed'); return res.json(); })
        .then(function (data) {
          modalText.textContent = data && data.text ? data.text : 'Scripture unavailable.';
          modalCopyright.textContent = COPYRIGHT[translation] || '';
        })
        .catch(function () {
          modalText.textContent = 'Scripture unavailable.';
        });
    });
  });
})();
`;

// apiBase lets a caller serving this document from a different origin than
// the API itself (apps/admin's Phone Preview, which runs on the admin
// panel's own origin) point the scripture fetch at the right place. The
// default empty string is correct for apps/api's own public endpoint,
// which serves this document from the API's own origin, so a relative
// fetch already lands in the right place.
export function renderSermonNotesDocument(html, { apiBase = '' } = {}) {
	const script = SCRIPT
		.replace('__COPYRIGHT_JSON__', JSON.stringify(BIBLE_COPYRIGHT))
		.replace('__API_BASE__', JSON.stringify(apiBase));

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
</head>
<body>${html || ''}
<script>${script}</script>
</body>
</html>`;
}
