'use strict';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const node = (tag, text = '', className = '') => {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
};
const icon = name => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};
const labels = {ready: '端点可达', unknown: '待验证', unavailable: '端点不可达', offline: '节点离线'};
const jobLabels = {running: '执行中', succeeded: '已完成', failed: '执行失败', cancelled: '已取消'};
const pageLabels = {connections: '连接与诊断', history: '诊断记录', mcp: 'MCP 接入', resources: '资源与助手'};
const tools = {
  jvm: {name: 'JVM 概览', help: '读取 JVM 运行环境，不需要输入参数。'},
  memory: {name: 'Memory', help: '查看当前内存信息，不会触发堆转储。'},
  thread: {name: 'Thread', help: '查看繁忙线程；可指定返回的线程数量。'},
  trace: {name: 'Trace', help: '跟踪方法内部调用，等待目标方法实际执行。'},
  watch: {name: 'Watch', help: '观察一次调用的入参、返回值与异常。'},
  version: {name: 'Version', help: '读取当前目标的 Arthas 版本。'}
};
let token = '', state = null, selected = null, selectedTool = 'jvm', filter = 'all';
let page = 'connections', jobId = null, submitting = false, epoch = 0, refreshing = false;
let timer = null, pollTimer = null, processes = [], pendingAttach = null, history = [];
const verified = new Map();
const results = new Map();
const busy = () => submitting || !!jobId;
const current = () => state?.instances.find(item => item.id === selected);
const connectorFor = item => state?.nodes.find(itemNode => itemNode.id === item?.node_id);
const statusText = item => item.status === 'ready' && verified.has(item.id) ? 'MCP 已验证' : labels[item.status] || item.status;

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { $('notice').hidden = true; }, 6500);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers},
    cache: 'no-store'
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`服务返回了无法识别的响应 (${response.status})`); }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function showPage(next) {
  if (!state || !pageLabels[next]) return;
  page = next;
  for (const [key, label] of Object.entries(pageLabels)) {
    $(`page-${key}`).hidden = key !== page;
    if (key === page) {
      $('page-label').textContent = label;
      document.title = `Arthas Workbench · ${label}`;
    }
  }
  all('#navigation [data-page]').forEach(button => {
    const active = button.dataset.page === page;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (page === 'history') renderHistory();
  window.scrollTo(0, 0);
}
all('[data-page]').forEach(button => { button.onclick = () => showPage(button.dataset.page); });

function setTab(name, focus = false) {
  for (const tab of ['diagnostics', 'connection']) {
    const active = tab === name;
    const button = $(`tab-${tab}`);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(tab === 'diagnostics' ? 'diagnostic-panel' : 'connection-panel').hidden = !active;
    if (active && focus) button.focus();
  }
}
for (const name of ['diagnostics', 'connection']) {
  $(`tab-${name}`).onclick = () => setTab(name);
  $(`tab-${name}`).onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'diagnostics' : event.key === 'End' ? 'connection' : name === 'diagnostics' ? 'connection' : 'diagnostics';
    setTab(next, true);
  };
}

function renderTargets() {
  const list = $('target-list');
  const focusedTarget = list.contains(document.activeElement) ? document.activeElement.dataset.target : null;
  const search = $('target-search').value.trim().toLocaleLowerCase();
  const items = state.instances.filter(item => (filter === 'all' || item.kind === filter) &&
    `${item.name} ${item.id}`.toLocaleLowerCase().includes(search));
  list.replaceChildren();
  $('target-count').textContent = String(state.instances.length);
  if (!items.length) {
    list.append(node('p', state.instances.length ? '没有匹配的实例，试试其他关键词或连接类型。' : '暂无已登记实例，请先接入执行节点。', 'list-empty hint'));
  }
  for (const item of items) {
    const button = node('button', '', 'target');
    button.dataset.target = item.id;
    button.setAttribute('aria-pressed', String(item.id === selected));
    button.setAttribute('aria-label', `${item.name}，${item.kind === 'local' ? '本机' : 'K8s'}，${statusText(item)}`);
    const line = node('span', '', 'target-line');
    line.append(icon(item.kind === 'k8s' ? 'cluster' : 'monitor'), node('strong', item.name));
    const bottom = node('span', '', 'target-bottom');
    bottom.append(node('span', item.kind === 'k8s' ? 'KUBERNETES' : 'LOCAL JVM', 'target-kind-label'), node('span', statusText(item), `status ${item.status}`));
    button.append(line, node('small', item.id), bottom);
    button.onclick = () => selectTarget(item.id);
    list.append(button);
    if (focusedTarget === item.id) button.focus({preventScroll: true});
  }
}
function selectTarget(id) {
  if (busy() && id !== selected) {
    notice('当前操作仍在进行。完成或取消后可切换目标。');
    return;
  }
  if (id !== selected) {
    selected = id;
    processes = [];
    $('processes').hidden = true;
    $('pid').replaceChildren();
    pendingAttach = null;
    setTab('diagnostics');
  }
  render();
}
function render() {
  if (!state) return;
  $('account').textContent = state.user;
  $('account').title = state.user;
  $('mcp-url').value = state.mcp_url;
  $('mcp-config').textContent = JSON.stringify({mcpServers: {'arthas-workbench': {
    type: 'http', url: state.mcp_url, headers: {Authorization: 'Bearer <YOUR_USER_TOKEN>'}
  }}}, null, 2);
  const online = state.nodes.filter(item => item.online).length;
  $('connection-health').replaceChildren(node('span', '', 'small-dot'), document.createTextNode(online ? `${online} 个节点在线` : '等待节点接入'));
  $('connection-health').classList.toggle('online', online > 0);
  $('step-node').textContent = online ? `${online} 个执行节点在线` : '等待助手接入';
  $('step-target').textContent = selected ? '已选择目标实例' : '扫描或选择实例';
  $('step-probe').textContent = verified.has(selected) ? '本页 MCP 验证通过' : '检查 HTTP / MCP';
  renderTargets();
  $('node-list').replaceChildren();
  for (const item of state.nodes) {
    const row = node('div', '', 'node');
    row.append(node('span', item.id), node('span', item.online ? '在线' : '离线', `status ${item.online ? 'ready' : 'offline'}`));
    $('node-list').append(row);
  }
  if (!state.nodes.length) $('node-list').append(node('p', '尚未授权任何节点。', 'hint'));
  const item = current();
  $('no-selection').hidden = !!item;
  $('selection').hidden = !item;
  $('refresh').disabled = refreshing;
  $('clear-history').disabled = busy() || !history.length;
  if (!item) return;
  $('target-icon').replaceChildren(icon(item.kind === 'k8s' ? 'cluster' : 'monitor'));
  $('target-kind').textContent = item.kind === 'k8s' ? 'KUBERNETES / JAVA TARGET' : 'LOCAL CONNECTOR / JAVA TARGET';
  $('target-name').textContent = item.name;
  $('target-id').textContent = item.id;
  $('target-status').textContent = statusText(item);
  $('target-status').className = `status ${item.status}`;
  $('target-detail').textContent = item.detail || '验证连接后，选择诊断工具开始调用。';
  const connector = connectorFor(item);
  const canDiagnose = state.scopes.includes('diagnose');
  const canScan = connector?.online && connector.capabilities.includes('scan_java');
  const canAttach = connector?.online && connector.capabilities.includes('attach_local') && state.scopes.includes('attach');
  $('probe').disabled = busy() || !connector?.online || !canDiagnose;
  $('probe').classList.toggle('primary', !verified.has(item.id));
  $('probe').title = !canDiagnose ? '当前账户没有诊断权限' : !connector?.online ? '请先连接执行节点' : '握手并查询目标的 MCP 工具';
  $('scan').hidden = item.kind !== 'local';
  $('scan').disabled = busy() || !canScan;
  $('scan').title = canScan ? '扫描此助手可访问的 JVM' : '助手未在线或尚未开放扫描能力';
  $('attach').disabled = busy() || !processes.length || !canAttach;
  $('pid').disabled = busy() || !processes.length;
  $('attach-hint').textContent = !canAttach ? '当前账户或助手尚未开放 Attach 权限。' : 'Attach 前会再次核对 PID 与进程身份。';
  $('fact-id').textContent = item.id;
  $('fact-node').textContent = `${item.node_id} · ${connector?.online ? '在线' : '离线'}`;
  $('fact-kind').textContent = item.kind === 'k8s' ? 'K8s 执行节点 → Pod 端口转发' : '本机助手 → JVM HTTP / MCP';
  const check = verified.get(item.id);
  $('fact-verified').textContent = check ? `本页验证通过 · ${check.time}` : '尚未在本页验证';
  renderTool();
  renderResult();
}

function renderTool() {
  const item = current();
  const connector = connectorFor(item);
  const check = verified.get(item?.id);
  const long = ['trace', 'watch'].includes(selectedTool);
  all('[data-tool]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.tool === selectedTool));
    button.disabled = busy();
  });
  $('trace-fields').hidden = !long;
  $('thread-fields').hidden = selectedTool !== 'thread';
  $('watch-expression').hidden = selectedTool !== 'watch';
  // Inactive inputs must not take part in native form validation.
  for (const id of ['class-pattern', 'method-pattern', 'timeout']) $(id).disabled = !long || busy();
  $('class-pattern').required = long;
  $('top-n').disabled = selectedTool !== 'thread' || busy();
  $('tool-help').textContent = tools[selectedTool].help;
  const reason = !item ? '先选择一个目标实例。' : !connector?.online ? '执行节点已离线，请等待助手重新连接。' :
    !state.scopes.includes('diagnose') ? '当前账户没有诊断权限。' :
    !check ? '先点击“验证连接”，确认目标的 MCP 能力。' :
    !check.tools.includes(selectedTool) ? '目标未提供这个诊断工具。' :
    long && !check.tasks ? '目标没有声明任务能力，暂不能运行 Trace / Watch。' : '';
  $('run').disabled = busy() || !!reason;
  $('run-disabled-reason').hidden = !reason;
  $('run-disabled-reason').textContent = reason;
  $('run-label').textContent = busy() ? '处理中…' : '运行诊断';
}
all('[data-tool]').forEach(button => {
  button.onclick = () => { if (!busy()) { selectedTool = button.dataset.tool; renderTool(); } };
});
all('[data-filter]').forEach(button => {
  button.onclick = () => {
    filter = button.dataset.filter;
    all('[data-filter]').forEach(other => other.setAttribute('aria-pressed', String(other.dataset.filter === filter)));
    renderTargets();
  };
});
$('target-search').oninput = () => { if (state) renderTargets(); };

