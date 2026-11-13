// 主控：渲染编排、事件代理、编辑器输入、同步/冲突/迁移联动、SW 注册。
import { LATEST_VERSION, getFormDef } from './forms.js';
import { validateAnswers } from './engine.js';
import {
  closeModal, conflictModalHtml, esc, pendingModalHtml, showHistoryModal, toast,
} from './components.js';
import {
  createDraft, deleteDraft, editDraft, closeEditor, migrateDraft, pullFormDefs,
  refresh, resetDemo, resolveConflictWithChoices, resolvePending, saveCurrentDraft,
  server, state, store, switchDevice, syncDraft, syncOutbox,
} from './app-core.js';
import { draftsView, editorView, recordDetailView, recordsView, scenariosView } from './views.js';

let recordDetailId = null;

/* ---------------- 渲染 ---------------- */

function render() {
  refresh();
  renderTopbar();

  const app = document.getElementById('app');
  const draft = state.editingDraftId ? store().getDraft(state.editingDraftId) : null;

  if (draft) {
    app.innerHTML = editorView(draft);
    bindEditor(draft);
  } else if (state.tab === 'drafts') {
    app.innerHTML = draftsView();
  } else if (state.tab === 'records') {
    if (recordDetailId) {
      const record = safeGetRecord(recordDetailId);
      if (record) {
        app.innerHTML = recordDetailView(record);
      } else {
        recordDetailId = null;
        app.innerHTML = recordsView();
      }
    } else {
      app.innerHTML = recordsView();
    }
  } else if (state.tab === 'scenarios') {
    app.innerHTML = scenariosView();
  }

  renderOutboxBadge();
}

function safeGetRecord(sampleId) {
  try {
    return server.getRecord(sampleId);
  } catch {
    return null;
  }
}

function renderTopbar() {
  document.getElementById('net-dot').className = `net-dot ${state.online ? 'online' : 'offline'}`;
  document.getElementById('net-text').textContent = state.online ? '在线（本地服务可达）' : '离线（断网模拟中）';
  document.getElementById('net-toggle').textContent = state.online ? '断开网络' : '恢复网络';
  document.getElementById('device-select').value = state.deviceId;
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('tab-active', el.dataset.tab === state.tab);
  });
}

function renderOutboxBadge() {
  const queued = state.drafts.filter((d) => d.history?.some((h) => h.action === 'queued')).length;
  const badgeEl = document.getElementById('outbox-badge');
  badgeEl.textContent = queued;
  badgeEl.style.display = queued ? '' : 'none';
}

/* ---------------- 编辑器 ---------------- */

function readEditorForm(draft) {
  const def = getFormDef(draft.formVersion);
  const answers = { ...draft.answers };
  const form = document.getElementById('editor-form') || document;

  for (const field of def.fields) {
    if (field.type === 'checkbox') {
      answers[field.key] = [...form.querySelectorAll(`input[data-field="${CSS.escape(field.key)}"]:checked`)]
        .map((el) => el.value);
    } else if (field.type === 'radio') {
      const checked = form.querySelector(`input[data-field="${CSS.escape(field.key)}"]:checked`);
      answers[field.key] = checked ? checked.value : '';
    } else {
      const el = form.querySelector(`[data-field="${CSS.escape(field.key)}"]`);
      if (el) answers[field.key] = el.value;
    }
  }
  const sampleId = document.getElementById('sample-id-input')?.value.trim() || draft.sampleId;
  return { sampleId, answers };
}

function bindEditor(draft) {
  const form = document.getElementById('app');
  // 条件显示联动：radio/select 变化时重新渲染可见性（保留已填内容）
  form.querySelectorAll('input[type=radio], select, input[type=checkbox]').forEach((el) => {
    el.addEventListener('change', () => {
      const { sampleId, answers } = readEditorForm(draft);
      saveCurrentDraft(sampleId, answers);
    });
  });
  // 输入时即时保存（轻量，localStorage 同步写入）
  form.querySelectorAll('input[type=text], input[type=number], textarea').forEach((el) => {
    el.addEventListener('blur', () => {
      const { sampleId, answers } = readEditorForm(draft);
      saveCurrentDraft(sampleId, answers);
    });
  });
}

function handleSave(andSync = false) {
  const draft = store().getDraft(state.editingDraftId);
  if (!draft) return;
  const { sampleId, answers } = readEditorForm(draft);
  if (!sampleId) {
    toast('样本编号不能为空', 'error');
    return;
  }
  saveCurrentDraft(sampleId, answers);
  toast('草稿已保存到本机', 'ok');
  if (andSync) handleSync(draft.id);
}

