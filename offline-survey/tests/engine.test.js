// 核心引擎单元测试：node --test tests/engine.test.js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FORM_DEFS, MIGRATIONS, getFormDef } from '../js/forms.js';
import {
  answersDiff, applyResolution, buildSyncPlan, isFieldVisible,
  migrateAnswers, validateAnswers,
} from '../js/engine.js';

const v1 = getFormDef(1);
const v2 = getFormDef(2);

function validV1Answers(over = {}) {
  return {
    householdName: '王长贵',
    village: '河东村二组',
    householdSize: 4,
    landType: '水浇地',
    irrigatedArea: 12.5,
    cropYield: 8600,
    mainIncome: '种植',
    satisfaction: '满意',
    ...over,
  };
}

describe('条件显示', () => {
  it('水浇地时显示灌溉面积、隐藏旱地作物', () => {
    const answers = { landType: '水浇地' };
    const irrigated = v1.fields.find((f) => f.key === 'irrigatedArea');
    const dry = v1.fields.find((f) => f.key === 'drylandCrops');
    assert.equal(isFieldVisible(irrigated, answers), true);
    assert.equal(isFieldVisible(dry, answers), false);
  });

  it('旱地时反向显隐（eq 条件）', () => {
    const answers = { landType: '旱地' };
    const dry = v1.fields.find((f) => f.key === 'drylandCrops');
    const irrigated = v1.fields.find((f) => f.key === 'irrigatedArea');
    assert.equal(isFieldVisible(dry, answers), true);
    assert.equal(isFieldVisible(irrigated, answers), false);
  });
});

describe('字段校验', () => {
  it('完整答案通过校验', () => {
    assert.equal(validateAnswers(v1, validV1Answers()).valid, true);
  });

  it('必填字段缺失报错，且隐藏字段不参与必填', () => {
    const answers = validV1Answers();
    delete answers.householdName;
    const { valid, errors } = validateAnswers(v1, answers);
    assert.equal(valid, false);
    assert.match(errors.householdName, /必填/);
    // 旱地时 irrigatedArea 隐藏，即使为空也不报错
    const dryAnswers = validV1Answers({ landType: '旱地', drylandCrops: '玉米' });
    delete dryAnswers.irrigatedArea;
    assert.equal(validateAnswers(v1, dryAnswers).valid, true);
  });

  it('数值范围校验（min/max）', () => {
    const tooSmall = validateAnswers(v1, validV1Answers({ householdSize: 0 }));
    assert.match(tooSmall.errors.householdSize, /不能小于 1/);
    const tooBig = validateAnswers(v1, validV1Answers({ cropYield: 999999 }));
    assert.match(tooBig.errors.cropYield, /不能大于 100000/);
    const notNumber = validateAnswers(v1, validV1Answers({ householdSize: 'abc' }));
    assert.match(notNumber.errors.householdSize, /有效数字/);
  });

  it('选项越界与多选非法值报错', () => {
    const badRadio = validateAnswers(v1, validV1Answers({ satisfaction: '超级满意' }));
    assert.match(badRadio.errors.satisfaction, /选项范围/);
    const badCheck = validateAnswers(v2, {
      ...validV1Answers(),
      plantMode: ['单作', '乱种'],
    });
    assert.match(badCheck.errors.plantMode, /无效选项/);
  });
});

describe('答案差异', () => {
  it('识别差异字段并集，数组按排序后比较', () => {
    const keys = answersDiff(
      { a: 1, b: 'x', tags: ['a', 'b'] },
      { a: 2, c: 'y', tags: ['b', 'a'] },
    );
    assert.deepEqual(keys.sort(), ['a', 'b', 'c']);
  });

  it('空白与 null 视为相同', () => {
    assert.deepEqual(answersDiff({ a: '' }, { a: null }), []);
  });
});

describe('同步计划（乐观锁）', () => {
  const baseDraft = (over = {}) => ({
    sampleId: 'S-1001',
    baseRev: 1,
    answers: validV1Answers(),
    ...over,
  });

  it('服务端无记录 -> create', () => {
    assert.equal(buildSyncPlan(baseDraft(), null).action, 'create');
  });

  it('baseRev 等于服务端 rev -> 快进 update', () => {
    const remote = { rev: 1, answers: validV1Answers() };
    assert.equal(buildSyncPlan(baseDraft(), remote).action, 'update');
  });

  it('rev 落后但答案无差异 -> update（不制造伪冲突）', () => {
    const remote = { rev: 2, answers: validV1Answers() };
    assert.equal(buildSyncPlan(baseDraft({ baseRev: 1 }), remote).action, 'update');
  });

  it('rev 落后且字段被双方修改 -> conflict 并列出冲突字段', () => {
    const remote = { rev: 2, answers: validV1Answers({ cropYield: 5000, satisfaction: '一般' }) };
    const plan = buildSyncPlan(baseDraft({ answers: validV1Answers({ cropYield: 9200 }) }), remote);
    assert.equal(plan.action, 'conflict');
    assert.deepEqual(plan.conflictKeys.sort(), ['cropYield', 'satisfaction']);
  });
});

describe('冲突合并', () => {
  it('逐字段选择，未选择的字段以服务端为准', () => {
    const local = { a: 'L1', b: 'L2', c: 'L3' };
    const remote = { a: 'R1', b: 'R2', c: 'R3' };
    const merged = applyResolution(local, remote, { a: 'local', b: 'remote' });
    assert.deepEqual(merged, { a: 'L1', b: 'R2', c: 'R3' });
  });

  it('本地删除的字段选择 local 时会从合并结果移除', () => {
    const local = { a: 'L1' };
    const remote = { a: 'R1', b: 'R2' };
    const merged = applyResolution(local, remote, { b: 'local' });
    assert.deepEqual(merged, { a: 'R1' });
  });
});

describe('表单迁移 v1 -> v2', () => {
  const mapping = MIGRATIONS['1->2'].mapping;

  it('同名字段迁移、满意度选项按值映射、已移除字段进入 unmapped', () => {
    const oldAnswers = validV1Answers({
      satisfaction: '非常满意',
      note_v1: '劳动力不足',
    });
    const { answers, unmapped } = migrateAnswers(v1, v2, mapping, oldAnswers);

    assert.equal(answers.householdName, '王长贵');
    assert.equal(answers.satisfaction, '很满意');
    assert.equal(answers.note_v1, undefined);
    assert.equal(unmapped.length, 1);
    assert.equal(unmapped[0].fieldKey, 'note_v1');
  });

  it('目标字段选项不存在时进入待处理而不是写入脏数据', () => {
    // 构造一个映射后选项不被 v2 接受的场景：直接复用未在 values 中的旧满意度
    const customMapping = {
      ...mapping,
      satisfaction: { field: 'satisfaction' }, // 不做值转换
    };
    const { answers, unmapped } = migrateAnswers(
      v1, v2, customMapping,
      validV1Answers({ satisfaction: '非常满意' }),
    );
    assert.equal(answers.satisfaction, undefined);
    assert.equal(unmapped[0].fieldKey, 'satisfaction');
  });

  it('迁移后的 v2 草稿仅缺少新增必填项，其余字段无需重填', () => {
    const { answers } = migrateAnswers(v1, v2, mapping, validV1Answers({ note_v1: 'x' }));
    const { valid, errors } = validateAnswers(v2, answers);
    assert.equal(valid, false);
    assert.deepEqual(Object.keys(errors), ['plantMode']);
  });
});
