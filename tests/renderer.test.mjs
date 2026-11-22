import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const installAgyDragGraft = require('../src/renderer.cjs');

class MockEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this._stopped = false;
    this._immediateStopped = false;
    this.target = null;
    this.currentTarget = null;
    Object.assign(this, init);
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
  stopImmediatePropagation() {
    this._immediateStopped = true;
    this._stopped = true;
  }
}

function splitSelectors(selector) {
  return selector.split(',').map((s) => s.trim()).filter(Boolean);
}

function matchesSingle(el, part) {
  if (!el || !el.tagName) return false;
  let rest = part.trim();
  const tagMatch = /^[a-zA-Z0-9_-]+/.exec(rest);
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  const attrRe = /\[([a-zA-Z0-9_-]+)(?:(\*?=)"([^"]*)")?\]/g;
  let m;
  while ((m = attrRe.exec(rest)) !== null) {
    const [, attr, op, expected] = m;
    const actual = el.getAttribute(attr);
    if (actual === null) return false;
    if (op === '=' && actual !== expected) return false;
    if (op === '*=' && !actual.includes(expected)) return false;
  }
  rest = rest.replace(attrRe, '').trim();
  return rest === '';
}

function matchesSelector(el, selector) {
  for (const commaPart of splitSelectors(selector)) {
    const tokens = commaPart.trim().split(/\s+/);
    if (tokens.length === 1) {
      if (matchesSingle(el, tokens[0])) return true;
    } else if (tokens.length === 2) {
      if (!matchesSingle(el, tokens[1])) continue;
      let p = el.parentElement;
      let matched = false;
      while (p) {
        if (matchesSingle(p, tokens[0])) { matched = true; break; }
        p = p.parentElement;
      }
      if (matched) return true;
    }
  }
  return false;
}

class MockElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map();
    for (const [k, v] of Object.entries(attrs)) {
      this.attrs.set(k, String(v));
    }
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.style = { outline: '', outlineOffset: '', boxShadow: '', cssText: '' };
    this.textContent = '';
    this._rect = { left: 0, top: 0, right: 200, bottom: 80, width: 200, height: 80 };
    this._listeners = new Map();
    this._ownerDoc = null;
  }

  setRect(rect) {
    this._rect = rect;
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches?.(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this._propagateConnected(node, this.isConnected);
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  remove() {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
    this._propagateConnected(this, false);
  }

  _propagateConnected(node, connected) {
    node.isConnected = connected;
    if (this._ownerDoc) node._ownerDoc = this._ownerDoc;
    for (const child of node.children || []) {
      this._propagateConnected(child, connected);
    }
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getClientRects() {
    return this._rect && this._rect.width > 0 && this._rect.height > 0 ? [this._rect] : [];
  }

  getBoundingClientRect() {
    return this._rect;
  }

  addEventListener(type, fn, capture = false) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ fn, capture: Boolean(capture) });
  }

  removeEventListener(type, fn, capture = false) {
    const list = this._listeners.get(type);
    if (!list) return;
    const next = list.filter((item) => !(item.fn === fn && item.capture === Boolean(capture)));
    this._listeners.set(type, next);
  }

  dispatchEvent(event) {
    event.target = this;
    const chain = [];
    let cur = this;
    while (cur) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    const win = this._ownerDoc?._window;
    if (win) chain.push(win);
    const topDown = [...chain].reverse();

    for (const node of topDown) {
      const list = [...(node._listeners?.get(event.type) || [])].filter((l) => l.capture);
      for (const l of list) {
        event.currentTarget = node;
        l.fn.call(node, event);
        if (event._immediateStopped) break;
      }
      if (event._stopped) return !event.defaultPrevented;
    }
    for (const node of chain) {
      if (node !== this && !event.bubbles) continue;
      const list = [...(node._listeners?.get(event.type) || [])].filter((l) => !l.capture);
      for (const l of list) {
        event.currentTarget = node;
        l.fn.call(node, event);
        if (event._immediateStopped) break;
      }
      if (event._stopped) return !event.defaultPrevented;
    }
    return !event.defaultPrevented;
  }
}

