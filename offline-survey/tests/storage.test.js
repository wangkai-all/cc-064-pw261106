// 存储与应用流程集成测试：用 localStorage/window 桩模拟浏览器环境，
// 跑通离线发件箱、双设备冲突合并、表单迁移待处理的完整链路。
// 运行：node --test tests/storage.test.js
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

/* ---- 浏览器环境桩，必须在 import 业务模块前安装 ---- */
class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
};
globalThis.window = {
  listeners: {},
  dispatchEvent() { return true; },
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
};

const {
  DeviceStore, MockLocalServer, Network, seedDemoData,
} = await import('../js/storage.js');
const {
  state, switchDevice, createDraft, syncDraft, syncOutbox,
  resolveConflictWithChoices, migrateDraft, resolvePending, saveCurrentDraft,
  store, server,
} = await import('../js/app-core.js');
const { getFormDef } = await import('../js/forms.js');
const { validateAnswers } = await import('../js/engine.js');

before(() => {
  seedDemoData(); // 每个文件进程一次，保证起点确定
});

function v1Answers(over = {}) {
  return {
    householdName: '测试户', village: '测试村', householdSize: 3,
    landType: '水浇地', irrigatedArea: 5, cropYield: 3000,
    mainIncome: '种植', satisfaction: '满意', ...over,
  };
}
// 新建草稿基于最新 v2 表单，需包含 v2 新增必填项 plantMode
function v2Answers(over = {}) {
  return { ...v1Answers(), plantMode: ['单作'], ...over };
}

describe('离线录入与发件箱同步', () => {
  it('离线保存草稿并排队，恢复连接后自动同步到本地服务', () => {
    switchDevice('A');
    Network.setOnline(false);
    assert.equal(Network.isOnline(), false);

    const draft = createDraft('S-2001');
    saveCurrentDraft('S-2001', v2Answers());
    assert.equal(syncDraft(draft.id).status, 'queued');

    // “离线刷新”：重新 new DeviceStore 数据仍在（localStorage 持久化）
    const reopened = new DeviceStore('A').getDraft(draft.id);
    assert.ok(reopened, '离线刷新后草稿仍存在');
    assert.equal(reopened.history.at(-1).action, 'queued');

    Network.setOnline(true);
    const results = syncOutbox();
    assert.equal(results.length, 1);
    assert.ok(['create', 'update'].includes(results[0].status));

    const record = server.getRecord('S-2001');
    assert.ok(record);
    assert.equal(record.answers.householdName, '测试户');
    assert.equal(new DeviceStore('A').getDraft(draft.id), null, '同步成功后草稿已移除');
  });

  it('离线状态下服务端请求被拒绝，表单定义走本地缓存兜底', () => {
    Network.setOnline(false);
    let offlineErr;
    try { server.listRecords(); } catch (err) { offlineErr = err; }
    assert.equal(offlineErr?.code, 'OFFLINE');
    const pulled = new DeviceStore('A').pullFormDefs(server);
    assert.equal(pulled.offline, true);
    assert.ok(pulled.defs.length >= 2);
    Network.setOnline(true);
  });

  it('校验不通过或有待处理答案时禁止同步', () => {
    const draft = createDraft('S-2002');
    saveCurrentDraft('S-2002', { householdName: '缺字段' });
    const result = syncDraft(draft.id);
    assert.equal(result.status, 'invalid');
    assert.ok(Object.keys(result.errors).length > 0);
  });
});

