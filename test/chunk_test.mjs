import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import worker from '../worker.js';
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

async function runAdminCleanTest() {
  const env = {
    STATS_STORAGE: new FakeKV(),
    IMG_BED_URL: 'https://fake.imgbed/upload',
    AUTH_CODE: 'secret-token',
    BOT_TOKEN: 'dummy',
    ADMIN_USERS: '1'
  };

  await env.STATS_STORAGE.put('users_list', JSON.stringify([
    { userId: 1, username: 'admin', firstSeen: '2024-01-01T00:00:00.000Z', lastSeen: '2024-01-01T00:00:00.000Z' },
    { userId: 2, username: 'alice', firstSeen: '2024-01-01T00:00:00.000Z', lastSeen: '2024-01-01T00:00:00.000Z' }
  ]));

  await env.STATS_STORAGE.put('user_stats_1', JSON.stringify({
    totalUploads: 3,
    successfulUploads: 3,
    failedUploads: 0,
    totalSize: 1024,
    fileTypes: { image: 2 },
    dailyData: { '2024-01-01': { uploads: 3, size: 1024, successful: 3, failed: 0 } },
    createdAt: '2024-01-01T00:00:00.000Z',
    uploadHistory: [{ id: '1', timestamp: '2024-01-01T00:00:00.000Z', fileName: 'a.png', fileType: 'image', fileSize: 512, url: 'https://example.com/a.png', description: 'hello' }]
  }));

  await env.STATS_STORAGE.put('user_stats_2', JSON.stringify({
    totalUploads: 2,
    successfulUploads: 2,
    failedUploads: 0,
    totalSize: 2048,
    fileTypes: { document: 2 },
    dailyData: { '2024-01-01': { uploads: 2, size: 2048, successful: 2, failed: 0 } },
    createdAt: '2024-01-01T00:00:00.000Z',
    uploadHistory: [{ id: '2', timestamp: '2024-01-01T00:00:00.000Z', fileName: 'b.pdf', fileType: 'document', fileSize: 1024, url: 'https://example.com/b.pdf', description: 'world' }]
  }));

  global.fetch = async function(url) {
    if (typeof url === 'object' && url.url) url = url.url;
    if (String(url).startsWith('https://api.telegram.org/bot')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
        text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } })
      };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };

  const response = await worker.fetch(new Request('https://example.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        chat: { id: 12345 },
        from: { id: 1, username: 'admin' },
        text: '/admin clean confirm'
      }
    })
  }), env, {});

  if (response.status !== 200) {
    throw new Error(`管理员清理命令返回异常状态: ${response.status}`);
  }

  const cleanedStats1 = await env.STATS_STORAGE.get('user_stats_1');
  const cleanedStats2 = await env.STATS_STORAGE.get('user_stats_2');
  if (cleanedStats1 !== null || cleanedStats2 !== null) {
    throw new Error('管理员清理命令未清理用户统计数据');
  }

  console.log('管理员清理命令测试通过');
}

async function main() {
  await runTest();
  await runAdminCleanTest();
}

main().catch(e => { console.error('测试出错:', e); process.exit(1); });