class MockWindow {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, fn, capture = false) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ fn, capture: Boolean(capture) });
  }
  removeEventListener(type, fn, capture = false) {
    const list = this._listeners.get(type);
    if (!list) return;
    this._listeners.set(type, list.filter((item) => !(item.fn === fn && item.capture === Boolean(capture))));
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    const list = [...(this._listeners.get(event.type) || [])];
    for (const l of list) {
      event.currentTarget = this;
      l.fn.call(this, event);
      if (event._immediateStopped) break;
    }
    return !event.defaultPrevented;
  }
}

function createMockLexicalEditor({ withSelection = true } = {}) {
  const paragraphNodes = [];
  let selectedCalls = 0;
  let focusCalls = 0;

  const makePara = () => {
    const para = {
      type: 'paragraph',
      children: [],
      append(...nodes) {
        for (const n of nodes) this.children.push(n);
      },
      selectEnd() {
        selectedCalls += 1;
      },
    };
    return para;
  };
  paragraphNodes.push(makePara());

  const root = {
    type: 'root',
    children: paragraphNodes,
    getLastChild() {
      return paragraphNodes[paragraphNodes.length - 1] || null;
    },
    append(para) {
      paragraphNodes.push(para);
    },
  };

  class ContextScopeItemMentionNode {
    constructor(data) {
      this.__data = data;
    }
    static importJSON(json) {
      return new ContextScopeItemMentionNode(json.data);
    }
    exportJSON() {
      return {
        trigger: '@',
        value: 'contextScopeItemMention',
        data: this.__data,
        type: 'contextScopeItemMention',
        version: 1,
      };
    }
  }

  class TextNode {
    constructor(json) {
      this.__json = json;
    }
    static importJSON(json) {
      return new TextNode(json);
    }
    exportJSON() {
      return this.__json;
    }
  }

  class ParagraphNode {
    static importJSON() {
      return makePara();
    }
  }

  const nodeMap = new Map([
    ['root', root],
    ['anchor-1', paragraphNodes[0]],
  ]);

  const selection = withSelection
    ? {
      anchor: { key: 'anchor-1' },
      insertNodes(nodes) {
        paragraphNodes[0].append(...nodes);
      },
    }
    : null;

  const state = {
    _nodeMap: nodeMap,
    _selection: selection,
    toJSON() {
      return {
        root: {
          type: 'root',
          children: paragraphNodes.map((p) => ({
            type: 'paragraph',
            children: p.children.map((c) => (typeof c.exportJSON === 'function' ? c.exportJSON() : c)),
          })),
        },
      };
    },
  };

  const lex = {
    _nodes: new Map([
      ['contextScopeItemMention', { klass: ContextScopeItemMentionNode }],
      ['text', { klass: TextNode }],
      ['paragraph', { klass: ParagraphNode }],
    ]),
    _editorState: state,
    _pendingEditorState: null,
    update(fn) {
      lex._pendingEditorState = state;
      try {
        fn();
      } finally {
        lex._pendingEditorState = null;
      }
    },
    getEditorState() {
      return state;
    },
    focus() {
      focusCalls += 1;
    },
    getStats() {
      return { focusCalls, selectedCalls };
    },
  };
  return lex;
}

