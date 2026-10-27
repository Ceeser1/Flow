'use strict';

// How Flow names itself to the sites that ask apps to say who they are
// (LRCLIB, Discogs): "Flow Client" from the apps, "Flow Server" from a
// server (its main.js sets it at start).

let name = 'Flow Client';

module.exports = {
  agentName: () => name,
  setAgentName: (n) => {
    name = String(n);
  },
};
