'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 32145;
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'airchina_config.json');
const HTML_PATH = path.join(ROOT, 'airchina_ui.html');
const OPTIONS_PATH = path.join(ROOT, 'airchina_options.json');
const SCHEDULE_PATH = path.join(ROOT, 'airchina_schedule.json');
const CANCEL_PATH = path.join(ROOT, 'airchina_cancel.signal');
const TOKEN = crypto.randomBytes(24).toString('hex');

const state = {
  running: false,
  action: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  scheduledAt: null,
  logs: [],
};
let scheduleTimer = null;

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function appendLog(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(Boolean);
  for (const line of lines) state.logs.push(line);
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) reject(new Error('请求内容过大。'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('数据格式无效。')); }
    });
    request.on('error', reject);
  });
}

function validateDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`${name}格式无效。`);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`${name}不是有效日期。`);
  }
  return date;
}

function normalizeConfig(input, autoSubmit) {
  const config = {
    personName: String(input.personName || '').trim(),
    employeeId: String(input.employeeId || '').trim(),
    flightPosition: String(input.flightPosition || '').trim(),
    leaveReason: String(input.leaveReason || '').trim(),
    dateMode: input.dateMode === 'calendar' ? 'calendar' : 'range',
    refreshWaitMilliseconds: Math.max(100, Number(input.refreshWaitMilliseconds) || 500),
    submitWaitMilliseconds: Math.max(100, Number(input.submitWaitMilliseconds) || 1500),
    forceLeave: input.forceLeave === true,
    autoSubmit: autoSubmit === true,
    autoConfirm: input.autoConfirm !== false,
  };
  for (const key of ['personName', 'employeeId', 'flightPosition', 'leaveReason']) {
    if (!config[key]) throw new Error(`请填写${key}。`);
  }

  if (config.dateMode === 'calendar') {
    if (!Array.isArray(input.leaveDates) || input.leaveDates.length === 0) throw new Error('请至少选择一个请假日期。');
    config.leaveDates = [...new Set(input.leaveDates.map(String))].sort();
    const dates = config.leaveDates.map((value, index) => validateDate(value, `第${index + 1}个日期`));
    const first = dates[0];
    if (dates.some((date) => date.getFullYear() !== first.getFullYear() || date.getMonth() !== first.getMonth())) {
      throw new Error('日历点选的日期必须在同一个月份。');
    }
    config.days = config.leaveDates.length;
  } else {
    config.startDate = String(input.startDate || '');
    config.endDate = String(input.endDate || '');
    const start = validateDate(config.startDate, '起始日期');
    const end = validateDate(config.endDate, '结束日期');
    if (start > end) throw new Error('结束日期不能早于起始日期。');
    if (start.getFullYear() !== end.getFullYear() || start.getMonth() !== end.getMonth()) {
      throw new Error('起始日期和结束日期必须在同一个月份。');
    }
    config.days = Math.round((end - start) / 86_400_000) + 1;
  }
  return config;
}

function saveConfig(input, autoSubmit) {
  const config = normalizeConfig(input, autoSubmit);
  const temporary = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, CONFIG_PATH);
  return config;
}

function prepareAutomation(action, configInput) {
  let args;
  if (action === 'login') {
    args = ['airchina_web.js', '--login', '--keep-browser-open'];
  } else if (action === 'fill') {
    saveConfig(configInput, false);
    args = ['airchina_web.js', '--keep-browser-open'];
  } else if (action === 'submit') {
    saveConfig(configInput, true);
    args = ['airchina_web.js', '--wait-open', '--allow-submit', '--keep-browser-open'];
  } else {
    throw new Error('未知操作。');
  }
  return args;
}

function launchAutomation(action, args, activeScheduledAt = null) {
  if (state.running) throw new Error('已有任务正在运行，请等待当前任务结束。');

  state.running = true;
  state.scheduledAt = activeScheduledAt;
  state.action = action;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.exitCode = null;
  state.logs = [activeScheduledAt
    ? `定时前登录保活已启动；将于 ${new Date(activeScheduledAt).toLocaleString('zh-CN')} 正式发起。`
    : action === 'login' ? '正在打开登录窗口……' : action === 'fill' ? '正在打开页面并填写……' : '正在等待开放；开放后将自动填写并提交……'];
  fs.rmSync(CANCEL_PATH, { force: true });

  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  child.on('error', (error) => appendLog(`启动失败：${error.message}`));
  child.on('close', (code) => {
    fs.rmSync(CANCEL_PATH, { force: true });
    state.running = false;
    state.scheduledAt = null;
    fs.rmSync(SCHEDULE_PATH, { force: true });
    state.finishedAt = new Date().toISOString();
    state.exitCode = code;
    appendLog(code === 0 ? '任务已完成。' : `任务已停止，退出代码：${code}`);
  });
}

function armSchedule(schedule) {
  clearTimeout(scheduleTimer);
  state.action = schedule.action;
  state.scheduledAt = schedule.scheduledAt;
  state.exitCode = null;
  state.logs = [`任务已安排在 ${new Date(schedule.scheduledAt).toLocaleString('zh-CN')} 发起。`];
  const tick = () => {
    const remaining = new Date(schedule.scheduledAt).getTime() - Date.now();
    if (remaining <= 0) {
      fs.rmSync(SCHEDULE_PATH, { force: true });
      try { launchAutomation(schedule.action, schedule.args); } catch (error) { appendLog(error.message); }
      return;
    }
    scheduleTimer = setTimeout(tick, Math.min(remaining, 60_000));
  };
  tick();
}

