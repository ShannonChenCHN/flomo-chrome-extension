/**
 * flomo 笔记清空扩展 - Content Script
 *
 * 核心逻辑：
 * 1. CSS 注入：让 .menu-trigger 始终可见（绕过 hover 限制）
 * 2. 扫描：滚动 .memos 容器，收集所有 memo_id
 * 3. 删除：逐条通过 UI 菜单执行删除（不调用内部 API）
 *
 * DOM 结构（基于实际观察）：
 * - 笔记卡片：DIV.memo > .header > A.time.copy-allowed[href*="memo_id=XXX"]
 * - 笔记列表：DIV.memos-list > DIV.memo (×N)
 * - 滚动容器：DIV.memos (scrollHeight >> clientHeight)
 * - 操作菜单触发：.menu-trigger（hover 显示，CSS 强制可见后可 click）
 * - 菜单项："删除" 类名含 menu-item danger
 * - 详情弹窗：.el-dialog.is-fullscreen.memoModal
 *
 * 删除流程（用户确认）：
 * - 卡片右上角"..."→ 弹出菜单 → 点"删除"→ 直接移入回收站，无确认弹窗
 */
(function () {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    DELETE_INTERVAL: 1200,      // 每次删除之间的间隔（ms）
    MENU_WAIT: 400,             // 等待菜单出现（ms）
    DELETE_WAIT: 1200,          // 等待删除完成（ms）
    SCROLL_WAIT: 1500,          // 等待滚动加载（ms）
    MAX_CONSECUTIVE_FAILURES: 3, // 连续失败上限，超过则停止
    MAX_NO_NEW_NOTES: 5,         // 滚动后无新笔记的轮次上限
  };

  // ==================== 状态 ====================
  const state = {
    scanning: false,
    deleting: false,
    paused: false,
    stopped: false,
    deletedCount: 0,
    failedCount: 0,
    scannedIds: [],
  };

  // ==================== 工具函数 ====================
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 检查元素是否真正可见（非 display:none / visibility:hidden / opacity:0） */
  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none'
      && s.visibility !== 'hidden'
      && (s.opacity === '' || parseFloat(s.opacity) > 0);
  }

  /** 向 popup 发送状态消息（popup 可能已关闭，静默失败） */
  function send(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (_) { }
  }

  /** 日志（同时发往 popup 并保留内存副本） */
  const logs = [];
  function log(message, type) {
    type = type || 'info';
    const entry = { time: new Date().toLocaleTimeString('zh-CN'), message, type };
    logs.unshift(entry);
    if (logs.length > 100) logs.pop();
    send({ type: 'log', entry });
  }

  /**
   * 持久化运行状态到 chrome.storage.local。
   * popup 关闭后再打开时，可据此恢复扫描数/删除进度/暂停停止按钮等 UI 状态。
   * 命名空间 flomoCleaner，避免与其它扩展冲突。
   */
  function persistState() {
    try {
      chrome.storage.local.set({
        flomoCleaner: {
          scanning: state.scanning,
          deleting: state.deleting,
          paused: state.paused,
          scannedCount: state.scannedIds.length,
          deletedCount: state.deletedCount,
          failedCount: state.failedCount,
          updatedAt: Date.now(),
        }
      });
    } catch (_) { /* storage 不可用时静默 */ }
  }

  // ==================== CSS 注入 ====================
  // 让操作菜单触发器始终可见，绕过 CSS :hover 限制
  function injectStyles() {
    if (document.getElementById('flomo-cleaner-css')) return;
    const style = document.createElement('style');
    style.id = 'flomo-cleaner-css';
    style.textContent = [
      '.memo .menu-trigger,',
      '.memo .base-menu-wrapper,',
      '.el-dialog.memoModal .menu-trigger,',
      '.el-dialog.memoModal .base-menu-wrapper {',
      '  opacity: 1 !important;',
      '  visibility: visible !important;',
      '  pointer-events: auto !important;',
      '}'
    ].join('\n');
    document.head.appendChild(style);
    log('CSS 已注入，操作菜单强制可见', 'info');
  }

  // ==================== DOM 查找 ====================

  /** 获取当前 DOM 中第一条可见笔记 */
  function getFirstNote() {
    const cards = document.querySelectorAll('.memo');
    for (const card of cards) {
      const link = card.querySelector('a[href*="memo_id"]');
      if (link) {
        const m = link.href.match(/memo_id=([^&]+)/);
        if (m) return { card, id: m[1] };
      }
    }
    return null;
  }

  /** 获取当前已加载的笔记数量（去重，只从卡片头部提取） */
  function getNoteCount() {
    const ids = new Set();
    document.querySelectorAll('.memo').forEach((card) => {
      const link = card.querySelector('a[href*="memo_id"]');
      if (link) {
        const m = link.href.match(/memo_id=([^&]+)/);
        if (m) ids.add(m[1]);
      }
    });
    return ids.size;
  }

  /** 检查指定 memoId 的笔记卡片是否仍在 DOM 中（只匹配卡片头部链接，不匹配正文内部链接） */
  function noteStillExists(memoId) {
    const cards = document.querySelectorAll('.memo');
    for (const card of cards) {
      const link = card.querySelector('a[href*="memo_id"]');
      if (link) {
        const m = link.href.match(/memo_id=([^&]+)/);
        if (m && m[1] === memoId) return true;
      }
    }
    return false;
  }

  /**
   * 在整个 document 中查找当前可见的"删除"菜单项。
   * 菜单可能被 teleport 到 body 末尾，所以搜索全文档。
   * 优先级：.menu-item.danger > .menu-item 含"删除"文字 > 所有叶子元素中文字==="删除"
   */
  function findVisibleDeleteItem() {
    // 1. 优先：带 danger 类的 menu-item（删除项的特定标记）
    const dangerItems = document.querySelectorAll('.menu-item.danger, .menu-item[class*="danger"]');
    for (const it of dangerItems) {
      if (isVisible(it) && it.textContent.trim().includes('删除')) return it;
    }

    // 2. 所有可见 .menu-item 中包含"删除"的
    const items = document.querySelectorAll('.menu-item');
    for (const it of items) {
      if (isVisible(it) && it.textContent.trim().includes('删除')) return it;
    }

    // 3. 兜底：全文档搜索可见叶子元素，文字恰好是"删除"
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length === 0 && el.textContent.trim() === '删除' && isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  // ==================== 单条删除 ====================

  /**
   * 删除单条笔记。
   *
   * 流程（用户确认的正确路径）：
   * 1. 点击卡片右上角的"..."(.menu-trigger) → 弹出下拉菜单
   * 2. 在菜单中找到"删除"项并点击 → 直接移入回收站（无确认弹窗）
   * 3. 验证笔记已从 DOM 消失
   *
   * 不再打开详情弹窗(memoModal)，直接在卡片上操作。
   */
  async function deleteNote(card, memoId) {
    log('开始删除: ' + memoId);

    // 1. 找到"..."菜单触发器
    const trigger = card.querySelector('.menu-trigger');
    if (!trigger) {
      return { success: false, error: '卡片内未找到.menu-trigger' };
    }

    // 2. 点击"..."弹出菜单（尝试多种方式确保触发）
    trigger.click();
    await sleep(500);

    let deleteItem = findVisibleDeleteItem();

    // 如果没出现菜单，尝试点击 trigger 的子元素（SVG 图标等）
    if (!deleteItem) {
      const child = trigger.querySelector('svg, span, i, button, [class*="icon"]');
      if (child) {
        child.click();
        await sleep(500);
        deleteItem = findVisibleDeleteItem();
      }
    }

    // 如果还没出现，模拟 hover 后再 click
    if (!deleteItem) {
      trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(300);
      trigger.click();
      await sleep(500);
      deleteItem = findVisibleDeleteItem();
    }

    if (!deleteItem) {
      log('点击菜单后未找到删除项，menu-triggers: ' + document.querySelectorAll('.menu-trigger').length, 'error');
      return { success: false, error: '菜单未出现或未找到"删除"选项' };
    }

    // 3. 点击"删除"
    log('找到删除项，准备点击', 'info');
    deleteItem.click();
    await sleep(1200);

    // 4. 验证笔记已从 DOM 消失（只检查卡片头部链接，不检查正文内部链接）
    if (!noteStillExists(memoId)) {
      log('删除成功: ' + memoId, 'success');
      return { success: true };
    }

    // 如果笔记仍在，可能需要关闭可能弹出的弹窗
    const modal = document.querySelector('.el-dialog.memoModal');
    if (modal && isVisible(modal)) {
      const closeBtn = modal.querySelector('.el-dialog__close, .el-dialog__headerbtn');
      if (closeBtn) closeBtn.click();
      await sleep(300);
      if (!noteStillExists(memoId)) {
        log('删除成功(关闭弹窗后验证): ' + memoId, 'success');
        return { success: true };
      }
    }

    log('删除后笔记仍存在: ' + memoId, 'error');
    return { success: false, error: '点击删除后笔记仍存在' };
  }

  // ==================== 批量删除 ====================

  async function deleteAll() {
    state.deleting = true;
    state.deletedCount = 0;
    state.failedCount = 0;
    state.stopped = false;
    state.paused = false;

    const container = document.querySelector('.memos');
    let consecutiveFailures = 0;
    let noNewNotesRounds = 0;

    // 滚动回顶部，从头开始删除（避免在中间位置开始导致卡片无法加载）
    if (container) {
      container.scrollTop = 0;
      await sleep(1000);
      log('已滚动到顶部，准备开始删除', 'info');
    }

    log('开始批量删除', 'info');
    send({ type: 'deleting' });
    persistState();

    while (state.deleting && !state.stopped) {
      // 暂停
      while (state.paused && !state.stopped) await sleep(200);
      if (state.stopped) break;

      const note = getFirstNote();
      if (note) {
        consecutiveFailures = 0;
        noNewNotesRounds = 0;

        const r = await deleteNote(note.card, note.id);
        if (r.success) {
          state.deletedCount++;
        } else {
          state.failedCount++;
          consecutiveFailures++;
          if (consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
            const msg = '连续 ' + CONFIG.MAX_CONSECUTIVE_FAILURES + ' 次删除失败: ' + r.error;
            log(msg, 'error');
            send({ type: 'error', message: msg });
            break;
          }
        }

        send({ type: 'progress', deleted: state.deletedCount, failed: state.failedCount });
        persistState();
        await sleep(CONFIG.DELETE_INTERVAL);
      } else {
        // 当前 DOM 无笔记 → 滚动加载
        noNewNotesRounds++;
        if (noNewNotesRounds >= CONFIG.MAX_NO_NEW_NOTES) {
          log('没有更多笔记，删除完成', 'success');
          break;
        }
        log('向下滚动加载下一批 (' + noNewNotesRounds + '/' + CONFIG.MAX_NO_NEW_NOTES + ')');
        if (container) {
          // 向下滚动一屏，加载下一批笔记（不直接跳到底部，避免跳过中间的笔记）
          container.scrollTop += container.clientHeight;
          await sleep(CONFIG.SCROLL_WAIT);
        }
      }
    }

    state.deleting = false;
    const msg = '删除完成: 成功 ' + state.deletedCount + ' 条, 失败 ' + state.failedCount + ' 条';
    log(msg, 'info');
    send({ type: 'complete', deleted: state.deletedCount, failed: state.failedCount });
    persistState();
  }

  // ==================== 扫描 ====================

  async function scanAll() {
    state.scanning = true;
    state.stopped = false;
    state.scannedIds = [];

    const container = document.querySelector('.memos');
    if (!container) {
      send({ type: 'error', message: '未找到笔记列表容器 (.memos)' });
      state.scanning = false;
      return;
    }

    const ids = new Set();
    let prev = 0;
    let stable = 0;

    log('开始扫描', 'info');

    while (state.scanning && !state.stopped) {
      // 只从卡片头部提取 memo_id，排除笔记正文中的内部引用链接
      document.querySelectorAll('.memo').forEach((card) => {
        const link = card.querySelector('a[href*="memo_id"]');
        if (link) {
          const m = link.href.match(/memo_id=([^&]+)/);
          if (m) ids.add(m[1]);
        }
      });
      send({ type: 'scanProgress', count: ids.size });

      if (ids.size === prev) {
        stable++;
        if (stable >= CONFIG.MAX_NO_NEW_NOTES) break;
      } else {
        stable = 0;
      }
      prev = ids.size;

      container.scrollTop = container.scrollHeight;
      await sleep(CONFIG.SCROLL_WAIT);
    }

    state.scanning = false;
    state.scannedIds = Array.from(ids);
    log('扫描完成: 共 ' + state.scannedIds.length + ' 条笔记', 'success');
    send({ type: 'scanComplete', count: state.scannedIds.length });
    persistState();
  }

  // ==================== 消息监听 ====================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.command) {
      case 'checkPage':
        sendResponse({
          isFlomo: location.hostname.includes('flomoapp.com'),
          noteCount: getNoteCount(),
        });
        break;
      case 'scan':
        scanAll();
        sendResponse({ ok: true });
        break;
      case 'startDelete':
        deleteAll();
        sendResponse({ ok: true });
        break;
      case 'pause':
        state.paused = true;
        log('已暂停');
        persistState();
        sendResponse({ ok: true });
        break;
      case 'resume':
        state.paused = false;
        log('已继续');
        persistState();
        sendResponse({ ok: true });
        break;
      case 'stop':
        state.stopped = true;
        state.deleting = false;
        state.scanning = false;
        log('已停止', 'warn');
        persistState();
        sendResponse({ ok: true });
        break;
      case 'getStatus':
        sendResponse({
          scanning: state.scanning,
          deleting: state.deleting,
          paused: state.paused,
          scannedCount: state.scannedIds.length,
          deletedCount: state.deletedCount,
          failedCount: state.failedCount,
        });
        break;
    }
    return true;
  });

  // ==================== 初始化 ====================
  injectStyles();
})();
