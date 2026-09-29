'use strict';

// Line icons as inline SVG, drawn in currentColor so every button colours its
// own icon. 24x24 grid, 2px strokes.

const Icons = (() => {
  const svg = (body, fill = false) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" ${fill
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;

  return {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
    download: svg('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
    add: svg('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
    playlists: svg('<path d="M4 6h12M4 11h12M4 16h7"/><circle cx="17" cy="17" r="3"/><path d="M20 17V6h2"/>'),
    list: svg('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
    library: svg('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    play: svg('<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>', true),
    pause: svg('<rect x="6" y="4" width="4.5" height="16" rx="1"/><rect x="13.5" y="4" width="4.5" height="16" rx="1"/>', true),
    prev: svg('<path d="M18 5.5v13a1 1 0 0 1-1.5.87L7 13.3v5.2a1 1 0 0 1-2 0v-13a1 1 0 0 1 2 0v5.2l9.5-6.07A1 1 0 0 1 18 5.5z"/>', true),
    next: svg('<path d="M6 5.5v13a1 1 0 0 0 1.5.87L17 13.3v5.2a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0v5.2L7.5 4.63A1 1 0 0 0 6 5.5z"/>', true),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    pencil: svg('<path d="M16.5 3.5l4 4L8 20H4v-4z"/><path d="M13.5 6.5l4 4"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
    star: svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z"/>'),
    starFilled: svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z"/>', true),
    volume: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
    volumeLow: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
    mute: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>'),
    chevron: svg('<path d="M9 6l6 6-6 6"/>'),
    pulse: svg('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
    more: svg('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>', true),    speaker: svg('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>'),
    back10: `<span class="skip-label">-10</span>`,
    fwd10: `<span class="skip-label">+10</span>`,
  };
})();
