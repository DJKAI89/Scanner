import React from 'react';

// Minimal inline SVG icon set. No icon library is a dependency of this
// project (lucide-react etc. are only preloaded in a separate sandbox, not
// this Vite build) — adding one just for a handful of icons isn't worth a
// new dependency in a production app deployed via CI. These replace the
// most-repeated emoji-as-icon usages (target/stop/next-target, check/cross,
// lock, live, clock, scale, flag, box) with a consistent thin-stroke style
// that reads as a serious tool rather than a chat app.
const PATHS = {
  target:   <><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".5" fill="currentColor"/></>,
  trendUp:   <><polyline points="4,17 10,11 14,15 20,7"/><polyline points="14,7 20,7 20,13"/></>,
  trendDown: <><polyline points="4,7 10,13 14,9 20,17"/><polyline points="14,17 20,17 20,11"/></>,
  check:    <polyline points="5,13 9,17 19,7"/>,
  cross:    <><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></>,
  lock:     <><rect x="5.5" y="11" width="13" height="9" rx="1.6"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"/></>,
  zap:      <polygon points="13,2 4,14 11,14 10,22 20,9 13,9"/>,
  clock:    <><circle cx="12" cy="12" r="8.5"/><polyline points="12,7 12,12 16,14"/></>,
  scale:    <><line x1="12" y1="4" x2="12" y2="20"/><line x1="5" y1="8" x2="19" y2="8"/><path d="M5 8l-2.5 6a2.5 2.5 0 0 0 5 0L5 8Z"/><path d="M19 8l-2.5 6a2.5 2.5 0 0 0 5 0L19 8Z"/></>,
  flag:     <><line x1="6" y1="3" x2="6" y2="21"/><path d="M6 4h11l-3 4 3 4H6"/></>,
  box:      <><path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5v-9Z"/><path d="M4 7.5 12 11l8-3.5"/><line x1="12" y1="11" x2="12" y2="20"/></>,
};

export default function Icon({ name, size = 13, strokeWidth = 2, style, className }) {
  const body = PATHS[name];
  if (!body) return null;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: '-2px', flexShrink: 0, ...style }}
      className={className}
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}

