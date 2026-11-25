// 主世界渲染注入脚本：零依赖、支持安全幂等安装与完整卸载清理。
module.exports = function installAgyDragGraft(options = {}) {
  const version = typeof options?.version === 'string' && options.version ? options.version : '0.0.0';
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
  const ROOT_URI_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/\/)([a-zA-Z](?:%3[aA]|:))?\/*$/;
  const DRAG_THRESHOLD = 8;
  const SUPPRESS_CLICK_MS = 300;
  const STALE_DRAG_MS = 15000;
  const Z_INDEX_UI = '2147483000';
  const CONVERSATION_SIDEBAR = '[data-testid="conversation-list-sidebar"]';
  const SEL = {
    CONVERSATION_ROW: '[data-testid="conversation-row-sidebar"]',
    CONVERSATION_VIEW: '[data-testid="conversation-view"]',
    CONVERSATION_SIDEBAR,
    SIDEBAR_EXCLUDED: `${CONVERSATION_SIDEBAR}, [role="navigation"]`,
    FILE_TREE_SIDEBAR: '[data-testid="tab-file-tree-sidebar"]',
    FILE_TREE_ICON: '[data-testid="file-tree-node-icon"]',
    INPUT_BOX: '[data-testid="agent-input-box"]',
    LEXICAL_EDITOR: '[contenteditable="true"][data-lexical-editor="true"]',
    AUX_PANE: '[data-aux-pane-open]',
    AUX_MARKER: '[data-testid="subagent-tab-conversation"][data-cascade-id], [data-testid="side-question-conversation"][data-cascade-id]',
  };
  const DUPLICATE_LABELS = { conversation: '', directory: '文件夹', file: '文件' };
  const HOVER_INPUT_ATTR = 'data-agy-drag-graft-hover-input';
  const FILE_DRAG_ACTIVE_ATTR = 'data-agy-drag-graft-file-drag';
  const SPLIT_SUPPRESS_CSS = [
    'html[data-agy-drag-graft-hover-input="true"] body > div.fixed.pointer-events-none.bg-primary.opacity-15.z-\\[5000\\] { opacity: 0 !important; visibility: hidden !important; animation: none !important; transition: none !important; }',
    'html[data-agy-drag-graft-file-drag="true"], html[data-agy-drag-graft-file-drag="true"] * { user-select: none !important; -webkit-user-select: none !important; }',
  ].join('\n');

  let disposed = false;
  let drag = null;
  const activeHighlights = new Map();
  let styleEl = null;
  let ghostEl = null;
  let suppressClickUntil = 0;
  let lastSuppressedSourceEl = null;
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
        `z-index:${Z_INDEX_UI}`, 'padding:8px 14px', 'border-radius:8px', 'font-size:12.5px',
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

  const encodePathSegments = (pathStr) => pathStr
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');

  const trimTrailingSlash = (uri) => {
    if (!uri) return uri;
    const rootMatch = ROOT_URI_RE.exec(uri);
    if (rootMatch) return rootMatch[2] ? `${rootMatch[1]}${rootMatch[2]}/` : rootMatch[1];
    return uri.replace(/\/+$/, '') || '/';
  };

  const normalizeLocalUri = (raw) => {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    if (/^(?:https?|data|blob|javascript|mailto):/i.test(s)) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
      return trimTrailingSlash(s);
    }
    const winMatch = /^([a-zA-Z]:)[\\/](.*)$/.exec(s);
    if (winMatch) {
      const drive = winMatch[1];
      const rest = winMatch[2].replace(/\\/g, '/').replace(/\/+$/, '');
      const encodedRest = rest ? encodePathSegments(rest) : '';
      return encodedRest ? `file:///${drive}/${encodedRest}` : `file:///${drive}/`;
    }
    if (s.startsWith('/')) {
      const clean = s.replace(/\/+$/, '') || '/';
      return clean === '/' ? 'file:///' : `file://${encodePathSegments(clean)}`;
    }
    return null;
  };

  const normalizeUriForCompare = (raw) => {
    const uri = normalizeLocalUri(raw);
    if (!uri) return '';
    if (uri.startsWith('file:///')) {
      const rest = uri.slice(8).replace(/^([a-zA-Z])(?:%3a|%3A|:)/, (_, d) => `${d.toLowerCase()}:`);
      return `file:///${rest}`;
    }
    return uri;
  };

  const basenameFromUri = (uri) => {
    if (typeof uri !== 'string' || !uri) return '';
    const noFrag = uri.split('#', 1)[0].split('?', 1)[0];
    const clean = trimTrailingSlash(noFrag);
    const parts = clean.split('/');
    const last = parts[parts.length - 1] || '';
    if (!last) return '';
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  };

  const getReactFiber = (el) => {
    if (!el || typeof el !== 'object') return null;
    try {
      const fk = Object.getOwnPropertyNames(el).find((k) => k.startsWith('__reactFiber$'));
      return fk ? el[fk] : null;
    } catch {
      return null;
    }
  };

  const getStartFiber = (target) => getReactFiber(target) || getReactFiber(target?.parentElement);

  const walkAncestorFibers = (startFiber, visitor, maxDepth = 25) => {
    let f = startFiber;
    for (let i = 0; f && i < maxDepth; f = f.return, i += 1) {
      const res = visitor(f);
      if (res !== undefined) return res;
    }
    return undefined;
  };

  const findSingleDirectoryIconFiber = (fiber, maxDepth = 8, maxVisits = 40) => {
    if (!fiber) return { fiber: null, ambiguous: false };
    const queue = [{ node: fiber.child, depth: 1 }];
    let head = 0;
    let visits = 0;
    let firstMatch = null;
    let firstKey = '';
    while (head < queue.length && visits < maxVisits) {
      const { node, depth } = queue[head++];
      if (!node) continue;
      visits += 1;
      const props = node.memoizedProps;
      if (typeof props?.uri === 'string' && typeof props?.isDirectory === 'boolean') {
        const key = normalizeUriForCompare(props.uri) || props.uri;
        if (!firstMatch) {
          firstMatch = node;
          firstKey = key;
        } else if (key !== firstKey) {
          return { fiber: null, ambiguous: true };
        }
      }
      if (depth < maxDepth && node.child) {
        queue.push({ node: node.child, depth: depth + 1 });
      }
      if (node.sibling) {
        queue.push({ node: node.sibling, depth });
      }
    }
    return { fiber: firstMatch, ambiguous: false };
  };

  const extractConversationMeta = (target) => {
    const row = target?.closest?.(SEL.CONVERSATION_ROW);
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
    return { kind: 'conversation', sourceEl: row, id: rawId.toLowerCase(), title, hasHostDrag: true };
  };

  const extractFileTreeMeta = (target) => {
    const item = target?.closest?.('[role="treeitem"]');
    if (!item) return null;
    if (item.closest?.(SEL.SIDEBAR_EXCLUDED)) return null;
    const inTreeSidebar = Boolean(item.closest?.(SEL.FILE_TREE_SIDEBAR));
    const hasTreeIcon = Boolean(item.querySelector?.(SEL.FILE_TREE_ICON));
    if (!inTreeSidebar && !hasTreeIcon) return null;

    const ctrl = target?.closest?.('button, input, textarea');
    if (ctrl && item.contains(ctrl)) return null;

    const meta = walkAncestorFibers(getReactFiber(item), (f) => {
      const entry = f.memoizedProps?.entry;
      if (!entry || typeof entry.uri !== 'string') return undefined;
      const uri = normalizeLocalUri(entry.uri);
      if (!uri) return null;
      const isDir = entry.fileType === 2;
      const propName = typeof f.memoizedProps?.name === 'string' ? f.memoizedProps.name.trim() : '';
      const label = propName || basenameFromUri(uri) || (item.textContent || '').trim() || uri;
      const sourceInPopover = !inTreeSidebar && !item.closest?.(SEL.AUX_PANE);
      return { kind: isDir ? 'directory' : 'file', sourceEl: item, uri, label, hasHostDrag: false, sourceInPopover };
    }, 15);
    return meta || null;
  };

  const extractArtifactRowMeta = (target) => {
    if (!target?.closest?.(`${SEL.FILE_TREE_SIDEBAR}, ${SEL.AUX_PANE}`)) return null;
    if (target?.closest?.('button, input, textarea')) return null;

    let foundBookmarkUri = null;
    let foundLabel = '';
    const meta = walkAncestorFibers(getStartFiber(target), (f) => {
      const props = f.memoizedProps;
      if (!props) return undefined;
      if (!foundBookmarkUri && typeof props.bookmarkUri === 'string') {
        foundBookmarkUri = props.bookmarkUri;
      }
      if (!foundLabel && typeof props.label === 'string' && props.label.trim()) {
        foundLabel = props.label.trim();
      }
      const snap = props.artifactSnapshot;
      if (!snap || typeof snap !== 'object') return undefined;
      if (snap.payload?.case === 'urlArtifactPayload') return null;
      const rawUri = normalizeLocalUri(foundBookmarkUri) || normalizeLocalUri(snap.artifactAbsoluteUri);
      if (!rawUri) return null;
      const sourceEl = target?.closest?.('.agy-hover-row') || target;
      const label = foundLabel || basenameFromUri(rawUri) || (sourceEl?.textContent || '').trim() || rawUri;
      return { kind: 'file', sourceEl, uri: rawUri, label, hasHostDrag: false };
    }, 25);
    return meta || null;
  };

  const extractDirectoryViewMeta = (target) => {
    const auxPane = target?.closest?.(SEL.AUX_PANE);
    if (!auxPane) return null;
    if (target?.closest?.(`${SEL.FILE_TREE_SIDEBAR}, ${SEL.CONVERSATION_SIDEBAR}, ${SEL.INPUT_BOX}`)) {
      return null;
    }
    if (target?.closest?.('button, input, textarea, a')) return null;

    const dirViewerFiber = walkAncestorFibers(
      getStartFiber(target),
      (f) => (typeof f.memoizedProps?.directoryUri === 'string' ? f : undefined),
      25,
    );
    if (!dirViewerFiber) return null;

    let rowEl = target;
    for (let depth = 0; rowEl && depth < 6 && auxPane.contains(rowEl) && rowEl !== auxPane; depth += 1, rowEl = rowEl.parentElement) {
      if (rowEl.tagName !== 'DIV') continue;
      const rowFiber = getReactFiber(rowEl);
      if (!rowFiber) continue;
      // 命中目录视图容器边界即止，避免从空白区域或表头向下扫到子条目。
      if (rowFiber === dirViewerFiber || typeof rowFiber.memoizedProps?.directoryUri === 'string') {
        break;
      }
      const { fiber: iconFiber, ambiguous } = findSingleDirectoryIconFiber(rowFiber);
      if (ambiguous) return null;
      if (iconFiber) {
        const iconProps = iconFiber.memoizedProps;
        const uri = normalizeLocalUri(iconProps.uri);
        if (!uri) return null;
        const label = basenameFromUri(uri) || (rowEl.textContent || '').trim() || uri;
        return {
          kind: iconProps.isDirectory ? 'directory' : 'file',
          sourceEl: rowEl,
          uri,
          label,
          hasHostDrag: false,
        };
      }
    }
    return null;
  };

  const extractDragMeta = (target) => (
    extractConversationMeta(target)
    || extractFileTreeMeta(target)
    || extractArtifactRowMeta(target)
    || extractDirectoryViewMeta(target)
  );

  const resolveAuxPaneCascadeId = (box, auxPane) => {
    // 沿输入框向辅助侧栏边界逐层查找同级分支里的唯一会话标记。
    for (let scope = box?.parentElement; scope && scope !== document.body && scope !== document.documentElement; scope = scope.parentElement) {
      const candidates = Array.from(scope.querySelectorAll?.(SEL.AUX_MARKER) || []).filter((el) => {
        if (!visible(el)) return false;
        const innerBoxes = Array.from(el.querySelectorAll?.(SEL.INPUT_BOX) || []).filter(visible);
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
    const view = box?.closest?.(SEL.CONVERSATION_VIEW);
    const fromView = view?.getAttribute?.('data-cascade-id');
    if (UUID_RE.test(fromView || '')) return fromView.toLowerCase();

    const auxPane = box?.closest?.(SEL.AUX_PANE);
    if (auxPane) {
      const fromAux = resolveAuxPaneCascadeId(box, auxPane);
      if (fromAux) return fromAux;
    }

    const fromFiber = walkAncestorFibers(getReactFiber(box), (f) => {
      const cid = f.memoizedProps?.cascadeId || f.memoizedProps?.conversationId;
      return typeof cid === 'string' && UUID_RE.test(cid) ? cid.toLowerCase() : undefined;
    }, 35);
    if (fromFiber) return fromFiber;

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
    if (hits.some((el) => el?.closest?.(SEL.SIDEBAR_EXCLUDED))) {
      return null;
    }
    for (const el of hits) {
      const direct = el?.closest?.(SEL.INPUT_BOX);
      if (direct && visible(direct)) return direct;
    }
    return null;
  };

  const findVisibleInputBoxes = () => {
    const root = document.body || document.documentElement;
    const list = Array.from(root?.querySelectorAll?.(SEL.INPUT_BOX) || []);
    return list.filter((box) => (
      visible(box)
      && !box.closest?.(SEL.SIDEBAR_EXCLUDED)
    ));
  };

  const hasMentionInEditor = (lex, item) => {
    let found = false;
    const targetCompareUri = item.kind === 'conversation' ? '' : normalizeUriForCompare(item.uri);
    const walk = (node) => {
      if (!node || typeof node !== 'object' || found) return;
      if (node.type === 'contextScopeItemMention' && typeof node.data?.data === 'string') {
        try {
          const parsed = JSON.parse(node.data.data);
          if (item.kind === 'conversation') {
            if (String(parsed?.conversation?.id || '').toLowerCase() === item.id) found = true;
          } else if (normalizeUriForCompare(parsed?.[item.kind]?.absoluteUri) === targetCompareUri) {
            found = true;
          }
        } catch {}
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    const json = typeof lex.getEditorState === 'function' ? lex.getEditorState()?.toJSON?.() : null;
    walk(json?.root);
    return found;
  };

  const buildMentionPayload = (item) => {
    if (item.kind === 'conversation') {
      return { data: { data: JSON.stringify({ conversation: { id: item.id, title: item.title } }) } };
    }
    return { data: { data: JSON.stringify({ [item.kind]: { absoluteUri: item.uri } }) } };
  };

  const insertMentionChip = (box, item) => {
    const editorEl = box.querySelector?.(SEL.LEXICAL_EDITOR);
    const lex = editorEl?.__lexicalEditor;
    if (!lex || typeof lex.update !== 'function') throw new Error('未找到 __lexicalEditor 实例');

    const MentionCls = lex._nodes?.get?.('contextScopeItemMention')?.klass;
    const TextCls = lex._nodes?.get?.('text')?.klass;
    const ParaCls = lex._nodes?.get?.('paragraph')?.klass;
    if (!MentionCls || !TextCls || !ParaCls) throw new Error('缺少 Lexical 节点类注册');

    if (hasMentionInEditor(lex, item)) {
      const kindLabel = DUPLICATE_LABELS[item.kind] ?? '文件';
      const name = item.kind === 'conversation' ? item.title : item.label;
      toast(`草稿中已引用${kindLabel}「${name}」`);
      return { ok: true, skipped: 'duplicate' };
    }

    const payload = buildMentionPayload(item);
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
        `z-index:${Z_INDEX_UI}`, 'padding:2px 8px', 'border-radius:6px',
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

  const stripTestIdRecursive = (el) => {
    if (!el) return;
    try { el.removeAttribute?.('data-testid'); } catch {}
    for (const child of el.children || []) {
      stripTestIdRecursive(child);
    }
  };

  const findSourceIcon = (sourceEl) => {
    if (!sourceEl) return { iconHost: null, targetIcon: null };
    const iconHost = sourceEl.querySelector?.(SEL.FILE_TREE_ICON) || null;
    const targetIcon = iconHost || sourceEl.querySelector?.('img, svg') || null;
    return { iconHost, targetIcon };
  };

  const cloneSourceIcon = (sourceEl) => {
    const { iconHost, targetIcon } = findSourceIcon(sourceEl);
    if (!targetIcon || typeof targetIcon.cloneNode !== 'function') return null;
    try {
      const cloned = targetIcon.cloneNode(true);
      stripTestIdRecursive(cloned);
      if (iconHost) return cloned;
      const wrapper = document.createElement('div');
      wrapper.setAttribute('class', 'shrink-0 h-4 w-4 flex items-center justify-center');
      wrapper.appendChild(cloned);
      return wrapper;
    } catch {
      return null;
    }
  };

  const clearDragGhost = () => {
    if (ghostEl) {
      try { ghostEl.remove(); } catch {}
      ghostEl = null;
    }
    document.documentElement?.removeAttribute?.(FILE_DRAG_ACTIVE_ATTR);
  };

  const syncDragGhost = (x, y, isHoveringInput) => {
    if (disposed || !drag || !drag.moved || drag.hasHostDrag || !document.body) {
      clearDragGhost();
      return;
    }
    ensureSuppressStyle();
    document.documentElement?.setAttribute?.(FILE_DRAG_ACTIVE_ATTR, 'true');
    if (!ghostEl || !ghostEl.isConnected) {
      ghostEl = document.createElement('div');
      ghostEl.setAttribute('aria-hidden', 'true');
      ghostEl.setAttribute('data-agy-drag-graft-ui', 'drag-ghost');
      ghostEl.setAttribute('data-agy-drag-graft-kind', drag.kind);
      ghostEl.setAttribute(
        'class',
        'surface-opaque pointer-events-none inline-flex items-center gap-1.5 overflow-hidden rounded-lg border border-border bg-sidebar text-foreground shadow-lg px-2.5 py-1 text-sm',
      );
      const iconClone = cloneSourceIcon(drag.sourceEl);
      if (iconClone) ghostEl.appendChild(iconClone);
      const labelEl = document.createElement('span');
      labelEl.setAttribute('class', 'truncate min-w-0');
      labelEl.textContent = drag.label;
      ghostEl.appendChild(labelEl);
      ghostEl.style.position = 'fixed';
      ghostEl.style.left = '-9999px';
      ghostEl.style.top = '-9999px';
      ghostEl.style.width = 'fit-content';
      ghostEl.style.maxWidth = `${drag.overlayMaxWidth}px`;
      if (drag.overlayHeight) ghostEl.style.height = `${drag.overlayHeight}px`;
      ghostEl.style.zIndex = Z_INDEX_UI;
      ghostEl.style.pointerEvents = 'none';
      drag.lastGhostLeft = null;
      drag.lastGhostTop = null;
      drag.lastGhostHover = null;
      document.body.appendChild(ghostEl);
    }
    if (!drag.ghostMeasured) {
      const ghostRect = typeof ghostEl.getBoundingClientRect === 'function' ? ghostEl.getBoundingClientRect() : null;
      const actualWidth = ghostRect && ghostRect.width > 0 ? Math.min(Math.round(ghostRect.width), drag.overlayMaxWidth) : null;
      if (actualWidth != null) {
        if (drag.grabOffsetX == null || drag.grabOffsetX > actualWidth - 8) {
          drag.grabOffsetX = Math.round(actualWidth / 2);
        }
      } else if (drag.grabOffsetX == null) {
        drag.grabOffsetX = Math.round(drag.overlayMaxWidth / 2);
      }
      drag.ghostMeasured = true;
    }
    const left = Math.round(x - (drag.grabOffsetX ?? 0));
    const top = Math.round(y - (drag.grabOffsetY ?? 0));
    const hover = Boolean(isHoveringInput);
    if (drag.lastGhostLeft === left && drag.lastGhostTop === top && drag.lastGhostHover === hover) {
      return;
    }
    drag.lastGhostLeft = left;
    drag.lastGhostTop = top;
    drag.lastGhostHover = hover;
    ghostEl.style.left = `${left}px`;
    ghostEl.style.top = `${top}px`;
    ghostEl.style.borderColor = hover ? '#4c8bf5' : '';
  };

  const clearHighlights = () => {
    for (const box of Array.from(activeHighlights.keys())) {
      removeBoxHighlight(box);
    }
    document.documentElement?.removeAttribute?.(HOVER_INPUT_ATTR);
  };

  const ensureBadgeElement = (existingBadge) => {
    if (existingBadge) {
      if (!existingBadge.isConnected && document.body) {
        document.body.appendChild(existingBadge);
      }
      return existingBadge;
    }
    if (!document.body) return null;
    const badge = document.createElement('div');
    badge.setAttribute('data-agy-drag-graft-ui', 'badge');
    document.body.appendChild(badge);
    return badge;
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
    if (drag.hasHostDrag && hoveredBox && nextSet.has(hoveredBox)) {
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
        if (typeof box.getBoundingClientRect === 'function') {
          existingEntry.badgeEl = ensureBadgeElement(existingEntry.badgeEl);
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
      const badgeEl = typeof box.getBoundingClientRect === 'function' ? ensureBadgeElement(null) : null;
      applyHighlightAppearance(box, badgeEl, targetMode);
      activeHighlights.set(box, { savedStyle, badgeEl, mode: targetMode });
    }
  };

  const clearDragState = () => {
    drag = null;
    clearHighlights();
    clearDragGhost();
  };

  const withSynthesizedCancel = (fn) => {
    const prev = synthesizingCancel;
    synthesizingCancel = true;
    try {
      return fn();
    } finally {
      synthesizingCancel = prev;
    }
  };

  const dispatchSyntheticEvent = (target, EventCtor, type, init) => {
    if (!target?.dispatchEvent) return;
    const ev = typeof EventCtor === 'function'
      ? new EventCtor(type, init)
      : Object.assign(new Event(type, { bubbles: init.bubbles, cancelable: init.cancelable }), init);
    target.dispatchEvent(ev);
  };

  const dispatchEscape = (target) => {
    if (!target) return;
    withSynthesizedCancel(() => {
      dispatchSyntheticEvent(
        target,
        typeof KeyboardEvent === 'function' ? KeyboardEvent : null,
        'keydown',
        { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true },
      );
    });
  };

  const cancelHostDrag = (event) => {
    withSynthesizedCancel(() => {
      dispatchEscape(document.activeElement || document.body || window);
      dispatchSyntheticEvent(
        event.target?.isConnected ? event.target : window,
        typeof PointerEvent === 'function' ? PointerEvent : null,
        'pointercancel',
        {
          pointerId: event.pointerId ?? 1,
          pointerType: event.pointerType || 'mouse',
          clientX: event.clientX ?? 0,
          clientY: event.clientY ?? 0,
          bubbles: true,
          cancelable: true,
        },
      );
    });
  };

  const dismissPopover = (sourceEl) => {
    if (!sourceEl?.isConnected) return;
    dispatchEscape(sourceEl);
  };

  const isMatchingPointer = (e) => Boolean(
    drag && (drag.pointerId == null || e?.pointerId == null || e.pointerId === drag.pointerId),
  );

  const computeGhostMetrics = (sourceEl, clientX, clientY) => {
    const rect = typeof sourceEl?.getBoundingClientRect === 'function' ? sourceEl.getBoundingClientRect() : null;
    const rawWidth = rect && rect.width > 0 ? Math.round(rect.width) : 220;
    const overlayMaxWidth = Math.min(Math.max(rawWidth, 140), 320);
    const overlayHeight = rect && rect.height >= 20 && rect.height <= 48 ? Math.round(rect.height) : null;
    const { targetIcon: iconEl } = findSourceIcon(sourceEl);
    const iconRect = typeof iconEl?.getBoundingClientRect === 'function' ? iconEl.getBoundingClientRect() : null;
    const contentLeft = rect && rect.width > 0 && iconRect && iconRect.width > 0 && iconRect.left >= rect.left && iconRect.left < rect.right
      ? Math.max(rect.left, iconRect.left - 10)
      : rect?.left;
    const grabOffsetX = rect && rect.width > 0
      ? Math.max(0, Math.min(overlayMaxWidth, clientX - contentLeft))
      : null;
    const grabOffsetY = rect && rect.height > 0
      ? Math.max(0, Math.min(overlayHeight || rect.height, clientY - rect.top))
      : 16;
    return {
      overlayMaxWidth,
      overlayHeight,
      grabOffsetX,
      grabOffsetY,
      ghostMeasured: false,
    };
  };

  const onPointerDown = (e) => {
    if (Date.now() >= suppressClickUntil) {
      lastSuppressedSourceEl = null;
    }
    if (disposed || e.button !== 0) return;
    if (drag) {
      const samePointer = isMatchingPointer(e);
      const staleOrNewPrimary = e.isPrimary === true || (Date.now() - drag.lastActiveAt > STALE_DRAG_MS);
      if (drag.moved && !samePointer && !staleOrNewPrimary) {
        return;
      }
      clearDragState();
    }
    const meta = extractDragMeta(e.target);
    if (!meta) return;
    const nextDrag = {
      ...meta,
      pointerId: e.pointerId ?? null,
      startX: e.clientX,
      startY: e.clientY,
      lastActiveAt: Date.now(),
      moved: false,
    };
    if (!meta.hasHostDrag) {
      Object.assign(nextDrag, computeGhostMetrics(meta.sourceEl, e.clientX, e.clientY));
    }
    drag = nextDrag;
  };

  const onPointerMove = (e) => {
    if (disposed || !drag || !isMatchingPointer(e)) return;
    drag.lastActiveAt = Date.now();
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= DRAG_THRESHOLD) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    const hoveredBox = findTargetInputBox(e.clientX, e.clientY);
    syncHighlights(hoveredBox);
    syncDragGhost(e.clientX, e.clientY, Boolean(hoveredBox));
  };

  const onPointerUp = (e) => {
    if (disposed) return;
    if (drag && !isMatchingPointer(e)) return;
    const current = drag;
    const box = current?.moved ? findTargetInputBox(e.clientX, e.clientY) : null;
    clearDragState();
    if (!current || !current.moved) return;
    if (!box) {
      if (!current.hasHostDrag) {
        suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;
        lastSuppressedSourceEl = current.sourceEl || null;
      }
      return;
    }

    if (current.hasHostDrag) {
      // 抢先退出宿主分屏拖拽态，并阻断本次 pointerup 进入分屏释放处理器。
      cancelHostDrag(e);
    } else if (current.sourceInPopover) {
      dismissPopover(current.sourceEl);
    }
    e.preventDefault?.();
    e.stopImmediatePropagation?.();
    suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;
    lastSuppressedSourceEl = current.sourceEl || null;

    const sourceSummary = current.kind === 'conversation'
      ? { id: current.id, title: current.title }
      : { kind: current.kind, uri: current.uri, label: current.label };
    const targetCascadeId = resolveBoxCascadeId(box);
    if (current.kind === 'conversation' && targetCascadeId && targetCascadeId === current.id) {
      toast('这是当前对话本身，不能自引用', true);
      api.lastResult = { ok: false, reason: 'self-reference', current: sourceSummary, targetCascadeId };
      return;
    }
    try {
      const res = insertMentionChip(box, current);
      api.lastResult = { ...res, current: sourceSummary, targetCascadeId };
      console.info('[agy-drag-graft] inserted:', api.lastResult);
    } catch (err) {
      toast(`插入引用失败：${err?.message || String(err)}`, true);
      api.lastResult = { ok: false, error: String(err?.stack || err) };
      console.error('[agy-drag-graft] error:', err);
    }
  };

  const onPointerCancel = (e) => {
    if (synthesizingCancel) return;
    if (drag && !isMatchingPointer(e)) return;
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
    if (Date.now() >= suppressClickUntil) {
      lastSuppressedSourceEl = null;
      return;
    }
    const isConversationRow = Boolean(e.target?.closest?.(SEL.CONVERSATION_ROW));
    const isSuppressedSource = Boolean(
      lastSuppressedSourceEl && (e.target === lastSuppressedSourceEl || lastSuppressedSourceEl.contains?.(e.target)),
    );
    if (isConversationRow || isSuppressedSource) {
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
    lastSuppressedSourceEl = null;
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