describe('两台设备并发修改与字段级冲突合并', () => {
  it('第二台设备同步时收到冲突，人工选择后保留另一版历史', () => {
    const base = server.getRecord('S-1001');
    assert.ok(base, '样例数据包含 S-1001');

    // 设备 A：基于当前 rev 修改 cropYield，同步成功（快进）
    switchDevice('A');
    const draftA = createDraft('S-1001');
    saveCurrentDraft('S-1001', { ...base.answers, cropYield: 9200 });
    const aDraft = store().getDraft(draftA.id);
    store().saveDraft({ ...aDraft, baseRev: base.rev, formVersion: base.formVersion });
    const rA = syncDraft(draftA.id);
    assert.equal(rA.status, 'update');
    const revAfterA = server.getRecord('S-1001').rev;
    assert.equal(revAfterA, base.rev + 1);

    // 设备 B：基于旧 rev 修改 satisfaction（不同字段），同步触发冲突
    switchDevice('B');
    const draftB = createDraft('S-1001');
    saveCurrentDraft('S-1001', { ...base.answers, satisfaction: '不满意' });
    const bDraft = store().getDraft(draftB.id);
    store().saveDraft({ ...bDraft, baseRev: base.rev, formVersion: base.formVersion });
    const rB = syncDraft(draftB.id);
    assert.equal(rB.status, 'conflict');
    assert.deepEqual(rB.conflict.conflictKeys.sort(), ['cropYield', 'satisfaction']);

    // 人工合并：cropYield 采用设备 A（服务端）值，satisfaction 采用设备 B（本地）值
    const merged = resolveConflictWithChoices(draftB.id, {
      cropYield: 'remote',
      satisfaction: 'local',
    });
    assert.equal(merged.status, 'merged');
    const finalRecord = server.getRecord('S-1001');
    assert.equal(finalRecord.answers.cropYield, 9200);
    assert.equal(finalRecord.answers.satisfaction, '不满意');

    const mergeEntry = finalRecord.history.find((h) => h.action === 'conflict-merge');
    assert.ok(mergeEntry, '修改记录包含冲突合并条目');
    assert.deepEqual(mergeEntry.merge.localPicked, ['satisfaction']);
    assert.deepEqual(mergeEntry.merge.remotePicked, ['cropYield']);
    // 另一版完整快照被保留
    assert.equal(mergeEntry.merge.localSnapshot.satisfaction, '不满意');
    assert.equal(mergeEntry.merge.remoteSnapshot.cropYield, 9200);
  });
});

describe('表单升级 v1 -> v2 迁移', () => {
  it('旧草稿按映射迁移，无法对应的答案待人工处理后才能同步', () => {
    switchDevice('A');
    const seed = store().listDrafts().find((d) => d.sampleId === 'S-1004');
    assert.ok(seed, '样例包含 v1 草稿 S-1004');
    assert.equal(seed.formVersion, 1);

    const migrated = migrateDraft(seed.id, 2);
    assert.equal(migrated.formVersion, 2);
    assert.equal(migrated.answers.satisfaction, '很满意', '选项值按映射转换');
    assert.equal(migrated.answers.drylandCrops, '谷子', '同名字段直接迁移');
    assert.equal(migrated.pendingAnswers.length, 1);
    assert.equal(migrated.pendingAnswers[0].fieldKey, 'note_v1');
    assert.match(migrated.pendingAnswers[0].reason, /已移除/);

    // 有待处理答案时禁止同步（先补齐 v2 新增必填项，避免被必填校验先行拦截）
    const def = getFormDef(2);
    const withRequired = store().saveDraft({
      ...migrated,
      answers: { ...migrated.answers, plantMode: ['单作', '轮作'] },
    });
    assert.equal(validateAnswers(def, withRequired.answers).valid, true);
    assert.equal(syncDraft(seed.id).status, 'pending');

    // 保留到新版备注
    const resolved = resolvePending(seed.id, 'note_v1', 'keep-note');
    assert.equal(resolved.pendingAnswers.length, 0);
    assert.match(resolved.answers.note, /劳动力不足/);

    const r = syncDraft(seed.id);
    assert.ok(['create', 'update'].includes(r.status), `期望同步成功，实际 ${r.status}`);

    const record = server.getRecord('S-1004');
    assert.equal(record.formVersion, 2);
    assert.deepEqual(record.answers.plantMode, ['单作', '轮作']);
    assert.match(record.answers.note, /迁移自旧版表单/);
    assert.ok(record.history.some((h) => h.by === 'A'));
  });
});
