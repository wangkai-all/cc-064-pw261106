// 存储层：
// - MockLocalServer：模拟本地服务（localStorage 模拟服务端存储，带 rev 乐观锁与历史）
// - DeviceStore：调查员设备上的本地库（草稿/发件箱/已下载表单），两台设备各一个命名空间
// - Network：可持久化的断网开关（断网后刷新页面仍处于离线状态）
// 全部通过 localStorage 持久化，无需后端。

import {
  FORM_ID, FORM_DEFS, LATEST_VERSION, MIGRATIONS, getFormDef, getLatestFormDef,
} from './forms.js';
import { answersDiff, buildSyncPlan, migrateAnswers } from './engine.js';

const SERVER_KEY = 'offline-survey:server:v1';
const NETWORK_KEY = 'offline-survey:network';
const ACTIVE_DEVICE_KEY = 'offline-survey:active-device';
const deviceKey = (deviceId, suffix) => `offline-survey:device:${deviceId}:${suffix}`;

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function nowISO() {
  return new Date().toISOString();
}

/* ---------------- 网络开关 ---------------- */

export const Network = {
  isOnline() {
    return readJSON(NETWORK_KEY, { online: true }).online;
  },
  setOnline(online) {
    writeJSON(NETWORK_KEY, { online, updatedAt: nowISO() });
    window.dispatchEvent(new CustomEvent('network-change', { detail: { online } }));
  },
  toggle() {
    const next = !this.isOnline();
    this.setOnline(next);
    return next;
  },
};

/* ---------------- Mock 本地服务 ---------------- */

export class MockLocalServer {
  _load() {
    return readJSON(SERVER_KEY, { records: {} });
  }
  _save(state) {
    writeJSON(SERVER_KEY, state);
  }

  // 模拟一次需要网络的请求
  _requireNetwork() {
    if (!Network.isOnline()) {
      const err = new Error('当前处于离线状态，无法访问本地服务');
      err.code = 'OFFLINE';
      throw err;
    }
  }

  // 下载表单定义（离线时由设备本地缓存兜底，见 DeviceStore.pullFormDefs）
  getFormDefs() {
    this._requireNetwork();
    return Object.values(FORM_DEFS);
  }

  getRecord(sampleId) {
    this._requireNetwork();
    const state = this._load();
    return state.records[sampleId] || null;
  }

