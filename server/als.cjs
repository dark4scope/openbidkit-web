'use strict';

// 单一 AsyncLocalStorage，用于把"当前请求上下文"透传给上游被复用的服务代码。
// 关键用途：fake `dialog.showOpenDialog` 需要拿到本次 multipart 上传落地的文件路径，
// 而调用它的是上游 fileService（在 handler 的异步栈里），无法通过参数传递。
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

// ctx 结构：{ session, dialogFiles: string[]|null, saveTarget: string|null }
function runWithContext(ctx, fn) {
  return storage.run(ctx, fn);
}

function getContext() {
  return storage.getStore() || null;
}

module.exports = { runWithContext, getContext };
