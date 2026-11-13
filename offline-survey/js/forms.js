// 表单定义、版本与字段映射。纯数据模块，浏览器与 Node 测试均可引用。

export const FORM_ID = 'FARM';
export const LATEST_VERSION = 2;

// v1：初始发布版本
const FORM_V1 = {
  id: FORM_ID,
  version: 1,
  code: 'FARM-V1',
  name: '农户种植情况调查表',
  publishedAt: '2026-09-01T08:00:00.000Z',
  fields: [
    { key: 'householdName', label: '户主姓名', type: 'text', required: true, placeholder: '请输入户主姓名' },
    { key: 'village', label: '所在村组', type: 'text', required: true, placeholder: '如：河东村二组' },
    { key: 'householdSize', label: '家庭人口（人）', type: 'number', required: true, min: 1, max: 20 },
    {
      key: 'landType', label: '主要耕地类型', type: 'radio', required: true,
      options: ['水浇地', '旱地', '水田'],
    },
    {
      key: 'irrigatedArea', label: '灌溉面积（亩）', type: 'number', min: 0, max: 99999, step: 0.1,
      visibleWhen: { field: 'landType', in: ['水浇地', '水田'] },
      help: '仅水浇地、水田需要填写',
    },
    {
      key: 'drylandCrops', label: '旱地主要作物', type: 'select',
      options: ['玉米', '小麦', '马铃薯', '其他'],
      visibleWhen: { field: 'landType', eq: '旱地' },
    },
    { key: 'cropYield', label: '全年粮食总产量（公斤）', type: 'number', required: true, min: 0, max: 100000 },
    {
      key: 'mainIncome', label: '主要收入来源', type: 'radio', required: true,
      options: ['种植', '养殖', '外出务工', '经营性收入'],
    },
    {
      key: 'satisfaction', label: '帮扶满意度', type: 'radio', required: true,
      options: ['非常满意', '满意', '一般', '不满意'],
    },
    { key: 'note_v1', label: '其他说明', type: 'textarea', placeholder: '其他需要记录的情况' },
  ],
};

// v2：升级版本——新增字段、调整选项、移除旧备注字段
const FORM_V2 = {
  id: FORM_ID,
  version: 2,
  code: 'FARM-V2',
  name: '农户种植情况调查表',
  publishedAt: '2026-11-01T08:00:00.000Z',
  fields: [
    { key: 'householdName', label: '户主姓名', type: 'text', required: true, placeholder: '请输入户主姓名' },
    { key: 'village', label: '所在村组', type: 'text', required: true, placeholder: '如：河东村二组' },
    { key: 'householdSize', label: '家庭人口（人）', type: 'number', required: true, min: 1, max: 20 },
    {
      key: 'landType', label: '主要耕地类型', type: 'radio', required: true,
      options: ['水浇地', '旱地', '水田'],
    },
    {
      key: 'irrigatedArea', label: '灌溉面积（亩）', type: 'number', min: 0, max: 99999, step: 0.1,
      visibleWhen: { field: 'landType', in: ['水浇地', '水田'] },
      help: '仅水浇地、水田需要填写',
    },
    {
      key: 'drylandCrops', label: '旱地主要作物', type: 'select',
      options: ['玉米', '小麦', '马铃薯', '谷子', '其他'],
      visibleWhen: { field: 'landType', eq: '旱地' },
    },
    {
      key: 'plantMode', label: '种植模式（可多选）', type: 'checkbox', required: true,
      options: ['单作', '间作', '轮作', '套种'],
      help: 'v2 新增必填项',
    },
    { key: 'cropYield', label: '全年粮食总产量（公斤）', type: 'number', required: true, min: 0, max: 100000 },
    { key: 'pesticideUse', label: '农药使用量（公斤）', type: 'number', min: 0, max: 10000, step: 0.1, help: 'v2 新增字段' },
    {
      key: 'mainIncome', label: '主要收入来源', type: 'radio', required: true,
      options: ['种植', '养殖', '外出务工', '经营性收入'],
    },
    {
      key: 'satisfaction', label: '帮扶满意度', type: 'radio', required: true,
      options: ['很满意', '满意', '一般', '不满意', '很不满意'],
      help: 'v2 调整了满意度选项',
    },
    { key: 'note', label: '备注', type: 'textarea', placeholder: '其他需要记录的情况' },
  ],
};

export const FORM_DEFS = {
  1: FORM_V1,
  2: FORM_V2,
};

// v1 -> v2 字段映射：字符串=同名迁移；对象=值转换；null=字段移除（进入待处理）
export const MIGRATIONS = {
  '1->2': {
    fromVersion: 1,
    toVersion: 2,
    mapping: {
      householdName: 'householdName',
      village: 'village',
      householdSize: 'householdSize',
      landType: 'landType',
      irrigatedArea: 'irrigatedArea',
      drylandCrops: 'drylandCrops',
      cropYield: 'cropYield',
      mainIncome: 'mainIncome',
      satisfaction: { field: 'satisfaction', values: { 非常满意: '很满意' } },
      note_v1: null,
    },
  },
};

export function getFormDef(version) {
  const def = FORM_DEFS[version];
  if (!def) throw new Error(`未知表单版本: v${version}`);
  return def;
}

export function getLatestFormDef() {
  return getFormDef(LATEST_VERSION);
}

export function getField(def, key) {
  return def.fields.find((f) => f.key === key) || null;
}

export function fieldLabel(version, key) {
  const def = FORM_DEFS[version];
  const field = def && getField(def, key);
  return field ? field.label : key;
}