function setupDomEnv({ withSelection = true, mainId = '11111111-1111-1111-1111-111111111111' } = {}) {
  const win = new MockWindow();
  const docEl = new MockElement('html');
  docEl.isConnected = true;
  const head = new MockElement('head');
  const body = new MockElement('body');
  docEl.append(head, body);

  let hitStack = [];
  const doc = {
    documentElement: docEl,
    head,
    body,
    activeElement: body,
    _window: win,
    createElement: (tag) => {
      const el = new MockElement(tag);
      el._ownerDoc = doc;
      return el;
    },
    elementsFromPoint: () => hitStack,
  };
  docEl._ownerDoc = doc;
  head._ownerDoc = doc;
  body._ownerDoc = doc;

  // 侧边栏结构
  const sidebarNav = new MockElement('div', { role: 'navigation' });
  const sidebarList = new MockElement('div', { 'data-testid': 'conversation-list-sidebar' });
  sidebarNav.append(sidebarList);

  const makeRow = (id, title) => {
    const row = new MockElement('div', {
      'data-testid': 'conversation-row-sidebar',
      'data-cascade-id': id,
    });
    const link = new MockElement('a', {
      href: `/c/${id}`,
      'aria-label': title,
    });
    const span = new MockElement('span');
    link.append(span);
    const moreBtn = new MockElement('button', { 'aria-label': 'More' });
    row.append(link, moreBtn);
    sidebarList.append(row);
    return { row, link, span, moreBtn };
  };

  // 主对话区与主输入框
  const mainView = new MockElement('section', {
    'data-testid': 'conversation-view',
    'data-cascade-id': mainId,
  });
  const transcriptArea = new MockElement('div', { 'data-testid': 'agent-response' });
  const mainBox = new MockElement('div', { 'data-testid': 'agent-input-box' });
  mainBox.setRect({ left: 300, top: 500, right: 900, bottom: 600, width: 600, height: 100 });
  const mainLex = createMockLexicalEditor({ withSelection });
  const mainEditor = new MockElement('div', {
    contenteditable: 'true',
    'data-lexical-editor': 'true',
  });
  mainEditor.__lexicalEditor = mainLex;
  mainBox.append(mainEditor);
  mainView.append(transcriptArea, mainBox);

  body.append(sidebarNav, mainView);

  globalThis.window = win;
  globalThis.document = doc;
  globalThis.Event = MockEvent;
  globalThis.KeyboardEvent = MockEvent;
  globalThis.PointerEvent = MockEvent;
  globalThis.location = { pathname: `/c/${mainId}`, origin: 'https://127.0.0.1:49707' };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });

  const teardown = () => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
    delete globalThis.KeyboardEvent;
    delete globalThis.PointerEvent;
    delete globalThis.location;
    delete globalThis.getComputedStyle;
  };

  return {
    win,
    doc,
    body,
    sidebarNav,
    sidebarList,
    mainView,
    transcriptArea,
    mainBox,
    mainEditor,
    mainLex,
    makeRow,
    setHits: (els) => { hitStack = els; },
    teardown,
  };
}

function getMentionIds(lex) {
  const json = lex.getEditorState().toJSON();
  const children = json.root.children[0].children;
  return children
    .filter((n) => n.type === 'contextScopeItemMention')
    .map((n) => JSON.parse(n.data.data).conversation);
}

