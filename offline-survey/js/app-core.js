// 应用核心：状态、设备切换、同步编排（含冲突/迁移/发件箱）。
import {
  FORM_ID, LATEST_VERSION, getField, getFormDef,
} from './forms.js';
import {
  answersDiff, applyResolution, formatValue, isFieldVisible, validateAnswers,
} from './engine.js';
import {
  DeviceStore, MockLocalServer, Network, ensureSeeded, getActiveDeviceId,
  seedDemoData, setActiveDeviceId,
} from './storage.js';

ensureSeeded();

export const server = new MockLocalServer();
export const state = {
  deviceId: getActiveDeviceId(),
  online: Network.isOnline(),
  tab: 'drafts',
  drafts: [],
  records: [],
  editingDraftId: null,
  search: '',
};

export function store() {
  return new DeviceStore(state.deviceId);
}

export function refresh() {
  state.online = Network.isOnline();
  state.drafts = store().listDrafts();
  try {
    state.records = server.listRecords();
  } catch {
    state.records = null; // 离线时无法读取服务端
  }
}

export function switchDevice(deviceId) {
  state.deviceId = deviceId;
  setActiveDeviceId(deviceId);
  store().ensureForms(server);
  state.editingDraftId = null;
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
}

export function resetDemo() {
  seedDemoData();
  state.deviceId = 'A';
  state.editingDraftId = null;
  state.search = '';
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
}

export function createDraft(sampleId, formVersion = LATEST_VERSION) {
  const def = getFormDef(formVersion);
  const draft = store().saveDraft({
    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    formId: FORM_ID,
    formVersion: def.version,
    sampleId: sampleId || `S-${1000 + Math.floor(Math.random() * 9000)}`,
    baseRev: null,
    answers: {},
    pendingAnswers: [],
    collectedAt: new Date().toISOString(),
  });
  state.editingDraftId = draft.id;
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
  return draft;
}

export function editDraft(id) {
  state.editingDraftId = id;
  window.dispatchEvent(new CustomEvent('app-render'));
}

export function closeEditor() {
  state.editingDraftId = null;
  window.dispatchEvent(new CustomEvent('app-render'));
}

export function saveCurrentDraft(sampleId, answers) {
  const draft = store().getDraft(state.editingDraftId);
  if (!draft) return;
  store().saveDraft({ ...draft, sampleId: sampleId.trim(), answers });
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
}

export function deleteDraft(id) {
  store().deleteDraft(id);
  if (state.editingDraftId === id) state.editingDraftId = null;
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
}

export function migrateDraft(id) {
  const migrated = store().migrateDraft(id, LATEST_VERSION);
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
  return migrated;
}

export function resolvePending(id, fieldKey, decision) {
  const resolved = store().resolvePending(id, fieldKey, decision);
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
  return resolved;
}

// 同步单个草稿：离线入发件箱；在线按 create/update/conflict 处理。
export function syncDraft(id) {
  const device = store();
  const draft = device.getDraft(id);
  if (!draft) return { status: 'missing' };

  const def = device.getFormDef(draft.formVersion);
  const { valid, errors } = validateAnswers(def, draft.answers);
  if (!valid) {
    return {
      status: 'invalid',
      errors,
      message: `草稿「${draft.sampleId}」存在 ${Object.keys(errors).length} 个校验问题，修正后才能同步`,
    };
  }
  if ((draft.pendingAnswers || []).some((p) => p.status === 'pending' || !p.status)) {
    return { status: 'pending', message: '还有迁移后无法对应的答案待处理' };
  }

  if (!Network.isOnline()) {
    device.addDraftHistory(id, { action: 'queued', detail: '离线：已加入发件箱，恢复连接后自动同步' });
    refresh();
    window.dispatchEvent(new CustomEvent('app-render'));
    return { status: 'queued' };
  }

  const result = server.pushRecord({ ...draft, deviceId: state.deviceId });
  if (result.status === 'conflict') {
    refresh();
    window.dispatchEvent(new CustomEvent('app-render'));
    return { status: 'conflict', conflict: { draft, remote: result.remote, conflictKeys: result.conflictKeys } };
  }
  device.markSynced(draft, result.record);
  if (state.editingDraftId === id) state.editingDraftId = null;
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
  return { status: result.status, record: result.record };
}

// 恢复连接后同步全部发件箱草稿（含离线期间排队的）。
export function syncOutbox() {
  const results = [];
  for (const draft of store().listDrafts()) {
    const isQueued = draft.history?.some((h) => h.action === 'queued');
    // 离线时所有草稿都尝试；在线时仅同步排过队的（用户也可手动同步任意草稿）
    if (Network.isOnline() && !isQueued) continue;
    const result = syncDraft(draft.id);
    results.push({ draftId: draft.id, sampleId: draft.sampleId, ...result });
    if (result.status === 'conflict') break; // 冲突先人工解决，其余草稿保留待处理
  }
  return results;
}

export function resolveConflictWithChoices(draftId, choices) {
  const device = store();
  const draft = device.getDraft(draftId);
  if (!draft) throw new Error('草稿不存在');
  const remote = server.getRecord(draft.sampleId);
  if (!remote) throw new Error('服务端记录不存在');

  const merged = applyResolution(draft.answers, remote.answers, choices);
  const localKeys = Object.keys(choices).filter((k) => choices[k] === 'local');
  const remoteKeys = Object.keys(choices).filter((k) => choices[k] === 'remote');

  const result = server.resolveConflict({
    sampleId: draft.sampleId,
    mergedAnswers: merged,
    formVersion: draft.formVersion,
    choices: { local: localKeys, remote: remoteKeys },
    localAnswers: draft.answers,
    remoteRev: remote.rev,
    deviceId: state.deviceId,
  });

  if (result.status === 'conflict') {
    return { status: 'conflict', conflict: { draft, remote: result.remote, conflictKeys: result.conflictKeys } };
  }
  device.markSynced(draft, result.record);
  if (state.editingDraftId === draftId) state.editingDraftId = null;
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
  return { status: 'merged', record: result.record };
}

export function pullFormDefs() {
  const result = store().pullFormDefs(server);
  refresh();
  window.dispatchEvent(new CustomEvent('app-render'));
  return result;
}

export { formatValue, isFieldVisible, getField };
