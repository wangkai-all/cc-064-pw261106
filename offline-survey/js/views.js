// 视图渲染：草稿列表、表单编辑器、服务端记录查询、演示场景引导。
import { LATEST_VERSION, getFormDef } from './forms.js';
import { validateAnswers, visibleFields } from './engine.js';
import { state } from './app-core.js';
import { badge, esc, fieldBlockHtml, fmtTime, historyTimelineHtml } from './components.js';

/* ---------------- 草稿列表 ---------------- */

function draftStatus(draft) {
  const def = getFormDef(draft.formVersion);
  const { valid } = validateAnswers(def, draft.answers);
  const pending = (draft.pendingAnswers || []).filter((p) => !p.status || p.status === 'pending');
  const queued = draft.history?.some((h) => h.action === 'queued');
  if (pending.length) return { text: `${pending.length} 项待处理`, kind: 'warn' };
  if (queued) return { text: '发件箱待同步', kind: 'warn' };
  if (!valid) return { text: '未完成', kind: 'neutral' };
  return { text: state.online ? '可同步' : '离线暂存', kind: state.online ? 'ok' : 'warn' };
}

export function draftsView() {
  const drafts = state.drafts;
  return `
  <div class="view-head">
    <div>
      <h2>我的草稿（设备 ${esc(state.deviceId)}）</h2>
      <p class="muted">离线录入的问卷保存在本机；${state.online ? '在线时可直接同步到本地服务。' : '当前离线，同步将进入发件箱，恢复连接后自动上传。'}</p>
    </div>
    <div class="view-actions">
      <button class="btn btn-primary" data-action="new-draft">＋ 新建问卷</button>
    </div>
  </div>
  ${drafts.length === 0 ? `
    <div class="empty-state">
      <p>本机暂无草稿。点击「新建问卷」开始离线采集。</p>
    </div>` : `
    <div class="card-list">
      ${drafts.map((d) => {
        const st = draftStatus(d);
        const def = getFormDef(d.formVersion);
        const outOfDate = d.formVersion < LATEST_VERSION;
        const pending = (d.pendingAnswers || []).filter((p) => !p.status || p.status === 'pending');
        return `
        <div class="card draft-card" data-draft-id="${esc(d.id)}">
          <div class="card-main">
            <div class="card-title-row">
              <h3>样本 ${esc(d.sampleId)}</h3>
              ${badge(`v${d.formVersion}`, outOfDate ? 'warn' : 'info')}
              ${badge(st.text, st.kind)}
              ${outOfDate ? badge(`可升级 v${LATEST_VERSION}`, 'danger') : ''}
            </div>
            <div class="card-meta">
              <span>${esc(def.name)}</span>
              <span>采集时间：${fmtTime(d.collectedAt)}</span>
              <span>最近保存：${fmtTime(d.updatedAt)}</span>
            </div>
            ${pending.length ? `
              <div class="pending-banner">⚠ 表单迁移后有 ${pending.length} 个答案无法对应，需人工处理后才能同步</div>` : ''}
          </div>
          <div class="card-actions">
            <button class="btn btn-sm" data-action="edit-draft" data-id="${esc(d.id)}">打开录入</button>
            ${outOfDate ? `<button class="btn btn-sm btn-warn" data-action="migrate" data-id="${esc(d.id)}">迁移到 v${LATEST_VERSION}</button>` : ''}
            <button class="btn btn-sm btn-primary" data-action="sync-draft" data-id="${esc(d.id)}">同步</button>
            <button class="btn btn-sm btn-ghost" data-action="draft-history" data-id="${esc(d.id)}">修改记录</button>
            <button class="btn btn-sm btn-danger-ghost" data-action="delete-draft" data-id="${esc(d.id)}">删除</button>
          </div>
        </div>`;
      }).join('')}
    </div>`}
  `;
}

/* ---------------- 表单编辑器 ---------------- */

