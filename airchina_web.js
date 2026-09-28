'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright-core');

const APP_URL = 'https://hv5zjf4j8yb.feishuapp.com/app/app_17cz0pmhz37/apply';
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AirChinaWebAutomation', 'edge-profile');
const CONFIG_PATH = path.join(__dirname, 'airchina_config.json');
const CANCEL_PATH = path.join(__dirname, 'airchina_cancel.signal');

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function readConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const required = ['personName', 'employeeId', 'flightPosition', 'leaveReason'];
  for (const key of required) {
    if (config[key] === undefined || config[key] === null || config[key] === '') {
      throw new Error(`配置缺少必填项：${key}`);
    }
  }
  config.forceLeave = config.forceLeave === true;

  config.dateMode = config.dateMode || (Array.isArray(config.leaveDates) ? 'calendar' : 'range');
  if (!['calendar', 'range'].includes(config.dateMode)) {
    throw new Error('dateMode 只能是 calendar 或 range。');
  }

  if (config.dateMode === 'calendar') {
    if (!Array.isArray(config.leaveDates) || config.leaveDates.length === 0) {
      throw new Error('日历点选模式下 leaveDates 必须是非空日期数组。');
    }
    if (new Set(config.leaveDates).size !== config.leaveDates.length) {
      throw new Error('leaveDates 中不能有重复日期，否则重复点击会取消选择。');
    }
    const dates = config.leaveDates.map((value, index) => parseDate(value, `leaveDates[${index}]`));
    const first = dates[0];
    if (dates.some((date) => date.getFullYear() !== first.getFullYear() || date.getMonth() !== first.getMonth())) {
      throw new Error('日历点选模式下的请假日期必须在同一个月份。');
    }
    config.leaveDates = [...config.leaveDates].sort();
    config.days = config.leaveDates.length;
  } else {
    for (const key of ['startDate', 'endDate']) {
      if (config[key] === undefined || config[key] === null || config[key] === '') {
        throw new Error(`配置缺少必填项：${key}`);
      }
    }
    const start = parseDate(config.startDate, 'startDate');
    const end = parseDate(config.endDate, 'endDate');
    if (start > end) throw new Error('结束日期不能早于起始日期。');
    if (start.getFullYear() !== end.getFullYear() || start.getMonth() !== end.getMonth()) {
      throw new Error('起始日期和结束日期必须在同一个月份。');
    }
    config.days = Math.round((end - start) / 86_400_000) + 1;
  }
  return config;
}

function parseDate(value, key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new Error(`${key} 必须使用 YYYY-MM-DD 格式。`);
  }
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`${key} 不是有效日期。`);
  }
  return date;
}

function findEdge() {
  const edge = EDGE_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!edge) throw new Error('未找到 Microsoft Edge。');
  return edge;
}

async function launch() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: findEdge(),
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
}

async function openApp(context, refreshFirst) {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (refreshFirst) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  return page;
}

function allScopes(page) {
  return [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
}

async function waitForForm(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of allScopes(page)) {
      const marker = scope.getByText('请假预占填报', { exact: true });
      if (await marker.count() && await marker.first().isVisible().catch(() => false)) return scope;
      const nameInput = scope.locator('input[placeholder*="人员姓名"]');
      if (await nameInput.count() && await nameInput.first().isVisible().catch(() => false)) return scope;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('没有找到填报表单。登录可能已失效，请先运行“网页登录.cmd”。');
}

async function visibleFirst(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function controlNearLabel(scope, labelText, selector) {
  const direct = await visibleFirst(scope.getByLabel(labelText, { exact: false }));
  if (direct) return direct;

  const labels = scope.getByText(labelText, { exact: true });
  const labelCount = await labels.count();
  for (let i = 0; i < labelCount; i += 1) {
    let container = labels.nth(i).locator('xpath=..');
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = await visibleFirst(container.locator(selector));
      if (candidate) return candidate;
      container = container.locator('xpath=..');
    }
  }
  throw new Error(`未找到字段：${labelText}`);
}

async function findInput(scope, labelText, placeholderPart) {
  if (placeholderPart) {
    const byPlaceholder = await visibleFirst(scope.locator(`input[placeholder*="${placeholderPart}"]`));
    if (byPlaceholder) return byPlaceholder;
  }
  return controlNearLabel(scope, labelText, 'input, textarea');
}

async function fillInput(scope, labelText, placeholderPart, value) {
  const input = await findInput(scope, labelText, placeholderPart);
  await input.fill(String(value));
  await input.blur();
  const actual = await input.inputValue();
  if (actual !== String(value)) throw new Error(`${labelText}填写失败，页面值为：${actual}`);
}

async function chooseOption(scope, labelText, value) {
  const container = await controlNearLabel(scope, labelText, '[role="combobox"], input, .ant-select, .semi-select');
  const current = (await container.textContent().catch(() => '')) || '';
  if (current.trim().includes(String(value))) return;

  await container.click();
  await scope.waitForTimeout(250);
  const candidates = [
    scope.getByRole('option', { name: String(value), exact: true }),
    scope.locator('.ant-select-item-option, .semi-select-option').filter({ hasText: String(value) }),
    scope.getByText(String(value), { exact: true }),
  ];
  for (const candidateSet of candidates) {
    const option = await visibleFirst(candidateSet);
    if (option) {
      await option.click();
      await scope.waitForTimeout(150);
      const selected = await visibleFirst(scope.getByText(String(value), { exact: true }));
      if (!selected) throw new Error(`${labelText}选择后未显示：${value}`);
      return;
    }
  }
  throw new Error(`${labelText}中没有找到选项：${value}`);
}

function dateMatches(value, isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const digits = String(value).match(/\d+/g)?.map(Number) || [];
  return digits.includes(year) && digits.includes(month) && digits.includes(day);
}

async function chooseDate(scope, labelText, placeholderPart, isoDate) {
  let button = await visibleFirst(scope.locator('button').filter({ hasText: placeholderPart }));
  if (!button) {
    const label = await visibleFirst(scope.locator('label').filter({ hasText: labelText }));
    if (label) button = await visibleFirst(label.locator('xpath=following::button[1]'));
  }
  if (!button) {
    const available = (await scope.locator('button').allTextContents()).map((text) => text.trim()).filter(Boolean);
    throw new Error(`未找到字段：${labelText}；当前按钮：${available.join(' | ')}`);
  }
  await button.click();
  await scope.waitForTimeout(250);

  const [targetYear, targetMonth, targetDay] = isoDate.split('-').map(Number);
  const dataDay = `${targetYear}/${targetMonth}/${targetDay}`;
  let dateButton = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    dateButton = await visibleFirst(scope.locator(`button[data-day="${dataDay}"]`));
    if (dateButton) break;

    const monthButton = await visibleFirst(scope.getByRole('combobox', { name: '选择月份' }));
    const monthText = (await monthButton?.textContent().catch(() => '')) || '';
    const match = monthText.match(/(\d{4})年(\d{1,2})月/);
    if (!match) throw new Error(`无法读取日期选择器当前月份：${monthText}`);
    const currentIndex = Number(match[1]) * 12 + Number(match[2]);
    const targetIndex = targetYear * 12 + targetMonth;
    const direction = targetIndex > currentIndex ? 'Go to the Next Month' : 'Go to the Previous Month';
    const navigation = await visibleFirst(scope.getByRole('button', { name: direction }));
    if (!navigation) throw new Error(`日期选择器无法切换到：${isoDate}`);
    await navigation.click();
    await scope.waitForTimeout(150);
  }

  if (!dateButton) throw new Error(`${labelText}日期选择器中没有找到日期：${isoDate}`);
  if (!await dateButton.isEnabled()) throw new Error(`${labelText}日期不可选：${isoDate}`);
  await dateButton.click();
  await scope.waitForTimeout(150);

  const expectedText = `${targetYear}年${targetMonth}月${targetDay}日`;
  const selected = await visibleFirst(scope.getByText(expectedText, { exact: true }));
  const triggerText = (await button.textContent().catch(() => '')) || '';
  const selectedByAttribute = await dateButton.getAttribute('data-selected-single').catch(() => null) === 'true'
    || await dateButton.getAttribute('data-range-start').catch(() => null) === 'true'
    || await dateButton.getAttribute('data-range-end').catch(() => null) === 'true';
  if (!selected && !dateMatches(triggerText, isoDate) && !selectedByAttribute) {
    throw new Error(`${labelText}选择失败，页面未显示：${expectedText}`);
  }
}

