import './index.css';
import './popover.css';

const PLATFORM_NAMES = {
  zoom: 'Zoom',
  'google-meet': 'Google Meet',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

function formatCountdown(startTimeIso) {
  const diffMs = new Date(startTimeIso).getTime() - Date.now();
  // N4: clamp negative (clock skew / meeting already started) to "now".
  const diffMin = Math.max(0, Math.round(diffMs / 60000));
  if (diffMin === 0) return 'now';
  if (diffMin < 60) return `in ${diffMin} min`;
  const hours = Math.floor(diffMin / 60);
  return `in ${hours}h ${diffMin % 60}m`;
}

function formatDateTile(startTimeIso) {
  const d = new Date(startTimeIso);
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    dom: String(d.getDate()).padStart(2, '0'),
  };
}

function formatClock(startTimeIso) {
  return new Date(startTimeIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function setChip(text, tone) {
  const chip = document.getElementById('stateChip');
  chip.style.display = '';
  chip.textContent = text;
  chip.className = `popover-chip${tone ? ` tone-${tone}` : ''}`;
}

// Every branch below builds its DOM via createElement/textContent, never
// innerHTML with interpolated data - SF Event Subject/Location are user-
// authored text (any org user with calendar access can set them), so this
// isn't decorative caution. Only the small number of fully-static
// (author-written, no data interpolation) fragments use a template string.
function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.dataset) Object.entries(opts.dataset).forEach(([k, v]) => { node.dataset[k] = v; });
  (opts.children || []).forEach((c) => node.appendChild(c));
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// Same 16x16 stroke-icon convention as primitives.jsx's Icon component
// (clock/link paths) - built via createElementNS, never innerHTML, so
// there's no markup-parsing surface even though this data is static.
const ICON_PATHS = {
  clock: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M8 4.5V8l2 1.5' }]],
  link: [
    ['path', { d: 'M9 7L7 9' }],
    ['path', { d: 'M10.5 5.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1' }],
    ['path', { d: 'M5.5 10.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1' }],
  ],
};
function miniIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', '#7a8095');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.flexShrink = '0';
  for (const [tag, attrs] of ICON_PATHS[name] || []) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    svg.appendChild(node);
  }
  return svg;
}
function metaLine(iconName, text) {
  return el('div', { className: 'popover-event-line', children: [miniIcon(iconName), el('span', { text })] });
}

function renderEventCard(nextEvent) {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(el('div', { className: 'popover-section-label', text: 'Next on calendar' }));

  if (!nextEvent) {
    wrap.appendChild(el('div', { className: 'popover-empty', text: 'No upcoming interviews scheduled.' }));
    return wrap;
  }

  const { dow, dom } = formatDateTile(nextEvent.startTime);
  const title = nextEvent.whoName
    ? `${nextEvent.whoName}${nextEvent.subject ? ` — ${nextEvent.subject}` : ''}`
    : nextEvent.subject;

  const dateTile = el('div', {
    className: 'popover-date-tile',
    children: [el('div', { className: 'dow', text: dow }), el('div', { className: 'dom', text: dom })],
  });
  const meta = el('div', { className: 'popover-event-meta' });
  meta.appendChild(el('div', { className: 'popover-event-title', text: title }));
  meta.appendChild(metaLine('clock', `${formatClock(nextEvent.startTime)} · ${formatCountdown(nextEvent.startTime)}`));
  if (nextEvent.location) {
    meta.appendChild(metaLine('link', nextEvent.location));
  }
  const eventRow = el('div', { className: 'popover-event-row', children: [dateTile, meta] });
  const actions = el('div', {
    className: 'popover-event-actions',
    children: [
      el('button', { className: 'popover-btn-primary', text: '✳ Open Pre-Brief', dataset: { action: 'openPreBrief' } }),
      el('button', { className: 'popover-btn-ghost', text: 'Skip', dataset: { action: 'skip' } }),
    ],
  });
  wrap.appendChild(el('div', { className: 'popover-event-card', children: [eventRow, actions] }));
  return wrap;
}

function renderLocked(message) {
  return el('div', {
    className: 'popover-locked-card',
    children: [el('div', { className: 'popover-locked-message', text: message || 'Your Recall license needs attention.' })],
  });
}

function renderRecording(rec) {
  const card = el('div', { className: 'popover-recording-card' });
  card.appendChild(el('div', { className: 'popover-recording-timer', text: formatElapsed(rec.elapsedSeconds || 0) }));
  card.appendChild(el('div', { className: 'popover-recording-meta', text: PLATFORM_NAMES[rec.platform] || rec.platform || 'Recording' }));
  card.appendChild(el('div', {
    className: 'popover-event-actions',
    children: [
      el('button', { className: 'popover-btn-primary tone-red', text: 'Stop & save', dataset: { action: 'stopRecording' } }),
      el('button', { className: 'popover-btn-ghost', text: 'Open window', dataset: { action: 'openWindow' } }),
    ],
  }));
  return card;
}