export function editorView(draft) {
  const def = getFormDef(draft.formVersion);
  const errors = validateAnswers(def, draft.answers).errors;
  const pending = (draft.pendingAnswers || []).filter((p) => !p.status || p.status === 'pending');
  const visible = visibleFields(def, draft.answers);
  const visibleRequired = visible.filter((f) => f.required).length;
  const filled = visible.filter((f) => {
    const v = draft.answers[f.key];
    return v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
  }).length;

  return `
  <div class="editor">
    <div class="editor-head">
      <div>
        <button class="btn btn-ghost btn-sm" data-action="back-list">← 返回草稿列表</button>
        <h2>${esc(def.name)} <span class="muted">${esc(def.code)} · v${def.version}</span></h2>
      </div>
      <div class="editor-head-actions">
        <button class="btn" data-action="save-draft">保存草稿</button>
        <button class="btn btn-primary" data-action="sync-draft" data-id="${esc(draft.id)}">
          ${state.online ? '保存并同步' : '保存（离线入发件箱）'}
        </button>
      </div>
    </div>

    <div class="editor-progress">
      填写进度：${filled} / ${visibleRequired} 个可见必填字段
      <div class="progress-bar"><div style="width:${visibleRequired ? Math.round((filled / visibleRequired) * 100) : 0}%"></div></div>
    </div>

    ${draft.formVersion < LATEST_VERSION ? `
      <div class="banner banner-warn">
        当前草稿基于旧版表单 v${draft.formVersion}，最新为 v${LATEST_VERSION}。
        <button class="btn btn-sm btn-warn" data-action="migrate" data-id="${esc(draft.id)}">立即迁移</button>
      </div>` : ''}

    ${pending.length ? `
      <div class="banner banner-warn">
        ⚠ ${pending.length} 个迁移答案待处理：
        ${pending.map((p) => esc(p.label)).join('、')}
        <button class="btn btn-sm btn-warn" data-action="open-pending" data-id="${esc(draft.id)}">去处理</button>
      </div>` : ''}

    <div class="form-grid">
      <div class="field-block sample-id-block">
        <label class="field-label">样本编号 <span class="req">*</span></label>
        <input type="text" id="sample-id-input" value="${esc(draft.sampleId)}" placeholder="如：S-1005">
      </div>
      ${def.fields.map((f) => fieldBlockHtml(def, f, draft.answers, errors)).join('')}
    </div>

    ${Object.keys(errors).length ? `
      <div class="banner banner-error">
        还有 ${Object.keys(errors).length} 个字段未通过校验（隐藏字段不参与必填校验），同步前需修正。
      </div>` : ''}

    <div class="editor-foot">
      <button class="btn" data-action="save-draft">保存草稿</button>
      <button class="btn btn-primary" data-action="sync-draft" data-id="${esc(draft.id)}">
        ${state.online ? '保存并同步' : '保存（离线入发件箱）'}
      </button>
    </div>
  </div>`;
}

/* ---------------- 服务端记录查询 ---------------- */

export function recordsView() {
  if (state.records === null) {
    return `
    <div class="view-head"><div><h2>采集记录</h2></div></div>
    <div class="empty-state">
      <p>📵 当前离线，无法查询本地服务上的采集记录。</p>
      <p class="muted">恢复连接后即可按样本编号查看采集时间、表单版本与完整修改记录。</p>
    </div>`;
  }

  const q = (state.search || '').trim().toLowerCase();
  const records = q
    ? state.records.filter((r) => r.sampleId.toLowerCase().includes(q))
    : state.records;

  return `
  <div class="view-head">
    <div>
      <h2>采集记录（本地服务）</h2>
      <p class="muted">共 ${state.records.length} 条，按最近更新排序。点击卡片查看采集时间、表单版本与修改记录。</p>
    </div>
    <div class="search-box">
      <input type="search" id="record-search" placeholder="按样本编号搜索，如 S-1001" value="${esc(state.search || '')}">
    </div>
  </div>
  ${records.length === 0 ? `<div class="empty-state"><p>没有匹配「${esc(state.search || '')}」的记录。</p></div>` : `
  <div class="card-list">
    ${records.map((r) => {
      const def = getFormDef(r.formVersion);
      return `
      <div class="card record-card" data-action="record-detail" data-id="${esc(r.sampleId)}">
        <div class="card-main">
          <div class="card-title-row">
            <h3>样本 ${esc(r.sampleId)}</h3>
            ${badge(`${def.code} · v${r.formVersion}`, 'info')}
            ${badge(`rev ${r.rev}`, 'neutral')}
            ${r.history?.some((h) => h.action === 'conflict-merge') ? badge('含冲突合并', 'danger') : ''}
          </div>
          <div class="card-meta">
            <span>采集时间：${fmtTime(r.collectedAt)}</span>
            <span>最近同步：${fmtTime(r.updatedAt)}</span>
            <span>修改记录：${r.history?.length || 0} 条</span>
          </div>
          <div class="answer-preview">
            ${def.fields.slice(0, 4).map((f) => `
              <span class="answer-chip"><em>${esc(f.label)}：</em>${esc(r.answers[f.key] ?? '—')}</span>`).join('')}
          </div>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm" data-action="record-detail" data-id="${esc(r.sampleId)}">详情 / 修改记录</button>
        </div>
      </div>`;
    }).join('')}
  </div>`}
  `;
}

