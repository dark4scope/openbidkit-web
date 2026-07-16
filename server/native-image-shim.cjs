'use strict';

// Electron nativeImage 的最小同步替代（纯 JS）。
// 上游只在两处用到：
//  1) localImageRenderService.stitchPngVertically —— 仅 PNG，且只有截图高度 >8192px 才触发；
//  2) exportService WebP→PNG 兜底 —— 输入可能是 webp，pngjs 解不了时返回 isEmpty()=true，让上游走降级。
// 因此这里只需支持 PNG 的同步编解码 + 尺寸探测，其它格式标记为 empty 让上游优雅跳过。
const { PNG } = require('pngjs');

let imageSizeFn = null;
try {
  imageSizeFn = require('image-size').imageSize;
} catch {
  imageSizeFn = null;
}

class ShimImage {
  constructor({ width = 0, height = 0, rgba = null, empty = false } = {}) {
    this._width = width;
    this._height = height;
    this._rgba = rgba; // RGBA Buffer（仅 PNG 解码 / createFromBitmap 时有）
    this._empty = empty || (!rgba && (!width || !height));
  }

  isEmpty() {
    return this._empty;
  }

  getSize() {
    return { width: this._width, height: this._height };
  }

  toBitmap() {
    if (!this._rgba) throw new Error('nativeImage.toBitmap: 该图未解码为位图（仅支持 PNG）');
    return this._rgba;
  }

  toPNG() {
    if (!this._rgba) throw new Error('nativeImage.toPNG: 无位图数据可编码');
    const png = new PNG({ width: this._width, height: this._height });
    this._rgba.copy(png.data);
    return PNG.sync.write(png);
  }

  // exportService 可能调用 toJPEG / resize 等——本 shim 不实现，抛错让上游降级。
}

function createFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return new ShimImage({ empty: true });
  }
  // 先按 PNG 尝试完整解码
  try {
    const png = PNG.sync.read(buffer);
    return new ShimImage({ width: png.width, height: png.height, rgba: png.data });
  } catch {
    // 非 PNG：尽量拿尺寸（jpg/webp/gif），但没有可用位图 —— 标记 empty 触发上游降级
    if (imageSizeFn) {
      try {
        const dim = imageSizeFn(buffer);
        if (dim && dim.width && dim.height) {
          return new ShimImage({ width: dim.width, height: dim.height, rgba: null, empty: true });
        }
      } catch {
        // ignore
      }
    }
    return new ShimImage({ empty: true });
  }
}

function createFromBitmap(buffer, { width, height } = {}) {
  if (!Buffer.isBuffer(buffer) || !width || !height) {
    return new ShimImage({ empty: true });
  }
  return new ShimImage({ width, height, rgba: buffer });
}

function createEmpty() {
  return new ShimImage({ empty: true });
}

module.exports = { createFromBuffer, createFromBitmap, createEmpty };