  listRecords() {
    this._requireNetwork();
    const state = this._load();
    return Object.values(state.records).sort(
      (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    );
  }

  // 草稿同步推送。返回 conflict 时不写入任何数据，由调查员人工合并后重试。
  pushRecord(draft) {
    this._requireNetwork();
    const state = this._load();
    const existing = state.records[draft.sampleId];
    const plan = buildSyncPlan(draft, existing);

    if (plan.action === 'conflict') {
      return {
        status: 'conflict',
        remote: existing,
        conflictKeys: plan.conflictKeys,
      };
    }

    const timestamp = nowISO();
    let record;

    if (!existing) {
      record = {
        sampleId: draft.sampleId,
        formId: draft.formId,
        formVersion: draft.formVersion,
        answers: draft.answers,
        rev: 1,
        baseRev: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        collectedAt: draft.collectedAt || timestamp,
        history: [
          { action: 'create', at: timestamp, rev: 1, by: draft.deviceId, detail: '新建采集记录' },
        ],
      };
    } else {
      const changedKeys = answersDiff(existing.answers, draft.answers);
      record = {
        ...existing,
        answers: { ...draft.answers },
        formVersion: draft.formVersion,
        rev: existing.rev + 1,
        baseRev: existing.rev,
        updatedAt: timestamp,
      };
      record.history = [
        ...existing.history,
        {
          action: 'update',
          at: timestamp,
          rev: record.rev,
          by: draft.deviceId,
          detail:
            changedKeys.length
              ? `修改字段：${changedKeys.join('、')}`
              : '重新提交（内容无变化）',
          changedKeys,
        },
      ];
    }

    state.records[record.sampleId] = record;
    this._save(state);
    return { status: plan.action, record, rev: record.rev };
  }

  // 冲突人工解决后的提交。
  resolveConflict({ sampleId, mergedAnswers, formVersion, choices, localAnswers, remoteRev, deviceId }) {
    this._requireNetwork();
    const state = this._load();
    const existing = state.records[sampleId];
    if (!existing || existing.rev !== remoteRev) {
      return {
        status: 'conflict',
        remote: existing,
        conflictKeys: existing ? answersDiff(localAnswers, existing.answers) : [],
      };
    }

    const timestamp = nowISO();
    const changedKeys = answersDiff(existing.answers, mergedAnswers);
    const record = {
      ...existing,
      answers: { ...mergedAnswers },
      formVersion,
      rev: existing.rev + 1,
      baseRev: existing.rev,
      updatedAt: timestamp,
      history: [
        ...existing.history,
        {
          action: 'conflict-merge',
          at: timestamp,
          rev: existing.rev + 1,
          by: deviceId,
          detail: `冲突合并：采用本设备字段 ${choices.local.length || 0} 个、服务端字段 ${choices.remote.length || 0} 个；差异字段 ${changedKeys.join('、') || '无'}`,
          changedKeys,
          merge: {
            localPicked: choices.local,
            remotePicked: choices.remote,
            // 另一版完整快照作为历史保留，可随时追溯
            localSnapshot: localAnswers,
            remoteSnapshot: { ...existing.answers },
          },
        },
      ],
    };
    state.records[sampleId] = record;
    this._save(state);
    return { status: 'merged', record, rev: record.rev };
  }
}

/* ---------------- 设备本地库 ---------------- */

export class DeviceStore {
  constructor(deviceId) {
    this.deviceId = deviceId;
  }

  _read(suffix, fallback) {
    return readJSON(deviceKey(this.deviceId, suffix), fallback);
  }
  _write(suffix, value) {
    writeJSON(deviceKey(this.deviceId, suffix), value);
  }

  // 首次使用时初始化：下载全部表单定义到本地
  ensureForms(server) {
    const cached = this._read('forms', null);
    if (cached) return cached;
    let defs;
    try {
      defs = server.getFormDefs();
    } catch {
      defs = Object.values(FORM_DEFS); // 断网兜底
    }
    this._write('forms', defs);
    return defs;
  }

  getFormDefs() {
    return this._read('forms', Object.values(FORM_DEFS));
  }

  getFormDef(version) {
    return this.getFormDefs().find((d) => d.version === version) || getFormDef(version);
  }

  // 显式“下载/更新表单定义”
  pullFormDefs(server) {
    let defs;
    try {
      defs = server.getFormDefs();
      this._write('forms', defs);
      return { ok: true, defs, offline: false };
    } catch (err) {
      if (err.code === 'OFFLINE') {
        return { ok: true, defs: this.getFormDefs(), offline: true };
      }
      throw err;
    }
  }