export function recordDetailView(record) {
  const def = getFormDef(record.formVersion);
  return `
  <div class="editor">
    <div class="editor-head">
      <div>
        <button class="btn btn-ghost btn-sm" data-action="back-records">← 返回记录列表</button>
        <h2>样本 ${esc(record.sampleId)}</h2>
      </div>
    </div>
    <div class="detail-grid">
      <div class="card detail-panel">
        <h3>记录信息</h3>
        <dl class="info-list">
          <dt>表单版本</dt><dd>${esc(def.name)}（${esc(def.code)} · v${record.formVersion}）</dd>
          <dt>版本号 rev</dt><dd>${record.rev}</dd>
          <dt>采集时间</dt><dd>${fmtTime(record.collectedAt)}</dd>
          <dt>创建时间</dt><dd>${fmtTime(record.createdAt)}</dd>
          <dt>最近更新</dt><dd>${fmtTime(record.updatedAt)}</dd>
        </dl>
        <h3>答案明细</h3>
        <table class="table">
          <tbody>
            ${def.fields.map((f) => `
              <tr>
                <th>${esc(f.label)}${f.required ? ' *' : ''}</th>
                <td>${esc(formatAnswer(record.answers[f.key]))}</td>
              </tr>`).join('')}
            ${Object.keys(record.answers).filter((k) => !def.fields.some((f) => f.key === k)).map((k) => `
              <tr><th class="muted">${esc(k)}（旧版字段）</th><td>${esc(formatAnswer(record.answers[k]))}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card detail-panel">
        <h3>修改记录（${record.history?.length || 0} 条）</h3>
        ${historyTimelineHtml(record.history)}
      </div>
    </div>
  </div>`;
}

function formatAnswer(value) {
  if (value === undefined || value === null || value === '') return '（空）';
  return Array.isArray(value) ? value.join('、') : String(value);
}

/* ---------------- 演示场景 ---------------- */

export function scenariosView() {
  const scenarios = [
    {
      id: 's1',
      title: '场景一：离线录入 → 断网刷新 → 恢复同步',
      steps: [
        '点击「新建问卷」录入一份样本并保存草稿。',
        '用顶部网络开关断开网络（状态持久化），刷新浏览器页面——Service Worker 保证页面离线可用，数据仍在。',
        '继续在草稿中修改并点击同步，系统提示进入「发件箱」。',
        '恢复网络后点击「同步发件箱」，记录出现在「采集记录」中，可查看采集时间、表单版本与修改记录。',
      ],
      actions: [{ label: '新建问卷', action: 'new-draft' }],
    },
    {
      id: 's2',
      title: '场景二：两台设备并发修改 → 字段级冲突合并',
      steps: [
        '点击「一键模拟并发修改」：设备 A、B 基于同一个 rev 分别离线修改 S-1001 的不同字段（A 改粮食产量、B 改满意度）。',
        '设备 A 先同步成功（快进到新 rev）；设备 B 同步时收到冲突弹窗，逐字段选择采用哪一版，系统不会静默覆盖。',
        '合并完成后到「采集记录」打开 S-1001，可在修改记录中查看冲突合并条目，以及保留下来的另一版完整快照。',
        '也可以手动复现：先在设备 A、B 分别新建同编号草稿并保存，断网分别修改后再依次同步。',
      ],
      actions: [{ label: '一键模拟并发修改冲突', action: 'seed-conflict' }],
    },
    {
      id: 's3',
      title: '场景三：表单升级 v1 → v2 字段映射迁移',
      steps: [
        '设备 A 预置了一份 v1 草稿 S-1004（含已移除的「其他说明」字段与旧满意度选项「非常满意」）。',
        '打开草稿点击「迁移到 v2」：同名字段自动迁移，「非常满意」按映射转换为「很满意」。',
        '已移除字段的答案进入「待处理」列表，可选择保留到新版备注或丢弃，处理完才允许同步。',
        '同步后在采集记录中查看迁移与处理历史。',
      ],
      actions: [{ label: '打开 v1 草稿 S-1004', action: 'open-seed-draft' }],
    },
  ];

  return `
  <div class="view-head">
    <div><h2>演示场景与样例数据</h2>
      <p class="muted">系统已内置 3 条样例调查记录（S-1001 ~ S-1003）与 1 份 v1 旧草稿。可随时重置全部演示数据。</p>
    </div>
    <div class="view-actions">
      <button class="btn btn-danger-ghost" data-action="reset-demo">重置演示数据</button>
    </div>
  </div>
  <div class="scenario-list">
    ${scenarios.map((s) => `
      <div class="card scenario-card">
        <h3>${esc(s.title)}</h3>
        <ol class="steps">
          ${s.steps.map((step) => `<li>${esc(step)}</li>`).join('')}
        </ol>
        <div class="card-actions">
          ${s.actions.map((a) => `<button class="btn btn-sm btn-primary" data-action="${esc(a.action)}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>`).join('')}
  </div>`;
}
