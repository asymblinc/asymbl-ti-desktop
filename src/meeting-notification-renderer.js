import './index.css';
import './meeting-notification.css';

// Same safe-DOM convention as popover-renderer.js: meeting title/platform
// are externally-influenced (calendar/window-title data), so every
// interpolated value goes through textContent/createElement, never
// innerHTML with a template string.
function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.title !== undefined) node.title = opts.title;
  (opts.children || []).forEach((c) => node.appendChild(c));
  return node;
}

function homeInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROW_ICON_PATHS = {
  bot: [['rect', { x: 3, y: 5, width: 10, height: 8, rx: 2 }], ['path', { d: 'M8 5V3M5.5 9h.01M10.5 9h.01' }]],
  sparkle: [['path', { d: 'M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z' }]],
  clock: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M8 4.5V8l2 1.5' }]],
  slash: [['path', { d: 'M3 3l10 10M13 3L3 13' }]],
};
function rowIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('notif-row-icon');
  for (const [tag, attrs] of ROW_ICON_PATHS[name] || []) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    svg.appendChild(node);
  }
  return svg;
}

const panel = document.getElementById('panel');
const avatarEl = document.getElementById('avatar');
const titleEl = document.getElementById('title');
const sublineEl = document.getElementById('subline');
const startBtn = document.getElementById('startBtn');
const startLabel = document.getElementById('startLabel');
const chevronBtn = document.getElementById('chevronBtn');
const expandEl = document.getElementById('expand');

let currentMeeting = null;
let pinned = false;
let collapseTimer = null;

// Real OS window resize (this is a native BrowserWindow, not a fixed-size
// webview) - the main process owns setBounds; the renderer only requests a
// height via IPC (task #37b/#37f).
function requestResize(expanded) {
  const collapsedHeight = 58;
  const expandedHeight = expandEl.scrollHeight ? collapsedHeight + expandEl.scrollHeight : collapsedHeight;
  window.notificationAPI.requestResize(expanded ? expandedHeight : collapsedHeight);
}

function buildSubline(meeting) {
  sublineEl.replaceChildren();
  sublineEl.appendChild(el('span', { text: `${meeting.timeLabel} · ${meeting.platformLabel}` }));
  if (meeting.liveStatus) {
    sublineEl.appendChild(el('span', { className: 'notif-dot' }));
    sublineEl.appendChild(el('span', { className: 'notif-live', text: meeting.liveStatus }));
  }
}

