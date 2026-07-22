// Vanilla-JS ports of the Recall by Asymbl design system's primitives.jsx
// (React) for this Electron app's plain-DOM renderer. Icon set is a subset -
// add more paths from the design project's primitives.jsx as later screens
// need them, rather than porting all ~35 speculatively.

// Each icon is a list of [tagName, attrs] tuples - built via createElementNS,
// never innerHTML, so there's no markup-parsing surface even though this
// data is static/self-authored.
const ICON_SHAPES = {
  mic: [
    ['rect', { x: 6, y: 2, width: 4, height: 9, rx: 2 }],
    ['path', { d: 'M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2M5.5 14h5' }],
  ],
  pause: [
    ['rect', { x: 5, y: 3, width: 2, height: 10 }],
    ['rect', { x: 9, y: 3, width: 2, height: 10 }],
  ],
  stop: [['rect', { x: 4, y: 4, width: 8, height: 8, rx: 1, fill: 'currentColor' }]],
  search: [
    ['circle', { cx: 7, cy: 7, r: 4.5 }],
    ['path', { d: 'M10.5 10.5l3 3' }],
  ],
  edit: [['path', { d: 'M11.5 2.5l2 2-8 8H3.5v-2z' }]],
  sparkle: [['path', { d: 'M8 2v4M8 10v4M2 8h4M10 8h4M4 4l2.5 2.5M9.5 9.5L12 12M12 4l-2.5 2.5M6.5 9.5L4 12' }]],
  link: [
    ['path', { d: 'M9 7L7 9' }],
    ['path', { d: 'M10.5 5.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1' }],
    ['path', { d: 'M5.5 10.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1' }],
  ],
  check: [['path', { d: 'M3 8l3 3 7-7' }]],
  upload: [['path', { d: 'M8 11V3M4 6l4-4 4 4M3 13.5h10' }]],
  lock: [
    ['rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1 }],
    ['path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }],
  ],
  refresh: [
    ['path', { d: 'M2 8a6 6 0 0 1 10.5-4M14 8a6 6 0 0 1-10.5 4' }],
    ['path', { d: 'M11 1.5v3.5h-3M5 14.5V11h3' }],
  ],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 16, color = 'currentColor', strokeWidth = 1.5 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.flexShrink = '0';
  for (const [tag, attrs] of ICON_SHAPES[name] || []) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    svg.appendChild(el);
  }
  return svg;
}

export function recDot(live = true) {
  const span = document.createElement('span');
  span.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--brand-record-red);letter-spacing:0.06em;text-transform:uppercase;';
  const dot = document.createElement('span');
  if (live) {
    dot.className = 'recall-pulse';
  } else {
    dot.style.cssText = 'width:8px;height:8px;border-radius:4px;background:var(--brand-gray);display:inline-block;';
  }
  span.appendChild(dot);
  span.appendChild(document.createTextNode(live ? 'Rec' : 'Idle'));
  return span;
}

export function waveform({ bars = 14, height = 16 } = {}) {
  const wrap = document.createElement('span');
  wrap.style.cssText = `display:inline-flex;align-items:center;gap:2px;height:${height}px;`;
  for (let i = 0; i < bars; i++) {
    const bar = document.createElement('span');
    bar.className = 'recall-wave-bar';
    bar.style.cssText = `height:100%;background:var(--brand-record-red);animation-delay:${(i * 0.08) % 0.9}s;animation-duration:${0.7 + (i % 4) * 0.1}s;`;
    wrap.appendChild(bar);
  }
  return wrap;
}

const AVATAR_TONES = {
  neutral: ['#e9edf6', '#3a4066'],
  coral: ['#ffe8f4', '#b02570'],
  sage: ['#e5fff2', '#067a46'],
  sky: ['#d1eaff', '#0264ac'],
  sand: ['#fff8e5', '#8a5e00'],
  plum: ['#f2ebff', '#6534cc'],
  forest: ['#d3f2e3', '#0a6b44'],
};

export function avatar(name = 'AB', { size = 28, tone = 'neutral' } = {}) {
  const [bg, fg] = AVATAR_TONES[tone] || AVATAR_TONES.neutral;
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const span = document.createElement('span');
  span.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:${fg};font-size:${size * 0.4}px;font-weight:600;flex-shrink:0;letter-spacing:0.02em;font-family:var(--brand-font);`;
  span.textContent = initials;
  return span;
}

const CHIP_TONES = {
  neutral: { bg: 'var(--paper-2, #f4f6fb)', fg: 'var(--brand-slate)' },
  accent: { bg: 'var(--brand-tint-blue)', fg: '#024a82' },
  green: { bg: 'var(--brand-tint-green)', fg: '#068a4f' },
  amber: { bg: 'var(--brand-tint-yellow)', fg: '#a36d00' },
  blue: { bg: 'var(--brand-tint-blue)', fg: '#0273c4' },
  ink: { bg: 'var(--brand-ink-navy)', fg: '#fff' },
};

export function chip(text, { tone = 'neutral', size = 'sm' } = {}) {
  const t = CHIP_TONES[tone] || CHIP_TONES.neutral;
  const sizes = { xs: { f: 10, py: 1, px: 6 }, sm: { f: 11, py: 2, px: 7 }, md: { f: 12, py: 3, px: 9 } };
  const sz = sizes[size] || sizes.sm;
  const span = document.createElement('span');
  span.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:${sz.py}px ${sz.px}px;font-size:${sz.f}px;font-weight:500;border-radius:999px;background:${t.bg};color:${t.fg};white-space:nowrap;font-family:var(--brand-font);`;
  span.textContent = text;
  return span;
}

export function kbd(text) {
  const span = document.createElement('span');
  span.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;font-size:10px;font-family:var(--brand-font-mono);color:var(--brand-gray);background:#fff;border:1px solid #dfe3ee;border-radius:4px;';
  span.textContent = text;
  return span;
}
