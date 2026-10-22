import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatDistance, html, raw, str, timeAgo } from '../js/format.js';

test('timeAgo', () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);
  assert.equal(timeAgo(now, now), 'just now');
  assert.equal(timeAgo(now - 30_000, now), 'just now');
  assert.equal(timeAgo(now - 60_000, now), '1 min ago');
  assert.equal(timeAgo(now - 5 * 60_000, now), '5 min ago');
  assert.equal(timeAgo(now - 59.6 * 60_000, now), '1 h ago');
  assert.equal(timeAgo(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(timeAgo(now - 2 * 86_400_000, now), '2 d ago');
  assert.equal(timeAgo(now + 10_000, now), 'just now', 'clock skew never shows a future time');
});

test('formatDistance', () => {
  assert.equal(formatDistance(7.4), '7 m');
  assert.equal(formatDistance(999.4), '999 m');
  assert.equal(formatDistance(999.6), '1.0 km');
  assert.equal(formatDistance(1449), '1.4 km');
  assert.equal(formatDistance(12_345), '12 km');
  assert.equal(formatDistance(NaN), '–');
  assert.equal(formatDistance(null), '–');
});

test('html escapes interpolated text but not nested html or raw', () => {
  const name = '<img src=x onerror=alert(1)>';
  assert.equal(str(html`<b>${name}</b>`), '<b>&lt;img src=x onerror=alert(1)&gt;</b>');
  assert.equal(str(html`<ul>${['a', 'b'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(str(html`${raw('<i>ok</i>')}${null}${false}${undefined}${0}`), '<i>ok</i>0');
  assert.equal(str(html`<input value="${'" autofocus onfocus="x'}">`), '<input value="&quot; autofocus onfocus=&quot;x">');
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});