function buildExpand(meeting) {
  expandEl.replaceChildren();

  // Teaser - only when a Pre-Brief/linked-record summary exists. No brief
  // system exists yet (task #23 pending), so this block is honestly omitted
  // rather than showing fabricated content, per spec section 2.2's
  // "content by availability" rule.
  if (meeting.teaser) {
    const teaser = el('div', { className: 'notif-teaser' });
    const text = el('div', { className: 'notif-teaser-text' });
    text.appendChild(document.createTextNode(meeting.teaser));
    teaser.appendChild(text);
    if (meeting.chips?.length) {
      const chips = el('div', { className: 'notif-chips' });
      meeting.chips.forEach((c) => chips.appendChild(el('span', { className: 'notif-chip', text: c })));
      teaser.appendChild(chips);
    }
    expandEl.appendChild(teaser);
  }

  const dropdown = el('div', { className: 'notif-dropdown' });
  const rows = [
    { ic: 'bot', l: 'Send the bot instead', s: 'Joins as "Asymbl Notetaker" — you stay hands-free', kbd: 'B', action: 'sendBot', disabled: true, disabledReason: 'Not available yet' },
    { ic: 'sparkle', l: 'Open Pre-Brief first', s: null, kbd: 'P', action: 'openPreBrief', disabled: true, disabledReason: 'Pre-Brief isn’t built yet' },
    { ic: 'clock', l: 'Remind me in 2 minutes', s: null, kbd: 'R', action: 'remindLater', disabled: false },
    { ic: 'slash', l: "Don't capture this call", s: 'Recall stays silent for this meeting', kbd: 'D', action: 'dontCapture', disabled: false },
  ];
  rows.forEach((r) => {
    const row = el('div', {
      className: `notif-row${r.disabled ? ' notif-row-disabled' : ''}`,
      title: r.disabled ? r.disabledReason : undefined,
    });
    row.appendChild(rowIcon(r.ic));
    const textCol = el('div', { className: 'notif-row-text' });
    textCol.appendChild(el('div', { className: 'notif-row-label', text: r.l }));
    if (r.s) textCol.appendChild(el('div', { className: 'notif-row-sub', text: r.s }));
    row.appendChild(textCol);
    row.appendChild(el('span', { className: 'notif-kbd', text: r.kbd }));
    if (!r.disabled) {
      row.addEventListener('click', () => runAction(r.action));
    }
    dropdown.appendChild(row);
  });

  // Consent footer - only when the policy check says this jurisdiction
  // requires it (control-plane's jurisdiction is currently hardcoded
  // 'one_party' - F6-R8 gap, see gcp/control-plane/src/capture-policy-
  // handler.ts - so consentRequired is always false today; this path is
  // wired for when that's fixed, not fabricated locally).
  if (meeting.consentNoticeText) {
    const consent = el('div', { className: 'notif-consent' });
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('width', '10');
    icon.setAttribute('height', '10');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.5');
    icon.classList.add('notif-consent-icon');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M8 2l5 2v4c0 3.5-2.2 5.7-5 6.5-2.8-.8-5-3-5-6.5V4z');
    icon.appendChild(path);
    consent.appendChild(icon);
    consent.appendChild(el('span', { text: meeting.consentNoticeText }));
    dropdown.appendChild(consent);
  }

  expandEl.appendChild(dropdown);
}

function showExpand() {
  expandEl.style.display = '';
  requestResize(true);
}
function hideExpand() {
  if (pinned) return;
  expandEl.style.display = 'none';
  requestResize(false);
}

panel.addEventListener('mouseenter', () => {
  clearTimeout(collapseTimer);
  showExpand();
});
panel.addEventListener('mouseleave', () => {
  // 300ms collapse delay per spec section 2.2.
  collapseTimer = setTimeout(hideExpand, 300);
});
chevronBtn.addEventListener('click', () => {
  pinned = !pinned;
  if (pinned) showExpand();
  else hideExpand();
});

async function runAction(action) {
  if (action === 'startCapture') {
    startLabel.textContent = 'Starting…';
    startBtn.disabled = true;
    await window.notificationAPI.startCapture();
    return;
  }
  if (action === 'remindLater') {
    await window.notificationAPI.remindLater();
    return;
  }
  if (action === 'dontCapture') {
    await window.notificationAPI.dontCapture();
    return;
  }
}

startBtn.addEventListener('click', () => runAction('startCapture'));

// Keyboard shortcuts (B/P/R/D) - active only while this panel is visible
// (this window only exists while a meeting is being nudged), not registered
// as OS-global shortcuts, which would conflict with the app's real global
// shortcuts (#20l, main.js's registerGlobalShortcuts for ⌘N/⌘L/⌘,).
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'r') runAction('remindLater');
  else if (key === 'd') runAction('dontCapture');
  // 'b'/'p' intentionally no-op today - both actions are disabled (see
  // buildExpand's rows array) until their backends/screens exist.
});

window.notificationAPI.onMeeting((meeting) => {
  currentMeeting = meeting;
  pinned = false;
  avatarEl.textContent = homeInitials(meeting.personName);
  titleEl.textContent = meeting.title;
  buildSubline(meeting);
  buildExpand(meeting);
  startLabel.textContent = 'Start capture';
  startBtn.disabled = false;
  expandEl.style.display = 'none';
  requestResize(false);
});