test('拖拽侧边栏历史会话到输入框插入原生 chip 并取消宿主分屏', () => {
  const env = setupDomEnv({ withSelection: true });
  try {
    const hostEvents = [];
    env.win.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hostEvents.push('escape');
    }, false);
    env.win.addEventListener('pointercancel', (e) => {
      hostEvents.push(`pointercancel:${e.pointerId}`);
    }, false);
    env.win.addEventListener('pointerup', () => {
      hostEvents.push('host-pointerup');
    }, false);

    const api = installAgyDragGraft({ version: '0.1.0' });
    const targetId = '22222222-2222-2222-2222-222222222222';
    const { link, span } = env.makeRow(targetId, '历史会话示例');

    span.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 7, clientX: 100, clientY: 200, bubbles: true, cancelable: true }));
    env.setHits([env.mainEditor, env.mainBox]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 7, clientX: 400, clientY: 540, bubbles: true, cancelable: true }));

    assert.match(env.mainBox.style.outline, /dashed/);
    const badge = env.body.querySelector('[data-agy-drag-graft-ui="badge"]');
    assert.ok(badge);
    assert.equal(badge.textContent, '拖拽到此引用');
    assert.equal(env.doc.documentElement.getAttribute('data-agy-drag-graft-hover-input'), 'true');
    const suppressStyle = env.doc.head.querySelector('[data-agy-drag-graft-ui="suppress-split-style"]');
    assert.ok(suppressStyle);
    assert.ok(suppressStyle.textContent.includes('body > div.fixed.pointer-events-none.bg-primary.opacity-15.z-\\[5000\\]'));
    assert.ok(suppressStyle.textContent.includes('opacity: 0 !important'));

    // 拖离输入框进入对话正文区时应恢复宿主分屏遮罩，再拖回输入框重新压制
    env.setHits([env.transcriptArea, env.mainView]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 7, clientX: 400, clientY: 260, bubbles: true, cancelable: true }));
    assert.equal(env.doc.documentElement.getAttribute('data-agy-drag-graft-hover-input'), null);
    assert.equal(env.mainBox.style.outline, '');
    assert.equal(env.body.querySelector('[data-agy-drag-graft-ui="badge"]'), null);

    env.setHits([env.mainEditor, env.mainBox]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 7, clientX: 420, clientY: 545, bubbles: true, cancelable: true }));
    assert.equal(env.doc.documentElement.getAttribute('data-agy-drag-graft-hover-input'), 'true');
    assert.match(env.mainBox.style.outline, /dashed/);

    const up = new MockEvent('pointerup', { pointerId: 7, pointerType: 'mouse', clientX: 420, clientY: 545, bubbles: true, cancelable: true });
    span.dispatchEvent(up);

    assert.equal(up.defaultPrevented, true);
    assert.equal(up._immediateStopped, true);
    assert.ok(hostEvents.includes('escape'));
    assert.ok(hostEvents.includes('pointercancel:7'));
    assert.equal(hostEvents.includes('host-pointerup'), false);

    // 紧随其后的侧边栏误点击应被拦截
    const followClick = new MockEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(followClick);
    assert.equal(followClick.defaultPrevented, true);

    assert.equal(api.lastResult.mode, 'selection.insertNodes');
    assert.deepEqual(getMentionIds(env.mainLex), [{ id: targetId, title: '历史会话示例' }]);
    assert.equal(env.mainBox.style.outline, '');
    assert.equal(env.body.querySelector('[data-agy-drag-graft-ui="badge"]'), null);
    assert.equal(env.doc.documentElement.getAttribute('data-agy-drag-graft-hover-input'), null);
  } finally {
    globalThis.window?.__agyDragGraftDispose?.();
    env.teardown();
  }
});

test('无有效选区时回退到 root.append 并调用 selectEnd', () => {
  const env = setupDomEnv({ withSelection: false });
  try {
    const api = installAgyDragGraft();
    const targetId = '33333333-3333-3333-3333-333333333333';
    const { link } = env.makeRow(targetId, 'Fallback Session');

    link.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 50, bubbles: true, cancelable: true }));
    env.setHits([env.mainBox]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 1, clientX: 450, clientY: 520, bubbles: true, cancelable: true }));
    link.dispatchEvent(new MockEvent('pointerup', { pointerId: 1, clientX: 450, clientY: 520, bubbles: true, cancelable: true }));

    assert.equal(api.lastResult.mode, 'root.append');
    assert.equal(env.mainLex.getStats().selectedCalls, 1);
    assert.equal(env.mainLex.getStats().focusCalls, 1);
    assert.deepEqual(getMentionIds(env.mainLex), [{ id: targetId, title: 'Fallback Session' }]);
  } finally {
    globalThis.window?.__agyDragGraftDispose?.();
    env.teardown();
  }
});

