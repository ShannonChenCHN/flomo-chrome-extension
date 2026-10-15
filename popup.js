/**
 * flomo 笔记清空扩展 - Popup Script
 *
 * 负责：
 * 1. 检测当前页面是否为 flomo
 * 2. 向 content.js 发送命令（scan / startDelete / pause / stop）
 * 3. 接收 content.js 的进度消息并更新 UI
 * 4. 确认文字输入控制删除按钮
 */
document.addEventListener('DOMContentLoaded', init);

let currentTab = null;
let scannedCount = 0;

async function init() {
  // 获取当前标签页
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0];

  if (!currentTab || !currentTab.url) {
    setStatus('无法获取当前页面信息', 'error');
    return;
  }

  // 检查是否在 flomo 页面
  if (!currentTab.url.includes('flomoapp.com')) {
    setStatus('请在 flomo 网页版 (v.flomoapp.com) 打开此扩展', 'error');
    return;
  }

  // 尝试与 content script 通信
  try {
    const res = await chrome.tabs.sendMessage(currentTab.id, { command: 'checkPage' });
    if (res && res.isFlomo) {
      setStatus('flomo 网页版已连接，当前已加载 ' + res.noteCount + ' 条笔记', 'success');
      show('scan-section');
      show('delete-section');
    } else {
      setStatus('页面识别失败，请刷新后重试', 'error');
      return;
    }
  } catch (_) {
    setStatus('扩展未注入，请刷新 flomo 页面后重试', 'error');
    return;
  }

  // 恢复上次运行状态（popup 因失焦关闭后重新打开时）
  // 优先取 content script 的内存实时状态，失败则回退到 chrome.storage.local
  let liveStatus = null;
  try {
    liveStatus = await chrome.tabs.sendMessage(currentTab.id, { command: 'getStatus' });
  } catch (_) { /* content script 可能未就绪，回退到 storage */ }

  let storedStatus = null;
  try {
    const got = await chrome.storage.local.get('flomoCleaner');
    storedStatus = got && got.flomoCleaner ? got.flomoCleaner : null;
  } catch (_) { /* storage 读取失败 */ }

  restoreState(storedStatus, liveStatus);

  // 绑定事件
  $('scan-btn').addEventListener('click', handleScan);
  $('confirm-input').addEventListener('input', handleConfirmInput);
  $('delete-btn').addEventListener('click', handleDelete);
  $('pause-btn').addEventListener('click', handlePause);
  $('stop-btn').addEventListener('click', handleStop);

  // 监听 content script 消息
  chrome.runtime.onMessage.addListener(handleMessage);
}

/**
 * 根据持久化/实时状态恢复 popup UI。
 * 实时状态（content script 内存）优先级高于 storage：
 *   - 若 content script 仍在运行（deleting/scanning），以实时状态为准；
 *   - 否则用 storage 里保存的最近一次结果展示。
 */
function restoreState(stored, live) {
  const merged = Object.assign({}, stored || {}, live || {});
  const { scanning, deleting, paused, deletedCount, failedCount } = merged;

  // 同步模块级扫描总数，供 updateProgress 计算百分比
  scannedCount = merged.scannedCount || 0;

  // 1. 恢复扫描结果
  if (scannedCount > 0) {
    $('scan-result').textContent =
      (scanning ? '扫描中... 已扫描 ' : '扫描完成: 共 ') + scannedCount + ' 条笔记';
    $('scan-btn').textContent = '重新扫描';
  }
  if (scanning) {
    $('scan-btn').disabled = true;
    $('scan-btn').textContent = '扫描中...';
  }

  // 2. 恢复删除进度
  const hasDeletion = deleting || (deletedCount && deletedCount > 0);
  if (hasDeletion) {
    show('progress-section');
    if (deleting) {
      // 删除进行中：禁用删除按钮和确认输入，启用暂停/停止
      $('delete-btn').disabled = true;
      $('confirm-input').disabled = true;
      $('pause-btn').disabled = false;
      $('stop-btn').disabled = false;
      $('pause-btn').textContent = paused ? '继续' : '暂停';
      updateProgress(deletedCount || 0, failedCount || 0);
    } else {
      // 上一次删除已结束（完成/停止）：展示最终结果，按钮置灰
      $('progress-text').textContent =
        '完成: 删除 ' + (deletedCount || 0) + ' 条, 失败 ' + (failedCount || 0) + ' 条';
      $('progress-fill').style.width = '100%';
      $('pause-btn').disabled = true;
      $('stop-btn').disabled = true;
    }
  }
}

