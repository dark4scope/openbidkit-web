'use strict';

// AI 配置的服务端强制内置 + 出入口脱敏。
// - 每次会话构建都把 AI 供应商/模型/密钥/MinerU token 强制写成平台内置值（newapi 免费池），
//   用户无需也无法改动；改模型/换 token 只需改 env 重启即可对所有账号（含已存在的）立即生效。
// - config:load 出口把所有 api_key / mineru_token 换成掩码，不把真实 key 发给浏览器。
// - config:save 入口把掩码值还原成已存的真实值（用户没改 key 时保持不变）。

const AI_BASE_URL = process.env.YIBIAO_AI_BASE_URL || 'https://newapi.darkscope.cn/v1';
const AI_API_KEY = process.env.YIBIAO_AI_API_KEY || '';
const TEXT_MODEL = process.env.YIBIAO_TEXT_MODEL || 'gpt-5.5';
const IMAGE_MODEL = process.env.YIBIAO_IMAGE_MODEL || 'gpt-image-2';
const MINERU_TOKEN = process.env.YIBIAO_MINERU_TOKEN || '';
const TEXT_CONCURRENCY = Number(process.env.YIBIAO_TEXT_CONCURRENCY || 3);
const IMAGE_CONCURRENCY = Number(process.env.YIBIAO_IMAGE_CONCURRENCY || 2);

const MASK = '__YB_MASKED__';

function clone(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

// 每次会话构建都强制写入 newapi 内置配置（模型/密钥/MinerU 由平台统一管理）。
function seedConfig(configStore) {
  if (!AI_API_KEY) return; // 未通过 env 提供 key，则不强制，交给用户在设置页自填
  const cur = configStore.load();

  const textProfile = {
    api_key: AI_API_KEY,
    base_url: AI_BASE_URL,
    model_name: TEXT_MODEL,
    context_length_limit: 400000,
    concurrency_limit: TEXT_CONCURRENCY,
    request_mode: 'stream',
  };
  const imageProfile = {
    provider: 'custom',
    api_key: AI_API_KEY,
    base_url: AI_BASE_URL,
    model_name: IMAGE_MODEL,
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: IMAGE_CONCURRENCY,
    status: 'untested',
    tested_at: '',
    last_error: '',
  };

  const next = {
    ...cur,
    text_model_provider: 'custom',
    // 顶层扁平字段必须一并写：provider=custom 时 normalizeConfig 会用这些扁平字段重建 custom profile，
    // 只写嵌套 profile 会被空的顶层字段覆盖回默认 gpt-3.5-turbo。
    api_key: AI_API_KEY,
    base_url: AI_BASE_URL,
    model_name: TEXT_MODEL,
    context_length_limit: 400000,
    concurrency_limit: TEXT_CONCURRENCY,
    request_mode: 'stream',
    text_model_profiles: { ...cur.text_model_profiles, custom: textProfile },
    image_model: imageProfile,
    image_model_profiles: { ...cur.image_model_profiles, custom: imageProfile },
    // 文件解析器：内置 MinerU token（云端解析可选），默认仍走本地解析。
    components: {
      ...(cur.components || {}),
      file_parser: {
        ...((cur.components && cur.components.file_parser) || {}),
        provider: (cur.components && cur.components.file_parser && cur.components.file_parser.provider) || 'local',
        mineru_token: MINERU_TOKEN || ((cur.components && cur.components.file_parser && cur.components.file_parser.mineru_token) || ''),
      },
    },
  };
  configStore.save(next);
}

function maskConfig(config) {
  const c = clone(config);
  if (c.api_key) c.api_key = MASK;
  for (const key of ['text_model_profiles', 'image_model_profiles']) {
    if (c[key] && typeof c[key] === 'object') {
      for (const profile of Object.values(c[key])) {
        if (profile && profile.api_key) profile.api_key = MASK;
      }
    }
  }
  if (c.image_model && c.image_model.api_key) c.image_model.api_key = MASK;
  if (c.components && c.components.file_parser && c.components.file_parser.mineru_token) {
    c.components.file_parser.mineru_token = MASK;
  }
  return c;
}

function unmaskConfig(incoming, stored) {
  const c = clone(incoming);
  const s = stored || {};
  if (c.api_key === MASK) c.api_key = s.api_key || '';
  for (const key of ['text_model_profiles', 'image_model_profiles']) {
    if (c[key] && typeof c[key] === 'object') {
      for (const [id, profile] of Object.entries(c[key])) {
        if (profile && profile.api_key === MASK) {
          profile.api_key = (s[key] && s[key][id] && s[key][id].api_key) || '';
        }
      }
    }
  }
  if (c.image_model && c.image_model.api_key === MASK) {
    c.image_model.api_key = (s.image_model && s.image_model.api_key) || '';
  }
  if (c.components && c.components.file_parser && c.components.file_parser.mineru_token === MASK) {
    c.components.file_parser.mineru_token = (s.components && s.components.file_parser && s.components.file_parser.mineru_token) || '';
  }
  return c;
}

module.exports = { seedConfig, maskConfig, unmaskConfig, MASK, AI_API_KEY };