test('拖到对话区非输入框区域或侧边栏内部时完全放行以保留原生分屏与排序', () => {
  const env = setupDomEnv();
  try {
    let hostPointerUps = 0;
    env.win.addEventListener('pointerup', () => { hostPointerUps += 1; }, false);
    installAgyDragGraft();

    const { link } = env.makeRow('44444444-4444-4444-4444-444444444444', 'Split Test');
    // 场景 1：落点在对话正文（非输入框）
    link.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 2, clientX: 40, clientY: 40, bubbles: true, cancelable: true }));
    env.setHits([env.transcriptArea, env.mainView]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 2, clientX: 500, clientY: 200, bubbles: true, cancelable: true }));
    const upSplit = new MockEvent('pointerup', { pointerId: 2, clientX: 500, clientY: 200, bubbles: true, cancelable: true });
    link.dispatchEvent(upSplit);

    assert.equal(upSplit.defaultPrevented, false);
    assert.equal(hostPointerUps, 1);
    assert.equal(getMentionIds(env.mainLex).length, 0);

    // 场景 2：落点仍在侧边栏内部
    link.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 3, clientX: 40, clientY: 40, bubbles: true, cancelable: true }));
    env.setHits([env.sidebarList, env.sidebarNav]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 3, clientX: 40, clientY: 160, bubbles: true, cancelable: true }));
    const upSidebar = new MockEvent('pointerup', { pointerId: 3, clientX: 40, clientY: 160, bubbles: true, cancelable: true });
    link.dispatchEvent(upSidebar);

    assert.equal(upSidebar.defaultPrevented, false);
    assert.equal(hostPointerUps, 2);
  } finally {
    globalThis.window?.__agyDragGraftDispose?.();
    env.teardown();
  }
});

test('普通点击（位移小于阈值）与点击行内次级按钮不触发拖拽拦截', () => {
  const env = setupDomEnv();
  try {
    installAgyDragGraft();
    const { link, moreBtn } = env.makeRow('55555555-5555-5555-5555-555555555555', 'Click Test');

    // 短距离点击
    link.dispatchEvent(new MockEvent('pointerdown', { button: 0, clientX: 20, clientY: 20, bubbles: true, cancelable: true }));
    env.setHits([env.mainBox]);
    env.body.dispatchEvent(new MockEvent('pointermove', { clientX: 23, clientY: 22, bubbles: true, cancelable: true }));
    const upShort = new MockEvent('pointerup', { clientX: 23, clientY: 22, bubbles: true, cancelable: true });
    link.dispatchEvent(upShort);
    assert.equal(upShort.defaultPrevented, false);
    assert.equal(getMentionIds(env.mainLex).length, 0);

    // 点击行内按钮并移动
    moreBtn.dispatchEvent(new MockEvent('pointerdown', { button: 0, clientX: 180, clientY: 20, bubbles: true, cancelable: true }));
    env.body.dispatchEvent(new MockEvent('pointermove', { clientX: 420, clientY: 540, bubbles: true, cancelable: true }));
    const upBtn = new MockEvent('pointerup', { clientX: 420, clientY: 540, bubbles: true, cancelable: true });
    moreBtn.dispatchEvent(upBtn);
    assert.equal(upBtn.defaultPrevented, false);
  } finally {
    globalThis.window?.__agyDragGraftDispose?.();
    env.teardown();
  }
});

