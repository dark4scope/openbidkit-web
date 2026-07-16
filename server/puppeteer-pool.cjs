'use strict';

// 共享无头 chromium（puppeteer-core），供 fake-electron 的 BrowserWindow 离屏渲染 Mermaid/HTML 图表用。
// - 懒启动、全局复用一个 browser；崩溃/断连自动重启。
// - 用系统 chromium（PUPPETEER_EXECUTABLE_PATH，Dockerfile 里 apt 装），puppeteer-core 不下载浏览器。
// - file:// 加载本地 mermaid.min.js 需 --allow-file-access-from-files + --disable-web-security。

const EXEC = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

let browserPromise = null;

function launchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--disable-gpu',
    '--font-render-hinting=none',
  ];
}

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b && b.connected) return b;
    } catch {
      // 上次启动失败，落到下面重启
    }
    browserPromise = null;
  }
  if (!browserPromise) {
    const puppeteer = require('puppeteer-core');
    browserPromise = puppeteer
      .launch({ executablePath: EXEC, headless: true, args: launchArgs() })
      .then((b) => {
        b.on('disconnected', () => { browserPromise = null; });
        return b;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

module.exports = { getBrowser };