async function chooseCalendarMonth(scope, isoDate) {
  const [year, month] = isoDate.split('-').map(Number);
  const expected = `${year}年${month}月`;
  const monthControl = await visibleFirst(scope.getByRole('combobox', { name: '选择月份' }));
  if (!monthControl) throw new Error('日历点选中未找到月份选择器。');

  const current = ((await monthControl.textContent().catch(() => '')) || '').trim();
  if (current.includes(expected)) return;

  await monthControl.click();
  await scope.waitForTimeout(150);
  const candidates = [
    scope.getByRole('option', { name: expected, exact: true }),
    scope.getByText(expected, { exact: true }),
  ];
  for (const candidateSet of candidates) {
    const option = await visibleFirst(candidateSet);
    if (option) {
      await option.click();
      await scope.waitForTimeout(150);
      const selectedText = ((await monthControl.textContent().catch(() => '')) || '').trim();
      if (!selectedText.includes(expected)) throw new Error(`月份切换失败：${expected}`);
      return;
    }
  }
  throw new Error(`月份选择器中没有找到：${expected}`);
}

async function choosePointDates(scope, leaveDates) {
  const modeButton = await visibleFirst(scope.getByRole('button', { name: /日历点选/ }));
  if (!modeButton) throw new Error('未找到“日历点选（可不连续）”按钮。');
  await modeButton.click();
  await scope.waitForTimeout(250);

  await chooseCalendarMonth(scope, leaveDates[0]);
  for (const isoDate of leaveDates) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const dayButton = await visibleFirst(scope.locator(`button[data-day="${year}/${month}/${day}"]`));
    if (!dayButton) throw new Error(`日历中没有找到日期：${isoDate}`);
    if (!await dayButton.isEnabled()) throw new Error(`日期不可选：${isoDate}`);

    const selectedBefore = await dayButton.getAttribute('data-selected-single') === 'true'
      || await dayButton.locator('xpath=..').getAttribute('data-selected') === 'true';
    if (!selectedBefore) {
      await dayButton.click();
      await scope.waitForTimeout(100);
    }

    const selectedAfter = await dayButton.getAttribute('data-selected-single') === 'true'
      || await dayButton.locator('xpath=..').getAttribute('data-selected') === 'true';
    if (!selectedAfter) throw new Error(`日期点选失败：${isoDate}`);
  }

  const summary = await visibleFirst(scope.getByText(new RegExp(`已选\\s*${leaveDates.length}\\s*天`)));
  if (!summary) throw new Error(`日期已逐项点选，但页面未显示“已选 ${leaveDates.length} 天”。`);
}

function isoFromUtcDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addIsoDays(isoDate, offset) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return isoFromUtcDate(date);
}