// ==================== UI 工具 ====================

function $(id) { return document.getElementById(id); }

function setStatus(text, type) {
  const el = $('status-text');
  el.textContent = text;
  el.className = type || 'info';
}

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

function addLog(message, type) {
  const logEl = $('log');
  const entry = document.createElement('div');
  entry.className = 'log-entry log-' + (type || 'info');
  entry.textContent = '[' + new Date().toLocaleTimeString('zh-CN') + '] ' + message;
  logEl.insertBefore(entry, logEl.firstChild);
  while (logEl.children.length > 30) logEl.removeChild(logEl.lastChild);
}

function updateProgress(deleted, failed) {
  $('progress-text').textContent =
    '已删除: ' + deleted + ' 条 | 失败: ' + failed + ' 条';
  // 如果有扫描总数，显示百分比进度条
  if (scannedCount > 0) {
    const pct = Math.min(100, Math.round((deleted + failed) / scannedCount * 100));
    $('progress-fill').style.width = pct + '%';
  } else {
    // 无扫描总数时显示动态进度条
    const pct = Math.min(95, deleted * 2);
    $('progress-fill').style.width = pct + '%';
  }
}

// ==================== 事件处理 ====================

function handleScan() {
  chrome.tabs.sendMessage(currentTab.id, { command: 'scan' });
  $('scan-btn').disabled = true;
  $('scan-btn').textContent = '扫描中...';
  $('scan-result').textContent = '';
}

function handleConfirmInput(e) {
  const value = e.target.value.trim();
  $('delete-btn').disabled = value !== 'DELETE ALL FLOMO NOTES';
}

async function handleDelete() {
  show('progress-section');
  $('delete-btn').disabled = true;
  $('confirm-input').disabled = true;
  await chrome.tabs.sendMessage(currentTab.id, { command: 'startDelete' });
}

function handlePause() {
  const btn = $('pause-btn');
  if (btn.textContent === '暂停') {
    chrome.tabs.sendMessage(currentTab.id, { command: 'pause' });
    btn.textContent = '继续';
  } else {
    chrome.tabs.sendMessage(currentTab.id, { command: 'resume' });
    btn.textContent = '暂停';
  }
}

function handleStop() {
  chrome.tabs.sendMessage(currentTab.id, { command: 'stop' });
}

// ==================== 消息处理 ====================

function handleMessage(msg, _sender, _sendResponse) {
  switch (msg.type) {
    case 'scanProgress':
      $('scan-result').textContent = '已扫描 ' + msg.count + ' 条笔记...';
      break;

    case 'scanComplete':
      scannedCount = msg.count;
      $('scan-result').textContent = '扫描完成: 共 ' + msg.count + ' 条笔记';
      $('scan-btn').disabled = false;
      $('scan-btn').textContent = '重新扫描';
      break;

    case 'deleting':
      $('progress-text').textContent = '正在删除...';
      break;

    case 'progress':
      updateProgress(msg.deleted, msg.failed);
      break;

    case 'complete':
      $('progress-text').textContent =
        '完成: 删除 ' + msg.deleted + ' 条, 失败 ' + msg.failed + ' 条';
      $('progress-fill').style.width = '100%';
      $('pause-btn').disabled = true;
      $('stop-btn').disabled = true;
      break;

    case 'error':
      addLog(msg.message, 'error');
      break;

    case 'log':
      addLog(msg.entry.message, msg.entry.type);
      break;
  }
}
