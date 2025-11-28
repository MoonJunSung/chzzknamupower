async function withActiveTab(callback) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('활성 탭을 찾을 수 없습니다.');
  return callback(tab);
}

async function injectContentIfNeeded(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => true,
    });
  } catch (e) {
    // 일부 페이지는 주입이 제한될 수 있음
  }
}

async function fetchPageInfo() {
  return withActiveTab(async (tab) => {
    await injectContentIfNeeded(tab.id);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        url: location.href,
        selection: window.getSelection()?.toString() || '',
      }),
    });
    return result;
  });
}

function renderResult(info) {
  const el = document.getElementById('result');
  if (!el) return;
  const lines = [
    `제목: ${info.title}`,
    `URL: ${info.url}`,
    info.selection ? `선택 텍스트: ${info.selection}` : '선택 텍스트: (없음)',
  ];
  el.textContent = lines.join('\n');
}

document.addEventListener('DOMContentLoaded', () => {
  // 버전 표기 동기화
  try {
    const manifest = chrome?.runtime?.getManifest ? chrome.runtime.getManifest() : null;
    const el = document.querySelector('.brand-ver');
    if (manifest?.version && el) el.textContent = `v${manifest.version}`;
  } catch {}
  bindChzzkEvents();
  syncCurrentCount();
  loadSettings();
  // storage 변경 시 실시간 반영
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.chzzkAgg) {
      // 현재 탭 채널의 카운트만 갱신
      syncCurrentCount();
    }
    if (changes.chzzkSettings) {
      loadSettings();
    }
  });
  bindSidebarNavigation();

});


// -----------------------------
// CHZZK 통나무 기록 기능
// -----------------------------

const STORAGE_KEY = 'chzzkLogs';

async function readLogs() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function writeLogs(logs) {
  await chrome.storage.local.set({ [STORAGE_KEY]: logs });
}

function getDisplayNameFromTitleLike(title) {
  if (!title) return '';
  // 보수적으로 첫 파이프/대시 전을 이름 후보로 사용
  const separators = ['|', '-', '—', '·'];
  let cand = title;
  for (const sep of separators) {
    if (cand.includes(sep)) {
      cand = cand.split(sep)[0];
    }
  }
  return cand.trim();
}

async function extractChzzkInfo() {
  return withActiveTab(async (tab) => {
    await injectContentIfNeeded(tab.id);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const url = location.href;
        const u = new URL(url);
        const hostname = u.hostname;
        // 후보 수집
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
        const ogSite = document.querySelector('meta[property="og:site_name"]')?.content || '';
        const ogUrl = document.querySelector('meta[property="og:url"]')?.content || '';
        const title = document.title || '';
        const h1 = document.querySelector('h1')?.textContent?.trim() || '';
        const h2 = document.querySelector('h2')?.textContent?.trim() || '';

        // 채널/라이브 경로에서 ID 후보 추출
        // 예시: /live/xxxxxxxxx, /channel/xxxxxxxxx
        let channelId = '';
        const parts = u.pathname.split('/').filter(Boolean);
        for (let i = 0; i < parts.length - 0; i++) {
          const seg = parts[i];
          if (['live', 'channel', 'video'].includes(seg) && parts[i + 1]) {
            channelId = parts[i + 1];
            break;
          }
        }

        // 표시 이름 후보
        const nameCandidates = [h1, h2, ogTitle, ogSite, title];
        const displayName = nameCandidates.find(s => s && s.length >= 2) || '';

        return {
          isChzzk: hostname.includes('chzzk'),
          url,
          channelId,
          displayName,
          title,
          ogTitle,
          ogSite,
          ogUrl,
        };
      },
    });

    const bestName = result.displayName ? getDisplayNameFromTitleLike(result.displayName) : '';
    const name = bestName || getDisplayNameFromTitleLike(result.title) || '알 수 없음';
    return {
      isChzzk: Boolean(result.isChzzk),
      url: result.url,
      channelId: result.channelId || '',
      streamerName: name,
    };
  });
}