function isoDayNumber(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function enumerateIsoRange(startDate, endDate) {
  const dates = [];
  for (let date = startDate; date <= endDate; date = addIsoDays(date, 1)) dates.push(date);
  return dates;
}

function monthDates(isoDate) {
  const [year, month] = isoDate.split('-').map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`);
}

function isWeekend(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

async function readQuotaCalendar(scope, targetDate) {
  const [targetYear, targetMonth] = targetDate.split('-').map(Number);
  const pageText = await scope.locator('body').innerText();
  const openMonth = pageText.match(/开放期内仅可提交次月（(\d{4})年(\d{1,2})月）/);
  if (openMonth && (Number(openMonth[1]) !== targetYear || Number(openMonth[2]) !== targetMonth)) {
    throw new Error(`预填写日期为 ${targetYear}年${targetMonth}月，但网页当前开放月份为 ${openMonth[1]}年${openMonth[2]}月。`);
  }
  const allDates = monthDates(targetDate);
  let records = [];
  let diagnostics = { dateNodeCount: 0, quotaNodeCount: 0, samples: [] };
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const inspection = await scope.locator('body').evaluate((root, target) => {
      const found = new Map();
      const allElements = [...root.querySelectorAll('*')];
      const readCounts = (text) => {
        const captain = text.match(/机长\s*[:：]?\s*(\d+)/);
        const firstOfficer = text.match(/副驾(?:驶)?\s*[:：]?\s*(\d+)/);
        return captain && firstOfficer
          ? { captain: Number(captain[1]), firstOfficer: Number(firstOfficer[1]) }
          : null;
      };
      const readDay = (node, forcedDay = null) => {
        if (forcedDay !== null) return forcedDay;
        const dated = node.matches?.('[data-day]') ? node : node.querySelector?.('[data-day]');
        const dateParts = (dated?.getAttribute('data-day') || '').match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
        if (dateParts && Number(dateParts[1]) === target.year && Number(dateParts[2]) === target.month) {
          return Number(dateParts[3]);
        }
        const lines = (node.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
        const dayLine = lines.find((line) => /^\d{1,2}$/.test(line) && Number(line) >= 1 && Number(line) <= target.days);
        return dayLine ? Number(dayLine) : null;
      };
      const addCard = (node, forcedDay = null) => {
        const text = node.innerText || '';
        const counts = readCounts(text);
        const day = readDay(node, forcedDay);
        if (!counts || !Number.isInteger(day) || day < 1 || day > target.days) return false;
        const candidate = { day, ...counts, score: text.length };
        if (!found.has(day) || candidate.score < found.get(day).score) found.set(day, candidate);
        return true;
      };

      const dateNodes = [...root.querySelectorAll('[data-day]')];
      for (const dateNode of dateNodes) {
        const dateParts = (dateNode.getAttribute('data-day') || '').match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
        if (!dateParts || Number(dateParts[1]) !== target.year || Number(dateParts[2]) !== target.month) continue;
        for (let card = dateNode, depth = 0; depth < 7 && card; card = card.parentElement, depth += 1) {
          if (addCard(card, Number(dateParts[3]))) break;
        }
      }

      const quotaNodes = allElements.filter((element) => readCounts(element.innerText || ''));
      const smallestQuotaNodes = quotaNodes.filter((element) => ![...element.children]
        .some((child) => readCounts(child.innerText || '')));
      for (const quotaNode of smallestQuotaNodes) {
        for (let card = quotaNode, depth = 0; depth < 6 && card; card = card.parentElement, depth += 1) {
          if (addCard(card)) break;
        }
      }

      return {
        records: [...found.values()].map(({ score, ...record }) => record).sort((a, b) => a.day - b.day),
        dateNodeCount: dateNodes.length,
        quotaNodeCount: smallestQuotaNodes.length,
        samples: smallestQuotaNodes.slice(0, 3).map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)),
      };
    }, { year: targetYear, month: targetMonth, days: allDates.length });
    records = inspection.records;
    diagnostics = inspection;
    if (records.length >= allDates.length) break;
    await scope.waitForTimeout(200);
  }
  if (records.length < allDates.length) {
    const sampleText = diagnostics.samples.length ? `；人数节点示例：${diagnostics.samples.join(' | ')}` : '';
    throw new Error(`名额日历数据不完整：应有 ${allDates.length} 天，实际读取 ${records.length} 天；检测到日期节点 ${diagnostics.dateNodeCount} 个、人数节点 ${diagnostics.quotaNodeCount} 个${sampleText}。请确认网页日历已显示 ${targetYear}年${targetMonth}月及每天的机长/副驾人数。`);
  }
  const [year, month] = targetDate.split('-');
  return new Map(records.map((record) => [
    `${year}-${month}-${String(record.day).padStart(2, '0')}`,
    record,
  ]));
}

function applyResolvedDates(config, dates, mode) {
  if (!dates.length) throw new Error('按名额规则没有找到任何可申请日期。');
  config.days = dates.length;
  config.dateMode = mode;
  if (mode === 'range') {
    config.startDate = dates[0];
    config.endDate = dates[dates.length - 1];
    delete config.leaveDates;
  } else {
    config.leaveDates = [...dates].sort();
    delete config.startDate;
    delete config.endDate;
  }
}

function rankContinuousWindows(month, length, available, originalCenter, preferWeekends, preferredDates = []) {
  const preferred = new Set(preferredDates);
  const windows = [];
  for (let index = 0; index <= month.length - length; index += 1) {
    const dates = month.slice(index, index + length);
    if (!dates.every(available)) continue;
    const center = (isoDayNumber(dates[0]) + isoDayNumber(dates[dates.length - 1])) / 2;
    windows.push({
      dates,
      weekendCount: dates.filter(isWeekend).length,
      preferredCount: dates.filter((date) => preferred.has(date)).length,
      distance: Math.abs(center - originalCenter),
    });
  }
  windows.sort((a, b) => {
    if (preferWeekends && a.weekendCount !== b.weekendCount) return b.weekendCount - a.weekendCount;
    if (a.preferredCount !== b.preferredCount) return b.preferredCount - a.preferredCount;
    return a.distance - b.distance || a.dates[0].localeCompare(b.dates[0]);
  });
  return windows;
}

function selectThreeDayReservation(month, available, originalCenter, preferredDates = []) {
  const threeDayWindows = rankContinuousWindows(month, 3, available, originalCenter, true, preferredDates);
  if (threeDayWindows.length) return { ...threeDayWindows[0], requestedDays: 3, degraded: false };

  const twoDayWindows = rankContinuousWindows(month, 2, available, originalCenter, true, preferredDates);
  if (twoDayWindows.length) return { ...twoDayWindows[0], requestedDays: 3, degraded: true };
  return null;
}

function selectOriginalWeekendRemainder(desiredDates, available) {
  const remaining = desiredDates.filter(available);
  const hasUnavailableDate = remaining.length < desiredDates.length;
  if (!hasUnavailableDate || remaining.length < 1 || remaining.length > 2) return null;
  return remaining.some(isWeekend) ? remaining : null;
}

function selectForcedDates(desiredDates, available) {
  return desiredDates.filter(available);
}

function datesAreContinuous(dates) {
  const sorted = [...dates].sort();
  return sorted.every((date, index) => index === 0 || isoDayNumber(date) === isoDayNumber(sorted[index - 1]) + 1);
}

function selectThreeDayWithWeekendCorrection(desiredDates, month, available, originalCenter) {
  const originalWeekendRemainder = selectOriginalWeekendRemainder(desiredDates, available);
  const replacement = selectThreeDayReservation(month, available, originalCenter, desiredDates);

  if (originalWeekendRemainder) {
    const originalWeekendCount = originalWeekendRemainder.filter(isWeekend).length;
    const sameDates = replacement && replacement.dates.length === originalWeekendRemainder.length
      && replacement.dates.every((date, index) => date === originalWeekendRemainder[index]);
    const replacementIsBetter = replacement
      && replacement.weekendCount > 0
      && (replacement.dates.length > originalWeekendRemainder.length
        || replacement.weekendCount > originalWeekendCount
        || (!datesAreContinuous(originalWeekendRemainder) && datesAreContinuous(replacement.dates)))
      && !sameDates;
    if (!replacementIsBetter) {
      return {
        dates: originalWeekendRemainder,
        weekendCount: originalWeekendCount,
        preserveOriginal: true,
        degraded: true,
      };
    }
  }
  if (!replacement) return null;
  return {
    ...replacement,
    preserveOriginal: false,
    reselectedFromWeekendRemainder: Boolean(originalWeekendRemainder),
  };
}

function selectRestOrRecoveryWindow(month, requestedDays, available, originalCenter) {
  for (let length = requestedDays; length >= 3; length -= 1) {
    const windows = rankContinuousWindows(month, length, available, originalCenter, false);
    if (windows.length) return { ...windows[0], requestedDays, degraded: length < requestedDays };
  }
  return null;
}

async function resolveDatesByQuota(scope, config) {
  if (!['机长', '副驾驶'].includes(config.flightPosition)) {
    throw new Error(`未包含的飞行岗位规则：${config.flightPosition}`);
  }
  const desiredDates = config.dateMode === 'calendar'
    ? [...config.leaveDates].sort()
    : enumerateIsoRange(config.startDate, config.endDate);
  if (!desiredDates.length) throw new Error('没有预填写的请假日期。');
  if (desiredDates.some((date) => date.slice(0, 7) !== desiredDates[0].slice(0, 7))) {
    throw new Error('名额自动选择只支持同一个月份内的日期。');
  }

  const pointModeButton = await visibleFirst(scope.getByRole('button', { name: /日历点选/ }));
  if (!pointModeButton) throw new Error('未找到“日历点选”按钮，无法读取每日名额。');
  await pointModeButton.click();
  await scope.waitForTimeout(300);
  await chooseCalendarMonth(scope, desiredDates[0]);
  await scope.waitForTimeout(300);
  const quotas = await readQuotaCalendar(scope, desiredDates[0]);
  const quotaKey = config.flightPosition === '机长' ? 'captain' : 'firstOfficer';
  const available = (date) => {
    const quota = quotas.get(date);
    if (!quota) throw new Error(`名额日历缺少日期：${date}`);
    return quota[quotaKey] < 5;
  };
  const month = monthDates(desiredDates[0]);
  const originalStart = desiredDates[0];
  const originalEnd = desiredDates[desiredDates.length - 1];
  const originalCenter = (isoDayNumber(originalStart) + isoDayNumber(originalEnd)) / 2;
  const fullDates = desiredDates.filter((date) => !available(date));

  if (config.forceLeave === true) {
    const forcedDates = selectForcedDates(desiredDates, available);
    if (!forcedDates.length) {
      throw new Error(`强制请假失败：全部预选日期均不可用（${fullDates.join('、')}），已停止自动操作且不会补选其他日期。`);
    }
    applyResolvedDates(config, forcedDates, 'calendar');
    if (fullDates.length) {
      console.log(`强制请假：已排除不可用日期（${fullDates.join('、')}），仅勾选原预选日期中的可用日期：${forcedDates.join('、')}；不会补选其他日期。`);
    } else {
      console.log(`强制请假：全部预选日期均可用，仅勾选原预选日期：${forcedDates.join('、')}。`);
    }
    return config;
  }

  if (!fullDates.length && config.leaveReason !== '3天内预占') {
    // 名额日历已经处于“日历点选”模式。即使用户在助手中使用起止日期
    // 输入，也不要再切回网页的起止日期控件，否则会清空点选状态，且该
    // 控件在动态布局变化后容易出现日期校验失败。
    applyResolvedDates(config, desiredDates, 'calendar');
    console.log('预填写日期名额均未满，保留原日期并按日历逐日勾选。');
    return config;
  }

  if (config.leaveReason === '3天内预占') {
    const selection = selectThreeDayWithWeekendCorrection(desiredDates, month, available, originalCenter);
    if (!selection) {
      throw new Error(`三天内预占失败：本月找不到连续2天且${config.flightPosition}每天人数均少于5人的日期，已停止自动操作。`);
    }
    if (selection.preserveOriginal) {
      applyResolvedDates(config, selection.dates, 'calendar');
      const quotaSummary = selection.dates
        .map((date) => `${date}（${config.flightPosition}${quotas.get(date)[quotaKey]}/5）`)
        .join('、');
      console.log(`三天内预占原日期含满额日期（${fullDates.join('、')}），剩余可用日期包含周末，且没有同样包含周末的新连续方案；保持原日期，仅勾选 ${quotaSummary}。`);
      return config;
    }
    // “三天内预占”必须把最终选出的日期分别勾选到请假日历中。这里不能改用
    // 起止日期模式，否则页面虽然曾显示勾选结果，后续切换控件时会清空
    // 点选状态，并可能触发起止日期控件的校验失败。
    applyResolvedDates(config, selection.dates, 'calendar');
    const quotaSummary = selection.dates
      .map((date) => `${date}（${config.flightPosition}${quotas.get(date)[quotaKey]}/5）`)
      .join('、');
    const correctionText = selection.reselectedFromWeekendRemainder
      ? '原日期剩余可用日虽含周末，但新方案也含周末，因此重新选择；'
      : '';
    const downgradeText = selection.degraded ? '没有可用的连续3天，已降级为连续2天；' : '';
    console.log(`三天内预占：${correctionText}${downgradeText}已自动选择 ${quotaSummary}，含周末 ${selection.weekendCount} 天；将按日历逐日勾选。`);
    return config;
  }

  if (['公休', '疗养'].includes(config.leaveReason)) {
    const requestedDays = desiredDates.length;
    const selection = selectRestOrRecoveryWindow(month, requestedDays, available, originalCenter);
    if (!selection) {
      throw new Error(`${config.leaveReason}申请失败：原申请${requestedDays}天且包含满额日期（${fullDates.join('、')}），本月找不到至少连续3天且${config.flightPosition}每天人数均少于5人的时间段。`);
    }
    applyResolvedDates(config, selection.dates, 'calendar');
    const downgradeText = selection.degraded ? `；连续${requestedDays}天无可用时间段，已降级为${selection.dates.length}天` : '';
    console.log(`${config.leaveReason}原日期含满额日期（${fullDates.join('、')}），已改为：${selection.dates[0]} 至 ${selection.dates.at(-1)}${downgradeText}；将按日历逐日勾选。`);
    return config;
  }

  const continuousWindows = rankContinuousWindows(
    month,
    desiredDates.length,
    available,
    originalCenter,
    true,
    desiredDates,
  );
  if (continuousWindows.length) {
    const selection = continuousWindows[0];
    applyResolvedDates(config, selection.dates, 'calendar');
    console.log(`${config.leaveReason}原日期含满额日期（${fullDates.join('、')}），已选择含周末、连续且尽量保留原日期的方案：${selection.dates.join('、')}。`);
    return config;
  }

  const kept = desiredDates.filter(available);
  const outside = month.filter((date) => !desiredDates.includes(date) && available(date));
  outside.sort((a, b) => {
    const weekendDifference = Number(isWeekend(b)) - Number(isWeekend(a));
    if (weekendDifference) return weekendDifference;
    const distanceA = Math.min(Math.abs(isoDayNumber(a) - isoDayNumber(originalStart)), Math.abs(isoDayNumber(a) - isoDayNumber(originalEnd)));
    const distanceB = Math.min(Math.abs(isoDayNumber(b) - isoDayNumber(originalStart)), Math.abs(isoDayNumber(b) - isoDayNumber(originalEnd)));
    return distanceA - distanceB || a.localeCompare(b);
  });
  const resolved = [...kept, ...outside.slice(0, Math.max(0, desiredDates.length - kept.length))].sort();
  if (!resolved.length) throw new Error(`${config.leaveReason}：预填写日期及其前后均没有可申请日期。`);
  applyResolvedDates(config, resolved, 'calendar');
  console.log(`${config.leaveReason}没有足够的连续可用区间，已保留原可用日期并优先补入周末日期；最终选择：${resolved.join('、')}。`);
  return config;
}

function runRuleSelfTest() {
  const month = monthDates('2026-10-09');
  const captainCounts = [2, 2, 4, 4, 5, 5, 5, 2, 2, 4, 5, 5, 5, 2, 2, 2, 4, 4, 2, 1, 1, 3, 3, 4, 4, 3, 3, 2, 4, 4, 4];
  const available = (date) => captainCounts[Number(date.slice(-2)) - 1] < 5;
  const originalCenter = (isoDayNumber('2026-10-09') + isoDayNumber('2026-10-11')) / 2;
  const best = selectThreeDayReservation(month, available, originalCenter);
  if (!best || best.dates.join(',') !== '2026-10-02,2026-10-03,2026-10-04') {
    throw new Error(`三天预占规则测试失败：实际 ${best?.dates.join('、') || '无可用日期'}`);
  }
  if (best.weekendCount !== 2 || !best.dates.every(available)) {
    throw new Error('三天预占规则测试失败：未满足连续三天、人数少于5或周末优先。');
  }
  const config = { dateMode: 'range', startDate: '2026-10-09', endDate: '2026-10-11', days: 3 };
  applyResolvedDates(config, best.dates, 'calendar');
  if (config.dateMode !== 'calendar' || config.leaveDates.length !== 3 || config.startDate || config.endDate) {
    throw new Error('三天预占规则测试失败：自动结果没有保持为日历逐日点选模式。');
  }

  const weekendPair = new Set(['2026-10-10', '2026-10-11', '2026-10-14', '2026-10-15']);
  const fallback = selectThreeDayReservation(month, (date) => weekendPair.has(date), originalCenter);
  if (!fallback?.degraded || fallback.dates.join(',') !== '2026-10-10,2026-10-11' || fallback.weekendCount !== 2) {
    throw new Error(`三天预占两天降级测试失败：实际 ${fallback?.dates.join('、') || '无可用日期'}`);
  }

  const weekdayPair = new Set(['2026-10-12', '2026-10-13']);
  const weekdayFallback = selectThreeDayReservation(month, (date) => weekdayPair.has(date), originalCenter);
  if (!weekdayFallback?.degraded || weekdayFallback.dates.join(',') !== '2026-10-12,2026-10-13' || weekdayFallback.weekendCount !== 0) {
    throw new Error(`三天预占工作日两天降级测试失败：实际 ${weekdayFallback?.dates.join('、') || '无可用日期'}`);
  }

  const originalDates = ['2026-10-09', '2026-10-10', '2026-10-11'];
  const originalAvailable = new Set(['2026-10-10', '2026-10-11']);
  const originalWeekendRemainder = selectOriginalWeekendRemainder(originalDates, (date) => originalAvailable.has(date));
  if (originalWeekendRemainder?.join(',') !== '2026-10-10,2026-10-11') {
    throw new Error(`三天预占保留原周末日期测试失败：实际 ${originalWeekendRemainder?.join('、') || '无可用日期'}`);
  }
  const oneWeekendRemainder = selectOriginalWeekendRemainder(originalDates, (date) => date === '2026-10-10');
  if (oneWeekendRemainder?.join(',') !== '2026-10-10') {
    throw new Error(`三天预占保留单个周末日期测试失败：实际 ${oneWeekendRemainder?.join('、') || '无可用日期'}`);
  }
  const weekdayRemainder = selectOriginalWeekendRemainder(
    ['2026-10-12', '2026-10-13', '2026-10-14'],
    (date) => date !== '2026-10-14',
  );
  if (weekdayRemainder !== null) {
    throw new Error('三天预占原日期仅剩工作日时不应触发周末保留规则。');
  }

  const correctionAvailable = new Set(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-10']);
  const correctedSelection = selectThreeDayWithWeekendCorrection(
    originalDates,
    month,
    (date) => correctionAvailable.has(date),
    originalCenter,
  );
  if (correctedSelection?.preserveOriginal || correctedSelection?.dates.join(',') !== '2026-10-02,2026-10-03,2026-10-04') {
    throw new Error(`三天预占周末重新选择测试失败：实际 ${correctedSelection?.dates.join('、') || '无可用日期'}`);
  }

  const preserveAvailable = new Set(['2026-10-10', '2026-10-12', '2026-10-13']);
  const preservedSelection = selectThreeDayWithWeekendCorrection(
    originalDates,
    month,
    (date) => preserveAvailable.has(date),
    originalCenter,
  );
  if (!preservedSelection?.preserveOriginal || preservedSelection?.dates.join(',') !== '2026-10-10') {
    throw new Error(`三天预占周末保留测试失败：实际 ${preservedSelection?.dates.join('、') || '无可用日期'}`);
  }

  const tiedOriginalDates = ['2026-10-09', '2026-10-10', '2026-10-11'];
  const tiedAvailable = new Set(['2026-10-02', '2026-10-03', '2026-10-09', '2026-10-10']);
  const tiedSelection = selectThreeDayWithWeekendCorrection(
    tiedOriginalDates,
    month,
    (date) => tiedAvailable.has(date),
    originalCenter,
  );
  if (!tiedSelection?.preserveOriginal || tiedSelection?.dates.join(',') !== '2026-10-09,2026-10-10') {
    throw new Error(`三天预占同条件优先原日期测试失败：实际 ${tiedSelection?.dates.join('、') || '无可用日期'}`);
  }

  const preferredWeekendWindow = rankContinuousWindows(
    month,
    3,
    (date) => ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-23', '2026-10-24', '2026-10-25'].includes(date),
    originalCenter,
    true,
    ['2026-10-23', '2026-10-24', '2026-10-25'],
  )[0];
  if (preferredWeekendWindow?.dates.join(',') !== '2026-10-23,2026-10-24,2026-10-25') {
    throw new Error(`同条件优先预选日期测试失败：实际 ${preferredWeekendWindow?.dates.join('、') || '无可用日期'}`);
  }

  const forcedSource = ['2026-10-10', '2026-10-11', '2026-10-12'];
  const forcedAvailable = new Set(['2026-10-10', '2026-10-12']);
  const forcedResult = selectForcedDates(forcedSource, (date) => forcedAvailable.has(date));
  if (forcedResult.join(',') !== '2026-10-10,2026-10-12') {
    throw new Error(`强制请假规则测试失败：实际 ${forcedResult.join('、') || '无可用日期'}`);
  }
  if (selectForcedDates(forcedSource, () => false).length !== 0) {
    throw new Error('强制请假失败测试失败：全部不可用时不应补选其他日期。');
  }

  const noPair = new Set(['2026-10-02', '2026-10-04', '2026-10-06']);
  if (selectThreeDayReservation(month, (date) => noPair.has(date), originalCenter) !== null) {
    throw new Error('三天预占失败测试失败：没有连续2天时不应选择零散日期。');
  }

  const fourDaysOnly = new Set(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  const restFallback = selectRestOrRecoveryWindow(month, 5, (date) => fourDaysOnly.has(date), originalCenter);
  if (!restFallback?.degraded || restFallback.dates.length !== 4) {
    throw new Error(`公休疗养降级测试失败：实际 ${restFallback?.dates.length || 0} 天。`);
  }
  const restConfig = { dateMode: 'range', startDate: '2026-10-01', endDate: '2026-10-05', days: 5 };
  applyResolvedDates(restConfig, restFallback.dates, 'calendar');
  if (restConfig.dateMode !== 'calendar' || restConfig.leaveDates.length !== 4 || restConfig.startDate || restConfig.endDate) {
    throw new Error('公休疗养模式测试失败：最终结果没有转换为日历逐日点选。');
  }
  const twoDaysOnly = new Set(['2026-10-20', '2026-10-21']);
  if (selectRestOrRecoveryWindow(month, 5, (date) => twoDaysOnly.has(date), originalCenter) !== null) {
    throw new Error('公休疗养失败测试失败：不足连续3天时不应继续申请。');
  }
  console.log('名额规则测试通过：强制请假不补选；三天预占与其他理由优先周末、连续和原日期；公休疗养保持N天→3天原降级规则。');
}

async function findSubmitButton(scope) {
  const roleButton = await visibleFirst(scope.getByRole('button', { name: /提交预占申请|提交/ }));
  if (roleButton) return roleButton;
  const textButton = await visibleFirst(scope.locator('button').filter({ hasText: '提交预占申请' }));
  if (textButton) return textButton;
  throw new Error('未找到“提交预占申请”按钮。');
}

async function fillForm(scope, config) {
  await fillInput(scope, '人员姓名', '人员姓名', config.personName);
  await fillInput(scope, '员工号', '员工号', config.employeeId);
  await chooseOption(scope, '飞行岗位', config.flightPosition);
  await chooseOption(scope, '请假事由', config.leaveReason);
  if (config.dateMode !== 'calendar' || !Array.isArray(config.leaveDates) || !config.leaveDates.length) {
    throw new Error('最终日期未转换为日历点选模式，已停止以避免切换控件后丢失日期。');
  }
  await choosePointDates(scope, config.leaveDates);
}

async function waitForEnabled(button, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await button.isEnabled().catch(() => false)) return true;
    await button.page().waitForTimeout(100);
  }
  return button.isEnabled().catch(() => false);
}

async function confirmSubmission(scope) {
  const deadline = Date.now() + 5_000;
  let dialog = null;
  while (Date.now() < deadline && !dialog) {
    dialog = (await visibleFirst(scope.getByRole('alertdialog')))
      || (await visibleFirst(scope.getByRole('dialog')));
    if (!dialog) await scope.waitForTimeout(100);
  }
  if (!dialog) throw new Error('已点击提交，但5秒内未检测到确认弹窗；为避免误点，已停止自动确认。');

  const confirm = await visibleFirst(dialog.getByRole('button', { name: /确认|确定|提交/, exact: false }));
  if (!confirm) throw new Error('已检测到确认弹窗，但未找到确认按钮；请手动检查页面。');
  if (!await confirm.isEnabled().catch(() => false)) {
    throw new Error('确认按钮当前不可点击；请手动检查页面。');
  }
  await confirm.click();
}

async function waitForSubmissionWindow(page, initialScope, config) {
  const refreshIntervalMs = Math.max(100, Number(config.refreshWaitMilliseconds || 500));
  let scope = initialScope;
  let attempt = 0;

  const ensureNotCancelled = () => {
    if (fs.existsSync(CANCEL_PATH)) throw new Error('等待开放的刷新任务已由用户取消。');
    if (page.isClosed()) throw new Error('专用 Edge 已关闭，等待开放的刷新任务自动结束。');
  };

  const waitRefreshInterval = async () => {
    const deadline = Date.now() + refreshIntervalMs;
    while (Date.now() < deadline) {
      ensureNotCancelled();
      await page.waitForTimeout(Math.min(100, deadline - Date.now())).catch(() => {});
    }
  };

  while (true) {
    ensureNotCancelled();
    if (scope) {
      try {
        const button = await findSubmitButton(scope);
        if (await button.isEnabled().catch(() => false)) {
          console.log('提交按钮已可用，开始填写信息。');
          return scope;
        }
      } catch (error) {
        console.log(`暂时无法读取提交按钮：${error.message}`);
      }
    }

    attempt += 1;
    console.log(`提交按钮不可用，第 ${attempt} 次刷新将在 ${refreshIntervalMs}ms 后进行……`);
    await waitRefreshInterval();

    try {
      ensureNotCancelled();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (error) {
      console.log(`刷新失败，将继续重试：${error.message}`);
      try {
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } catch (navigationError) {
        console.log(`重新进入填报页失败，将继续重试：${navigationError.message}`);
      }
    }

    try {
      scope = await waitForForm(page, 15_000);
    } catch (error) {
      scope = null;
      console.log('暂时未找到填报页面；浏览器保持打开，请检查登录状态，脚本会继续刷新。');
    }
  }
}

async function submitCurrentForm(scope, config) {
  const waitMs = Number(config.submitWaitMilliseconds || 1500);
  const button = await findSubmitButton(scope);
  if (!await waitForEnabled(button, waitMs)) {
    throw new Error('信息填写完成后提交按钮仍不可用，已停止且未提交。');
  }

  await button.click();
  if (config.autoConfirm === true) await confirmSubmission(scope);
  console.log(config.autoConfirm === true ? '已点击提交并确认。' : '已点击提交；若出现确认窗口，请手动确认。');
}

function waitForEnter(message) {
  if (!process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message}\n`, () => {
      rl.close();
      resolve();
    });
  });
}