function startAutomation(action, configInput, scheduledAt, keepAliveBeforeStart = false, keepAliveIntervalMinutes = 5) {
  if (state.running || state.scheduledAt) throw new Error('已有运行中或已安排的任务，请先等待或取消。');
  const args = prepareAutomation(action, configInput);
  if (scheduledAt) {
    const time = new Date(scheduledAt);
    if (!Number.isFinite(time.getTime()) || time.getTime() <= Date.now()) throw new Error('定时发起时间必须晚于当前时间。');
    const schedule = { action, args, scheduledAt: time.toISOString(), keepAliveBeforeStart: Boolean(keepAliveBeforeStart) };
    fs.writeFileSync(SCHEDULE_PATH, `${JSON.stringify(schedule, null, 2)}\n`, 'utf8');
    if (keepAliveBeforeStart) {
      const minutes = Math.max(0.5, Number(keepAliveIntervalMinutes) || 5);
      args.push(`--start-at=${time.toISOString()}`, `--keep-alive-interval=${Math.round(minutes * 60_000)}`);
      launchAutomation(action, args, time.toISOString());
      return;
    }
    armSchedule(schedule);
    return;
  }
  launchAutomation(action, args);
}

function cancelSchedule() {
  if (!state.scheduledAt) throw new Error('当前没有已安排的任务。');
  if (state.running) {
    fs.writeFileSync(CANCEL_PATH, 'cancel\n', 'utf8');
    appendLog('已发出取消定时保活任务指令；自动操作将停止，专用 Edge 保持打开，等待人工关闭。');
    return;
  }
  clearTimeout(scheduleTimer);
  scheduleTimer = null;
  fs.rmSync(SCHEDULE_PATH, { force: true });
  state.scheduledAt = null;
  state.action = null;
  state.logs = ['已取消定时任务。'];
}

function refreshFormOptions() {
  if (state.running || state.scheduledAt) return Promise.reject(new Error('请先等待当前任务结束或取消定时任务。'));
  state.running = true;
  state.action = 'options';
  state.logs = ['正在从网页读取请假事由……'];
  return new Promise((resolve, reject) => {
    let output = '';
    let resolved = false;
    const child = spawn(process.execPath, ['airchina_web.js', '--export-form-options', '--keep-browser-open'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      appendLog(chunk);
      const match = output.match(/FORM_OPTIONS_JSON:(\{[^\r\n]+\})/);
      if (match && !resolved) {
        const options = JSON.parse(match[1]);
        fs.writeFileSync(OPTIONS_PATH, `${JSON.stringify(options, null, 2)}\n`, 'utf8');
        appendLog(`已读取 ${options.reasons.length} 个请假事由和 ${options.positions.length} 个飞行岗位；网页保持打开。`);
        resolved = true;
        resolve(options);
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk; appendLog(chunk); });
    child.on('close', (code) => {
      state.running = false;
      state.exitCode = code;
      if (!resolved) reject(new Error('未能从网页读取网页选项，请确认登录状态。'));
    });
  });
}

function authorized(request) {
  return request.headers['x-airchina-token'] === TOKEN;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(HTML_PATH, 'utf8').replaceAll('__AIRCHINA_TOKEN__', TOKEN);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/config') {
      if (!authorized(request)) return sendJson(response, 403, { error: '无权访问。' });
      return sendJson(response, 200, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      if (!authorized(request)) return sendJson(response, 403, { error: '无权访问。' });
      return sendJson(response, 200, state);
    }
    if (request.method === 'GET' && url.pathname === '/api/options') {
      if (!authorized(request)) return sendJson(response, 403, { error: '无权访问。' });
      const options = fs.existsSync(OPTIONS_PATH) ? JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')) : { reasons: [] };
      return sendJson(response, 200, options);
    }
    if (request.method === 'POST' && url.pathname === '/api/options/refresh') {
      if (!authorized(request)) return sendJson(response, 403, { error: '无权访问。' });
      return sendJson(response, 200, await refreshFormOptions());
    }
    if (request.method === 'POST' && url.pathname === '/api/save') {
      if (!authorized(request)) return sendJson(response, 403, { error: '无权访问。' });
      const config = saveConfig(await readBody(request), false);
      return sendJson(response, 200, { ok: true, config });
    }
    if (request.method === 'POST' && url.pathname === '/api/run') {
      if (!authorized(request)) return sendJson(response, 403, { error: '无权访问。' });
      const body = await readBody(request);
      startAutomation(
        body.action,
        body.config || {},
        body.scheduledAt || null,
        body.keepAliveBeforeStart === true,
        body.keepAliveIntervalMinutes,
      );
      return sendJson(response, 202, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/schedule/cancel') {
      if (!authorized(request)) return sendJson(response, 403, { error: '无权访问。' });
      cancelSchedule();
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/refresh/cancel') {
      if (!authorized(request)) return sendJson(response, 403, { error: '无权访问。' });
      if (!state.running || state.action !== 'submit') throw new Error('当前没有正在刷新的自动提交任务。');
      fs.writeFileSync(CANCEL_PATH, 'cancel\n', 'utf8');
      appendLog('已发出停止刷新指令；自动操作将停止，专用 Edge 保持打开，等待人工关闭。');
      return sendJson(response, 200, { ok: true });
    }
    return sendJson(response, 404, { error: '页面不存在。' });
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }
});

function openPanel() {
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edge = edgePaths.find(fs.existsSync);
  if (edge) spawn(edge, ['--new-window', `http://${HOST}:${PORT}/`], { detached: true, stdio: 'ignore' }).unref();
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) {
    openPanel();
    process.exit(0);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`国航预占助手已启动：http://${HOST}:${PORT}/`);
  if (fs.existsSync(SCHEDULE_PATH)) {
    try { armSchedule(JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'))); } catch (error) { appendLog(`恢复定时任务失败：${error.message}`); }
  }
  if (process.argv.includes('--open')) openPanel();
});
