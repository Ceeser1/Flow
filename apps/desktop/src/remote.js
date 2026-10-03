'use strict';

// "Use a Flow Server": the client shared by the Flow apps
// (@flow/core/client/remote), with the desktop's files, requests and library (env.js).

const { createRemote } = require('@flow/core/client/remote');
const env = require('./env');

module.exports = createRemote(env);
