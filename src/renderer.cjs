// 主世界渲染注入脚本：零依赖、支持安全幂等安装与完整卸载清理。
module.exports = function installAgyDragGraft(options = {}) {
  const version = typeof options?.version === 'string' && options.version ? options.version : '0.1.0';
  const existing = window.__agyDragGraft;
  if (existing && existing.installed) {
    if (existing.version === version) return existing;
    try {
      if (typeof window.__agyDragGraftDispose === 'function') window.__agyDragGraftDispose();
      else if (typeof existing.dispose === 'function') existing.dispose();
    } catch {}
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const UUID_PATH_RE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const DRAG_THRESHOLD = 8;
  const SUPPRESS_CLICK_MS = 300;
  const AUX_MARKER_SELECTOR = '[data-testid="subagent-tab-conversation"][data-cascade-id], [data-testid="side-question-conversation"][data-cascade-id]';
  const HOVER_INPUT_ATTR = 'data-agy-drag-graft-hover-input';
  const SPLIT_SUPPRESS_CSS = 'html[data-agy-drag-graft-hover-input="true"] body > div.fixed.pointer-events-none.bg-primary.opacity-15.z-\\[5000\\] { opacity: 0 !important; visibility: hidden !important; animation: none !important; transition: none !important; }';

  let disposed = false;
  let drag = null;
  const activeHighlights = new Map();
  let styleEl = null;
  let suppressClickUntil = 0;
  let synthesizingCancel = false;
  const activeToasts = new Map();

  const ensureSuppressStyle = () => {
    if (disposed) return;
    if (styleEl && styleEl.isConnected) return;
    const host = document.head || document.documentElement;
    if (!host || typeof document.createElement !== 'function') return;
    try {
      const style = document.createElement('style');
      style.setAttribute('data-agy-drag-graft-ui', 'suppress-split-style');
      style.textContent = SPLIT_SUPPRESS_CSS;
      host.appendChild(style);
      styleEl = style;
    } catch {}
  };

  const clearToasts = () => {
    for (const [el, timer] of activeToasts.entries()) {
      clearTimeout(timer);
      try { el.remove(); } catch {}
    }
    activeToasts.clear();
  };

  const toast = (msg, isError = false) => {
    if (disposed || !document.body) return;
    try {
      const el = document.createElement('div');
      el.setAttribute('role', 'status');
      el.setAttribute('data-agy-drag-graft-ui', 'toast');
      el.textContent = String(msg);
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:96px', 'transform:translateX(-50%)',
        'z-index:2147483000', 'padding:8px 14px', 'border-radius:8px', 'font-size:12.5px',
        'line-height:1.4', 'max-width:min(520px,70vw)', 'pointer-events:none', 'color:#fff',
        'box-shadow:0 8px 24px rgba(0,0,0,.25)',
        `background:${isError ? '#cf222e' : '#1f2328'}`,
      ].join(';');
      document.body.appendChild(el);
      const timer = setTimeout(() => {
        activeToasts.delete(el);
        try { el.remove(); } catch {}
      }, isError ? 3500 : 1800);
      if (typeof timer?.unref === 'function') timer.unref();
      activeToasts.set(el, timer);
    } catch {}
  };

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest?.('[hidden], [inert]')) return false;
    const rects = typeof el.getClientRects === 'function' ? el.getClientRects() : [];
    if (!rects || rects.length === 0) return false;
    try {
      if (typeof getComputedStyle === 'function' && getComputedStyle(el).visibility === 'hidden') return false;
    } catch {}
    return true;
  };

  const extractRowMeta = (target) => {
    const row = target?.closest?.('[data-testid="conversation-row-sidebar"]');
    if (!row) return null;
    // 放行行内原生按钮（如置顶/更多/删除），避免误伤带 menuitem 角色的会话行。
    const actionBtn = target?.closest?.('button');
    if (actionBtn && row.contains(actionBtn)) {
      return null;
    }
    const link = row.querySelector?.('a[href*="/c/"]');
    const rawId = row.getAttribute?.('data-cascade-id')
      || link?.getAttribute?.('href')?.match(UUID_PATH_RE)?.[1]
      || '';
    if (!UUID_RE.test(rawId)) return null;
    const ariaLink = row.querySelector?.('a[aria-label]');
    const title = (
      ariaLink?.getAttribute?.('aria-label')
      || link?.getAttribute?.('aria-label')
      || row.getAttribute?.('aria-label')
      || ''
    ).trim() || rawId;
    return { row, id: rawId.toLowerCase(), title };
  };

  const resolveAuxPaneCascadeId = (box, auxPane) => {
    // 沿输入框向辅助侧栏边界逐层查找同级分支里的唯一会话标记。
    for (let scope = box?.parentElement; scope && scope !== document.body && scope !== document.documentElement; scope = scope.parentElement) {
      const candidates = Array.from(scope.querySelectorAll?.(AUX_MARKER_SELECTOR) || []).filter((el) => {
        if (!visible(el)) return false;
        const innerBoxes = Array.from(el.querySelectorAll?.('[data-testid="agent-input-box"]') || []).filter(visible);
        return innerBoxes.length === 0 || innerBoxes.includes(box);
      });
      const ids = [...new Set(
        candidates
          .map((el) => el.getAttribute?.('data-cascade-id'))
          .filter((cid) => UUID_RE.test(cid || ''))
          .map((cid) => cid.toLowerCase()),
      )];
      if (ids.length === 1) return ids[0];
      if (ids.length > 1) return null;
      if (scope === auxPane) break;
    }
    return null;
  };

  const resolveBoxCascadeId = (box) => {
    const view = box?.closest?.('[data-testid="conversation-view"]');
    const fromView = view?.getAttribute?.('data-cascade-id');
    if (UUID_RE.test(fromView || '')) return fromView.toLowerCase();

    const auxPane = box?.closest?.('[data-aux-pane-open]');
    if (auxPane) {
      const fromAux = resolveAuxPaneCascadeId(box, auxPane);
      if (fromAux) return fromAux;
    }

    const fk = box ? Object.getOwnPropertyNames(box).find((k) => k.startsWith('__reactFiber$')) : null;
    if (fk) {
      for (let f = box[fk], i = 0; f && i < 35; f = f.return, i++) {
        const cid = f.memoizedProps?.cascadeId || f.memoizedProps?.conversationId;
        if (typeof cid === 'string' && UUID_RE.test(cid)) return cid.toLowerCase();
      }
    }

    // 辅助侧栏严禁回退主窗口 URL，避免子代理/Side Question 误借主会话 ID。
    if (!auxPane) {
      const fromUrl = location?.pathname?.match?.(UUID_PATH_RE)?.[1];
      if (UUID_RE.test(fromUrl || '')) return fromUrl.toLowerCase();
    }
    return null;
  };

  const findTargetInputBox = (x, y) => {
    if (typeof document.elementsFromPoint !== 'function') return null;
    const hits = document.elementsFromPoint(x, y) || [];
    if (hits.some((el) => el?.closest?.('[data-testid="conversation-list-sidebar"], [role="navigation"]'))) {
      return null;
    }
    for (const el of hits) {
      const direct = el?.closest?.('[data-testid="agent-input-box"]');
      if (direct && visible(direct)) return direct;
    }
    return null;
  };

  const findVisibleInputBoxes = () => {
    const root = document.body || document.documentElement;
    const list = Array.from(root?.querySelectorAll?.('[data-testid="agent-input-box"]') || []);
    return list.filter((box) => (
      visible(box)
      && !box.closest?.('[data-testid="conversation-list-sidebar"], [role="navigation"]')
    ));
  };

  const hasMentionInEditor = (lex, targetId) => {
    let found = false;
    const walk = (node) => {
      if (!node || typeof node !== 'object' || found) return;
      if (node.type === 'contextScopeItemMention' && typeof node.data?.data === 'string') {
        try {
          const parsed = JSON.parse(node.data.data);
          if (String(parsed?.conversation?.id || '').toLowerCase() === targetId) found = true;
        } catch {}
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    const json = typeof lex.getEditorState === 'function' ? lex.getEditorState()?.toJSON?.() : null;
    walk(json?.root);
    return found;
  };

  const insertConversationChip = (box, { id, title }) => {
    const editorEl = box.querySelector?.('[contenteditable="true"][data-lexical-editor="true"]');
    const lex = editorEl?.__lexicalEditor;
    if (!lex || typeof lex.update !== 'function') throw new Error('未找到 __lexicalEditor 实例');

    const MentionCls = lex._nodes?.get?.('contextScopeItemMention')?.klass;
    const TextCls = lex._nodes?.get?.('text')?.klass;
    const ParaCls = lex._nodes?.get?.('paragraph')?.klass;
    if (!MentionCls || !TextCls || !ParaCls) throw new Error('缺少 Lexical 节点类注册');

    if (hasMentionInEditor(lex, id)) {
      toast(`草稿中已引用「${title}」`);
      return { ok: true, skipped: 'duplicate' };
    }

    const payload = { data: { data: JSON.stringify({ conversation: { id, title } }) } };
    let mode = 'unknown';
    lex.update(() => {
      const mentionNode = MentionCls.importJSON(payload);
      const spaceNode = TextCls.importJSON({
        type: 'text',
        text: ' ',
        detail: 0,
        format: 0,
        mode: 'normal',
        style: '',
        version: 1,
      });
      const state = lex._pendingEditorState || lex._editorState;
      const sel = state?._selection;
      if (sel && typeof sel.insertNodes === 'function' && sel.anchor && state?._nodeMap?.has?.(sel.anchor.key)) {
        sel.insertNodes([mentionNode, spaceNode]);
        mode = 'selection.insertNodes';
      } else {
        const root = state?._nodeMap?.get?.('root');
        if (!root) throw new Error('无法读取 Lexical root 节点');
        let para = root.getLastChild?.();
        if (!para || typeof para.append !== 'function') {
          para = ParaCls.importJSON({
            type: 'paragraph',
            direction: null,
            format: '',
            indent: 0,
            textFormat: 0,
            textStyle: '',
            version: 1,
          });
          root.append(para);
        }
        para.append(mentionNode, spaceNode);
        para.selectEnd?.();
        mode = 'root.append';
      }
    });
    lex.focus?.();
    return { ok: true, mode };
  };

  const applyHighlightAppearance = (box, badge, mode) => {
    const isHover = mode === 'hover';
    box.style.outline = isHover ? '2px dashed #4c8bf5' : '2px dashed rgba(76, 139, 245, 0.55)';
    box.style.outlineOffset = '2px';
    box.style.boxShadow = isHover ? '0 0 0 4px rgba(76, 139, 245, 0.16)' : '0 0 0 3px rgba(76, 139, 245, 0.08)';
    if (badge && typeof box.getBoundingClientRect === 'function') {
      const rect = box.getBoundingClientRect();
      badge.setAttribute('data-agy-drag-graft-mode', mode);
      badge.textContent = '拖拽到此引用';
      badge.style.cssText = [
        'position:fixed',
        `left:${Math.max(8, Math.round(rect.right - 96))}px`,
        `top:${Math.max(8, Math.round(rect.top - 26))}px`,
        'z-index:2147483000', 'padding:2px 8px', 'border-radius:6px',
        'font-size:11.5px', 'font-weight:500',
        `background:${isHover ? '#4c8bf5' : 'rgba(76, 139, 245, 0.78)'}`,
        `opacity:${isHover ? '1' : '0.9'}`,
        'color:#fff', 'pointer-events:none',
        `box-shadow:${isHover ? '0 4px 12px rgba(0,0,0,.18)' : '0 2px 8px rgba(0,0,0,.12)'}`,
      ].join(';');
    }
  };

  const removeBoxHighlight = (box) => {
    const entry = activeHighlights.get(box);
    if (!entry) return;
    if (entry.savedStyle) {
      box.style.outline = entry.savedStyle.outline;
      box.style.outlineOffset = entry.savedStyle.outlineOffset;
      box.style.boxShadow = entry.savedStyle.boxShadow;
    }
    if (entry.badgeEl) {
      try { entry.badgeEl.remove(); } catch {}
    }
    activeHighlights.delete(box);
  };

  const clearHighlights = () => {
    for (const box of Array.from(activeHighlights.keys())) {
      removeBoxHighlight(box);
    }
    document.documentElement?.removeAttribute?.(HOVER_INPUT_ATTR);
  };

  const syncHighlights = (hoveredBox) => {
    if (disposed || !drag || !drag.moved) {
      clearHighlights();
      return;
    }
    const boxes = findVisibleInputBoxes();
    if (hoveredBox && visible(hoveredBox) && !boxes.includes(hoveredBox)) {
      boxes.push(hoveredBox);
    }
    const nextSet = new Set(boxes);
    for (const box of Array.from(activeHighlights.keys())) {
      if (!nextSet.has(box)) removeBoxHighlight(box);
    }
    if (hoveredBox && nextSet.has(hoveredBox)) {
      ensureSuppressStyle();
      document.documentElement?.setAttribute?.(HOVER_INPUT_ATTR, 'true');
    } else {
      document.documentElement?.removeAttribute?.(HOVER_INPUT_ATTR);
    }
    for (const box of boxes) {
      const targetMode = box === hoveredBox ? 'hover' : 'guide';
      const existingEntry = activeHighlights.get(box);
      if (existingEntry) {
        if (existingEntry.mode === targetMode && (!existingEntry.badgeEl || existingEntry.badgeEl.isConnected)) {
          continue;
        }
        if (!existingEntry.badgeEl && document.body && typeof box.getBoundingClientRect === 'function') {
          const badge = document.createElement('div');
          badge.setAttribute('data-agy-drag-graft-ui', 'badge');
          document.body.appendChild(badge);
          existingEntry.badgeEl = badge;
        } else if (existingEntry.badgeEl && !existingEntry.badgeEl.isConnected && document.body) {
          document.body.appendChild(existingEntry.badgeEl);
        }
        applyHighlightAppearance(box, existingEntry.badgeEl, targetMode);
        existingEntry.mode = targetMode;
        continue;
      }
      const savedStyle = {
        outline: box.style.outline,
        outlineOffset: box.style.outlineOffset,
        boxShadow: box.style.boxShadow,
      };
      let badgeEl = null;
      if (document.body && typeof box.getBoundingClientRect === 'function') {
        badgeEl = document.createElement('div');
        badgeEl.setAttribute('data-agy-drag-graft-ui', 'badge');
        document.body.appendChild(badgeEl);
      }
      applyHighlightAppearance(box, badgeEl, targetMode);
      activeHighlights.set(box, { savedStyle, badgeEl, mode: targetMode });
    }
  };

  const clearDragState = () => {
    drag = null;
    clearHighlights();
  };

  const cancelHostDrag = (event) => {
    synthesizingCancel = true;
    try {
      const escInit = {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      };
      const esc = typeof KeyboardEvent === 'function'
        ? new KeyboardEvent('keydown', escInit)
        : Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), escInit);
      const keyTarget = document.activeElement || document.body || window;
      keyTarget?.dispatchEvent?.(esc);

      const ptrInit = {
        pointerId: event.pointerId ?? 1,
        pointerType: event.pointerType || 'mouse',
        clientX: event.clientX ?? 0,
        clientY: event.clientY ?? 0,
        bubbles: true,
        cancelable: true,
      };
      const cancelEv = typeof PointerEvent === 'function'
        ? new PointerEvent('pointercancel', ptrInit)
        : Object.assign(new Event('pointercancel', { bubbles: true, cancelable: true }), ptrInit);
      const ptrTarget = event.target?.isConnected ? event.target : window;
      ptrTarget?.dispatchEvent?.(cancelEv);
    } finally {
      synthesizingCancel = false;
    }
  };

  const onPointerDown = (e) => {
    if (disposed || e.button !== 0) return;
    const meta = extractRowMeta(e.target);
    if (!meta) return;
    drag = { ...meta, startX: e.clientX, startY: e.clientY, moved: false };
  };

  const onPointerMove = (e) => {
    if (disposed || !drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= DRAG_THRESHOLD) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    syncHighlights(findTargetInputBox(e.clientX, e.clientY));
  };

  const onPointerUp = (e) => {
    if (disposed) return;
    const current = drag;
    const box = current?.moved ? findTargetInputBox(e.clientX, e.clientY) : null;
    clearDragState();
    if (!current || !current.moved || !box) return;

    // 抢先退出宿主分屏拖拽态，并阻断本次 pointerup 进入分屏释放处理器。
    cancelHostDrag(e);
    e.preventDefault?.();
    e.stopImmediatePropagation?.();
    suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;

    const sourceSummary = { id: current.id, title: current.title };
    const targetCascadeId = resolveBoxCascadeId(box);
    if (targetCascadeId && targetCascadeId === current.id) {
      toast('这是当前对话本身，不能自引用', true);
      api.lastResult = { ok: false, reason: 'self-reference', current: sourceSummary, targetCascadeId };
      return;
    }
    try {
      const res = insertConversationChip(box, current);
      api.lastResult = { ...res, current: sourceSummary, targetCascadeId };
      console.info('[agy-drag-graft] inserted:', api.lastResult);
    } catch (err) {
      toast(`插入引用失败：${err?.message || String(err)}`, true);
      api.lastResult = { ok: false, error: String(err?.stack || err) };
      console.error('[agy-drag-graft] error:', err);
    }
  };

  const onPointerCancel = () => {
    if (synthesizingCancel) return;
    clearDragState();
  };

  const onKeyDown = (e) => {
    if (synthesizingCancel) return;
    if (e.key === 'Escape') clearDragState();
  };

  // 仅在冒泡阶段监听 window 自身失焦，避免子元素失焦误清空拖拽态。
  const onWindowBlur = (e) => {
    if (e && e.target && e.target !== window) return;
    clearDragState();
  };

  const onClick = (e) => {
    if (Date.now() < suppressClickUntil && e.target?.closest?.('[data-testid="conversation-row-sidebar"]')) {
      e.preventDefault?.();
      e.stopPropagation?.();
    }
  };

  const listeners = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerCancel],
    ['keydown', onKeyDown],
    ['click', onClick],
  ];
  for (const [type, handler] of listeners) {
    window.addEventListener(type, handler, true);
  }
  window.addEventListener('blur', onWindowBlur, false);

  ensureSuppressStyle();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearDragState();
    clearToasts();
    if (styleEl) {
      try { styleEl.remove(); } catch {}
      styleEl = null;
    }
    document.documentElement?.removeAttribute?.(HOVER_INPUT_ATTR);
    for (const [type, handler] of listeners) {
      window.removeEventListener(type, handler, true);
    }
    window.removeEventListener('blur', onWindowBlur, false);
    if (window.__agyDragGraft === api) delete window.__agyDragGraft;
    if (window.__agyDragGraftDispose === dispose) delete window.__agyDragGraftDispose;
  };

  const api = {
    version,
    installed: true,
    lastResult: null,
    dispose,
  };
  window.__agyDragGraft = api;
  window.__agyDragGraftDispose = dispose;
  return api;
};