function waitForBrowserClose(context) {
  return new Promise((resolve) => {
    context.once('close', resolve);
  });
}

async function keepLoginAliveUntil(page, startAt, intervalMs) {
  const target = new Date(startAt).getTime();
  if (!Number.isFinite(target)) throw new Error('定时发起时间无效。');
  const interval = Math.max(30_000, Number(intervalMs) || 300_000);

  const ensureActive = () => {
    if (fs.existsSync(CANCEL_PATH)) throw new Error('定时前登录保活已由用户取消。');
    if (page.isClosed()) throw new Error('专用 Edge 已关闭，定时任务自动结束。');
  };
  const waitInterruptibly = async (milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      ensureActive();
      await page.waitForTimeout(Math.min(250, deadline - Date.now())).catch(() => {});
    }
  };
  const checkLogin = async () => {
    try {
      await waitForForm(page, 5_000);
      console.log(`登录状态正常：${new Date().toLocaleString('zh-CN')}。`);
    } catch {
      console.log('未检测到已登录的填报页面；专用 Edge 保持打开，请完成登录，脚本会继续检查。');
    }
  };

  console.log(`已进入定时前登录保活，每 ${Math.round(interval / 1000)} 秒刷新一次，正式发起时间：${new Date(target).toLocaleString('zh-CN')}。`);
  await checkLogin();
  while (Date.now() < target) {
    ensureActive();
    await waitInterruptibly(Math.min(interval, target - Date.now()));
    if (Date.now() >= target) break;
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (error) {
      console.log(`登录保活刷新失败，下个间隔继续重试：${error.message}`);
    }
    await checkLogin();
  }
  ensureActive();
  console.log('已到定时发起时间，开始检测提交按钮。');
}

