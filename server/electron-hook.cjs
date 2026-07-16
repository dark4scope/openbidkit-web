'use strict';

// 把上游任何 `require('electron')` 重定向到 fake-electron。
// 必须在 require 任何上游 client/electron 模块之前先 require 本文件。
const Module = require('module');

const FAKE = require.resolve('./fake-electron.cjs');
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
  if (request === 'electron') return FAKE;
  return originalResolve.call(this, request, parent, isMain, options);
};

module.exports = require('./fake-electron.cjs');