test('拦截当前会话自引用、草稿重复引用，并支持连续拖入 3 条不同会话', () => {
  const mainId = '11111111-1111-1111-1111-111111111111';
  const env = setupDomEnv({ mainId });
  try {
    const api = installAgyDragGraft();
    const dragIntoMain = (rowLink) => {
      rowLink.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 9, clientX: 30, clientY: 30, bubbles: true, cancelable: true }));
      env.setHits([env.mainBox]);
      env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 9, clientX: 400, clientY: 520, bubbles: true, cancelable: true }));
      rowLink.dispatchEvent(new MockEvent('pointerup', { pointerId: 9, clientX: 400, clientY: 520, bubbles: true, cancelable: true }));
    };

    // 自引用
    const selfRow = env.makeRow(mainId, 'Self Chat');
    dragIntoMain(selfRow.link);
    assert.equal(api.lastResult.reason, 'self-reference');
    assert.equal(getMentionIds(env.mainLex).length, 0);

    // 连续 3 条
    const ids = [
      ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '会话一'],
      ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '会话二'],
      ['cccccccc-cccc-cccc-cccc-cccccccccccc', '会话三'],
    ];
    for (const [id, title] of ids) {
      const r = env.makeRow(id, title);
      dragIntoMain(r.link);
    }
    assert.equal(getMentionIds(env.mainLex).length, 3);

    // 重复引用
    const dupRow = env.makeRow(ids[0][0], ids[0][1]);
    dragIntoMain(dupRow.link);
    assert.equal(api.lastResult.skipped, 'duplicate');
    assert.equal(getMentionIds(env.mainLex).length, 3);
  } finally {
    globalThis.window?.__agyDragGraftDispose?.();
    env.teardown();
  }
});

test('辅助侧栏独立识别会话 ID 且不借用主窗口 URL', () => {
  const mainId = '11111111-1111-1111-1111-111111111111';
  const subId = '99999999-9999-9999-9999-999999999999';
  const env = setupDomEnv({ mainId });
  try {
    const api = installAgyDragGraft();

    const auxPane = new MockElement('div', { 'data-aux-pane-open': 'true' });
    const subTranscript = new MockElement('div', {
      'data-testid': 'subagent-tab-conversation',
      'data-cascade-id': subId,
    });
    const subBox = new MockElement('div', { 'data-testid': 'agent-input-box' });
    subBox.setRect({ left: 950, top: 500, right: 1350, bottom: 600, width: 400, height: 100 });
    const subLex = createMockLexicalEditor();
    const subEditor = new MockElement('div', {
      contenteditable: 'true',
      'data-lexical-editor': 'true',
    });
    subEditor.__lexicalEditor = subLex;
    subBox.append(subEditor);
    auxPane.append(subTranscript, subBox);
    env.body.append(auxPane);

    // 把主会话拖进子代理输入框应允许插入（不发生自引用误判）
    const mainRow = env.makeRow(mainId, 'Main Session');
    mainRow.link.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 10, clientX: 30, clientY: 30, bubbles: true, cancelable: true }));
    env.setHits([subEditor, subBox]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 10, clientX: 1100, clientY: 540, bubbles: true, cancelable: true }));
    mainRow.link.dispatchEvent(new MockEvent('pointerup', { pointerId: 10, clientX: 1100, clientY: 540, bubbles: true, cancelable: true }));

    assert.equal(api.lastResult.targetCascadeId, subId);
    assert.deepEqual(getMentionIds(subLex), [{ id: mainId, title: 'Main Session' }]);

    // 把子代理自己拖进子代理输入框应被自引用拦截
    const subRow = env.makeRow(subId, 'Subagent Self');
    subRow.link.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 11, clientX: 30, clientY: 60, bubbles: true, cancelable: true }));
    env.setHits([subEditor, subBox]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 11, clientX: 1100, clientY: 540, bubbles: true, cancelable: true }));
    subRow.link.dispatchEvent(new MockEvent('pointerup', { pointerId: 11, clientX: 1100, clientY: 540, bubbles: true, cancelable: true }));

    assert.equal(api.lastResult.reason, 'self-reference');
  } finally {
    globalThis.window?.__agyDragGraftDispose?.();
    env.teardown();
  }
});