async function runLogin() {
  const keepBrowserOpen = hasArg('--keep-browser-open');
  const context = await launch();
  const browserClosed = waitForBrowserClose(context);
  try {
    const page = await openApp(context, false);
    console.log('请在专用 Edge 窗口中完成登录。检测到填报页面后会保存登录状态。');
    await waitForForm(page, 10 * 60_000);
    console.log('登录成功，已检测到填报页面。');
    if (keepBrowserOpen) {
      console.log('登录完成；专用 Edge 将保持打开，只有人工关闭窗口后任务才结束。');
      await browserClosed;
    } else {
      await waitForEnter('按 Enter 关闭专用 Edge。');
    }
  } catch (error) {
    if (keepBrowserOpen) {
      console.error(`\n操作停止：${error.message}`);
      console.log('自动操作已停止，但专用 Edge 保持打开；请人工关闭窗口。');
      error.alreadyReported = true;
      await browserClosed;
    }
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

async function runAutomation() {
  const config = readConfig();
  const allowSubmit = hasArg('--allow-submit');
  const waitOpen = hasArg('--wait-open');
  const keepBrowserOpen = hasArg('--keep-browser-open') || hasArg('--keep-open');
  const context = await launch();
  const browserClosed = waitForBrowserClose(context);
  try {
    const page = await openApp(context, hasArg('--refresh-first'));
    const startAt = argValue('--start-at');
    if (startAt) await keepLoginAliveUntil(page, startAt, argValue('--keep-alive-interval'));
    const guardedSubmit = config.autoSubmit === true && allowSubmit && waitOpen;
    let scope;
    if (guardedSubmit) {
      try {
        scope = await waitForForm(page, 15_000);
      } catch (error) {
        console.log('暂时未找到填报页面；进入持续刷新模式。');
        scope = null;
      }
      scope = await waitForSubmissionWindow(page, scope, config);
    } else {
      scope = await waitForForm(page);
    }

    await resolveDatesByQuota(scope, config);
    await fillForm(scope, config);
    const submitButton = await findSubmitButton(scope);
    const submitEnabled = await submitButton.isEnabled().catch(() => false);
    console.log(`提交按钮当前状态：${submitEnabled ? '可点击' : '不可点击'}。`);

    if (config.autoSubmit === true && allowSubmit) {
      await submitCurrentForm(scope, config);
    } else {
      console.log('表单已填写。当前入口没有提交权限，未点击提交。');
    }
    if (keepBrowserOpen) {
      console.log('自动操作已完成；专用 Edge 将保持打开，只有人工关闭窗口后任务才结束。');
      await browserClosed;
    } else {
      await waitForEnter('请检查页面；完成后按 Enter 关闭专用 Edge。');
    }
  } catch (error) {
    if (keepBrowserOpen) {
      console.error(`\n操作停止：${error.message}`);
      console.log('自动操作已停止，但专用 Edge 保持打开；请人工检查并关闭窗口。');
      error.alreadyReported = true;
      await browserClosed;
    }
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

async function runInspection() {
  const context = await launch();
  try {
    const page = await openApp(context, false);
    const scope = await waitForForm(page);
    const inputs = await scope.locator('input, textarea, [role="combobox"]').evaluateAll((items) => items.map((item) => ({
      tag: item.tagName,
      type: item.getAttribute('type'),
      placeholder: item.getAttribute('placeholder'),
      ariaLabel: item.getAttribute('aria-label'),
      role: item.getAttribute('role'),
      value: item.value || item.textContent?.trim() || '',
      className: item.className,
    })));
    const buttons = await scope.locator('button, [role="button"]').evaluateAll((items) => items.map((item) => ({
      text: item.textContent?.trim() || '',
      title: item.getAttribute('title'),
      ariaLabel: item.getAttribute('aria-label'),
      className: item.className,
    })));
    const labels = await scope.locator('label').allTextContents();
    console.log(JSON.stringify({ frameUrl: scope.url(), labels, inputs, buttons }, null, 2));
    await waitForEnter('检查完成，按 Enter 关闭专用 Edge。');
  } finally {
    await context.close().catch(() => {});
  }
}

async function runDateInspection() {
  const context = await launch();
  try {
    const page = await openApp(context, false);
    const scope = await waitForForm(page);
    const startButton = await visibleFirst(scope.getByRole('button', { name: /选择起始日期|起始日期/ }));
    if (!startButton) throw new Error('未找到起始日期按钮。');
    await startButton.click();
    await scope.waitForTimeout(500);
    const calendar = await scope.locator('button').evaluateAll((items) => items.filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).map((item) => ({
      text: item.textContent?.trim() || '',
      ariaLabel: item.getAttribute('aria-label'),
      title: item.getAttribute('title'),
      dataDay: item.getAttribute('data-day'),
      dataDate: item.getAttribute('data-date'),
      disabled: item.disabled,
      className: item.className,
    })).filter((item) => item.ariaLabel || item.title || item.dataDay || item.dataDate || /^\d{1,2}$/.test(item.text)));
    console.log(JSON.stringify(calendar, null, 2));
    await waitForEnter('日期检查完成，按 Enter 关闭专用 Edge。');
  } finally {
    await context.close().catch(() => {});
  }
}

async function runPointCalendarInspection() {
  const context = await launch();
  try {
    const page = await openApp(context, false);
    const scope = await waitForForm(page);
    const modeButton = await visibleFirst(scope.getByRole('button', { name: /日历点选/ }));
    if (!modeButton) throw new Error('未找到“日历点选”按钮。');
    await modeButton.click();
    await scope.waitForTimeout(500);
    const config = readConfig();
    const probeDate = Array.isArray(config.leaveDates) && config.leaveDates.length
      ? config.leaveDates[0]
      : config.startDate;
    const [year, month, day] = probeDate.split('-').map(Number);
    const dayButton = await visibleFirst(scope.locator(`button[data-day="${year}/${month}/${day}"]`));
    if (!dayButton) throw new Error(`日历中未找到检查日期：${probeDate}`);
    await dayButton.click();
    await scope.waitForTimeout(200);
    const state = await dayButton.evaluate((item) => {
      const attributes = (node) => Object.fromEntries(Array.from(node.attributes).map((attr) => [attr.name, attr.value]));
      return {
        button: attributes(item),
        parent: item.parentElement ? attributes(item.parentElement) : null,
        text: item.textContent?.trim() || '',
      };
    });
    const visibleInputs = await scope.locator('input:visible').evaluateAll((items) => items.map((item) => ({
      placeholder: item.getAttribute('placeholder'),
      value: item.value,
      ariaLabel: item.getAttribute('aria-label'),
    })));
    const bodyText = (await scope.locator('body').innerText()).split('\n')
      .map((text) => text.trim()).filter(Boolean)
      .filter((text) => /天数|已选|日期/.test(text));
    console.log(JSON.stringify({ probeDate, state, visibleInputs, relevantText: bodyText }, null, 2));
    await waitForEnter('日历点选检查完成，按 Enter 关闭专用 Edge。');
  } finally {
    await context.close().catch(() => {});
  }
}

async function exportFormOptions() {
  const context = await launch();
  const browserClosed = waitForBrowserClose(context);
  try {
    const page = await openApp(context, false);
    const scope = await waitForForm(page);
    const readOptions = async (labelText) => {
      const control = await controlNearLabel(scope, labelText, '[role="combobox"], input, .ant-select, .semi-select');
      await control.click();
      await scope.waitForTimeout(300);
      const optionLocators = [
        scope.locator('[role="option"]:visible'),
        scope.locator('.ant-select-item-option:visible, .semi-select-option:visible'),
      ];
      const values = [];
      for (const locator of optionLocators) {
        for (const text of await locator.allTextContents()) {
          const value = text.trim();
          if (value && !values.includes(value)) values.push(value);
        }
      }
      await page.keyboard.press('Escape').catch(() => {});
      return values;
    };
    const reasons = await readOptions('请假事由');
    const positions = await readOptions('飞行岗位');
    if (!reasons.length) throw new Error('网页中没有读取到请假事由选项。');
    if (!positions.length) throw new Error('网页中没有读取到飞行岗位选项。');
    console.log(`FORM_OPTIONS_JSON:${JSON.stringify({ reasons, positions })}`);
    if (hasArg('--keep-browser-open')) {
      console.log('网页选项读取完成；专用 Edge 保持打开，等待人工关闭。');
      await browserClosed;
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function inspectQuotaCalendar() {
  const context = await launch();
  try {
    const page = await openApp(context, false);
    const scope = await waitForForm(page);
    const config = readConfig();
    await chooseOption(scope, '飞行岗位', config.flightPosition);
    await chooseOption(scope, '请假事由', config.leaveReason);
    const modeButton = await visibleFirst(scope.getByRole('button', { name: /日历点选/ }));
    if (modeButton) await modeButton.click();
    const probeDate = config.leaveDates?.[0] || config.startDate;
    await chooseCalendarMonth(scope, probeDate);
    await scope.waitForTimeout(500);
    const days = await scope.locator('button[data-day]').evaluateAll((buttons) => buttons.map((button) => {
      const cell = button.closest('[role="gridcell"]') || button.parentElement;
      return {
        date: button.getAttribute('data-day'),
        buttonText: button.innerText.trim(),
        cellText: cell?.innerText?.trim() || '',
        cellTitle: cell?.getAttribute('title'),
        cellAriaLabel: cell?.getAttribute('aria-label'),
        disabled: button.disabled,
      };
    }));
    const relevantText = (await scope.locator('body').innerText()).split('\n')
      .map((text) => text.trim()).filter((text) => /机长|副驾驶|人数|名额|已占|申请/.test(text));
    const quotaNodes = await scope.locator('body').evaluate((root) => Array.from(root.querySelectorAll('*'))
      .filter((element) => /^(机长|副驾驶)\s*\d+$/.test(element.textContent.trim()))
      .filter((element) => !Array.from(element.children).some((child) => /^(机长|副驾驶)\s*\d+$/.test(child.textContent.trim())))
      .map((element) => {
        const summarize = (node) => node ? {
          tag: node.tagName,
          text: node.innerText?.trim() || '',
          className: node.className,
          dataDay: node.getAttribute?.('data-day'),
          role: node.getAttribute?.('role'),
        } : null;
        return {
          self: summarize(element),
          parent: summarize(element.parentElement),
          grandparent: summarize(element.parentElement?.parentElement),
          greatGrandparent: summarize(element.parentElement?.parentElement?.parentElement),
        };
      }));
    console.log(JSON.stringify({ days, relevantText, quotaNodes }, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
}

(async () => {
  try {
    if (hasArg('--self-test-rules')) runRuleSelfTest();
    else if (hasArg('--validate-config')) {
      const config = readConfig();
      const dates = config.dateMode === 'calendar'
        ? `日历点选 ${config.leaveDates.join('、')}`
        : `${config.startDate} 至 ${config.endDate}`;
      console.log(`配置有效：${config.personName}，${config.leaveReason}，${dates}，${config.days}天。`);
    } else if (hasArg('--export-form-options')) await exportFormOptions();
    else if (hasArg('--inspect-quota')) await inspectQuotaCalendar();
    else if (hasArg('--inspect-point-calendar')) await runPointCalendarInspection();
    else if (hasArg('--inspect-date')) await runDateInspection();
    else if (hasArg('--inspect')) await runInspection();
    else if (hasArg('--login')) await runLogin();
    else await runAutomation();
  } catch (error) {
    if (!error.alreadyReported) console.error(`\n操作停止：${error.message}`);
    process.exitCode = 1;
    await waitForEnter('按 Enter 关闭。');
  }
})();