/* ---------------- 同步与冲突 ---------------- */

function handleSync(draftId) {
  const result = syncDraft(draftId);
  switch (result.status) {
    case 'queued':
      toast('离线状态：已加入发件箱，恢复连接后自动同步', 'warn', 4200);
      break;
    case 'invalid':
      toast(result.message, 'error', 4500);
      break;
    case 'pending':
      toast(result.message, 'error');
      break;
    case 'create':
      toast(`同步成功：样本 ${result.record.sampleId} 已新建（rev 1）`, 'ok');
      break;
    case 'update':
      toast(`同步成功：样本 ${result.record.sampleId} 已更新到 rev ${result.record.rev}`, 'ok');
      break;
    case 'conflict':
      openConflict(result.conflict);
      break;
    default:
      toast('同步完成', 'info');
  }
}

function openConflict({ draft, remote, conflictKeys }) {
  const def = getFormDef(draft.formVersion);
  conflictModalHtml(def, draft, remote, conflictKeys, (choices) => {
    const result = resolveConflictWithChoices(draft.id, choices);
    closeModal();
    if (result.status === 'conflict') {
      toast('服务端在合并期间又被修改，请重新选择', 'warn');
      openConflict(result.conflict);
    } else {
      toast(`冲突已合并并同步：样本 ${result.record.sampleId}（rev ${result.record.rev}），另一版已保留在历史中`, 'ok', 4600);
    }
  });
}

function openPending(draftId) {
  const draft = store().getDraft(draftId);
  if (!draft) return;
  const pending = (draft.pendingAnswers || []).filter((p) => !p.status || p.status === 'pending');
  if (!pending.length) {
    toast('没有待处理的答案', 'info');
    return;
  }
  pendingModalHtml(draft, pending, (fieldKey, decision) => {
    resolvePending(draftId, fieldKey, decision);
    const still = store().getDraft(draftId);
    const left = (still?.pendingAnswers || []).filter((p) => !p.status || p.status === 'pending');
    if (left.length) {
      closeModal();
      openPending(draftId);
    } else {
      closeModal();
      toast('全部待处理答案已处理，草稿现在可以同步', 'ok');
    }
  });
}

/* ---------------- 场景辅助 ---------------- */

// 一键模拟两台设备基于同一 rev 离线分叉：各自产生本地草稿，先同步 A，再停在 B 的冲突弹窗
function seedConflictScenario() {
  const remote = server.getRecord('S-1001');
  const baseRev = remote.rev;

  // 设备 A 离线修改 cropYield 并同步（快进）
  switchDevice('A');
  const draftA = createDraft('S-1001', remote.formVersion);
  store().saveDraft({
    ...store().getDraft(draftA.id),
    baseRev,
    answers: { ...remote.answers, cropYield: 9200 },
  });
  const rA = syncDraft(draftA.id);

  // 设备 B 仍基于旧 rev 离线修改 satisfaction
  switchDevice('B');
  const draftB = createDraft('S-1001', remote.formVersion);
  store().saveDraft({
    ...store().getDraft(draftB.id),
    baseRev,
    answers: { ...remote.answers, satisfaction: '不满意' },
  });
  const rB = syncDraft(draftB.id);

  if (rA.status !== 'update' || rB.status !== 'conflict') {
    toast('场景构造异常，请先重置演示数据', 'error');
    return;
  }
  toast(`设备 A 已同步（rev ${baseRev} → ${rA.record.rev}）；设备 B 检测到冲突，请逐字段合并`, 'warn', 5200);
  openConflict(rB.conflict);
}

/* ---------------- 事件代理 ---------------- */

