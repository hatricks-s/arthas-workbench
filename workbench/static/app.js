const $ = id => document.getElementById(id);
let token = '', state = null, selected = null, jobId = null, timer = null, pollTimer = null, processes = [];
let epoch = 0;
const labels = {ready:'已就绪', unknown:'待探测', unavailable:'不可用', offline:'已离线'};
const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if(className) el.className = className; return el; };
function notice(text) { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(notice.timer); notice.timer = setTimeout(() => $('notice').hidden = true, 6000); }
async function api(path, options={}) {
  const response = await fetch(path, {...options, headers:{'Authorization':`Bearer ${token}`, 'Content-Type':'application/json', ...options.headers}, cache:'no-store'});
  const data = await response.json();
  if(!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
function current() { return state?.instances.find(x => x.id === selected); }
function render() {
  $('account').textContent = state.user;
  $('mcp-url').value = state.mcp_url;
  const list = $('target-list'); list.replaceChildren();
  if(!state.instances.length) { const p=node('p','暂无已登记实例。请启动已配置的连接器。','hint'); p.style.padding='20px'; list.append(p); }
  for(const item of state.instances) {
    const button=node('button','','target'); button.setAttribute('aria-pressed',String(item.id===selected));
    const line=node('span','','target-line'); line.append(node('strong',item.name),node('span',labels[item.status]||item.status,`status ${item.status}`));
    button.append(line,node('small',`${item.kind==='k8s'?'K8S':'LOCAL'} / ${item.id}`));
    button.onclick=()=>{ if(jobId && item.id!==selected) { notice('请等待当前操作完成，或取消等待后再切换实例。'); return; } selected=item.id; processes=[]; $('processes').hidden=true; $('result').textContent='选择工具后运行，结果会显示在这里。'; $('job-state').textContent='尚未执行'; render(); };
    list.append(button);
  }
  $('node-list').replaceChildren();
  for(const item of state.nodes) { const row=node('div','','node');row.append(node('span',item.id),node('span',item.online?'在线':'离线',`status ${item.online?'ready':'offline'}`));$('node-list').append(row); }
  const item=current(); $('no-selection').hidden=!!item; $('selection').hidden=!item;
  if(!item)return;
  $('target-kind').textContent=item.kind==='k8s'?'KUBERNETES / JAVA TARGET':'LOCAL CONNECTOR / JAVA TARGET';
  $('target-name').textContent=item.name; $('target-id').textContent=item.id;
  $('target-status').textContent=labels[item.status]||item.status; $('target-status').className=`status ${item.status}`;
  $('target-detail').textContent=item.detail||'先检查连接，确认 Arthas 端点、协议和可用工具。';
  const connector=state.nodes.find(x=>x.id===item.node_id);
  $('probe').disabled=!!jobId||!connector?.online;
  $('run').disabled=$('probe').disabled||item.status==='unavailable';
  $('scan').hidden=item.kind!=='local'; $('scan').disabled=!!jobId||!connector?.capabilities.includes('scan_java');
  $('attach').disabled=!!jobId||!processes.length||!connector?.capabilities.includes('attach_local')||!state.scopes.includes('attach');
}
async function refresh() {
  const version=epoch;
  try { const value=await api('/api/state'); if(version!==epoch)return; state=value; $('sync-state').textContent='已同步'; render(); }
  catch(error) { if(version!==epoch)return; $('sync-state').textContent='同步失败'; notice(error.message); }
}
$('login-form').onsubmit=async event=>{ event.preventDefault(); token=$('token').value.trim(); try { state=await api('/api/state'); epoch++; $('token').value=''; $('login').hidden=true; $('workspace').hidden=false; render(); clearInterval(timer);timer=setInterval(refresh,4000); }catch(error){token='';notice(error.message);} };
$('logout').onclick=()=>{epoch++;token='';state=null;selected=null;jobId=null;clearInterval(timer);clearTimeout(pollTimer);$('login').hidden=false;$('workspace').hidden=true;$('cancel').hidden=true;};
$('refresh').onclick=refresh;
$('theme').onclick=()=>{ const dark=document.documentElement.dataset.theme==='dark';document.documentElement.dataset.theme=dark?'light':'dark'; };
if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.dataset.theme='dark';
$('copy').onclick=async()=>{ try { await navigator.clipboard.writeText($('mcp-url').value);notice('MCP 地址已复制'); }catch { $('mcp-url').select();notice('请复制已选中的 MCP 地址'); } };
async function start(operation, onResult) {
  if(jobId)return;
  const version=epoch;
  try {
    const job=await api('/api/jobs',{method:'POST',body:JSON.stringify(operation)});if(version!==epoch)return;
    jobId=job.id;$('job-state').textContent='执行中';$('cancel').hidden=false;$('result').textContent='请求已提交，正在等待目标返回…';render();
    const poll=async()=>{
      try {
        const status=await api(`/api/jobs/${job.id}`);if(version!==epoch)return;
        if(status.status==='running'){pollTimer=setTimeout(poll,700);return;}
        jobId=null;$('cancel').hidden=true;$('job-state').textContent=({succeeded:'已完成',failed:'执行失败',cancelled:'已取消'})[status.status];
        $('result').textContent=status.error||JSON.stringify(status.result,null,2);
        if(status.status==='succeeded'&&onResult)onResult(status.result);render();
      }catch(error){if(version!==epoch)return;jobId=null;$('cancel').hidden=true;$('job-state').textContent='请求失败';$('result').textContent=error.message;render();}
    };await poll();
  }catch(error){if(version!==epoch)return;notice(error.message);render();}
}
$('probe').onclick=()=>start({action:'probe',instance_id:selected});
$('scan').onclick=()=>start({action:'scan_java',node_id:current().node_id},result=>{
  processes=result.processes||[];$('pid').replaceChildren();
  for(const process of processes){const option=node('option',`${process.pid} · ${process.identity}`);option.value=String(process.pid);$('pid').append(option);}
  $('processes').hidden=false;if(!processes.length)notice(result.detail||'没有发现可访问的 Java 进程');
});
$('attach').onclick=()=>{const process=processes.find(p=>String(p.pid)===$('pid').value);if(!process)return;if(!confirm(`确认 Attach 到 PID ${process.pid}？\n${process.identity}\n\n连接器会再次核对进程身份。`))return;start({action:'attach_local',instance_id:selected,pid:process.pid,identity:process.identity});};
$('tool').onchange=()=>{ $('trace-fields').hidden=!['trace','watch'].includes($('tool').value); };
$('diagnose-form').onsubmit=event=>{event.preventDefault();const tool=$('tool').value;let args={};if(tool==='thread')args={topN:5};if(['trace','watch'].includes(tool)){const classPattern=$('class-pattern').value.trim();if(!classPattern){notice('请填写目标类名');$('class-pattern').focus();return;}args={classPattern,methodPattern:$('method-pattern').value.trim()||'*',timeout:Number($('timeout').value),numberOfExecutions:1};if(tool==='watch')args.express='{params,returnObj,throwExp}';}start({action:'diagnose',instance_id:selected,tool,arguments:args});};
$('cancel').onclick=async()=>{if(!jobId)return;try{await api(`/api/jobs/${jobId}`,{method:'DELETE'});notice('取消请求已提交');}catch(error){notice(error.message);}};