  listDrafts() {
    return this._read('drafts', []).sort(
      (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    );
  }

  getDraft(id) {
    return this.listDrafts().find((d) => d.id === id) || null;
  }

  saveDraft(draft) {
    const drafts = this._read('drafts', []);
    const idx = drafts.findIndex((d) => d.id === draft.id);
    const timestamp = nowISO();
    const isNew = idx === -1;
    const saved = {
      ...draft,
      updatedAt: timestamp,
      history: draft.history || [],
    };
    if (isNew) {
      saved.createdAt = timestamp;
      saved.history = [{ action: 'draft-create', at: timestamp, detail: '创建草稿（本地）' }];
      drafts.push(saved);
    } else {
      const changedKeys = answersDiff(drafts[idx].answers, draft.answers);
      saved.history = [
        ...drafts[idx].history,
        {
          action: 'draft-update',
          at: timestamp,
          detail: changedKeys.length ? `本地修改：${changedKeys.join('、')}` : '保存草稿（内容无变化）',
          changedKeys,
        },
      ];
      drafts[idx] = saved;
    }
    this._write('drafts', drafts);
    return saved;
  }

  // 迁移记录写入草稿历史
  addDraftHistory(id, entry) {
    const drafts = this._read('drafts', []);
    const idx = drafts.findIndex((d) => d.id === id);
    if (idx === -1) return;
    drafts[idx].history = [...(drafts[idx].history || []), { at: nowISO(), ...entry }];
    this._write('drafts', drafts);
  }

  deleteDraft(id) {
    this._write('drafts', this._read('drafts', []).filter((d) => d.id !== id));
  }

  // 同步成功后移除草稿，保留一份本地提交记录便于查看
  markSynced(draft, record) {
    this.deleteDraft(draft.id);
    const synced = this._read('synced', []);
    synced.push({
      draftId: draft.id,
      sampleId: record.sampleId,
      formVersion: record.formVersion,
      rev: record.rev,
      syncedAt: nowISO(),
    });
    this._write('synced', synced);
  }

  listSynced() {
    return this._read('synced', []);
  }

  // 将草稿升级到新版表单，按字段映射迁移；无法对应的答案进入 pendingAnswers
  migrateDraft(draftId, toVersion = LATEST_VERSION) {
    const draft = this.getDraft(draftId);
    if (!draft) throw new Error('草稿不存在');
    if (draft.formVersion >= toVersion) return draft;

    const fromDef = this.getFormDef(draft.formVersion);
    const toDef = this.getFormDef(toVersion);
    const migration = MIGRATIONS[`${draft.formVersion}->${toVersion}`];
    if (!migration) throw new Error(`缺少 v${draft.formVersion} -> v${toVersion} 迁移映射`);

    const { answers, unmapped } = migrateAnswers(fromDef, toDef, migration.mapping, draft.answers);
    const updated = {
      ...draft,
      answers,
      formVersion: toVersion,
      pendingAnswers: [
        ...(draft.pendingAnswers || []),
        ...unmapped.map((u) => ({ ...u, status: 'pending' })),
      ],
    };
    const saved = this.saveDraft(updated);
    this.addDraftHistory(draftId, {
      action: 'migrate',
      detail: `表单由 v${draft.formVersion} 升级到 v${toVersion}，迁移 ${Object.keys(answers).length} 个字段，${unmapped.length} 个答案待人工处理`,
      fromVersion: draft.formVersion,
      toVersion,
      unmapped,
    });
    return saved;
  }

  // 人工处理待映射答案：保留为备注 / 丢弃
  resolvePending(draftId, fieldKey, decision, noteText) {
    const draft = this.getDraft(draftId);
    if (!draft) return null;
    const pending = (draft.pendingAnswers || []).filter((p) => p.fieldKey !== fieldKey);
    const target = (draft.pendingAnswers || []).find((p) => p.fieldKey === fieldKey);
    const answers = { ...draft.answers };
    if (target && decision === 'keep-note') {
      const prefix = `【迁移自旧版表单·${target.label}】`;
      answers.note = answers.note
        ? `${answers.note}\n${prefix}${target.value}`
        : `${prefix}${target.value}`;
    }
    const saved = this.saveDraft({ ...draft, answers, pendingAnswers: pending });
    this.addDraftHistory(draftId, {
      action: 'pending-resolve',
      detail: target
        ? `待处理字段「${target.label}」${decision === 'discard' ? '已丢弃' : '已保留到备注'}`
        : '处理待迁移答案',
    });
    return saved;
  }
}

/* ---------------- 活动设备 ---------------- */

export function getActiveDeviceId() {
  return readJSON(ACTIVE_DEVICE_KEY, 'A');
}

export function setActiveDeviceId(deviceId) {
  writeJSON(ACTIVE_DEVICE_KEY, deviceId);
}

/* ---------------- 演示种子数据 ---------------- */

function seedServer() {
  const t = (offsetMinutes) => new Date(Date.UTC(2026, 10, 10, 2, 0) + offsetMinutes * 60000).toISOString();
  return {
    records: {
      'S-1001': {
        sampleId: 'S-1001',
        formId: FORM_ID,
        formVersion: 1,
        rev: 2,
        baseRev: 1,
        createdAt: t(0),
        updatedAt: t(40),
        collectedAt: t(0),
        answers: {
          householdName: '王长贵',
          village: '河东村二组',
          householdSize: 4,
          landType: '水浇地',
          irrigatedArea: 12.5,
          cropYield: 8600,
          mainIncome: '种植',
          satisfaction: '满意',
          note_v1: '家中有一台小型收割机。',
        },
        history: [
          { action: 'create', at: t(0), rev: 1, by: 'A', detail: '新建采集记录' },
          { action: 'update', at: t(40), rev: 2, by: 'A', detail: '修改字段：cropYield、irrigatedArea', changedKeys: ['cropYield', 'irrigatedArea'] },
        ],
      },
      'S-1002': {
        sampleId: 'S-1002',
        formId: FORM_ID,
        formVersion: 1,
        rev: 1,
        baseRev: null,
        createdAt: t(120),
        updatedAt: t(120),
        collectedAt: t(120),
        answers: {
          householdName: '李秀莲',
          village: '西坡村三组',
          householdSize: 3,
          landType: '旱地',
          drylandCrops: '马铃薯',
          cropYield: 4200,
          mainIncome: '外出务工',
          satisfaction: '一般',
        },
        history: [
          { action: 'create', at: t(120), rev: 1, by: 'B', detail: '新建采集记录' },
        ],
      },
      'S-1003': {
        sampleId: 'S-1003',
        formId: FORM_ID,
        formVersion: 1,
        rev: 1,
        baseRev: null,
        createdAt: t(180),
        updatedAt: t(180),
        collectedAt: t(180),
        answers: {
          householdName: '赵建国',
          village: '河东村一组',
          householdSize: 5,
          landType: '水田',
          irrigatedArea: 8,
          cropYield: 5300,
          mainIncome: '养殖',
          satisfaction: '非常满意',
          note_v1: '计划明年增加两亩大棚。',
        },
        history: [
          { action: 'create', at: t(180), rev: 1, by: 'A', detail: '新建采集记录' },
        ],
      },
    },
  };
}

function seedDeviceA() {
  const t = (offsetMinutes) => new Date(Date.UTC(2026, 10, 10, 5, 0) + offsetMinutes * 60000).toISOString();
  return {
    drafts: [
      // v1 旧草稿：用于演示表单升级后的字段映射迁移
      {
        id: 'draft-seed-1',
        formId: FORM_ID,
        formVersion: 1,
        sampleId: 'S-1004',
        baseRev: null,
        answers: {
          householdName: '孙美玲',
          village: '北沟村四组',
          householdSize: 2,
          landType: '旱地',
          drylandCrops: '谷子',
          cropYield: 2100,
          mainIncome: '种植',
          satisfaction: '非常满意',
          note_v1: '子女在外读书，农忙时劳动力不足。',
        },
        pendingAnswers: [],
        createdAt: t(0),
        updatedAt: t(0),
        collectedAt: t(0),
        history: [{ action: 'draft-create', at: t(0), detail: '创建草稿（本地）' }],
      },
    ],
    forms: Object.values(FORM_DEFS),
    synced: [],
  };
}

export function seedDemoData() {
  writeJSON(SERVER_KEY, seedServer());
  writeJSON(deviceKey('A', 'drafts'), seedDeviceA().drafts);
  writeJSON(deviceKey('A', 'forms'), seedDeviceA().forms);
  writeJSON(deviceKey('A', 'synced'), []);
  writeJSON(deviceKey('B', 'drafts'), []);
  writeJSON(deviceKey('B', 'forms', ), Object.values(FORM_DEFS));
  writeJSON(deviceKey('B', 'synced'), []);
  writeJSON(NETWORK_KEY, { online: true, updatedAt: nowISO() });
  writeJSON(ACTIVE_DEVICE_KEY, 'A');
}

// 首次打开自动播种
export function ensureSeeded() {
  if (readJSON(SERVER_KEY, null) === null) seedDemoData();
}