function formatResult(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function renderResult() {
  const record = results.get(selected);
  $('result-empty').hidden = !!record;
  $('result').hidden = !record;
  $('result').textContent = record?.text || '';
  $('job-state').textContent = record ? jobLabels[record.status] || record.status : '尚未执行';
  $('result-dot').className = `result-dot ${record?.status || ''}`;
  $('copy-result').disabled = !record || record.status === 'running';
  $('cancel').hidden = !jobId || !record || record.status !== 'running';
  $('result-context').textContent = record ? `${record.label} · ${record.time}${record.simulated ? ' · 模拟结果' : ''}` : '等待首次调用';
}
function renderHistory() {
  $('history-count').textContent = String(history.length);
  const list = $('history-list');
  const expanded = new Set([...list.querySelectorAll('details[open]')].map(element => element.dataset.job));
  list.replaceChildren();
  $('clear-history').disabled = busy() || !history.length;
  if (!history.length) {
    const empty = node('div', '', 'panel empty');
    empty.append(icon('clock'), node('h2', '还没有诊断记录'), node('p', '验证连接或运行一次诊断，操作与结果就会出现在这里。'));
    list.append(empty);
    return;
  }
  for (const record of [...history].reverse()) {
    const entry = node('details', '', 'panel history-entry');
    entry.dataset.job = record.id;
    entry.open = expanded.has(record.id);
    const summary = node('summary');
    const description = node('span', '', 'history-label');
    description.append(node('strong', record.label), node('small', record.target));
    summary.append(description, node('span', record.time, 'history-time'), node('span', jobLabels[record.status] || record.status, `status ${record.status}`));
    const output = node('pre', record.text);
    output.tabIndex = 0;
    entry.append(summary, output);
    list.append(entry);
  }
}
$('clear-history').onclick = () => {
  if (busy()) return;
  history = [];
  results.clear();
  renderHistory();
  renderResult();
  notice('本页记录已清空');
};

async function refresh() {
  if (!token || refreshing) return;
  const version = epoch;
  refreshing = true;
  $('refresh').disabled = true;
  try {
    const value = await api('/api/state');
    if (version !== epoch) return;
    const changed = JSON.stringify(value) !== JSON.stringify(state);
    state = value;
    for (const id of verified.keys()) {
      const item = state.instances.find(candidate => candidate.id === id);
      if (!item || item.status !== 'ready' || !connectorFor(item)?.online) verified.delete(id);
    }
    if (!current() && !busy()) selected = state.instances[0]?.id || null;
    const recovering = $('sync-state').textContent === '同步失败';
    $('sync-state').textContent = '刚刚同步';
    if (changed || recovering) render();
  } catch (error) {
    if (version !== epoch) return;
    verified.clear();
    $('sync-state').textContent = '同步失败';
    if (error.status === 401) { logout(); notice('登录已失效，请重新输入用户令牌。'); }
    else {
      render();
      $('connection-health').replaceChildren(node('span', '', 'small-dot'), document.createTextNode('同步中断'));
      $('connection-health').classList.remove('online');
      notice(`连接状态暂时无法更新：${error.message}`);
    }
  } finally {
    if (version === epoch) { refreshing = false; $('refresh').disabled = false; }
  }
}
$('refresh').onclick = refresh;
$('login-form').onsubmit = async event => {
  event.preventDefault();
  if ($('login-submit').disabled) return;
  $('login-submit').disabled = true;
  token = $('token').value.trim();
  const version = epoch;
  try {
    const value = await api('/api/state');
    if (version !== epoch) return;
    state = value;
    epoch++;
    selected = state.instances.find(item => item.status === 'ready')?.id || state.instances[0]?.id || null;
    $('token').value = '';
    $('login').hidden = true;
    $('workspace').hidden = false;
    $('navigation').hidden = false;
    $('logout').hidden = false;
    $('sync-state').textContent = '刚刚同步';
    $('mcp-preview-note').hidden = !window.WORKBENCH_PREVIEW;
    showPage('connections');
    render();
    clearInterval(timer);
    timer = setInterval(refresh, 4000);
  } catch (error) { token = ''; notice(error.message); }
  finally { $('login-submit').disabled = false; }
};
function logout() {
  const pending = busy();
  epoch++;
  token = ''; state = null; selected = null; jobId = null; submitting = false; refreshing = false;
  processes = []; history = []; pendingAttach = null; selectedTool = 'jvm'; filter = 'all';
  verified.clear(); results.clear();
  clearInterval(timer); clearTimeout(pollTimer);
  $('login').hidden = false; $('workspace').hidden = true; $('navigation').hidden = true; $('logout').hidden = true;
  $('result').textContent = ''; $('history-list').replaceChildren(); $('history-count').textContent = '0'; $('pid').replaceChildren(); $('processes').hidden = true;
  for (const id of ['fact-id', 'fact-node', 'fact-kind', 'fact-verified', 'target-kind', 'target-status', 'result-context']) $(id).textContent = '';
  $('target-search').value = ''; $('class-pattern').value = ''; $('method-pattern').value = '*'; $('timeout').value = '30'; $('top-n').value = '5';
  $('mcp-url').value = ''; $('mcp-config').textContent = ''; $('account').textContent = '未登录';
  $('target-list').replaceChildren(); $('node-list').replaceChildren(); $('attach-target').textContent = '';
  $('target-name').textContent = ''; $('target-id').textContent = ''; $('target-detail').textContent = '';
  $('guide-dialog').close(); $('attach-dialog').close();
  all('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === 'all')));
  $('connection-health').replaceChildren(node('span', '', 'small-dot'), document.createTextNode('等待登录'));
  $('connection-health').classList.remove('online');
  $('token').focus();
  if (pending) notice('已退出。服务端已提交的操作可能仍在执行，退出不会停止目标 JVM。');
}
$('logout').onclick = logout;
$('theme').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').setAttribute('aria-label', `切换到${dark ? '浅色' : '深色'}主题`);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#141719' : '#f5f6f3';
};
async function copyText(text, element, message) {
  try { await navigator.clipboard.writeText(text); notice(message); }
  catch {
    if (typeof element.select === 'function') { element.focus(); element.select(); }
    else {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    notice('浏览器未允许自动复制，已选中内容，可手动复制。');
  }
}
$('copy').onclick = () => copyText($('mcp-url').value, $('mcp-url'), 'MCP 地址已复制');
$('copy-config').onclick = () => copyText($('mcp-config').textContent, $('mcp-config'), '配置模板已复制，请替换令牌占位符');
$('copy-result').onclick = () => copyText($('result').textContent, $('result'), '执行结果已复制');

async function start(operation, onResult) {
  if (busy() || !current()) return;
  const version = epoch;
  const target = selected;
  const actionLabels = {probe: '验证 MCP 连接', scan_java: '扫描 Java 进程', attach_local: 'Attach 并连接'};
  const record = {
    id: `pending-${Date.now()}`, target, label: actionLabels[operation.action] || tools[operation.tool]?.name || '诊断',
    status: 'running', time: new Date().toLocaleTimeString('zh-CN', {hour12: false}),
    text: '正在提交请求…', simulated: !!window.WORKBENCH_PREVIEW
  };
  submitting = true;
  results.set(target, record);
  setTab('diagnostics');
  render();
  try {
    const job = await api('/api/jobs', {method: 'POST', body: JSON.stringify(operation)});
    if (version !== epoch) return;
    jobId = job.id;
    submitting = false;
    record.id = job.id;
    record.text = ['trace', 'watch'].includes(operation.tool) ? '任务已提交，等待目标方法实际执行…\n可取消等待；不会自动重放调用。' : '请求已提交，正在等待目标返回…';
    history.push(record);
    if (history.length > 50) history.shift();
    renderHistory(); render();
    let pollErrors = 0;
    const poll = async () => {
      try {
        const status = await api(`/api/jobs/${job.id}`);
        if (version !== epoch) return;
        pollErrors = 0;
        if (status.status === 'running') { pollTimer = setTimeout(poll, 700); return; }
        jobId = null;
        const resultFailed = status.result?.isError === true || status.result?.success === false;
        record.status = resultFailed ? 'failed' : status.status;
        record.text = status.error || formatResult(status.result) || '操作已结束，没有返回内容。';
        if (record.status === 'succeeded' && onResult) onResult(status.result);
        if (record.status === 'failed' && ['probe', 'diagnose', 'attach_local'].includes(operation.action)) verified.delete(target);
        renderHistory(); render();
        await refresh();
      } catch (error) {
        if (version !== epoch) return;
        if (error.status === 401) { logout(); notice('登录已失效，请重新登录。已提交的操作不会重放。'); return; }
        if (error.status === 404) {
          jobId = null; record.status = 'failed'; record.text = '服务端不再提供此任务记录，执行结果未知。请验证连接后再继续。';
          verified.delete(target); renderHistory(); render(); return;
        }
        pollErrors++;
        record.text = `暂时无法读取任务状态：${error.message}\n正在重试读取结果，不会重新执行诊断。`;
        renderResult();
        if (pollErrors === 1) notice('读取任务状态失败，正在恢复查询。');
        pollTimer = setTimeout(poll, 4000);
      }
    };
    await poll();
  } catch (error) {
    if (version !== epoch) return;
    submitting = false;
    record.status = 'failed';
    record.text = `${error.message}\n${error.status ? '服务拒绝了此次请求。' : '未收到提交确认，执行状态未知；不会自动重试提交。'}`;
    history.push(record);
    if (history.length > 50) history.shift();
    renderHistory(); render(); notice(error.message);
  }
}
$('probe').onclick = () => {
  const id = selected;
  start({action: 'probe', instance_id: id}, result => {
    const names = (result.tools || []).map(tool => typeof tool === 'string' ? tool : tool.name);
    verified.set(id, {tools: names, tasks: result.tasks === true, time: new Date().toLocaleTimeString('zh-CN', {hour12: false})});
    notice('MCP 握手完成，已读取目标工具列表。');
  });
};
$('scan').onclick = () => {
  const item = current();
  if (!item) return;
  start({action: 'scan_java', node_id: item.node_id}, result => {
    processes = result.processes || [];
    $('pid').replaceChildren();
    for (const process of processes) {
      const option = node('option', `${process.pid} · ${process.identity}`);
      option.value = String(process.pid);
      $('pid').append(option);
    }
    $('processes').hidden = false;
    if (!processes.length) notice(result.detail || '没有发现当前助手可访问的 Java 进程。');
  });
};
$('close-processes').onclick = () => { $('processes').hidden = true; };
$('attach').onclick = () => {
  const process = processes.find(candidate => String(candidate.pid) === $('pid').value);
  if (!process || busy()) return;
  pendingAttach = {pid: process.pid, identity: process.identity, instance_id: selected};
  $('attach-target').textContent = `PID ${process.pid}\n${process.identity}`;
  $('attach-dialog').showModal();
};
function closeAttach() { $('attach-dialog').close(); pendingAttach = null; }
$('close-attach').onclick = closeAttach;
$('dismiss-attach').onclick = closeAttach;
$('attach-dialog').addEventListener('cancel', () => { pendingAttach = null; });
$('confirm-attach').onclick = () => {
  const process = pendingAttach;
  if (!process || process.instance_id !== selected || busy() || $('attach').disabled) { closeAttach(); return; }
  closeAttach();
  verified.delete(selected);
  start({action: 'attach_local', ...process}, () => notice('Attach 操作已返回。请验证 MCP 连接后开始诊断。'));
};
$('diagnose-form').onsubmit = event => {
  event.preventDefault();
  if ($('run').disabled || !current()) return;
  const tool = selectedTool;
  let args = {};
  if (tool === 'thread') {
    const topN = Number($('top-n').value);
    if (!Number.isInteger(topN) || topN < 1 || topN > 50) { notice('线程数量应为 1–50 的整数。'); return; }
    args = {topN};
  }
  if (['trace', 'watch'].includes(tool)) {
    const classPattern = $('class-pattern').value.trim();
    const timeout = Number($('timeout').value);
    if (!classPattern) { notice('请填写目标类名。'); $('class-pattern').focus(); return; }
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) { notice('等待时间应为 1–300 秒的整数。'); return; }
    args = {classPattern, methodPattern: $('method-pattern').value.trim() || '*', timeout, numberOfExecutions: 1};
    if (tool === 'watch') args.express = '{params,returnObj,throwExp}';
  }
  start({action: 'diagnose', instance_id: selected, tool, arguments: args});
};
$('cancel').onclick = async () => {
  if (!jobId) return;
  const version = epoch;
  $('cancel').disabled = true;
  try {
    await api(`/api/jobs/${jobId}`, {method: 'DELETE'});
    if (version === epoch) notice('取消请求已提交。取消等待不保证撤回已经开始的操作。');
  } catch (error) { if (version === epoch) notice(error.message); }
  finally { $('cancel').disabled = false; }
};

const guides = {
  connect: {title: '把目标接入工作台', intro: '当前版本通过已配置的助手接入目标。扫描和诊断由助手在目标环境中执行。', steps: [
    ['本机 Java', '运行配置好的本机助手，选择本机实例，再扫描 Java 进程。已有 Arthas 端点可先验证连接。'],
    ['Kubernetes', '管理员为执行节点配置 kubeconfig、命名空间、Pod 与 Arthas HTTP 端口。节点建立转发后，这里会出现目标。'],
    ['验证并开始诊断', '验证 HTTP / MCP 通道，检查工具能力，再运行诊断或接入 MCP 客户端。']
  ], note: '一键安装、设备配对、动态实例登记与自动复用正在规划中，当前页面不会替你创建这些配置。'},
  local: {title: '接入本机助手', intro: '助手在你的电脑运行，主动连接中心服务。网页通过助手扫描和操作 Java 进程。', steps: [
    ['准备助手配置', '管理员配置中心地址、节点身份与本机目标。用户令牌和节点令牌分别使用。'],
    ['运行助手并扫描', '助手上线后，在“连接与诊断”选择本机目标，点击“扫描 Java”。'],
    ['明确选择目标', '选择进程并确认 Attach。助手检查进程身份，使用独立资源目录，默认关闭 Telnet。']
  ], note: '当前原型没有可下载的一键安装包。Attach 需要助手配置 Arthas 资源目录、开放权限，并满足目标 JVM 的 Attach 条件。'},
  k8s: {title: '接入 Kubernetes', intro: '执行节点负责访问集群和建立 Pod 转发，同事通过统一网页访问授权目标。', steps: [
    ['准备执行节点', '由管理员配置 kubeconfig、命名空间、Pod 和远端 Arthas HTTP 端口。'],
    ['建立 Pod 转发', '节点在本机分配转发端口，通过反向连接将 HTTP / MCP 请求转到 Pod。'],
    ['验证可用能力', '在工作台选择 K8s 目标，验证连接后运行诊断。离线状态不会被当作已连接。']
  ], note: 'Pod 内当前需要已有可用 Arthas。Perl 资源传输与 K8s 自动 Attach 尚未实现，不依赖 OBS。'},
  assets: {title: 'Arthas 资源准备流程', intro: '最终目标是由中心统一管理 arthas-bin.zip，用户只需运行助手。', steps: [
    ['中心管理资源', '登记 Arthas 版本、包大小与 SHA-256 校验值，选定团队使用的资源版本。'],
    ['助手按需准备', '助手下载、校验并缓存资源；本机进程扫描可独立进行，不必等待下载。'],
    ['连接选中的 JVM', '确认目标与权限后，使用准备好的资源 Attach，再验证 HTTP / MCP 通道。']
  ], note: '以上自动下发流程尚未接入。当前原型使用管理员预先配置的本地 Arthas 目录，不会在此页面触发下载。'},
  capabilities: {title: '完整诊断能力，一步步接入', intro: '核心能力会集中在同一工作台，通过表单操作与 MCP 调用，不提供 Telnet 交互终端。', steps: [
    ['现在可用 · 基础诊断', 'JVM、Memory、Thread、Version。本机与 K8s 目标共用调用链路。'],
    ['现在可用 · 方法观察', 'Trace 查看方法内部调用，Watch 观察入参、返回值与异常。需要目标支持任务能力。'],
    ['待接入 · 深度诊断', 'OGNL 表达式、类与方法检索、反编译、Profiler、Dump、编译与热更新；OGNL 需一并补齐超时与 JDBC 防护。'],
    ['待接入 · 团队协作', '服务器资源下发、自动配对、动态实例登记、已有 Arthas 复用、持久审计。']
  ], note: '“现在可用”指网关已接入的功能，仍取决于目标 Arthas 能力与用户权限。静态预览全部使用模拟数据。'}
};
function openGuide(key) {
  const guide = guides[key];
  if (!guide) return;
  $('guide-title').textContent = guide.title;
  const content = $('guide-content');
  content.replaceChildren(node('p', guide.intro));
  const list = node('ol', '', 'setup-list');
  guide.steps.forEach(([title, description], index) => {
    const item = node('li');
    const text = node('div');
    text.append(node('strong', title), node('p', description));
    item.append(node('span', String(index + 1).padStart(2, '0')), text);
    list.append(item);
  });
  content.append(list, node('p', guide.note, 'hint'));
  $('guide-dialog').showModal();
}
all('[data-guide]').forEach(button => { button.onclick = () => openGuide(button.dataset.guide); });
$('close-guide').onclick = () => $('guide-dialog').close();
$('guide-done').onclick = () => $('guide-dialog').close();
for (const id of ['guide-dialog', 'attach-dialog']) {
  $(id).addEventListener('click', event => {
    const bounds = $(id).getBoundingClientRect();
    if (event.target === $(id) && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
      if (id === 'attach-dialog') closeAttach(); else $(id).close();
    }
  });
}
// Authentication and diagnostic data deliberately never enter persistent browser storage.
