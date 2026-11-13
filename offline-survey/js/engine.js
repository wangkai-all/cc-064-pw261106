// 纯逻辑引擎：条件显示、校验、答案差异、同步计划、迁移、冲突合并。
// 不依赖 DOM / localStorage，可直接在 Node 下单元测试。

import { getField } from './forms.js';

export function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.slice().sort().join('|');
  return String(value).trim();
}

export function isFieldVisible(field, answers) {
  if (!field.visibleWhen) return true;
  const current = answers[field.visibleWhen.field];
  const cond = field.visibleWhen;
  if (cond.eq !== undefined) return current === cond.eq;
  if (Array.isArray(cond.in)) return cond.in.includes(current);
  return true;
}

export function visibleFields(def, answers) {
  return def.fields.filter((f) => isFieldVisible(f, answers));
}

// 校验：隐藏字段不参与必填校验；草稿可暂存，同步前才强制校验。
export function validateAnswers(def, answers) {
  const errors = {};
  for (const field of def.fields) {
    if (!isFieldVisible(field, answers)) continue;
    const raw = answers[field.key];
    const isEmpty =
      raw === undefined || raw === null || raw === '' ||
      (Array.isArray(raw) && raw.length === 0);

    if (field.required && isEmpty) {
      errors[field.key] = '该字段为必填项';
      continue;
    }
    if (isEmpty) continue;

    if (field.type === 'number') {
      const num = Number(raw);
      if (Number.isNaN(num)) {
        errors[field.key] = '请输入有效数字';
        continue;
      }
      if (field.min !== undefined && num < field.min) {
        errors[field.key] = `数值不能小于 ${field.min}`;
      } else if (field.max !== undefined && num > field.max) {
        errors[field.key] = `数值不能大于 ${field.max}`;
      }
      continue;
    }

    if ((field.type === 'select' || field.type === 'radio') && field.options) {
      if (!field.options.includes(raw)) {
        errors[field.key] = '所选值不在允许的选项范围内';
      }
    }
    if (field.type === 'checkbox' && Array.isArray(raw) && field.options) {
      const invalid = raw.filter((v) => !field.options.includes(v));
      if (invalid.length) errors[field.key] = `包含无效选项：${invalid.join('、')}`;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// 比较两份答案，返回值不同的字段 key 列表（并集）。
export function answersDiff(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => normalizeValue(a[key]) !== normalizeValue(b[key]));
}

// 草稿迁移：按 mapping 把旧版本答案搬到新版本，无法对应的答案进入 unmapped。
export function migrateAnswers(fromDef, toDef, mapping, answers) {
  const next = {};
  const unmapped = [];

  for (const [oldKey, rule] of Object.entries(mapping)) {
    if (!(oldKey in answers) || normalizeValue(answers[oldKey]) === '') continue;
    const oldValue = answers[oldKey];

    if (rule === null || rule === undefined) {
      unmapped.push({
        fieldKey: oldKey,
        label: getField(fromDef, oldKey)?.label || oldKey,
        value: oldValue,
        reason: '新版表单已移除该字段',
      });
      continue;
    }

    const targetKey = typeof rule === 'string' ? rule : rule.field;
    let nextValue = oldValue;
    if (typeof rule === 'object' && rule.values) {
      nextValue = Object.prototype.hasOwnProperty.call(rule.values, oldValue)
        ? rule.values[oldValue]
        : oldValue;
    }

    const target = getField(toDef, targetKey);
    if (target && (target.type === 'select' || target.type === 'radio') &&
        target.options && !target.options.includes(nextValue)) {
      unmapped.push({
        fieldKey: oldKey,
        label: getField(fromDef, oldKey)?.label || oldKey,
        value: oldValue,
        reason: `选项「${oldValue}」在新版表单中不存在，无法自动转换`,
      });
      continue;
    }
    next[targetKey] = nextValue;
  }

  return { answers: next, unmapped };
}

// 同步计划：create 新建 / update 快进 / conflict 需人工合并。
// baseRev 与服务器当前 rev 不一致即存在并发修改，再按字段差异决定是否冲突。
export function buildSyncPlan(draft, remote) {
  if (!remote) return { action: 'create' };
  if (draft.baseRev != null && draft.baseRev === remote.rev) {
    return { action: 'update' };
  }
  const conflictKeys = answersDiff(draft.answers, remote.answers);
  return conflictKeys.length
    ? { action: 'conflict', conflictKeys }
    : { action: 'update' };
}

// 冲突解决：choices 为 { 字段key: 'local' | 'remote' }，未列出的字段以服务器为准。
export function applyResolution(draftAnswers, remoteAnswers, choices) {
  const merged = { ...remoteAnswers };
  for (const [key, side] of Object.entries(choices)) {
    if (side !== 'local') continue;
    if (key in draftAnswers) merged[key] = draftAnswers[key];
    else delete merged[key];
  }
  return merged;
}

export function formatValue(value) {
  if (value === undefined || value === null || value === '') return '（空）';
  if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
  return String(value);
}