async function captureCurrentChzzk() {
  const captureBtn = document.getElementById('btn-chzzk-capture');
  if (captureBtn) {
    captureBtn.setAttribute('disabled', 'true');
    captureBtn.textContent = '기록 중...';
  }
  try {
    const info = await extractChzzkInfo();
    if (!info.isChzzk) throw new Error('치지직 페이지가 아닙니다.');

    const key = info.channelId || info.streamerName || info.url;
    const logs = await readLogs();
    const prev = logs[key] || { count: 0, streamerName: info.streamerName, channelId: info.channelId, lastUrl: info.url, createdAt: Date.now() };
    const next = {
      ...prev,
      streamerName: info.streamerName || prev.streamerName,
      channelId: info.channelId || prev.channelId,
      lastUrl: info.url,
      count: (prev.count || 0) + 1,
      updatedAt: Date.now(),
    };
    logs[key] = next;
    await writeLogs(logs);
    await renderChzzkList();
  } catch (e) {
    const el = document.getElementById('result');
    if (el) el.textContent = `CHZZK 오류: ${e?.message || e}`;
  } finally {
    if (captureBtn) {
      captureBtn.removeAttribute('disabled');
      captureBtn.textContent = '현재 스트리머 기록하기';
    }
  }
}

async function resetChzzkLogs() {
  const empty = { channels: {}, updatedAt: Date.now() };
  await chrome.storage.local.set({ chzzkAgg: empty });
  await renderChzzkList();
}

function bindChzzkEvents() {
  const pill = document.getElementById('btn-open-balances');
  pill?.addEventListener('click', openBalances);
  document.getElementById('opt-badge')?.addEventListener('change', saveSettings);
  document.getElementById('opt-auto')?.addEventListener('change', saveSettings);
  document.getElementById('opt-best')?.addEventListener('change', saveSettings);
  document.getElementById('opt-countdown')?.addEventListener('change', saveSettings);
}

async function openBalances() {
  await withActiveTab(async (tab) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          window.dispatchEvent(new CustomEvent('CHZZK_OPEN_BALANCES'));
        },
      });
    } catch (e) {}
  });
}

function bindSidebarNavigation() {
  const buttons = Array.from(document.querySelectorAll('.nav-item'));
  const panels = Array.from(document.querySelectorAll('.panel'));
  function activate(targetId) {
    buttons.forEach(b => b.classList.toggle('active', b.getAttribute('data-target') === targetId));
    panels.forEach(p => p.classList.toggle('hidden', p.id !== targetId));
  }
  buttons.forEach(b => {
    b.addEventListener('click', () => activate(b.getAttribute('data-target')));
  });
}

function formatDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch {
    return '';
  }
}

// 랭킹 섹션은 제거됨

async function syncCurrentCount() {
  const counter = document.getElementById('current-count');
  if (!counter) return;
  const { chzzkAgg } = await chrome.storage.local.get('chzzkAgg');
  // 활성 탭의 채널ID 얻기
  await withActiveTab(async (tab) => {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const m = location.pathname.match(/\/live\/([\w-]+)/);
          return { channelId: m ? m[1] : '' };
        },
      });
      const key = result?.channelId || '';
      const val = key ? (chzzkAgg?.channels?.[key]?.power || 0) : 0;
      counter.textContent = Number(val).toLocaleString();
    } catch {
      counter.textContent = '?';
    }
  });
}

async function loadSettings() {
  const { chzzkSettings } = await chrome.storage.local.get('chzzkSettings');
  const s = chzzkSettings || { badge: true, auto: true, best: false, countdown: true };
  const b = document.getElementById('opt-badge');
  const a = document.getElementById('opt-auto');
  const best = document.getElementById('opt-best');
  const cd = document.getElementById('opt-countdown');
  if (b) b.checked = !!s.badge;
  if (a) a.checked = !!s.auto;
  if (best) best.checked = !!s.best;
  if (cd) cd.checked = s.countdown !== false;
}

async function saveSettings() {
  const b = document.getElementById('opt-badge');
  const a = document.getElementById('opt-auto');
  const best = document.getElementById('opt-best');
  const s = {
    badge: b ? b.checked : true,
    auto: a ? a.checked : true,
    best: best ? best.checked : false,
    countdown: (document.getElementById('opt-countdown')?.checked) !== false,
  };
  await chrome.storage.local.set({ chzzkSettings: s });
}