test('支持热更新替换旧版本实例并在 dispose 时完整清除监听与高亮', () => {
  const env = setupDomEnv();
  try {
    const v1 = installAgyDragGraft({ version: '0.1.0' });
    const row = env.makeRow('77777777-7777-7777-7777-777777777777', 'Hot Upgrade');
    row.link.dispatchEvent(new MockEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    env.setHits([env.mainBox]);
    env.body.dispatchEvent(new MockEvent('pointermove', { clientX: 400, clientY: 530, bubbles: true, cancelable: true }));
    assert.ok(env.body.querySelector('[data-agy-drag-graft-ui="badge"]'));

    // 安装新版本应自动卸载旧版本并清理遗留高亮
    const v2 = installAgyDragGraft({ version: '0.2.0' });
    assert.notEqual(v1, v2);
    assert.equal(globalThis.window.__agyDragGraft.version, '0.2.0');
    assert.equal(env.mainBox.style.outline, '');
    assert.equal(env.body.querySelector('[data-agy-drag-graft-ui="badge"]'), null);

    v2.dispose();
    assert.equal(globalThis.window.__agyDragGraft, undefined);
    assert.equal(globalThis.window.__agyDragGraftDispose, undefined);
    assert.equal(env.doc.documentElement.getAttribute('data-agy-drag-graft-hover-input'), null);
    assert.equal(env.doc.head.querySelector('[data-agy-drag-graft-ui="suppress-split-style"]'), null);
  } finally {
    globalThis.window?.__agyDragGraftDispose?.();
    env.teardown();
  }
});

test('起拖时子元素触发 blur 不清空拖拽态，仅 window 自身失焦才清理', () => {
  const env = setupDomEnv();
  try {
    const api = installAgyDragGraft({ version: '0.1.0' });
    const targetId = '88888888-8888-8888-8888-888888888888';
    const { span } = env.makeRow(targetId, 'Blur Regression');

    span.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 12, clientX: 60, clientY: 140, bubbles: true, cancelable: true }));
    // 焦点从输入框离开会触发子元素 blur（经过 window 捕获阶段，不冒泡）
    env.mainEditor.dispatchEvent(new MockEvent('blur', { bubbles: false }));

    env.setHits([env.mainEditor, env.mainBox]);
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 12, clientX: 410, clientY: 530, bubbles: true, cancelable: true }));
    assert.match(env.mainBox.style.outline, /dashed/);
    assert.equal(env.body.querySelector('[data-agy-drag-graft-ui="badge"]')?.textContent, '拖拽到此引用');
    assert.equal(env.doc.documentElement.getAttribute('data-agy-drag-graft-hover-input'), 'true');

    // 松手应依然插入成功
    const up = new MockEvent('pointerup', { pointerId: 12, pointerType: 'mouse', clientX: 410, clientY: 530, bubbles: true, cancelable: true });
    span.dispatchEvent(up);
    assert.equal(up.defaultPrevented, true);
    assert.deepEqual(getMentionIds(env.mainLex), [{ id: targetId, title: 'Blur Regression' }]);
    assert.equal(api.lastResult.ok, true);
    assert.equal(env.body.querySelector('[data-agy-drag-graft-ui="badge"]'), null);
    assert.equal(env.doc.documentElement.getAttribute('data-agy-drag-graft-hover-input'), null);

    // 再次起拖后，仅当 window 自身失焦才清空拖拽态与浮标
    span.dispatchEvent(new MockEvent('pointerdown', { button: 0, pointerId: 13, clientX: 60, clientY: 140, bubbles: true, cancelable: true }));
    env.body.dispatchEvent(new MockEvent('pointermove', { pointerId: 13, clientX: 410, clientY: 530, bubbles: true, cancelable: true }));
    assert.match(env.mainBox.style.outline, /dashed/);
    assert.equal(env.body.querySelector('[data-agy-drag-graft-ui="badge"]')?.textContent, '拖拽到此引用');

    env.win.dispatchEvent(new MockEvent('blur', { bubbles: false }));
    assert.equal(env.mainBox.style.outline, '');
    assert.equal(env.body.querySelector('[data-agy-drag-graft-ui="badge"]'), null);
    assert.equal(env.doc.documentElement.getAttribute('data-agy-drag-graft-hover-input'), null);
  } finally {
    globalThis.window?.__agyDragGraftDispose?.();
    env.teardown();
  }
});
