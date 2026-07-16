'use strict';

// 每个 session 一个广播器：把上游 `webContents.send(channel, payload)` 转成对该会话
// 所有 SSE 连接的推送。fake webContents 满足 taskService.subscribe 需要的最小成员集
// （isDestroyed / send / once('destroyed')）。
function createSessionBroadcaster() {
  const sseClients = new Set(); // Express res 对象集合

  function broadcast(channel, payload) {
    const frame = `event: ${channel}\ndata: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  // 供上游当作 event.sender / webContents 使用的桩。生命周期与 session 绑定，
  // 永不"destroyed"（单个 SSE 连接断开不代表会话结束）。
  const webContents = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => broadcast(channel, payload),
    once: () => {},
    on: () => {},
    removeListener: () => {},
  };

  return {
    sseClients,
    webContents,
    broadcast,
    addClient(res) {
      sseClients.add(res);
    },
    removeClient(res) {
      sseClients.delete(res);
    },
    hasClients() {
      return sseClients.size > 0;
    },
  };
}

module.exports = { createSessionBroadcaster };
