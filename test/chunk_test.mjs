import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  handleChunkUploadStart,
  mergeAndUploadChunks
} from '../worker.js';

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(key, options) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    if (options && options.type === 'arrayBuffer') {
      if (v instanceof ArrayBuffer) return v;
      if (v instanceof Uint8Array) return v.buffer;
      if (typeof v === 'string') return new TextEncoder().encode(v).buffer;
      return v;
    }
    // 返回字符串形式以模拟 Cloudflare KV
    return (typeof v === 'string') ? v : JSON.stringify(v);
  }
  async put(key, value) {
    // 如果是 ArrayBuffer 或 Uint8Array，直接保存
    if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
      this.map.set(key, value instanceof Uint8Array ? value : value);
    } else {
      // KV 存储通常接受字符串
      this.map.set(key, (typeof value === 'string') ? value : JSON.stringify(value));
    }
  }
  async delete(key) { this.map.delete(key); }
}

async function runTest() {
  const env = {
    STATS_STORAGE: new FakeKV(),
    IMG_BED_URL: 'https://fake.imgbed/upload',
    AUTH_CODE: 'secret-token',
    BOT_TOKEN: 'dummy'
  };

  const chatId = 12345;
  const userId = 67890;

  // mock global.fetch 用于拦截上传请求和 Telegram API 请求
  global.fetch = async function(url, opts) {
    const urlStr = (typeof url === 'object' && url.url) ? url.url : String(url);
    // 图床上传请求返回 text/json
    if (String(urlStr).startsWith(env.IMG_BED_URL)) {
      const body = JSON.stringify({ url: 'https://cdn.example.com/test.bin' });
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body)
      };
    }

    // Telegram API 请求（sendMessage/editMessage等）返回 json
    if (String(urlStr).startsWith('https://api.telegram.org/bot')) {
      const resp = { ok: true, result: { message_id: 1 } };
      return {
        ok: true,
        status: 200,
        json: async () => resp,
        text: async () => JSON.stringify(resp)
      };
    }

    // fallback
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };

  // 启动一个分片上传会话（3个分片）
  await handleChunkUploadStart(chatId, userId, { text: '/chunk_upload 3 test.bin' }, env);

  // 从KV读取会话
  const stateKey = `chunk_state_${userId}`;
  const stateRaw = await env.STATS_STORAGE.get(stateKey);
  const chunkState = JSON.parse(stateRaw);

  // 准备3个分片并写入KV，同时更新会话状态
  let totalSize = 0;
  for (let i = 1; i <= chunkState.totalChunks; i++) {
    const bytes = new Uint8Array([i, i+1, i+2, i+3, i+4]);
    const chunkKey = `chunk_${userId}_${i}`;
    await env.STATS_STORAGE.put(chunkKey, bytes.buffer);

    chunkState.chunks[i] = {
      key: chunkKey,
      size: bytes.byteLength,
      originalName: `chunk_${i}`,
      type: 'document'
    };

    chunkState.receivedChunks = i;
    totalSize += bytes.byteLength;
  }

  chunkState.totalSize = totalSize;
  chunkState.status = 'receiving';

  await env.STATS_STORAGE.put(stateKey, JSON.stringify(chunkState));

  // mock global.fetch 用于拦截上传请求
  global.fetch = async function(url, opts) {
    if (typeof url === 'object' && url.url) url = url.url; // handle URL obj
    if (String(url).startsWith(env.IMG_BED_URL)) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: 'https://cdn.example.com/test.bin' })
      };
    }
    // fallback
    return { ok: true, status: 200, text: async () => '{}' };
  };

  // 运行合并并上传流程
  await mergeAndUploadChunks(chatId, userId, env);

  // 检查会话状态
  const finalStateRaw = await env.STATS_STORAGE.get(stateKey);
  const finalState = finalStateRaw ? JSON.parse(finalStateRaw) : null;
  console.log('最终会话状态:', finalState);
}

runTest().catch(e => { console.error('测试出错:', e); process.exit(1); });
