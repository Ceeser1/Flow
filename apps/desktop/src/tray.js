'use strict';

// Flow in the system tray (5.0). While the Mini Player is open, Flow's own
// window can be out of sight: hidden, with no button in the taskbar, only
// playing for the Mini Player. The tray icon stands for it then: a click on
// it opens Flow's window again, a right click gives Open Flow, Open Mini
// Player and Quit Flow. When it is there is main.js's to say (while Flow's
// window is hidden and the Mini Player open).
//
// Linux: the trays there (KDE, Xfce, Cinnamon, GNOME with the AppIndicator
// extension) mostly tell no click, only show the menu. A desktop without a
// tray (plain GNOME) shows nothing; Flow is then opened from the Mini Player,
// or by starting it again.

const { Tray, Menu, nativeImage } = require('electron');

/** The right click's menu. `texts`: { openFlow, openMini, quit }. */
function menuTemplate({
  texts, onOpen, onMini, onQuit,
}) {
  return [
    { label: texts.openFlow, click: () => onOpen() },
    { label: texts.openMini, click: () => onMini() },
    { type: 'separator' },
    { label: texts.quit, click: () => onQuit() },
  ];
}

/**
 * `icon`: the icon's file (or null). `texts()`: the menu's texts in the
 * language chosen, asked each time the icon appears. `onOpen`, `onMini`,
 * `onQuit`: what the click and the menu's entries do.
 */
function createTray({
  icon, texts, onOpen, onMini, onQuit,
}) {
  let tray = null;

  /** Windows takes the size it needs out of the .ico; a Linux tray is handed a small picture. */
  function picture() {
    if (!icon) return nativeImage.createEmpty();
    if (process.platform === 'win32') return icon;
    return nativeImage.createFromPath(icon).resize({ width: 32, height: 32 });
  }

  function show() {
    if (tray) return;
    try {
      tray = new Tray(picture());
      tray.setToolTip('Flow');
      tray.setContextMenu(Menu.buildFromTemplate(menuTemplate({
        texts: texts(), onOpen, onMini, onQuit,
      })));
      tray.on('click', () => onOpen());
    } catch {
      // No tray to be had: Flow is opened from the Mini Player or by starting it again.
      tray = null;
    }
  }

  function hide() {
    if (!tray) return;
    const gone = tray;
    tray = null;
    if (!gone.isDestroyed()) gone.destroy();
  }

  return {
    /** The icon there (true) or gone. */
    set(on) {
      if (on) show();
      else hide();
    },
    shown: () => !!tray,
  };
}

module.exports = { createTray, menuTemplate };