document.addEventListener('click', (e) => {
  // 弹窗打开期间其内部点击（如冲突合并单选框）由弹窗自身逻辑处理，不走视图动作代理。
  // 注意：jsdom 下重渲染后脱离文档的节点 closest() 不向上遍历，故以模态状态为准。
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot.classList.contains('modal-open') &&
      (modalRoot.contains(e.target) || !e.target.isConnected)) return;
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'new-draft':
      createDraft('');
      toast('已创建空白草稿，可直接离线录入', 'info');
      break;
    case 'edit-draft':
      editDraft(id);
      break;
    case 'back-list':
      closeEditor();
      break;
    case 'back-records':
      recordDetailId = null;
      render();
      break;
    case 'save-draft':
      handleSave(false);
      break;
    case 'sync-draft':
      handleSave(false);
      handleSync(id || state.editingDraftId);
      break;
    case 'sync-outbox':
      if (!state.online) {
        toast('仍处于离线状态，发件箱将在恢复连接后自动同步', 'warn');
        break;
      }
      runOutbox();
      break;
    case 'delete-draft':
      if (confirm(`确认删除草稿 ${id}？该操作仅影响本机。`)) {
        deleteDraft(id);
        toast('草稿已删除', 'info');
      }
      break;
    case 'migrate':
      migrateDraft(id);
      toast(`草稿已迁移到表单 v${LATEST_VERSION}`, 'ok');
      break;
    case 'open-pending':
      openPending(id);
      break;
    case 'draft-history': {
      const d = store().getDraft(id);
      if (d) showHistoryModal(`草稿修改记录：样本 ${d.sampleId}`, d.history);
      break;
    }
    case 'record-detail':
      recordDetailId = id;
      render();
      break;
    case 'reset-demo':
      if (confirm('重置将清空所有本地改动并恢复内置样例数据，确认继续？')) {
        recordDetailId = null;
        resetDemo();
        closeModal();
        toast('演示数据已重置', 'ok');
      }
      break;
    case 'seed-conflict':
      seedConflictScenario();
      break;
    case 'switch-b':
      switchDevice('B');
      toast('已切换到设备 B（独立本地库）', 'info');
      break;
    case 'open-seed-draft': {
      state.tab = 'drafts';
      const d = store().listDrafts().find((x) => x.sampleId === 'S-1004');
      if (d) editDraft(d.id);
      render();
      break;
    }
    case 'download-forms': {
      const r = pullFormDefs();
      toast(r.offline ? '离线：使用本机已缓存的表单定义' : `已下载 ${r.defs.length} 个版本的表单定义`, r.offline ? 'warn' : 'ok');
      break;
    }
    default:
      break;
  }
});

function runOutbox() {
  const results = syncOutbox();
  if (!results.length) {
    toast('发件箱为空', 'info');
    return;
  }
  const conflict = results.find((r) => r.status === 'conflict');
  if (conflict) {
    toast(`已同步部分草稿，样本 ${conflict.sampleId} 存在冲突，请人工合并`, 'warn', 4600);
    openConflict(conflict.conflict);
    return;
  }
  const ok = results.filter((r) => ['create', 'update'].includes(r.status)).length;
  const failed = results.filter((r) => ['invalid', 'pending'].includes(r.status));
  toast(`发件箱同步完成：成功 ${ok} 条${failed.length ? `，${failed.length} 条需修正` : ''}`, ok ? 'ok' : 'warn', 4600);
}

// Tab 切换
document.querySelectorAll('.tab').forEach((el) => {
  el.addEventListener('click', () => {
    state.tab = el.dataset.tab;
    recordDetailId = null;
    state.editingDraftId = null;
    render();
  });
});

// 设备切换
document.getElementById('device-select').addEventListener('change', (e) => {
  switchDevice(e.target.value);
  toast(`已切换到设备 ${e.target.value}（独立本地库与发件箱）`, 'info');
});

// 网络开关（持久化；恢复连接时自动同步发件箱）
document.getElementById('net-toggle').addEventListener('click', async () => {
  const { Network } = await import('./storage.js');
  const online = Network.toggle();
  render();
  if (online) {
    toast('网络已恢复，正在自动同步发件箱…', 'ok');
    setTimeout(runOutbox, 400);
  } else {
    toast('已断开网络：页面仍可使用，同步请求将被拦截', 'warn', 4200);
  }
});

// 记录搜索：输入即过滤，并保持输入焦点与光标位置
document.addEventListener('input', (e) => {
  if (e.target.id !== 'record-search') return;
  state.search = e.target.value;
  const cursor = e.target.selectionStart;
  document.getElementById('app').innerHTML = recordsView();
  const input = document.getElementById('record-search');
  if (input) {
    input.focus();
    input.setSelectionRange(cursor, cursor);
  }
});

// 其他标签页也能收到 storage 事件时重绘（备用）
window.addEventListener('app-render', render);
window.addEventListener('network-change', render);

// Service Worker：应用外壳离线缓存，断网后刷新页面仍可打开
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 文件协议或受限环境下忽略 */
    });
  });
}

// 初始化：确保设备本地有表单缓存
store().ensureForms(server);
render();