function renderUploading(progress) {
  const pct = Math.round(progress || 0);
  const track = el('div', { className: 'popover-upload-track' });
  const fill = el('div', { className: 'popover-upload-fill' });
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  return el('div', {
    className: 'popover-upload-row',
    children: [el('span', { text: 'Uploading' }), track, el('span', { text: `${pct}%` })],
  });
}

function renderMeetingDetected(meetingDetected) {
  const platform = PLATFORM_NAMES[meetingDetected?.platform] || meetingDetected?.platform || 'meeting';
  const wrap = document.createDocumentFragment();
  wrap.appendChild(el('div', { className: 'popover-section-label', text: 'Meeting detected' }));
  wrap.appendChild(el('div', {
    className: 'popover-event-card',
    children: [
      el('div', { className: 'popover-event-title', text: `${platform} meeting in progress` }),
      el('div', { className: 'popover-event-line', text: 'Recall can join or capture this call.' }),
      el('div', {
        className: 'popover-event-actions',
        children: [el('button', { className: 'popover-btn-primary', text: 'Start capture', dataset: { action: 'joinDetected' } })],
      }),
    ],
  }));
  return wrap;
}

function setContent(node) {
  const content = document.getElementById('content');
  content.replaceChildren(node);
}

function render(state) {
  const options = document.getElementById('options');
  const avatar = document.getElementById('avatar');
  const footerName = document.getElementById('footerName');
  const footerVersion = document.getElementById('footerVersion');

  footerVersion.textContent = state.version ? `v${state.version}` : '';
  if (state.user?.name) {
    avatar.textContent = state.user.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    footerName.textContent = state.user.org ? `${state.user.name} · ${state.user.org}` : state.user.name;
  } else {
    avatar.textContent = '?';
    footerName.textContent = 'Not signed in';
  }

  // Options rows only make sense once signed in - matches spec §5 N7
  // ("signed-out click -> sign-in window, never a dead popover").
  options.style.display = state.state === 'signed-out' ? 'none' : 'block';

  switch (state.state) {
    case 'signed-out':
      document.getElementById('stateChip').style.display = 'none';
      setContent(el('button', { className: 'popover-signin-btn', text: 'Sign in with Salesforce', dataset: { action: 'signIn' } }));
      break;

    case 'locked':
      setChip('Locked', 'amber');
      setContent(renderLocked(state.lockedMessage));
      break;

    case 'recording':
      setChip('REC', 'red');
      setContent(renderRecording(state.recording || {}));
      break;

    case 'uploading':
      setChip('Syncing…', 'blue');
      setContent(renderUploading(state.uploadProgress));
      break;

    case 'meeting-detected':
      setChip('Join?', 'blue');
      setContent(renderMeetingDetected(state.meetingDetected));
      break;

    case 'pre-meeting':
      setChip('Up next', 'blue');
      setContent(renderEventCard(state.nextEvent));
      break;

    case 'idle-ready':
    default:
      setChip('Ready', 'green');
      setContent(renderEventCard(state.nextEvent));
      break;
  }

  document.getElementById('content').querySelectorAll('[data-action]').forEach((elm) => {
    elm.addEventListener('click', () => dispatchAction(elm.dataset.action));
  });
}

function dispatchAction(action) {
  switch (action) {
    case 'signIn': return window.popoverAPI.signIn();
    case 'openPreBrief': return window.popoverAPI.openPreBrief();
    case 'skip': return window.popoverAPI.skip();
    case 'stopRecording': return window.popoverAPI.stopRecording();
    case 'startUnscheduledCall': return window.popoverAPI.startUnscheduledCall();
    case 'openLibrary': return window.popoverAPI.openLibrary();
    case 'openSettings': return window.popoverAPI.openSettings();
    default: return undefined;
  }
}

document.querySelectorAll('.popover-row[data-action]').forEach((elm) => {
  elm.addEventListener('click', () => dispatchAction(elm.dataset.action));
});

let lastState = null;
window.popoverAPI.onState((state) => {
  lastState = state;
  render(state);
});

// Recording's elapsed timer needs to tick locally between state pushes -
// main only pushes on real events (start/stop), not every second.
setInterval(() => {
  const timerEl = document.querySelector('.popover-recording-timer');
  if (timerEl && lastState?.recording?.startedAt) {
    const elapsed = (Date.now() - lastState.recording.startedAt) / 1000;
    timerEl.textContent = formatElapsed(elapsed);
  }
}, 1000);
