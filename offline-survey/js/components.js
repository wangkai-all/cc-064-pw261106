// 可复用 UI 组件：字段渲染、徽章、弹窗、历史时间线、Toast。
import { formatValue, isFieldVisible } from './engine.js';
import { getField } from './forms.js';

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function badge(text, kind = 'neutral') {
  return `<span class="badge badge-${kind}">${esc(text)}</span>`;
}

export function toast(message, kind = 'info', timeout = 3200) {
  const box = document.getElementById('toast-box');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-hide');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// 单个表单字段的输入控件
export function fieldInputHtml(field, value, disabled = false) {
  const name = `fld-${field.key}`;
  const dis = disabled ? 'disabled' : '';
  const v = esc(value ?? '');
  switch (field.type) {
    case 'textarea':
      return `<textarea name="${name}" data-field="${esc(field.key)}" rows="3"
        placeholder="${esc(field.placeholder || '')}" ${dis}>${v}</textarea>`;
    case 'number':
      return `<input type="number" name="${name}" data-field="${esc(field.key)}"
        value="${v}" min="${field.min ?? ''}" max="${field.max ?? ''}"
        step="${field.step ?? 'any'}" placeholder="${esc(field.placeholder || '')}" ${dis}>`;
    case 'select':
      return `<select name="${name}" data-field="${esc(field.key)}" ${dis}>
        <option value="">请选择…</option>
        ${field.options.map((o) => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
    case 'radio':
      return `<div class="option-group">${field.options.map((o) => `
        <label class="option-item">
          <input type="radio" name="${name}" data-field="${esc(field.key)}"
            value="${esc(o)}" ${o === value ? 'checked' : ''} ${dis}>
          <span>${esc(o)}</span>
        </label>`).join('')}</div>`;
    case 'checkbox': {
      const arr = Array.isArray(value) ? value : [];
      return `<div class="option-group">${field.options.map((o) => `
        <label class="option-item">
          <input type="checkbox" name="${name}" data-field="${esc(field.key)}"
            value="${esc(o)}" ${arr.includes(o) ? 'checked' : ''} ${dis}>
          <span>${esc(o)}</span>
        </label>`).join('')}</div>`;
    }
    default:
      return `<input type="text" name="${name}" data-field="${esc(field.key)}"
        value="${v}" placeholder="${esc(field.placeholder || '')}" ${dis}>`;
  }
}

// 完整字段块（含标签、必填星号、帮助、校验错误、条件显隐）
export function fieldBlockHtml(def, field, answers, errors = {}, disabled = false) {
  const visible = isFieldVisible(field, answers);
  const err = errors[field.key];
  return `
  <div class="field-block ${visible ? '' : 'field-hidden'}" data-field-block="${esc(field.key)}">
    <label class="field-label">
      ${esc(field.label)}
      ${field.required ? '<span class="req">*</span>' : ''}
      <span class="field-type-tag">${esc(field.type)}${field.visibleWhen ? ' · 条件显示' : ''}</span>
    </label>
    ${field.help ? `<div class="field-help">${esc(field.help)}</div>` : ''}
    ${fieldInputHtml(field, answers[field.key], disabled)}
    ${err ? `<div class="field-error">${esc(err)}</div>` : ''}
  </div>`;
}

function openModal(title, bodyHtml, footerHtml = '', wide = false) {
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="modal-mask" data-modal-close>
      <div class="modal ${wide ? 'modal-wide' : ''}" onclick="event.stopPropagation()">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="btn btn-ghost btn-icon" data-modal-close title="关闭">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-foot">${footerHtml}</div>` : ''}
      </div>
    </div>`;
  modal.classList.add('modal-open');
  modal.querySelectorAll('[data-modal-close]').forEach((el) => {
    el.addEventListener('click', (event) => {
      // 仅当点击直接发生在遮罩或关闭按钮上时才关闭；
      // 内容区内部点击会冒泡到遮罩，不能误关（jsdom 重渲染场景下尤其需要）
      if (el.classList.contains('modal-mask') && event.target !== el) return;
      closeModal();
    });
  });
  return modal;
}

export function closeModal() {
  const modal = document.getElementById('modal-root');
  modal.classList.remove('modal-open');
  modal.innerHTML = '';
}

// 冲突合并弹窗：逐字段选择采用本设备版还是服务端版
export function conflictModalHtml(def, draft, remote, conflictKeys, onResolve) {
  const rows = conflictKeys.map((key) => {
    const field = getField(def, key);
    const label = field ? field.label : key;
    const localVal = draft.answers[key];
    const remoteVal = remote.answers[key];
    return `
      <tr>
        <td><strong>${esc(label)}</strong><br><span class="muted">${esc(key)}</span></td>
        <td class="cell-local">${esc(formatValue(localVal))}</td>
        <td class="cell-remote">${esc(formatValue(remoteVal))}</td>
        <td>
          <label class="choice"><input type="radio" name="conf-${esc(key)}" value="local" checked> 本设备</label>
          <label class="choice"><input type="radio" name="conf-${esc(key)}" value="remote"> 服务端</label>
        </td>
      </tr>`;
  }).join('');

  const footer = `
    <button class="btn btn-ghost" data-modal-close>取消</button>
    <button class="btn btn-primary" id="conf-resolve">应用合并并同步</button>`;

  openModal(`检测到并发修改：样本 ${esc(draft.sampleId)}`, `
    <div class="conflict-summary">
      <p>本设备基于 <strong>rev ${esc(draft.baseRev ?? '?')}</strong> 离线修改，服务端当前为
        <strong>rev ${esc(remote.rev)}</strong>。以下 <strong>${conflictKeys.length}</strong> 个字段存在差异，
        系统不会静默覆盖，请逐字段选择采用哪一版；另一版完整内容会保留在修改记录中。</p>
    </div>
    <table class="table conflict-table">
      <thead><tr><th>字段</th><th>本设备版本</th><th>服务端版本</th><th>采用</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`, footer, true);

  document.getElementById('conf-resolve').addEventListener('click', () => {
    const choices = {};
    for (const key of conflictKeys) {
      choices[key] = document.querySelector(`input[name="conf-${CSS.escape(key)}"]:checked`).value;
    }
    onResolve(choices);
  });
}

// 迁移后无法对应答案的待处理弹窗
export function pendingModalHtml(draft, pending, onResolve) {
  const items = pending.map((p) => `
    <div class="pending-card" data-pending="${esc(p.fieldKey)}">
      <div class="pending-head">
        <strong>${esc(p.label)}</strong>
        ${badge('待处理', 'warn')}
      </div>
      <div class="pending-reason">${esc(p.reason)}</div>
      <div class="pending-value">原值：${esc(formatValue(p.value))}</div>
      <div class="pending-actions">
        <button class="btn btn-sm btn-primary" data-decision="keep-note">保留到新版「备注」字段</button>
        <button class="btn btn-sm btn-ghost" data-decision="discard">丢弃该答案</button>
      </div>
    </div>`).join('');

  openModal(`待人工处理的迁移答案（${pending.length} 项）`, `
    <p class="muted">表单升级后以下答案无法自动映射到新字段。逐项处理完之后草稿才允许同步。</p>
    <div class="pending-list">${items}</div>`, '', true);

  document.querySelectorAll('.pending-card').forEach((card) => {
    const key = card.dataset.pending;
    card.querySelectorAll('button[data-decision]').forEach((btn) => {
      btn.addEventListener('click', () => onResolve(key, btn.dataset.decision));
    });
  });
}

const ACTION_LABELS = {
  create: '新建记录',
  update: '修改记录',
  'conflict-merge': '冲突合并',
  migrate: '表单迁移',
  'draft-create': '创建草稿',
  'draft-update': '本地修改',
  queued: '加入发件箱',
  'pending-resolve': '处理待迁移答案',
};

const ACTION_KINDS = {
  create: 'ok',
  update: 'info',
  'conflict-merge': 'danger',
  migrate: 'warn',
  'draft-create': 'neutral',
  'draft-update': 'neutral',
  queued: 'warn',
  'pending-resolve': 'info',
};

export function historyTimelineHtml(history, versionForLabel) {
  if (!history || !history.length) return '<p class="muted">暂无修改记录</p>';
  return `<div class="timeline">
    ${[...history].reverse().map((h) => `
      <div class="timeline-item">
        <div class="timeline-dot dot-${ACTION_KINDS[h.action] || 'neutral'}"></div>
        <div class="timeline-body">
          <div class="timeline-head">
            ${badge(ACTION_LABELS[h.action] || h.action, ACTION_KINDS[h.action] || 'neutral')}
            <span class="muted">${fmtTime(h.at)}${h.rev ? ` · rev ${esc(h.rev)}` : ''}${h.by ? ` · 设备 ${esc(h.by)}` : ''}</span>
          </div>
          <div class="timeline-detail">${esc(h.detail || '')}</div>
          ${h.merge ? `
            <details class="merge-details">
              <summary>查看冲突合并快照（保留的另一版历史）</summary>
              <div class="merge-cols">
                <div><h4>本设备版快照</h4><pre>${esc(JSON.stringify(h.merge.localSnapshot, null, 2))}</pre></div>
                <div><h4>服务端版快照</h4><pre>${esc(JSON.stringify(h.merge.remoteSnapshot, null, 2))}</pre></div>
              </div>
              <div class="muted">采用本设备：${(h.merge.localPicked || []).map(esc).join('、') || '无'}；
                采用服务端：${(h.merge.remotePicked || []).map(esc).join('、') || '无'}</div>
            </details>` : ''}
          ${h.unmapped?.length ? `
            <details class="merge-details">
              <summary>迁移待处理字段（${h.unmapped.length}）</summary>
              <pre>${esc(JSON.stringify(h.unmapped, null, 2))}</pre>
            </details>` : ''}
        </div>
      </div>`).join('')}
  </div>`;
}

export function showHistoryModal(title, history) {
  openModal(title, historyTimelineHtml(history), '', true);
}
