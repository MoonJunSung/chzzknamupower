// 치지직 자동 수집 + 채팅 영역 아래 배지 표시
(() => {
  const SCAN_INTERVAL_MS = 4000;
  let scanning = false;
  let lastPayloadHash = '';
  let lastChatBadgeEl = null;
  let isChannelInactive = false;
  let powerCountInterval = null;
  // 설정(배지/자동)
  const DEFAULT_SETTINGS = { badge: true, auto: true, best: false, countdown: true };
  const POWER_LOG_KEY = 'powerLogs';
  const channelInfoCache = new Map();
  const claimedClaimIds = new Set();
  const POWER_CLAIM_POLL_MS = 15000;
  const VIEW_LOG_COOLDOWN = 60 * 1000;
  const SEEN_CLAIMS_KEY = 'chzzkSeenClaimIds';
  let claimPollInterval = null;
  const FOLLOW_CLAIM_CHECK_INTERVAL = 1000;
  const FOLLOW_CLAIM_MAX_TRIES = 15;
  const CLAIM_REFETCH_LIMIT = 10;
  const CLAIM_REFETCH_DELAY_MS = 1000;
  // 임시: 화질 자동 최적화 비활성화 플래그 (트러블슈팅용)
  const DISABLE_BEST_QUALITY = false;
  let settings = { ...DEFAULT_SETTINGS };
  // 타이머 핸들
  let scanTimer = null;
  let initialKickTimer = null;
  let bestInterval = null;
  let powerClaimInterval = null;
  let powerButtonInterval = null;
  // 배지
  let lastPowerNode = null;
  let lastChartBtnNode = null;
  // 변경 중복 전송 방지
  let lastSentDomCount = null;
  let lastApiAmount = null;
  let claimInProgress = false;
  let lastViewLogAt = 0;
  let followPowerCheckTimer = null;
  let lastClaimDetectedAt = 0;
  let pendingFetchOptions = null;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 통나무(보기) 획득 쿨다운(초)
  const COOLDOWN_SECONDS = 3600;
  // 마지막 클릭 시간(밀리초, epoch)
  let lastPowerClickAt = 0;
  // 남은 시간(초)
  let remainSeconds = COOLDOWN_SECONDS;
  // 카운트다운 타이머 중지 핸들
  let stopCountdownTimerHandle = null;
  // 카운트다운 표기 엘리먼트
  let countdownSpan = null;

  // 보정된 주기 타이머(fixed rate)
  function fixedRate(callback, interval) {
    let nextTime = Date.now();
    let timeoutId = null;
    let stopped = false;
    function schedule() {
      if (stopped) return;
      nextTime += interval;
      timeoutId = setTimeout(() => {
        try { callback(); } catch {}
        schedule();
      }, Math.max(0, nextTime - Date.now()));
    }
    nextTime += interval;
    timeoutId = setTimeout(() => {
      try { callback(); } catch {}
      schedule();
    }, interval);
    return () => { stopped = true; if (timeoutId) try { clearTimeout(timeoutId); } catch {} };
  }

  function formatMMSS(total) {
    const sec = Math.max(0, Math.floor(total || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function findChatInputWrapper() {
    try {
      // contenteditable 또는 textarea/input 기반 모두 탐색
      const candidates = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"]'));
      for (const el of candidates) {
        const ph = (el.getAttribute('placeholder') || '').trim();
        const txt = ph || (el.textContent || '');
        if (/채팅을\s*입력/i.test(txt)) {
          const wrapper = el.closest('div');
          if (wrapper) return wrapper;
        }
      }
      // 보조: 클래스 기반 래퍼 추정
      const alt = Array.from(document.querySelectorAll('div')).find(d => Array.from(d.classList || []).some(c => /live_chatting_input.*textarea/i.test(c)));
      return alt || null;
    } catch { return null; }
  }

  function findChatInputElement() {
    try {
      const candidates = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"]'));
      for (const el of candidates) {
        const ph = (el.getAttribute && el.getAttribute('placeholder')) || '';
        const txt = (ph || '').trim();
        const role = (el.getAttribute && el.getAttribute('role')) || '';
        const ariaLabel = (el.getAttribute && el.getAttribute('aria-label')) || '';
        if (/채팅을\s*입력/i.test(txt) || /채팅/i.test(ariaLabel) || /textbox/i.test(role)) {
          return el;
        }
      }
    } catch {}
    return null;
  }

  function isInputEmpty(el) {
    if (!el) return true;
    try {
      if (typeof el.value === 'string') return el.value.trim().length === 0;
      return (el.textContent || '').trim().length === 0;
    } catch { return true; }
  }

  function setTimerVisible(visible) {
    if (!countdownSpan) return;
    countdownSpan.style.display = visible ? 'inline-flex' : 'none';
  }

  function refreshTimerVisibility() {
    const input = findChatInputElement();
    if (!input) return;
    const focused = document.activeElement === input;
    const empty = isInputEmpty(input);
    setTimerVisible(!focused && empty);
  }

  function bindChatInputEvents() {
    const input = findChatInputElement();
    if (!input) return;
    if (input.__chzzkTimerBound) return;
    const hide = () => setTimerVisible(false);
    const onBlurOrChange = () => refreshTimerVisibility();
    input.addEventListener('focus', hide);
    input.addEventListener('click', hide);
    input.addEventListener('focusin', hide);
    input.addEventListener('blur', onBlurOrChange);
    input.addEventListener('focusout', onBlurOrChange);
    input.addEventListener('input', onBlurOrChange);
    try { input.__chzzkTimerBound = true; } catch {}
    // 초기 상태 반영
    refreshTimerVisibility();
  }

  function ensureCountdownSpan() {
    if (!settings.countdown) return null;
    const wrapper = findChatInputWrapper();
    if (!wrapper) return null;
    if (countdownSpan && countdownSpan.isConnected) return countdownSpan;
    // 입력창 안쪽 우측에 고정 표시
    countdownSpan = document.createElement('span');
    countdownSpan.className = 'point_remain_time';
    countdownSpan.style.position = 'absolute';
    countdownSpan.style.top = '50%';
    countdownSpan.style.transform = 'translateY(-50%)';
    countdownSpan.style.right = '44px';
    countdownSpan.style.display = 'inline-flex';
    countdownSpan.style.alignItems = 'center';
    countdownSpan.style.height = '20px';
    countdownSpan.style.padding = '0 6px';
    countdownSpan.style.gap = '4px';
    countdownSpan.style.fontSize = '13px';
    countdownSpan.style.fontWeight = '700';
    countdownSpan.style.lineHeight = '20px';
    countdownSpan.style.letterSpacing = '0.2px';
    countdownSpan.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    countdownSpan.style.color = '#cfd3dc';
    countdownSpan.style.pointerEvents = 'none';
    // 래퍼가 상대 위치가 아닐 경우에 한해 상대 위치 부여 (레이아웃 영향 최소화)
    try { const cs = getComputedStyle(wrapper); if (cs && cs.position === 'static') wrapper.style.position = 'relative'; } catch {}
    wrapper.appendChild(countdownSpan);
    bindChatInputEvents();
    refreshTimerVisibility();
    return countdownSpan;
  }

  function updateCountdownUI() {
    if (!settings.countdown) return;
    const el = ensureCountdownSpan();
    if (!el) return;
    el.innerHTML = `${TIMER_ICON_SVG}<span>${formatMMSS(remainSeconds)}</span>`;
  }

  async function saveLastPowerClickAt(ts) {
    lastPowerClickAt = ts;
    try { await chrome.storage.local.set({ chzzkLastPowerClickAt: ts }); } catch {}
  }

  function startCountdownTimer() {
    if (!settings.countdown) return;
    if (stopCountdownTimerHandle) return;
    stopCountdownTimerHandle = fixedRate(() => {
      const now = Date.now();
      if (lastPowerClickAt > 0) {
        const elapsed = Math.floor((now - lastPowerClickAt) / 1000);
        remainSeconds = Math.max(0, COOLDOWN_SECONDS - elapsed);
      } else {
        remainSeconds = COOLDOWN_SECONDS;
      }
      updateCountdownUI();
      if (remainSeconds <= 0 && settings.auto) {
        try { ensurePowerButtonClicked(); } catch {}
      }
    }, 1000);
    updateCountdownUI();
  }

  function stopCountdownTimer() {
    if (stopCountdownTimerHandle) {
      try { stopCountdownTimerHandle(); } catch {}
      stopCountdownTimerHandle = null;
    }
  }

  (function alwaysActive() {
    try {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    } catch {}
    try {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch {}
    try {
      Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
    } catch {}
    try {
      document.hasFocus = () => true;
    } catch {}
    const blockedEvents = ['visibilitychange', 'blur', 'webkitvisibilitychange'];
    const origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (blockedEvents.includes(type)) return;
      return origAdd.call(this, type, listener, options);
    };
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } catch {}
  })();

  function parsePower(text) {
    if (!text) return 0;
    const digits = text.replace(/[^0-9]/g, '');
    return Number(digits || 0);
  }

  async function getChannelInfo(channelId) {
    if (!channelId) return null;
    if (channelInfoCache.has(channelId)) return channelInfoCache.get(channelId);
    try {
      const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}`);
      const json = await res.json();
      const info = json?.content ? {
        channelId: json.content.channelId,
        channelName: json.content.channelName,
        channelImageUrl: json.content.channelImageUrl,
        verifiedMark: json.content.verifiedMark,
      } : null;
      if (info) channelInfoCache.set(channelId, info);
      return info;
    } catch (e) {
      return null;
    }
  }

  async function savePowerLog(channelId, amount, method, testAmount = null) {
    try {
      if (!channelId && !method) return;
      const info = channelId ? (await getChannelInfo(channelId)) : null;
      const logEntry = {
        timestamp: new Date().toISOString(),
        channelId: info?.channelId || channelId || '',
        channelName: info?.channelName || '알 수 없는 채널',
        channelImageUrl: info?.channelImageUrl || '',
        verifiedMark: !!info?.verifiedMark,
        amount,
        method,
      };
      if (testAmount !== null) {
        logEntry.channelName = `${logEntry.channelName} (테스트) - ${method} - ${testAmount}`;
      }
      const result = await chrome.storage.local.get([POWER_LOG_KEY]);
      const logs = result[POWER_LOG_KEY] || [];
      logs.unshift(logEntry);
      if (logs.length > 1000) logs.splice(1000);
      await chrome.storage.local.set({ [POWER_LOG_KEY]: logs });
    } catch (e) {}
  }

  async function fetchLogPower(channelId) {
    const result = { amount: null, active: true, claims: [] };
    if (!channelId) return result;
    try {
      const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/log-power`, { credentials: 'include' });
      const data = await res.json();
      if (data && data.content) {
        if (typeof data.content.amount === 'number') result.amount = data.content.amount;
        if (typeof data.content.active === 'boolean') result.active = data.content.active;
        if (Array.isArray(data.content.claims)) result.claims = data.content.claims;
      }
    } catch (e) {}
    return result;
  }

  function getChannelIdFromUrl() {
    try {
      const m = location.pathname.match(/\/(live|channel|video)\/([\w-]+)/);
      return m ? m[2] : '';
    } catch {
      return '';
    }
  }

  function tryFindRankingContainer() {
    // 가장 먼저 텍스트 헤딩을 포함한 컨테이너를 찾음
    const nodes = document.querySelectorAll('section, div, ul');
    for (const el of nodes) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ');
      if (/채널별 통나무 파워|누적 파워/i.test(txt)) {
        // 내부에 리스트스러운 요소가 있는지 확인
        if (el.querySelector('li, [role="listitem"], ul')) return el;
      }
    }
    return null;
  }

  function tryFindChannelCountBadge() {
    // 채팅창 근처의 통나무 아이콘+숫자
    const icons = Array.from(document.querySelectorAll('img, svg'));
    for (const icon of icons) {
      const parent = icon.closest('div, span');
      if (!parent) continue;
      const txt = (parent.textContent || '').trim();
      if (/^[0-9][0-9,\.\s]*$/.test(txt) && icon.getBoundingClientRect) {
        // 우선순위 높게 반환
        return parent;
      }
    }
    return null;
  }

  function extractItems(root) {
    const rows = root.querySelectorAll('li, [role="listitem"], div');
    const items = [];
    rows.forEach((r) => {
      const text = (r.textContent || '').trim();
      // 끝에 큰 숫자가 있는 패턴
      const m = text.match(/([0-9][0-9,\.\s]*)$/);
      const power = parsePower(m ? m[1] : '');
      if (!power) return;

      // 이름 후보
      let name = '';
      const nameEl = r.querySelector('span, strong, [class*="name" i]');
      if (nameEl) name = nameEl.textContent?.trim() || '';
      if (!name) {
        const trimmed = text.replace(m?.[1] || '', '').trim();
        name = trimmed.split(/\s+/).slice(0, 4).join(' ');
      }

      // 아바타 후보
      let avatar = '';
      const img = r.querySelector('img');
      if (img?.src) avatar = img.src;

      items.push({ name, power, avatar, channelId: getChannelIdFromUrl() });
    });
    return items;
  }

  function hashPayload(items) {
    try {
      return btoa(unescape(encodeURIComponent(JSON.stringify(items.slice(0, 20)))));
    } catch {
      return Math.random().toString(36).slice(2);
    }
  }

  // --------------------
  // 채널 API를 이용해 파워 수집/배지 반영
  // --------------------
  function isLivePage() {
    return /\/(live|video)\//.test(location.pathname);
  }

  // 플레이어 화질을 최고로 시도
  let lastBestQualityAt = 0;
  let bestLockInProgress = false;
  function alreadyAttemptedBest() { try { return !!window.__chzzkBestOnce; } catch { return false; } }
  function markAttemptedBest() { try { window.__chzzkBestOnce = true; } catch {} }
  function clickEl(el) {
    if (DISABLE_BEST_QUALITY) return;
    try {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      if (typeof el.click === 'function') el.click();
    } catch {}
  }
  function showToast(msg) {
    try {
      const id = 'chzzk-best-toast-style';
      if (!document.getElementById(id)) {
        const st = document.createElement('style');
        st.id = id;
        st.textContent = `.chzzk-best-toast{position:fixed;right:20px;bottom:16px;background:rgba(0,0,0,.75);color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;z-index:2147483647;opacity:0;transition:opacity .2s}`;
        document.head.appendChild(st);
      }
      const el = document.createElement('div');
      el.className = 'chzzk-best-toast';
      el.textContent = msg;
      document.body.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = '1'; });
      setTimeout(() => { el.style.opacity = '0'; el.addEventListener('transitionend', () => el.remove(), { once: true }); }, 1200);
    } catch {}
  }
  function moveMouseOver(el) {
    if (DISABLE_BEST_QUALITY) return;
    try {
      const rect = el.getBoundingClientRect();
      const x = Math.floor(rect.left + rect.width / 2);
      const y = Math.floor(rect.top + 10);
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true, clientX: x, clientY: y }));
    } catch {}
  }
  function getPlayerContainer() {
    const v = document.querySelector('video');
    if (!v) return document.body;
    const playerSelectors = [
      'div[class*="pzp-"]',
      'div[class*="webplayer" i]',
      'div[id*="player" i]',
      'div[class*="player" i]'
    ];
    for (const sel of playerSelectors) {
      const anc = v.closest(sel);
      if (anc) return anc;
    }
    return v.closest('div') || v.parentElement || document.body;
  }
  function findSettingsButton(scopeEl) {
    const scope = scopeEl || getPlayerContainer();
    const selectors = [
      'button[aria-label*="설정" i]',
      'button[aria-label*="품질" i]',
      'button[class*="setting" i]',
      'button[class*="quality" i]',
      '[role="button"][class*="setting" i]',
      '[data-test-id*="quality" i]',
      '[data-testid*="quality" i]'
    ];
    for (const sel of selectors) {
      const b = scope.querySelector(sel);
      if (b) return b;
    }
    // 플레이어 컨트롤 내부에서 기어 아이콘
    const candidates = Array.from(scope.querySelectorAll('button, [role="button"]'));
    return candidates.find(b => /설정|setting|gear|품질|quality/i.test(b.getAttribute('aria-label') || b.title || '')) || null;
  }
  function findQualityMenuItems(anchorEl) {
    const anchor = anchorEl || getPlayerContainer();
    const anchorRect = anchor.getBoundingClientRect();
    const containers = Array.from(document.querySelectorAll('[role="menu"], .menu, .dropdown, .popover, .layer, .popup'))
      // 플레이어 근처(센터 거리 기준) 컨테이너만 사용
      .filter(c => {
        const r = c.getBoundingClientRect();
        const dx = (r.left + r.width / 2) - (anchorRect.left + anchorRect.width / 2);
        const dy = (r.top + r.height / 2) - (anchorRect.top + anchorRect.height / 2);
        const dist = Math.hypot(dx, dy);
        const looksLikeQuality = /해상도|화질|품질|Quality|Resolution/i.test(c.textContent || '');
        return dist < 400 && looksLikeQuality && r.width > 0 && r.height > 0;
      });
    if (!containers.length) return [];
    // 가장 가까운 컨테이너 하나만 사용
    containers.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const ad = Math.hypot((ar.left + ar.width/2) - (anchorRect.left + anchorRect.width/2), (ar.top + ar.height/2) - (anchorRect.top + anchorRect.height/2));
      const bd = Math.hypot((br.left + br.width/2) - (anchorRect.left + anchorRect.width/2), (br.top + br.height/2) - (anchorRect.top + anchorRect.height/2));
      return ad - bd;
    });
    const target = containers[0];
    return Array.from(target.querySelectorAll('li, [role="menuitem"], [role="menuitemradio"], button'));
  }
  function computeQualityScore(text) {
    const t = (text || '').trim();
    if (!t) return -1;
    if (/원본|최고|최상|고화질|1080p\(원본\)/i.test(t)) return 10000;
    const m = t.match(/(\d{3,4})\s*p?/i);
    if (m) return parseInt(m[1], 10) || -1;
    if (/자동|auto/i.test(t)) return 0; // 자동은 최하
    return -1;
  }
  function pickBestItemFrom(items) {
    let bestItem = null;
    let bestScore = -1;
    for (const it of items) {
      const score = computeQualityScore(it.textContent || '');
      if (score > bestScore) { bestScore = score; bestItem = it; }
    }
    return { bestItem, bestScore };
  }

  // ------- 품질 고정 플로우  -------
  function pollOnce(selector, onFound, tries = 20, delayMs = 210) {
    let count = 0;
    const timer = setInterval(() => {
      count++;
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(timer);
        try { onFound(el); } catch {}
      } else if (count >= tries) {
        clearInterval(timer);
      }
    }, delayMs);
  }
  function applyTuneQualityFlow() {
    return new Promise((resolve) => {
      const settingSel = 'button[class*="pzp-pc-setting-button"]';
      const introSel = 'div[class*="pzp-pc-setting-intro-quality"]';
      const itemSel = 'li[class*="quality-item"]';
      let done = false;
      function finish(ok) { if (!done) { done = true; resolve(!!ok); } }
      pollOnce(settingSel, (btn) => {
        clickEl(btn);
        pollOnce(introSel, (intro) => {
          clickEl(intro);
          pollOnce(itemSel, () => {
            const list = Array.from(document.querySelectorAll(itemSel));
            if (!list.length) return finish(false);
            let target = list.find(li => /1080/.test((li.textContent||'')));
            if (!target) target = list.find(li => /720/.test((li.textContent||'')));
            if (!target) target = list[0];
            if (!target) return finish(false);
            try { target.focus(); } catch {}
            clickEl(target);
            const enter = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
            target.dispatchEvent(enter);
            finish(true);
          }, 20, 210);
        }, 20, 210);
      }, 20, 210);
      setTimeout(() => finish(false), 5000);
    });
  }
  function trySetBestQualityPzpPath() {
    const settingBtn = document.querySelector('button[class*="pzp-pc-setting-button"]');
    if (!settingBtn) return false;
    clickEl(settingBtn);
    const intro = document.querySelector('div[class*="pzp-pc-setting-intro-quality"]');
    if (intro) clickEl(intro);
    const items = document.querySelectorAll('li[class*="quality-item"]');
    if (!items || items.length === 0) return false;
    let best = Array.from(items).find(el => /2160|1440|1080|원본|최고|최상/i.test((el.textContent||'')));
    if (!best) best = Array.from(items).find(el => /720/i.test((el.textContent||'')));
    if (!best) return false;
    best.focus();
    clickEl(best);
    const enter = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    best.dispatchEvent(enter);
    lastBestQualityAt = Date.now();
    showToast('최고 화질로 전환');
    return true;
  }
  function startScrollBlock(durationMs = 1200) {
    try {
      const prevHtmlOverflow = document.documentElement.style.overflow;
      const prevBodyOverflow = document.body.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      const wheelHandler = (e) => { e.preventDefault(); };
      const touchHandler = (e) => { e.preventDefault(); };
      const keyHandler = (e) => {
        const k = e.key;
        if (k === ' ' || k === 'Spacebar' || k === 'PageDown' || k === 'PageUp' || k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
          e.preventDefault();
        }
      };
      window.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
      window.addEventListener('touchmove', touchHandler, { passive: false, capture: true });
      window.addEventListener('keydown', keyHandler, { capture: true });
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        window.removeEventListener('wheel', wheelHandler, { capture: true });
        window.removeEventListener('touchmove', touchHandler, { capture: true });
        window.removeEventListener('keydown', keyHandler, { capture: true });
        document.documentElement.style.overflow = prevHtmlOverflow;
        document.body.style.overflow = prevBodyOverflow;
      };
      setTimeout(end, durationMs);
      return end;
    } catch {
      return () => {};
    }
  }
  async function trySetBestQuality(force = false) {
    if (DISABLE_BEST_QUALITY) return;
    if (!settings.best) return;
    if (!isLivePage()) return;
    if (document.visibilityState !== 'visible') return;
    if (alreadyAttemptedBest()) return;
    if (!force && Date.now() - lastBestQualityAt < 4000) return;
    let endBlock;
    try {
      bestLockInProgress = true;
      endBlock = startScrollBlock(1200);
      // 컨트롤 노출을 위해 비디오 영역에 마우스 무브
      const player = getPlayerContainer();
      if (player) moveMouseOver(player);
      // 우선 특정 경로 시도 
      const tuned = await applyTuneQualityFlow();
      if (tuned || trySetBestQualityPzpPath()) { lastBestQualityAt = Date.now(); showToast('최고 화질로 전환'); bestLockInProgress = false; return; }
      const btn = findSettingsButton(player);
      if (!btn) return;
      clickEl(btn);
      setTimeout(() => {
        // 1단계: 설정 메뉴 내에서 "화질" 항목 진입 필요 여부 확인
        const firstItems = findQualityMenuItems(player);
        const qualityEntry = firstItems.find(x => /해상도|화질|품질|Quality|Resolution/i.test((x.textContent || '').trim()));
        if (qualityEntry) clickEl(qualityEntry);
        const attemptSelect = (attemptsLeft) => {
          setTimeout(() => {
            const items = findQualityMenuItems(player);
            if (!items.length) { if (attemptsLeft > 0) attemptSelect(attemptsLeft - 1); return; }
            const { bestItem, bestScore } = pickBestItemFrom(items);
            if (bestItem) {
              clickEl(bestItem);
              setTimeout(() => {
                // 선택 검증: 체크/선택됨 표시가 최고 점수인지 확인
                const checked = items.find(x => x.getAttribute('aria-checked') === 'true' || x.getAttribute('aria-selected') === 'true' || /선택됨|현재/i.test(x.textContent || '') || (x.classList && (x.classList.contains('selected') || x.classList.contains('is-selected'))));
                const ok = checked ? computeQualityScore(checked.textContent || '') >= bestScore : true;
                if (!ok && attemptsLeft > 0) {
                  attemptSelect(attemptsLeft - 1);
                } else {
                  lastBestQualityAt = Date.now();
                  showToast('최고 화질로 전환');
                }
              }, 40);
            } else if (attemptsLeft > 0) {
              attemptSelect(attemptsLeft - 1);
            }
          }, 10);
        };
        attemptSelect(3);
      }, 10);
    } catch {} finally { bestLockInProgress = false; markAttemptedBest(); try { if (typeof endBlock === 'function') endBlock(); } catch {} }
  }

  function findChatToolsRoot() {
    const candidates = Array.from(document.querySelectorAll('div'));
    for (const el of candidates) {
      const hasTools = Array.from(el.classList || []).some(cls => cls.startsWith('live_chatting_input_tools__'));
      if (hasTools) return el;
    }
    return null;
  }

  function renderChatBadge(amount, inactive) {
    // 더 이상 사용하지 않음: 새 배지 로직으로 대체됨
    updatePowerCountBadge(amount, !!inactive);
  }

  async function fetchAndUpdatePowerAmount() {
    if (!settings.auto) return;
    if (document.visibilityState !== 'visible') return;
    if (!isLivePage()) return;
    const channelId = getChannelIdFromUrl();
    if (!channelId) return;
    let amount = null;
    let active = true;
    let profileName = '';
    let profileImage = '';
    try {
      const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/log-power`, { credentials: 'include' });
      const data = await res.json();
      if (data && data.content) {
        if (typeof data.content.amount === 'number') amount = data.content.amount;
        if (typeof data.content.active === 'boolean') active = data.content.active;
      }
    } catch (e) {}

    // 채널 프로필 정보
    try {
      const profRes = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}`, { credentials: 'include' });
      const profJson = await profRes.json().catch(() => ({}));
      const c = profJson?.content || profJson?.channel || {};
      profileName = c.channelName || c.name || profileName;
      profileImage = c.channelImageUrl || c.imageUrl || profileImage;
      if (!profileName) {
        const liveRes = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/live-detail`, { credentials: 'include' });
        const liveJson = await liveRes.json().catch(() => ({}));
        const lc = liveJson?.content || {};
        const ch = lc.channel || {};
        profileName = lc.channelName || ch.channelName || profileName;
        profileImage = ch.channelImageUrl || ch.imageUrl || profileImage;
      }
    } catch (e) {}
    if (active === false) isChannelInactive = true; else isChannelInactive = false;
    cachedPowerAmount = amount;
    updatePowerCountBadge(amount, isChannelInactive);
    // 그래프용 시계열 샘플 전송
    try {
      if (typeof amount === 'number') {
        chrome.runtime.sendMessage({ type: 'CHZZK_TS_SAMPLE', channelId, amount, ts: Date.now() });
      }
    } catch {}
    // 집계에도 반영 (정확한 이름/이미지 제공)
    if (amount !== lastApiAmount) {
      lastApiAmount = amount;
      chrome.runtime.sendMessage({ type: 'CHZZK_CHANNEL_COUNT', channelId, name: profileName || document.title, count: amount || 0, avatar: profileImage || '' });
    }
  }

  async function scanOnce() {
    if (scanning) return;
    if (!settings.auto) return;
    if (document.visibilityState !== 'visible') return;
    scanning = true;
    try {
      // 1) 채널별 랭킹 패널 수집
      const panel = tryFindRankingContainer();
      if (panel) {
        const items = extractItems(panel).filter(i => i.name && i.power > 0);
        if (items.length > 0) {
          const h = hashPayload(items.map(i => ({ n: i.name, p: i.power })));
          if (h !== lastPayloadHash) {
            lastPayloadHash = h;
            chrome.runtime.sendMessage({ type: 'CHZZK_LOG_BATCH', items });
          }
        }
      }

      // 2) 현재 채널 배지 숫자 업데이트
      const badge = tryFindChannelCountBadge();
      if (badge) {
        const text = (badge.textContent || '').trim();
        const count = parsePower(text);
        const channelId = getChannelIdFromUrl();
        if (channelId && count !== lastSentDomCount) {
          lastSentDomCount = count;
          chrome.runtime.sendMessage({ type: 'CHZZK_CHANNEL_COUNT', channelId, name: document.title, count });
        }
      }
    } finally {
      scanning = false;
    }
  }

  // --------------------
  // 채팅 아래 배지
  // --------------------
  // 우측 하단 오버레이 배지 비활성화
  let badgeEl = null;
  function ensureBadge() { return null; }
  async function updateBadge() {
    const existing = document.getElementById('chzzk-log-badge');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    return;
  }

  // 오버레이 배지를 사용하지 않으므로 변경 감지 무시
  // ===== 새 배지(채팅 도구 옆) 표시 기능 =====
  let cachedPowerAmount = null;

  function isDarkTheme() {
    try { return document.documentElement.classList.contains('theme_dark'); } catch { return true; }
  }

  function getThemeColors() {
    const dark = isDarkTheme();
    return {
      bg: dark ? 'none' : '#fff',
      fg: dark ? '#fff' : '#000',
      hoverBg: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
      popupBg: dark ? 'var(--Ref-Color-Neutral-90, #141517)' : '#fff',
      popupFg: dark ? '#fff' : '#000',
    };
  }

  const POWER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none"><mask id="mask0_1071_43807" width="16" height="16" x="0" y="0" maskUnits="userSpaceOnUse" style="mask-type: alpha;"><path fill="currentColor" d="M6.795 2.434a.9.9 0 0 1 .74.388l.064.109 1.318 2.635H5.983l-.157-.313-.758-1.517a.9.9 0 0 1 .805-1.302h.922Z"></path><path fill="currentColor" fill-rule="evenodd" d="M12.148 4.434c.857 0 1.508.628 1.912 1.369.415.761.655 1.775.655 2.864 0 1.088-.24 2.102-.655 2.864-.404.74-1.055 1.369-1.912 1.369H4c-.857 0-1.508-.63-1.911-1.37-.416-.761-.655-1.775-.655-2.863 0-1.089.239-2.103.655-2.864.403-.74 1.054-1.37 1.911-1.37h8.148ZM4 5.566c-.248 0-.597.192-.917.779-.308.565-.517 1.385-.517 2.322 0 .936.209 1.756.517 2.321.32.587.67.779.917.779.248 0 .597-.192.917-.779.308-.565.517-1.385.517-2.321 0-.937-.209-1.757-.517-2.322-.32-.587-.67-.779-.917-.779Zm2.526 3.868a6.433 6.433 0 0 1-.222 1.132h5.363l.058-.002a.567.567 0 0 0 0-1.128l-.058-.002H6.526ZM6.284 6.7c.109.353.188.733.234 1.132h.815l.058-.002a.567.567 0 0 0 0-1.128l-.058-.002h-1.05Zm3.316 0a.567.567 0 1 0 0 1.132h3.923a4.83 4.83 0 0 0-.293-1.132H9.6Z" clip-rule="evenodd"></path><path fill="currentColor" d="M5.434 8.667c0-.937-.209-1.757-.517-2.322-.32-.587-.67-.779-.917-.779-.248 0-.597.192-.917.779-.308.565-.517 1.385-.517 2.322 0 .936.209 1.756.517 2.321.32.587.67.779.917.779.248 0 .597-.192.917-.779.308-.565.517-1.385.517-2.321Zm1.132 0c0 1.088-.239 2.102-.655 2.864C5.508 12.27 4.857 12.9 4 12.9s-1.508-.63-1.911-1.37c-.416-.761-.655-1.775-.655-2.863 0-1.089.239-2.103.655-2.864.403-.74 1.054-1.37 1.911-1.37s1.508.63 1.911 1.37c.416.761.655 1.775.655 2.864Z"></path><path fill="currentColor" d="M4.667 8.667C4.667 9.403 4.368 10 4 10c-.368 0-.667-.597-.667-1.333 0-.737.299-1.334.667-1.334.368 0 .667.597.667 1.334Z"></path></mask><g mask="url(#mask0_1071_43807)"><path fill="currentColor" d="M0 0h16v16H0z"></path></g></svg>`;
  const TIMER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 3"/><path d="M9 2h6"/></svg>`;

  (function injectTooltipStyle() {
    if (document.getElementById('chzzk_power_inactive_tooltip_style')) return;
    const style = document.createElement('style');
    style.id = 'chzzk_power_inactive_tooltip_style';
    style.textContent = `
    .log_disabled_tooltip{align-items:center;background-color:var(--color-bg-04,#2e3033);border:1px solid #0008;border-radius:6px;bottom:0;box-shadow:1px 1px 3px #0008;color:var(--color-content-02,#dfe2ea);display:none;font-size:12px;font-weight:400;justify-content:center;line-height:1.5;padding:5px 9px;pointer-events:none;position:absolute;right:30px;text-align:left;white-space:nowrap;z-index:1000}
    .chzzk_power_inactive_btn:hover .log_disabled_tooltip{display:inline-flex}
    `;
    document.head.appendChild(style);
  })();

  function updateBadgeInactiveState(badge, isInactive) {
    if (!badge) return;
    if (isInactive) {
      badge.classList.add('chzzk_power_inactive_btn');
      const svg = badge.querySelector('svg');
      if (svg) { svg.style.color = '#9aa0ab'; svg.setAttribute('fill', '#9aa0ab'); }
      if (!badge.querySelector('.log_disabled_tooltip')) {
        const tooltip = document.createElement('div');
        tooltip.textContent = '통나무가 비활성화 된 채널입니다.';
        tooltip.className = 'log_disabled_tooltip';
        const colors = getThemeColors();
        tooltip.style.backgroundColor = colors.bg === 'none' ? '#2e3033' : '#fff';
        tooltip.style.color = colors.fg;
        tooltip.style.border = '1px solid #0008';
        badge.appendChild(tooltip);
      }
    } else {
      badge.classList.remove('chzzk_power_inactive_btn');
      const svg = badge.querySelector('svg');
      if (svg) { const colors = getThemeColors(); svg.style.color = colors.fg; svg.setAttribute('fill', 'currentColor'); }
      const tooltip = badge.querySelector('.log_disabled_tooltip');
      if (tooltip) tooltip.remove();
    }
  }

  function createPowerBadge(amount, isInactive) {
    const toolsDivs = Array.from(document.querySelectorAll('div')).filter(div => Array.from(div.classList || []).some(cls => cls.startsWith('live_chatting_input_tools__')));
    let badgeTarget = null;
    let donationBtn = null;
    for (const toolsDiv of toolsDivs) {
      const btns = Array.from(toolsDiv.querySelectorAll('button'));
      const donationBtns = btns.filter(b => Array.from(b.classList || []).some(cls => cls.startsWith('live_chatting_input_donation_button__')));
      if (donationBtns.length > 0) {
        donationBtn = donationBtns[donationBtns.length - 1];
        badgeTarget = donationBtn;
        break;
      } else {
        const actionDivs = Array.from(toolsDiv.querySelectorAll('div')).filter(div => Array.from(div.classList || []).some(cls => cls.startsWith('live_chatting_input_action__')));
        if (actionDivs.length > 0) { badgeTarget = actionDivs[actionDivs.length - 1]; break; }
      }
    }
    if (!badgeTarget) return;

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.setAttribute('tabindex', '-1');
    badge.style.display = settings.badge ? 'inline-flex' : 'none';
    badge.style.alignItems = 'center';
    badge.style.justifyContent = 'center';
    badge.style.height = '24px';
    badge.style.minWidth = '24px';
    badge.style.gap = '6px';
    const colors = getThemeColors();
    badge.style.background = colors.bg;
    badge.style.border = 'none';
    badge.style.padding = '0 6px';
    badge.style.marginLeft = '6px';
    badge.style.borderRadius = '6px';
    badge.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Helvetica, Arial';
    badge.style.fontWeight = '700';
    badge.style.fontSize = '13px';
    badge.style.lineHeight = '24px';
    badge.style.color = colors.fg;
    badge.style.cursor = 'pointer';
    badge.addEventListener('mouseenter', () => { badge.style.background = colors.hoverBg; });
    badge.addEventListener('mouseleave', () => { badge.style.background = colors.bg; });
    badge.innerHTML = `${POWER_ICON_SVG}<span style="display:inline-block;min-width:3ch;text-align:right;">${amount !== null && amount !== undefined ? Number(amount).toLocaleString() : '?'}</span>`;
    badge.classList.add('chzzk_power_badge');
    const svg = badge.querySelector('svg');
    if (svg) { svg.style.color = colors.fg; svg.setAttribute('fill', 'currentColor'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); }

    updateBadgeInactiveState(badge, isInactive);

    badge.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      try { window.dispatchEvent(new CustomEvent('CHZZK_OPEN_BALANCES')); } catch {}
    };

    if (badgeTarget.tagName === 'BUTTON') badgeTarget.parentNode.insertBefore(badge, badgeTarget.nextSibling); else badgeTarget.appendChild(badge);
    lastPowerNode = badge;

    // 작은 그래프 버튼 생성 제거 (요청에 따라 비활성화)
  }

  function updatePowerCountBadge(amount = cachedPowerAmount, isInactive = false) {
    if (!settings.badge) return;
    if (!isLivePage()) return;
    cachedPowerAmount = amount;
    if (lastPowerNode && lastPowerNode.parentNode) { lastPowerNode.parentNode.removeChild(lastPowerNode); lastPowerNode = null; }
    if (lastChartBtnNode && lastChartBtnNode.parentNode) { lastChartBtnNode.parentNode.removeChild(lastChartBtnNode); lastChartBtnNode = null; }
    createPowerBadge(amount, isInactive);
  }

  let powerBadgeDomPoller = null;
  function startPowerBadgeDomPoller() {
    if (powerBadgeDomPoller) clearInterval(powerBadgeDomPoller);
    powerBadgeDomPoller = setInterval(() => {
      updatePowerCountBadge();
    }, 1000);
  }

  function clearTimers() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (powerCountInterval) { clearInterval(powerCountInterval); powerCountInterval = null; }
    if (initialKickTimer) { clearTimeout(initialKickTimer); initialKickTimer = null; }
    stopCountdownTimer();
    if (powerBadgeDomPoller) { clearInterval(powerBadgeDomPoller); powerBadgeDomPoller = null; }
    if (claimPollInterval) { clearInterval(claimPollInterval); claimPollInterval = null; }
  }

  async function loadSettings() {
    try {
      const { chzzkSettings, chzzkLastPowerClickAt, [SEEN_CLAIMS_KEY]: seen } = await chrome.storage.local.get(['chzzkSettings', 'chzzkLastPowerClickAt', SEEN_CLAIMS_KEY]);
      settings = { ...DEFAULT_SETTINGS, ...(chzzkSettings || {}) };
      if (Array.isArray(seen)) {
        for (const id of seen) claimedClaimIds.add(String(id));
      }
      if (typeof chzzkLastPowerClickAt === 'number') {
        lastPowerClickAt = chzzkLastPowerClickAt;
      }
      ensureTimers();
      ensureBestTimer();
      if (!settings.badge && lastChatBadgeEl && lastChatBadgeEl.parentNode) {
        lastChatBadgeEl.parentNode.removeChild(lastChatBadgeEl);
        lastChatBadgeEl = null;
      }
      // 새 배지 로직 즉시 반영
      updatePowerCountBadge(null, isChannelInactive);
      if (!settings.countdown && countdownSpan && countdownSpan.parentNode) {
        countdownSpan.parentNode.removeChild(countdownSpan);
        countdownSpan = null;
        stopCountdownTimer();
      }
      // 초기 진입 시 라이브 페이지면 타이머를 60:00에서 바로 시작
      try {
        if (isLivePage()) {
          const now = Date.now();
          lastPowerClickAt = now;
          saveLastPowerClickAt(now);
          remainSeconds = COOLDOWN_SECONDS;
          updateCountdownUI();
        }
      } catch {}
    } catch {}
  }

  function ensureTimers() {
    clearTimers();
    if (!settings.auto) return;
    // 즉시 1회 수행 + 주기 실행 (가시성일 때만 동작)
    initialKickTimer = setTimeout(() => { scanOnce(); updateBadge(); fetchAndUpdatePowerAmount(); if (!DISABLE_BEST_QUALITY) trySetBestQuality(true); }, 200);
    scanTimer = setInterval(scanOnce, SCAN_INTERVAL_MS);
    powerCountInterval = setInterval(fetchAndUpdatePowerAmount, 60 * 1000);
    startPowerButtonInterval();
    startCountdownTimer();
    startPowerBadgeDomPoller();
    startClaimPolling();
  }

  function ensureBestTimer() {
    if (bestInterval) { clearInterval(bestInterval); bestInterval = null; }
    if (DISABLE_BEST_QUALITY) return;
    if (!settings.best) return;
    if (alreadyAttemptedBest()) return;
    setTimeout(() => { if (!alreadyAttemptedBest()) trySetBestQuality(true); }, 150);
  }

  function isLivePage() {
    return /\/live\//.test(location.pathname);
  }

  async function pollClaimsAndLog() {
    try {
      if (document.visibilityState !== 'visible') return;
      if (!isLivePage()) return;
      const channelId = getChannelIdFromUrl();
      if (!channelId) return;
      const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/log-power`, { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      const claims = Array.isArray(data?.content?.claims) ? data.content.claims : [];
      if (!claims.length) return;
      let changed = false;
      for (const c of claims) {
        const claimId = c?.claimId || c?.id || `${c?.claimType || 'CLAIM'}-${c?.createdAt || c?.timestamp || ''}-${c?.amount || ''}`;
        const key = String(claimId);
        if (claimedClaimIds.has(key)) continue;
        const amt = Number(c?.amount ?? c?.value ?? c?.power ?? c?.delta ?? 0) || 0;
        const method = String(c?.claimType || 'claim').toLowerCase();
        await savePowerLog(channelId, amt, method);
        claimedClaimIds.add(key);
        changed = true;
      }
      if (changed) {
        // 보관 크기 제한
        const arr = Array.from(claimedClaimIds).slice(-2000);
        await chrome.storage.local.set({ [SEEN_CLAIMS_KEY]: arr });
        try { chrome.runtime.sendMessage({ action: 'powerAcquired' }); } catch {}
      }
    } catch {}
  }

  function startClaimPolling() {
    if (claimPollInterval) clearInterval(claimPollInterval);
    claimPollInterval = setInterval(pollClaimsAndLog, POWER_CLAIM_POLL_MS);
    // 즉시 1회
    pollClaimsAndLog();
  }

  function getChannelIdFromUrl() {
    try {
      const m = location.pathname.match(/\/(live|channel|video)\/([\w-]+)/);
      return m ? m[2] : '';
    } catch {
      return '';
    }
  }

  function hasRecentViewLog() {
    return Date.now() - lastViewLogAt < VIEW_LOG_COOLDOWN;
  }

  async function getViewPowerAmountBySubscription(channelId) {
    try {
      const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/subscription`, { credentials: 'include' });
      const data = await res.json();
      const tierNo = (data && data.content && typeof data.content.tierNo === 'number') ? data.content.tierNo : null;
      if (tierNo === 1) return 120;
      if (tierNo === 2) return 200;
    } catch (e) {}
    return 100;
  }

  async function ensurePowerButtonClicked() {
    if (!settings.auto) return;
    if (!isLivePage()) return;
    const aside = document.querySelector('aside#aside-chatting');
    if (!aside) return;
    const channelId = getChannelIdFromUrl();
    if (!channelId) return;
    const btn = Array.from(aside.querySelectorAll('button')).find((b) => Array.from(b.classList || []).some((cls) => cls.startsWith('live_chatting_power_button__')));
    if (!btn) return;
    const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    if (isDisabled) return;
    btn.click();
    try { await saveLastPowerClickAt(Date.now()); } catch {}
    remainSeconds = COOLDOWN_SECONDS;
    try { updateCountdownUI(); } catch {}
    try {
      const result = await chrome.storage.local.get(['powerLogs']);
      const logs = result.powerLogs || [];
      const now = Date.now();
      const hasRecentViewInStorage = logs.some((log) => log && log.method === 'view' && log.timestamp && (new Date(log.timestamp).getTime() >= now - VIEW_LOG_COOLDOWN));
      const hasRecentViewInMemory = hasRecentViewLog();
      if (!(hasRecentViewInStorage || hasRecentViewInMemory)) {
        const amountToLog = await getViewPowerAmountBySubscription(channelId);
        await savePowerLog(channelId, amountToLog, 'view');
        lastViewLogAt = now;
        try { chrome.runtime.sendMessage({ action: 'powerAcquired' }); } catch {}
      }
    } catch (e) {
      if (!hasRecentViewLog()) {
        const amountToLog = await getViewPowerAmountBySubscription(channelId);
        await savePowerLog(channelId, amountToLog, 'view');
        lastViewLogAt = Date.now();
        try { chrome.runtime.sendMessage({ action: 'powerAcquired' }); } catch {}
      }
    }
    if (!pendingFetchOptions) pendingFetchOptions = {};
    try { fetchAndUpdatePowerAmount(); } catch {}
  }

  function startPowerButtonInterval() {
    if (powerButtonInterval) clearInterval(powerButtonInterval);
    if (!settings.auto) return;
    powerButtonInterval = setInterval(ensurePowerButtonClicked, 1000);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes && changes.chzzkSettings) {
      const next = changes.chzzkSettings.newValue || {};
      settings = { ...DEFAULT_SETTINGS, ...next };
      ensureTimers();
      ensureBestTimer();
      if (!settings.badge && lastChatBadgeEl && lastChatBadgeEl.parentNode) {
        lastChatBadgeEl.parentNode.removeChild(lastChatBadgeEl);
        lastChatBadgeEl = null;
      }
      // 설정이 바뀌면 다음 탭 진입 때 다시 1회만 시도할 수 있도록 리셋
      try { delete window.__chzzkBestOnce; } catch {}
      if (!settings.countdown) {
        if (countdownSpan && countdownSpan.parentNode) {
          countdownSpan.parentNode.removeChild(countdownSpan);
          countdownSpan = null;
        }
        stopCountdownTimer();
      } else {
        startCountdownTimer();
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    // 가시성 변경 시 즉시 한 번 동작하고 타이머 재평가
    if (document.visibilityState === 'visible') {
      scanOnce();
      fetchAndUpdatePowerAmount();
      trySetBestQuality(true);
      updateCountdownUI();
      try { bindChatInputEvents(); refreshTimerVisibility(); } catch {}
    }
  });

  // URL 변화(채널 이동) 대비
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      updateBadge();
      fetchAndUpdatePowerAmount();
      try { delete window.__chzzkBestOnce; } catch {}
      trySetBestQuality(true);
      // 채널 이동 시 타이머를 60:00부터 즉시 시작
      try {
        if (isLivePage()) {
          const now = Date.now();
          lastPowerClickAt = now;
          saveLastPowerClickAt(now);
          remainSeconds = COOLDOWN_SECONDS;
          updateCountdownUI();
          bindChatInputEvents();
          refreshTimerVisibility();
        }
      } catch {}
    }
  }, 1000);

  // 매 분마다 API 값 갱신
  if (powerCountInterval) clearInterval(powerCountInterval);
  // 타이머는 ensureTimers에서 관리

  // 팝업에서 "통나무" 버튼을 눌렀을 때, 전체 보유 현황 팝업 레이어 열기
  window.addEventListener('CHZZK_OPEN_BALANCES', () => {
    (async () => {
      try {
        const res = await fetch('https://api.chzzk.naver.com/service/v1/log-power/balances', { credentials: 'include' });
        const json = await res.json();
        const arr = (json && json.content && json.content.data) ? json.content.data : [];
        const list = arr.filter(x => x.amount >= 100).sort((a, b) => b.amount - a.amount);
        const cleanName = (name) => {
          if (!name) return '';
          let n = String(name);
          // 줄바꿈 앞까지, ' - CHZZK' 등 접미사 제거
          n = n.split('\n')[0];
          n = n.replace(/\s*-\s*CHZZK.*$/i, '');
          // 제목 패턴: "채널명 - 제목" → 앞부분 선호
          const dashIdx = n.indexOf(' - ');
          if (dashIdx > 0 && dashIdx <= 20) {
            n = n.slice(0, dashIdx);
          }
          // 물음표 반복 등 비정상 문자 정리
          n = n.replace(/\?{2,}/g, '').trim();
          return n.trim();
        };
        const host = document.createElement('div');
        host.style.position = 'fixed';
        host.style.left = '0';
        host.style.top = '0';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.display = 'flex';
        host.style.alignItems = 'center';
        host.style.justifyContent = 'center';
        host.style.zIndex = '2147483646';
        host.style.background = 'rgba(0,0,0,0.7)';
        host.style.backdropFilter = 'blur(4px)';
        host.style.fontFamily = "'Pretendard',-apple-system,BlinkMacSystemFont,system-ui,Roboto,sans-serif";

        const box = document.createElement('div');
        box.style.background = '#111216';
        box.style.border = '1px solid rgba(255,255,255,0.1)';
        box.style.borderRadius = '24px';
        box.style.width = 'min(520px, 94vw)';
        box.style.maxHeight = '70vh';
        box.style.overflow = 'hidden';
        box.style.display = 'flex';
        box.style.flexDirection = 'column';
        box.style.boxShadow = '0 24px 48px rgba(0,0,0,0.5)';
        
        const total = list.reduce((s, x) => s + (x.amount || 0), 0);
        const defaultImg = 'https://ssl.pstatic.net/cmstatic/nng/img/img_anonymous_square_gray_opacity2x.png?type=f120_120_na';
        
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.padding = '20px 24px';
        header.style.borderBottom = '1px solid rgba(255,255,255,0.08)';
        header.style.background = 'rgba(255,255,255,0.02)';
        
        const titleWrap = document.createElement('div');
        titleWrap.innerHTML = `
          <div style="font-size:12px;font-weight:600;color:#94a3b8;margin-bottom:4px;">현재 방송 누적</div>
          <div style="font-weight:800;font-size:20px;color:#fff;">${Number(total).toLocaleString()} 통나무</div>
        `;
        
        const volBtn = document.createElement('button');
        volBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:18px;height:18px;margin-right:4px"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>차트';
        volBtn.style.background = 'rgba(59,130,246,0.1)';
        volBtn.style.border = 'none';
        volBtn.style.color = '#60a5fa';
        volBtn.style.borderRadius = '8px';
        volBtn.style.padding = '8px 12px';
        volBtn.style.marginRight = '8px';
        volBtn.style.cursor = 'pointer';
        volBtn.style.fontSize = '13px';
        volBtn.style.fontWeight = '600';
        volBtn.style.display = 'flex';
        volBtn.style.alignItems = 'center';
        volBtn.addEventListener('mouseover', () => volBtn.style.background = 'rgba(59,130,246,0.2)');
        volBtn.addEventListener('mouseout', () => volBtn.style.background = 'rgba(59,130,246,0.1)');

        const close = document.createElement('button');
        close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" style="width:20px;height:20px"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>';
        close.style.background = 'rgba(255,255,255,0.08)';
        close.style.border = 'none';
        close.style.color = '#9ca3af';
        close.style.borderRadius = '50%';
        close.style.width = '32px';
        close.style.height = '32px';
        close.style.display = 'flex';
        close.style.alignItems = 'center';
        close.style.justifyContent = 'center';
        close.style.cursor = 'pointer';
        close.addEventListener('mouseover', () => { close.style.background = 'rgba(255,255,255,0.15)'; close.style.color = '#fff'; });
        close.addEventListener('mouseout', () => { close.style.background = 'rgba(255,255,255,0.08)'; close.style.color = '#9ca3af'; });

        function removeHost() {
          if (escHandler) window.removeEventListener('keydown', escHandler);
          host.remove();
        }
        close.addEventListener('click', removeHost);
        
        const rightBtns = document.createElement('div');
        rightBtns.style.display = 'flex';
        rightBtns.style.alignItems = 'center';
        rightBtns.appendChild(volBtn);
        rightBtns.appendChild(close);
        
        header.appendChild(titleWrap);
        header.appendChild(rightBtns);
        
        function openVolatilityWindow() {
          const volHost = document.createElement('div');
          volHost.style.position = 'fixed';
          volHost.style.left = '0';
          volHost.style.top = '0';
          volHost.style.width = '100%';
          volHost.style.height = '100%';
          volHost.style.display = 'flex';
          volHost.style.alignItems = 'center';
          volHost.style.justifyContent = 'center';
          volHost.style.zIndex = '2147483647';
          volHost.style.background = 'rgba(0,0,0,0.45)';

          const vbox = document.createElement('div');
          vbox.style.background = '#141517';
          vbox.style.border = '1px solid #0008';
          vbox.style.borderRadius = '12px';
          vbox.style.width = '94%';
          vbox.style.maxWidth = '560px';
          vbox.style.maxHeight = '80vh';
          vbox.style.overflow = 'auto';
          vbox.style.padding = '12px 12px 16px';
          vbox.style.boxShadow = '0 20px 40px rgba(0,0,0,0.35)';

          const vheader = document.createElement('div');
          vheader.style.display = 'flex';
          vheader.style.alignItems = 'center';
          vheader.style.justifyContent = 'space-between';
          vheader.style.padding = '14px 16px';
          vheader.style.background = 'linear-gradient(135deg, #2a6aff 0%, #1e40af 100%)';
          vheader.style.color = '#fff';
          vheader.innerHTML = `<div style="font-weight:800;font-size:18px;letter-spacing:.2px">변동폭</div>`;

          const vbtns = document.createElement('div');
          vbtns.style.display = 'flex';
          vbtns.style.gap = '6px';
          const refresh = document.createElement('button');
          refresh.textContent = '새로고침';
          refresh.style.background = 'rgba(255,255,255,0.15)';
          refresh.style.border = '1px solid rgba(255,255,255,0.25)';
          refresh.style.color = '#fff';
          refresh.style.borderRadius = '999px';
          refresh.style.padding = '6px 12px';
          const vclose = document.createElement('button');
          vclose.textContent = '닫기';
          vclose.style.background = 'rgba(255,255,255,0.15)';
          vclose.style.border = '1px solid rgba(255,255,255,0.25)';
          vclose.style.color = '#fff';
          vclose.style.borderRadius = '999px';
          vclose.style.padding = '6px 12px';
          vbtns.appendChild(refresh);
          vbtns.appendChild(vclose);
          vheader.appendChild(vbtns);

          const vcontent = document.createElement('div');
          vcontent.style.padding = '12px 12px 16px';
          vcontent.innerHTML = `
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
              <label style="display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,0.18);padding:6px 10px;border-radius:8px;background:#0f1113;">
                <span style="font-size:13px;">기간</span>
                <select id="vw-period" style="background:#0f1113;color:#fff;border:1px solid rgba(255,255,255,0.18);border-radius:6px;padding:6px 8px;font-size:13px;">
                  <option value="24h">24시간</option>
                  <option value="7d">7일</option>
                  <option value="all" selected>전체</option>
                </select>
              </label>
              <label style="display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,0.18);padding:6px 10px;border-radius:8px;background:#0f1113;cursor:pointer;">
                <input id="vw-exclude-pred" type="checkbox" style="margin:0;" />
                <span style="font-size:13px;">승부예측 제외</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,0.18);padding:6px 10px;border-radius:8px;background:#0f1113;">
                <span style="font-size:13px;">모드</span>
                <select id="vw-mode" style="background:#0f1113;color:#fff;border:1px solid rgba(255,255,255,0.18);border-radius:6px;padding:6px 8px;font-size:13px;">
                  <option value="cum">누적(선)</option>
                  <option value="delta" selected>획득(막대)</option>
                </select>
              </label>
              <label style="display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,0.18);padding:6px 10px;border-radius:8px;background:#0f1113;cursor:pointer;">
                <input id="vw-live" type="checkbox" checked style="margin:0;" />
                <span style="font-size:13px;">실시간</span>
              </label>
            </div>

            <div style="margin-top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;">
              <div style="background:#121418;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;">
                <div style="font-size:12px;color:#aab;">채널</div>
                <div id="vw-name" style="font-weight:700;margin-top:6px;">-</div>
              </div>
              <div style="background:#121418;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;">
                <div style="font-size:12px;color:#aab;">기록 수</div>
                <div id="vw-samples" style="font-weight:700;margin-top:6px;">-</div>
              </div>
              <div style="background:#121418;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;">
                <div style="font-size:12px;color:#aab;">변동폭</div>
                <div id="vw-range" style="font-weight:700;margin-top:6px;">-</div>
              </div>
              <div style="background:#121418;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;">
                <div style="font-size:12px;color:#aab;">표준편차</div>
                <div id="vw-std" style="font-weight:700;margin-top:6px;">-</div>
              </div>
              <div style="background:#121418;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;grid-column:span 2;">
                <div style="font-size:12px;color:#aab;">최근 24시간 변동폭</div>
                <div id="vw-range24" style="font-weight:700;margin-top:6px;">-</div>
              </div>
            </div>

            <div style="margin-top:12px;background:#121418;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;">
              <canvas id="vw-chart" style="width:100%;height:220px;display:block;"></canvas>
              <div style="display:flex;justify-content:space-between;font-size:12px;color:#bbb;margin-top:6px;">
                <span id="vw-time">-</span>
                <span id="vw-unit">획득 금액</span>
              </div>
            </div>
          `;

          // ===== 통합 그래프 렌더링 시스템 =====
          class ChartConfig {
            constructor(options = {}) {
              this.padding = { left: options.padding?.left ?? 38, right: options.padding?.right ?? 8, top: options.padding?.top ?? 10, bottom: options.padding?.bottom ?? 20 };
              this.colors = {
                line: options.colors?.line ?? '#2a6aff',
                grid: options.colors?.grid ?? 'rgba(255,255,255,0.08)',
                text: options.colors?.text ?? 'rgba(255,255,255,0.65)',
                empty: options.colors?.empty ?? 'rgba(255,255,255,0.6)',
                gradientStart: options.colors?.gradientStart ?? 'rgba(42,106,255,0.35)',
                gradientEnd: options.colors?.gradientEnd ?? 'rgba(42,106,255,0.0)',
                barStart: options.colors?.barStart ?? 'rgba(42,106,255,0.9)',
                barEnd: options.colors?.barEnd ?? 'rgba(42,106,255,0.25)',
              };
              this.fonts = {
                axis: options.fonts?.axis ?? '11px system-ui, sans-serif',
                label: options.fonts?.label ?? '10px system-ui, sans-serif',
                empty: options.fonts?.empty ?? '12px system-ui, sans-serif',
              };
              this.gridLines = options.gridLines ?? 4;
              this.lineWidth = options.lineWidth ?? 2;
              this.barWidthRatio = options.barWidthRatio ?? 0.8;
              this.barMinWidth = options.barMinWidth ?? 2;
              this.barMaxWidth = options.barMaxWidth ?? 12;
              this.labelThreshold = options.labelThreshold ?? 60;
            }
          }

          class ChartDataProcessor {
            static simplify(points, maxPoints = 400) {
              if (points.length <= maxPoints) return points;
              const step = points.length / maxPoints;
              const result = [];
              for (let i = 0; i < points.length; i += step) {
                result.push(points[Math.floor(i)]);
              }
              return result;
            }

            static calculateBounds(points) {
              if (!points || points.length === 0) {
                return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
              }
              const xs = points.map(p => p.x);
              const ys = points.map(p => p.y);
              return {
                minX: Math.min(...xs),
                maxX: Math.max(...xs),
                minY: Math.min(...ys),
                maxY: Math.max(...ys),
              };
            }

            static addPadding(bounds, yPaddingPercent = 0.05) {
              const span = (bounds.maxY - bounds.minY) || 1;
              const pad = Math.max(1, span * yPaddingPercent);
              return {
                ...bounds,
                minY: bounds.minY - pad,
                maxY: bounds.maxY + pad,
              };
            }
          }

          class ChartRenderer {
            constructor(canvas, config = new ChartConfig()) {
              this.canvas = canvas;
              this.config = config;
              this.ctx = null;
              this.dpr = window.devicePixelRatio || 1;
              this.setupCanvas();
            }

            setupCanvas() {
              if (!this.canvas) return;
              const ctx = this.canvas.getContext('2d');
              if (!ctx) return;
              this.ctx = ctx;
              const cssW = this.canvas.clientWidth || 360;
              const cssH = this.canvas.clientHeight || 200;
              this.canvas.width = Math.floor(cssW * this.dpr);
              this.canvas.height = Math.floor(cssH * this.dpr);
              this.ctx.scale(this.dpr, this.dpr);
              this.cssWidth = cssW;
              this.cssHeight = cssH;
            }

            clear() {
              if (!this.ctx) return;
              this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
            }

            getDrawingArea() {
              const pad = this.config.padding;
              return {
                x: pad.left,
                y: pad.top,
                width: this.cssWidth - pad.left - pad.right,
                height: this.cssHeight - pad.top - pad.bottom,
              };
            }

            drawGrid() {
              if (!this.ctx) return;
              const area = this.getDrawingArea();
              this.ctx.strokeStyle = this.config.colors.grid;
              this.ctx.lineWidth = 1;
              this.ctx.beginPath();
              for (let i = 0; i <= this.config.gridLines; i++) {
                const y = area.y + (area.height * i) / this.config.gridLines;
                this.ctx.moveTo(area.x, y);
                this.ctx.lineTo(area.x + area.width, y);
              }
              this.ctx.stroke();
            }

            drawEmptyMessage(message = '데이터 부족') {
              if (!this.ctx) return;
              const area = this.getDrawingArea();
              this.ctx.fillStyle = this.config.colors.empty;
              this.ctx.font = this.config.fonts.empty;
              this.ctx.textAlign = 'left';
              this.ctx.fillText(message, area.x + 8, area.y + area.height / 2);
            }

            drawAxisLabels(bounds) {
              if (!this.ctx) return;
              const area = this.getDrawingArea();
              this.ctx.fillStyle = this.config.colors.text;
              this.ctx.font = this.config.fonts.axis;
              const minLabel = (bounds.minY || 0).toLocaleString();
              const maxLabel = (bounds.maxY || 0).toLocaleString();
              this.ctx.textAlign = 'left';
              this.ctx.fillText(maxLabel, 6, area.y + 10);
              this.ctx.fillText(minLabel, 6, area.y + area.height + 11);
            }

            renderLineChart(points, bounds) {
              if (!this.ctx || !points || points.length === 0 || bounds.maxX <= bounds.minX) {
                this.drawEmptyMessage();
                return;
              }

              this.clear();
              this.drawGrid();

              const area = this.getDrawingArea();
              const pad = this.config.padding;

              const xOf = (x) => area.x + ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * area.width;
              const yOf = (y) => {
                const minY = bounds.minY;
                const maxY = bounds.maxY === bounds.minY ? bounds.minY + 1 : bounds.maxY;
                const t = (y - minY) / (maxY - minY);
                return area.y + (1 - t) * area.height;
              };

              // 단일 데이터 포인트 처리
              if (points.length === 1) {
                const p = points[0];
                const X = xOf(p.x);
                const Y = yOf(p.y);
                this.ctx.fillStyle = this.config.colors.line;
                this.ctx.beginPath();
                this.ctx.arc(X, Y, 3, 0, Math.PI * 2);
                this.ctx.fill();
                this.ctx.fillStyle = 'rgba(255,255,255,0.9)';
                this.ctx.font = this.config.fonts.axis;
                this.ctx.textAlign = 'left';
                this.ctx.fillText(Number(p.y).toLocaleString(), Math.min(X + 6, area.x + area.width - 10), Math.max(Y - 6, area.y + 12));
                this.drawAxisLabels(bounds);
                return;
              }

              // 영역 채우기
              const path = new Path2D();
              points.forEach((p, i) => {
                const X = xOf(p.x);
                const Y = yOf(p.y);
                if (i === 0) path.moveTo(X, Y);
                else path.lineTo(X, Y);
              });
              const lastX = xOf(points[points.length - 1].x);
              const firstX = xOf(points[0].x);
              path.lineTo(lastX, area.y + area.height);
              path.lineTo(firstX, area.y + area.height);
              path.closePath();

              const grad = this.ctx.createLinearGradient(0, area.y, 0, area.y + area.height);
              grad.addColorStop(0, this.config.colors.gradientStart);
              grad.addColorStop(1, this.config.colors.gradientEnd);
              this.ctx.fillStyle = grad;
              this.ctx.fill(path);

              // 라인 그리기
              this.ctx.lineWidth = this.config.lineWidth;
              this.ctx.strokeStyle = this.config.colors.line;
              this.ctx.beginPath();
              points.forEach((p, i) => {
                const X = xOf(p.x);
                const Y = yOf(p.y);
                if (i === 0) this.ctx.moveTo(X, Y);
                else this.ctx.lineTo(X, Y);
              });
              this.ctx.stroke();

              this.drawAxisLabels(bounds);
            }

            renderBarChart(points, bounds) {
              if (!this.ctx || !points || points.length === 0 || bounds.maxX <= bounds.minX) {
                this.drawEmptyMessage();
                return;
              }

              this.clear();
              this.drawGrid();

              const area = this.getDrawingArea();
              const xOf = (x) => area.x + ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * area.width;
              const yOf = (y) => {
                const minY = Math.min(0, bounds.minY);
                const maxY = bounds.maxY <= minY ? minY + 1 : bounds.maxY;
                const t = (y - minY) / (maxY - minY);
                return area.y + (1 - t) * area.height;
              };

              const labelEvery = points.length > this.config.labelThreshold ? Math.ceil(points.length / this.config.labelThreshold) : 1;

              for (let i = 0; i < points.length; i++) {
                const p = points[i];
                const x = xOf(p.x);
                const nextX = i < points.length - 1 ? xOf(points[i + 1].x) : x + 6;
                const prevX = i > 0 ? xOf(points[i - 1].x) : x - 6;
                const step = Math.min(nextX - x, x - prevX);
                const bw = Math.max(this.config.barMinWidth, Math.min(this.config.barMaxWidth, step * this.config.barWidthRatio));

                const y0 = yOf(0);
                const y1 = yOf(p.y);
                const top = Math.min(y0, y1);
                const height = Math.max(1, Math.abs(y1 - y0));

                const grad = this.ctx.createLinearGradient(0, top, 0, top + height);
                grad.addColorStop(0, this.config.colors.barStart);
                grad.addColorStop(1, this.config.colors.barEnd);
                this.ctx.fillStyle = grad;
                this.ctx.fillRect(x - bw / 2, top, bw, height);

                // 라벨 표시
                if (i % labelEvery === 0 && height > 10 && bw >= 6) {
                  const label = Number(p.y).toLocaleString();
                  this.ctx.fillStyle = 'rgba(255,255,255,0.9)';
                  this.ctx.font = this.config.fonts.label;
                  this.ctx.textAlign = 'center';
                  const labelY = Math.max(top - 2, area.y + 10);
                  this.ctx.fillText(label, x, labelY);
                }
              }

              // 축 라벨
              this.ctx.fillStyle = this.config.colors.text;
              this.ctx.font = this.config.fonts.axis;
              const maxLabel = (bounds.maxY || 0).toLocaleString();
              this.ctx.textAlign = 'left';
              this.ctx.fillText(maxLabel, 6, area.y + 10);
              this.ctx.fillText('0', 6, area.y + area.height + 11);
            }
          }

          // 기존 함수 호환성을 위한 래퍼
          function drawChart(canvas, points, bounds) {
            const config = new ChartConfig({ padding: { left: 38, right: 8, top: 10, bottom: 20 } });
            const renderer = new ChartRenderer(canvas, config);
            renderer.renderLineChart(points, bounds);
          }

          function drawBarChart(canvas, points, bounds) {
            const config = new ChartConfig({ padding: { left: 38, right: 8, top: 10, bottom: 20 } });
            const renderer = new ChartRenderer(canvas, config);
            renderer.renderBarChart(points, bounds);
          }

          async function renderVolWin() {
            const nameEl = vcontent.querySelector('#vw-name');
            const samplesEl = vcontent.querySelector('#vw-samples');
            const rangeEl = vcontent.querySelector('#vw-range');
            const stdEl = vcontent.querySelector('#vw-std');
            const range24El = vcontent.querySelector('#vw-range24');
            const timeEl = vcontent.querySelector('#vw-time');
            const unitEl = vcontent.querySelector('#vw-unit');
            const canvas = vcontent.querySelector('#vw-chart');
            const periodSel = vcontent.querySelector('#vw-period');
            const excludePredEl = vcontent.querySelector('#vw-exclude-pred');
            const liveEl = vcontent.querySelector('#vw-live');
            const modeSel = vcontent.querySelector('#vw-mode');
            if (nameEl) nameEl.textContent = '계산 중...';
            if (samplesEl) samplesEl.textContent = '-';
            if (rangeEl) rangeEl.textContent = '-';
            if (stdEl) stdEl.textContent = '-';
            if (range24El) range24El.textContent = '-';
            if (timeEl) timeEl.textContent = '-';

            const channelId = getChannelIdFromUrl();
            if (!channelId) {
              if (nameEl) nameEl.textContent = '현재 라이브 채널 아님';
              const ctx = canvas?.getContext && canvas.getContext('2d');
              if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
              return;
            }

            let displayName = document.title || '';
            try {
              const inf = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}`, { credentials: 'include' }).then(r => r.json()).catch(() => ({}));
              const c = inf?.content || {};
              displayName = c.channelName || displayName;
            } catch {}
            if (nameEl) nameEl.textContent = cleanName(displayName || '');

            try {
              const r = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/log-power`, { credentials: 'include' });
              const d = await r.json();
              let claims = Array.isArray(d?.content?.claims) ? d.content.claims : [];
              // 필터: 승부예측 제외
              const excludePred = !!(excludePredEl && excludePredEl.checked);
              if (excludePred) {
                claims = claims.filter(c => {
                  const t = String(c?.claimType || '').toUpperCase();
                  return t !== 'PREDICTION' && !/PREDICT|BET/i.test(t);
                });
              }
              // 기간 필터
              const nowTs = Date.now();
              const period = periodSel ? periodSel.value : 'all';
              let cutoff = 0;
              if (period === '24h') cutoff = nowTs - 24*60*60*1000;
              else if (period === '7d') cutoff = nowTs - 7*24*60*60*1000;
              if (cutoff > 0) {
                claims = claims.filter(c => {
                  const ts = toTs(c);
                  return ts && ts >= cutoff;
                });
              }
              // 로컬 로그(통나무 획득) 포함
              let localPoints = [];
              try {
                const resLocal = await chrome.storage.local.get([POWER_LOG_KEY]);
                const logs = resLocal[POWER_LOG_KEY] || [];
                // 동일 채널만, 기간/예측제외 필터 반영
                const locFiltered = logs.filter((l) => {
                  if (!l || (l.channelId || '') !== channelId) return false;
                  const t = new Date(l.timestamp).getTime();
                  if (!t || isNaN(t)) return false;
                  if (cutoff > 0 && t < cutoff) return false;
                  if (excludePred) {
                    const m = String(l.method || '').toUpperCase();
                    if (m === 'PREDICTION' || /PREDICT|BET/.test(m)) return false;
                  }
                  return true;
                }).slice(0, 1000); // 과도 방지
                localPoints = locFiltered.map((l) => ({
                  ts: new Date(l.timestamp).getTime(),
                  amt: (typeof l.amount === 'number' ? l.amount : Number(l.amount)) || 0,
                })).filter(p => p.ts && isFinite(p.amt) && p.amt > 0);
              } catch {}

              const toPoint = (c) => ({ ts: toTs(c), amt: toAmount(c) });
              const apiPoints = claims.map(toPoint).filter(p => p.ts && p.amt !== null && p.amt > 0);
              const merged = apiPoints.concat(localPoints);
              const sorted = merged.sort((a,b)=>a.ts-b.ts);
              const limited = sorted.slice(Math.max(0, sorted.length - 120));
              let cum = 0;
              const pts = limited.map(p => { cum += p.amt; return { x: p.ts, y: cum }; });
              // 통합 데이터 처리 시스템 사용
              const bounds = ChartDataProcessor.calculateBounds(pts);
              const { minX, maxX, minY, maxY } = bounds;
              const sAll = computeStats(limited.map(p => p.amt));
              const now = Date.now();
              // 최근 24시간 변동폭(로컬+API 합산)
              const last24 = merged.filter((p) => now - p.ts <= 24*60*60*1000).map(p => p.amt);
              const s24 = computeStats(last24);
              if (samplesEl) samplesEl.textContent = String(sAll.count || 0);
              if (rangeEl) rangeEl.textContent = sAll.range !== null ? Number(sAll.range).toLocaleString() : '-';
              if (stdEl) stdEl.textContent = sAll.std !== null ? Math.round(sAll.std).toLocaleString() : '-';
              if (range24El) range24El.textContent = s24.range !== null ? Number(s24.range).toLocaleString() : (sAll.count ? '데이터 부족' : '-');
              if (timeEl && pts.length) {
                const fmt = (t) => {
                  const d = new Date(t);
                  const mm = String(d.getMonth()+1).padStart(2,'0');
                  const dd = String(d.getDate()).padStart(2,'0');
                  const hh = String(d.getHours()).padStart(2,'0');
                  const mi = String(d.getMinutes()).padStart(2,'0');
                  return `${mm}/${dd} ${hh}:${mi}`;
                };
                timeEl.textContent = `${fmt(minX)} ~ ${fmt(maxX)}`;
              }
              if (canvas) {
                const mode = modeSel ? modeSel.value : 'cum';
                if (unitEl) unitEl.textContent = mode === 'delta' ? '획득 금액' : '누적 금액';
                if (mode === 'delta') {
                  const deltas = limited.map(p => ({ x: p.x, y: p.amt }));
                  const minYb = 0;
                  const maxYb = deltas.length ? Math.max(...deltas.map(p => p.y)) : 1;
                  drawBarChart(canvas, deltas, { minX, maxX, minY: minYb, maxY: maxYb });
                } else {
                  drawChart(canvas, pts, { minX, maxX, minY, maxY });
                }
              }
            } catch {}
          }

          vbox.appendChild(vheader);
          vbox.appendChild(vcontent);
          volHost.appendChild(vbox);

          // 실시간 자동 갱신/리스너
          let autoTimer = null;
          const ensureAutoTimer = () => {
            const liveEl = vcontent.querySelector('#vw-live');
            if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
            if (liveEl && liveEl.checked) {
              autoTimer = setInterval(() => { renderVolWin(); }, 30000); // 30초 주기
            }
          };
          const onStorage = (changes, area) => {
            if (area !== 'local') return;
            if (changes && (changes[POWER_LOG_KEY] || changes['powerLogs'])) {
              const liveEl = vcontent.querySelector('#vw-live');
              if (!liveEl || liveEl.checked) renderVolWin();
            }
          };
          const onMessage = (msg) => {
            if (msg?.action === 'powerAcquired' || msg?.type === 'CHZZK_CHANNEL_COUNT') {
              const liveEl = vcontent.querySelector('#vw-live');
              if (!liveEl || liveEl.checked) renderVolWin();
            }
          };
          try { chrome.storage.onChanged.addListener(onStorage); } catch {}
          try { chrome.runtime.onMessage.addListener(onMessage); } catch {}

          function removeVol() {
            if (esc) window.removeEventListener('keydown', esc);
            if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
            try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
            try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
            volHost.remove();
          }
          vclose.addEventListener('click', removeVol);
          refresh.addEventListener('click', () => { renderVolWin(); });
          vcontent.addEventListener('change', (e) => {
            if (e.target && (e.target.id === 'vw-period' || e.target.id === 'vw-exclude-pred' || e.target.id === 'vw-mode')) {
              renderVolWin();
            }
            if (e.target && e.target.id === 'vw-live') {
              ensureAutoTimer();
            }
          });
          const esc = (ev) => { if (ev.key === 'Escape') removeVol(); };
          window.addEventListener('keydown', esc);
          volHost.addEventListener('click', (e) => { if (e.target === volHost) removeVol(); });
          document.documentElement.appendChild(volHost);
          renderVolWin();
          ensureAutoTimer();
        }
        async function renderVolatilityForCurrent() {
          const nameEl = volPanel.querySelector('#vol-name-ovr');
          const samplesEl = volPanel.querySelector('#vol-samples-ovr');
          const rangeEl = volPanel.querySelector('#vol-range-ovr');
          const stdEl = volPanel.querySelector('#vol-std-ovr');
          const range24El = volPanel.querySelector('#vol-range24-ovr');
          const timeRangeEl = volPanel.querySelector('#vol-range-time-ovr');
          const chartEl = volPanel.querySelector('#vol-chart-ovr');
          if (nameEl) nameEl.textContent = '계산 중...';
          if (samplesEl) samplesEl.textContent = '-';
          if (rangeEl) rangeEl.textContent = '-';
          if (stdEl) stdEl.textContent = '-';
          if (range24El) range24El.textContent = '-';
          if (timeRangeEl) timeRangeEl.textContent = '-';
          const channelId = getChannelIdFromUrl();
          if (!channelId) {
            if (nameEl) nameEl.textContent = '현재 라이브 채널 아님';
            // 차트 초기화
            if (chartEl && chartEl.getContext) {
              const ctx = chartEl.getContext('2d');
              if (ctx) { ctx.clearRect(0, 0, chartEl.width, chartEl.height); }
            }
            return;
          }
          let displayName = document.title || '';
          try {
            const inf = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}`, { credentials: 'include' }).then(r => r.json()).catch(() => ({}));
            const c = inf?.content || {};
            displayName = c.channelName || displayName;
          } catch {}
          if (nameEl) nameEl.textContent = cleanName(displayName || '');
          try {
            const r = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/log-power`, { credentials: 'include' });
            const d = await r.json();
            const claims = Array.isArray(d?.content?.claims) ? d.content.claims : [];
            const all = claims.map(toAmount).filter((n) => n !== null && n > 0);
            const now = Date.now();
            const last24 = claims.filter((c) => {
              const ts = toTs(c);
              return ts && (now - ts <= 24*60*60*1000);
            }).map(toAmount).filter((n) => n !== null && n > 0);
            const sAll = computeStats(all);
            const s24 = computeStats(last24);
            if (samplesEl) samplesEl.textContent = String(sAll.count || 0);
            if (rangeEl) rangeEl.textContent = sAll.range !== null ? Number(sAll.range).toLocaleString() : '-';
            if (stdEl) stdEl.textContent = sAll.std !== null ? Math.round(sAll.std).toLocaleString() : '-';
            if (range24El) range24El.textContent = s24.range !== null ? Number(s24.range).toLocaleString() : (sAll.count ? '데이터 부족' : '-');

            // --------- 라인 차트: 누적 금액 시간 추이 ---------
            if (chartEl && chartEl.getContext) {
              const pointsRaw = claims
                .map((c) => ({ ts: toTs(c), amt: toAmount(c) }))
                .filter((p) => p.ts && p.amt !== null && p.amt > 0)
                .sort((a, b) => a.ts - b.ts);
              // 최근 100개로 제한
              const pointsLimited = pointsRaw.slice(Math.max(0, pointsRaw.length - 100));
              let cum = 0;
              const points = pointsLimited.map((p) => { cum += p.amt; return { x: p.ts, y: cum }; });
              // 통합 데이터 처리 시스템 사용
              const bounds = ChartDataProcessor.calculateBounds(points);
              const { minX, maxX, minY, maxY } = bounds;
              // 타임레인지 표시
              if (timeRangeEl && points.length) {
                const fmt = (t) => {
                  const d = new Date(t);
                  const mm = String(d.getMonth()+1).padStart(2,'0');
                  const dd = String(d.getDate()).padStart(2,'0');
                  const hh = String(d.getHours()).padStart(2,'0');
                  const mi = String(d.getMinutes()).padStart(2,'0');
                  return `${mm}/${dd} ${hh}:${mi}`;
                };
                timeRangeEl.textContent = `${fmt(minX)} ~ ${fmt(maxX)}`;
              }
              drawLineChart(chartEl, points, { minX, maxX, minY, maxY });
            }
          } catch {}
        }
        function drawLineChart(canvas, points, bounds) {
          const config = new ChartConfig({ padding: { left: 34, right: 8, top: 8, bottom: 18 } });
          const renderer = new ChartRenderer(canvas, config);
          renderer.renderLineChart(points, bounds);
        }
        // 그래프(인페이지 차트) 열기
        volBtn.addEventListener('click', () => {
          try { window.dispatchEvent(new CustomEvent('CHZZK_OPEN_CHART')); } catch {}
        });
        const listEl = document.createElement('div');
        listEl.style.display = 'flex';
        listEl.style.flexDirection = 'column';
        listEl.style.gap = '0';
        listEl.style.overflowY = 'auto';
        listEl.style.padding = '12px 0';
        
        listEl.innerHTML = list.map((x, i) => {
          const cid = x.channelId || x.channelIdHash || '';
          const displayName = cleanName(x.channelName || '');
          // Modern row style with hover effect
          return `
          <div class="chzzk-balance-row" style="display:flex;align-items:center;justify-content:space-between;padding:10px 24px;border-bottom:1px solid rgba(255,255,255,0.04);transition:background 0.2s;">
            <div style="display:flex;align-items:center;gap:16px;min-width:0;">
              <span style="font-weight:700;width:24px;text-align:center;color:${i<3 ? '#3b82f6' : '#64748b'};font-size:14px;">${i+1}</span>
              <img src="${x.channelImageUrl ? x.channelImageUrl : defaultImg}" style="width:36px;height:36px;border-radius:12px;object-fit:cover;background:#222;box-shadow:0 2px 4px rgba(0,0,0,0.2);" />
              <span class="chzzk-row-name" data-channel-id="${cid}" data-channel-name="${(displayName||'').replace(/"/g,'&quot;') }" style="font-weight:600;font-size:15px;color:#f1f5f9;white-space:normal;word-break:break-all;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;cursor:pointer;transition:color 0.2s;">${displayName}${x.verifiedMark ? ` <img src='https://ssl.pstatic.net/static/nng/glive/resource/p/static/media/icon_official.a53d1555f8f4796d7862.png' style='width:14px;height:14px;vertical-align:middle;margin-left:4px;'>` : ''}</span>
            </div>
            <span style="font-weight:700;font-size:15px;color:#fff;letter-spacing:0.5px;">${Number(x.amount || 0).toLocaleString()}</span>
          </div>`;
        }).join('');
        
        // Add style for hover
        const hoverStyle = document.createElement('style');
        hoverStyle.textContent = `
          .chzzk-balance-row:hover { background: rgba(255,255,255,0.04); }
          .chzzk-balance-row:last-child { border-bottom: none !important; }
          .chzzk-row-name:hover { color: #60a5fa !important; text-decoration: underline; }
        `;
        box.appendChild(hoverStyle);
        
        // 닉네임 클릭 → 채네임 이동 (채네임 없으면 검색으로)
        listEl.addEventListener('click', (ev) => {
          const target = ev.target.closest('.chzzk-row-name');
          if (!target) return;
          const cid = target.getAttribute('data-channel-id') || '';
          const cname = target.getAttribute('data-channel-name') || '';
          let url = '';
          if (cid) url = `https://chzzk.naver.com/live/${cid}`;
          else if (cname) url = `https://chzzk.naver.com/search?keyword=${encodeURIComponent(cname)}`;
          if (url) {
            location.href = url;
            removeHost();
          }
        });
        box.appendChild(header);
        box.appendChild(listEl);
        host.appendChild(box);
        host.addEventListener('click', (e) => { if (e.target === host) removeHost(); });
        // ESC로 닫기
        function escHandler(ev) {
          if (ev.key === 'Escape') removeHost();
        }
        window.addEventListener('keydown', escHandler);
        document.documentElement.appendChild(host);
      } catch (e) {
        console.warn('balances 팝업 실패', e);
      }
    })();
  });
  // 페이지 내 변동 차트 오버레이 (베타와 동일한 구조)
  ;(function setupInPageChart(){
    if (window.__chzzkChartSetup) return; window.__chzzkChartSetup = true;
    const styleId = 'chzzk_chart_style';
    if (!document.getElementById(styleId)) {
      const st = document.createElement('style');
      st.id = styleId;
      st.textContent = `
        .chzzk-chart-host{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);z-index:2147483647;font-family:'Pretendard',-apple-system,BlinkMacSystemFont,system-ui,Roboto,sans-serif}
        .chzzk-chart-box{width:min(920px,94vw);background:#111216;border:1px solid rgba(255,255,255,0.1);border-radius:24px;padding:28px;display:flex;flex-direction:column;gap:24px;box-shadow:0 24px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05) inset;overflow:hidden;color:#e2e8f0}
        .chzzk-chart-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
        .chzzk-chart-title{display:flex;flex-direction:column;gap:4px}
        .chzzk-chart-tag{font-size:11px;font-weight:700;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase;background:rgba(255,255,255,0.06);padding:4px 8px;border-radius:6px;align-self:flex-start}
        .chzzk-chart-channel{font-size:18px;font-weight:700;color:#f8fafc;margin-top:4px}
        .chzzk-chart-price-wrap{display:flex;align-items:baseline;gap:12px;margin-top:4px}
        .chzzk-chart-price{font-size:36px;font-weight:800;color:#fff;letter-spacing:-0.5px;line-height:1}
        .chzzk-chart-change{font-size:14px;font-weight:600;padding:4px 10px;border-radius:8px;background:rgba(255,255,255,0.05)}
        .chzzk-chart-change.up{color:#f87171;background:rgba(248,113,113,0.1)}
        .chzzk-chart-change.down{color:#60a5fa;background:rgba(96,165,250,0.1)}
        .chzzk-chart-change.flat{color:#9ca3af}
        .chzzk-chart-close{width:32px;height:32px;border-radius:50%;border:none;background:rgba(255,255,255,0.08);color:#9ca3af;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
        .chzzk-chart-close:hover{background:rgba(255,255,255,0.15);color:#fff;transform:rotate(90deg)}
        .chzzk-chart-close svg{width:20px;height:20px}
        .chzzk-chart-svg-wrap{position:relative;border-radius:16px;background:#0b0c0f;border:1px solid rgba(255,255,255,0.06);height:320px;overflow:hidden}
        .chzzk-chart-svg{width:100%;height:100%;display:block;cursor:crosshair}
        .chzzk-axis-label{fill:#6b7280;font-size:11px;font-weight:500;font-family:inherit}
        .chzzk-grid-line{stroke:rgba(255,255,255,0.06);stroke-dasharray:4 4}
        .chzzk-tooltip{position:absolute;pointer-events:none;z-index:20;background:rgba(17,18,22,0.9);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.15);color:#f1f5f9;font-size:12px;padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);transition:opacity .1s, transform .1s}
        .chzzk-tooltip-time{color:#94a3b8;font-size:11px;margin-bottom:4px}
        .chzzk-tooltip-val{font-weight:700;font-size:14px;color:#fff}
        .chzzk-chart-footer{display:flex;justify-content:space-between;align-items:center;padding-top:8px}
        .chzzk-chart-meta{color:#64748b;font-size:11px}
        .chzzk-range{background:#1a1b20;padding:4px;border-radius:10px;display:flex;gap:2px}
        .chzzk-range button{background:transparent;border:none;color:#6b7280;font-size:12px;font-weight:600;padding:6px 14px;border-radius:8px;cursor:pointer;transition:all .2s}
        .chzzk-range button:hover{color:#e2e8f0;background:rgba(255,255,255,0.04)}
        .chzzk-range button.active{color:#fff;background:#3b82f6;box-shadow:0 2px 8px rgba(59,130,246,0.4)}
      `;
      document.head.appendChild(st);
    }
    const ChartDataProcessor = (() => {
      if (window.__chzzkChartDataProcessor) return window.__chzzkChartDataProcessor;
      const processor = {
        simplify(points = [], maxPoints = 400) {
          if (!Array.isArray(points) || points.length <= maxPoints) {
            return Array.isArray(points) ? points : [];
          }
          const step = points.length / maxPoints;
          const result = [];
          for (let i = 0; i < points.length; i += step) {
            result.push(points[Math.floor(i)]);
          }
          return result;
        },
        calculateBounds(points = []) {
          if (!Array.isArray(points) || points.length === 0) {
            return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
          }
          const xs = points.map(p => p.x);
          const ys = points.map(p => p.y);
          return {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
          };
        },
        addPadding(bounds = { minY: 0, maxY: 1 }, yPaddingPercent = 0.05) {
          const span = (bounds.maxY - bounds.minY) || 1;
          const pad = Math.max(1, span * yPaddingPercent);
          return {
            ...bounds,
            minY: bounds.minY - pad,
            maxY: bounds.maxY + pad,
          };
        },
        getSplinePath(points, xOf, yOf) {
          if (!points || points.length === 0) return '';
          if (points.length === 1) return '';
          
          const data = points.map(p => ({ x: xOf(p.x), y: yOf(p.y) }));
          
          // Catmull-Rom to Cubic Bezier conversion
          const k = 1; // tension
          let path = `M${data[0].x.toFixed(2)},${data[0].y.toFixed(2)}`;
          
          for (let i = 0; i < data.length - 1; i++) {
            const p0 = data[i === 0 ? 0 : i - 1];
            const p1 = data[i];
            const p2 = data[i + 1];
            const p3 = data[i + 2] || p2;
            
            const cp1x = p1.x + (p2.x - p0.x) / 6 * k;
            const cp1y = p1.y + (p2.y - p0.y) / 6 * k;
            const cp2x = p2.x - (p3.x - p1.x) / 6 * k;
            const cp2y = p2.y - (p3.y - p1.y) / 6 * k;
            
            path += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
          }
          return path;
        }
      };
      window.__chzzkChartDataProcessor = processor;
      return processor;
    })();
    const RANGE_OPTIONS = [
      { key: '1d', label: '1일', ms: 24 * 60 * 60 * 1000 },
    ];
    const RANGE_LOOKUP = RANGE_OPTIONS.reduce((map, opt) => {
      map[opt.key] = opt;
      return map;
    }, {});
    const DEFAULT_RANGE = '1d';
    let chartChannelInfo = null;
    function ensureHost(){
      let host = document.getElementById('chzzk_chart_host');
      if (host) return host;
      host = document.createElement('div'); 
      host.id='chzzk_chart_host'; 
      host.className='chzzk-chart-host';

      const box = document.createElement('div'); 
      box.className='chzzk-chart-box';

      const header = document.createElement('div');
      header.className='chzzk-chart-header';

      const title = document.createElement('div');
      title.className='chzzk-chart-title';
      
      const tag = document.createElement('span');
      tag.className='chzzk-chart-tag';
      tag.textContent='통나무 차트';
      
      const channelEl = document.createElement('span');
      channelEl.id='chzzk_chart_channel';
      channelEl.className='chzzk-chart-channel';
      channelEl.textContent='불러오는 중...';
      
      const priceWrap = document.createElement('div');
      priceWrap.className='chzzk-chart-price-wrap';
      
      const priceEl = document.createElement('div');
      priceEl.id='chzzk_chart_price';
      priceEl.className='chzzk-chart-price';
      priceEl.textContent='—';
      
      const changeEl = document.createElement('div');
      changeEl.id='chzzk_chart_change';
      changeEl.className='chzzk-chart-change flat';
      changeEl.textContent='—';
      
      priceWrap.appendChild(priceEl);
      priceWrap.appendChild(changeEl);
      
      title.appendChild(tag);
      title.appendChild(channelEl);
      title.appendChild(priceWrap);

      const close = document.createElement('button');
      close.type='button';
      close.className='chzzk-chart-close';
      close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>';

      header.appendChild(title);
      header.appendChild(close);

      const svgWrap = document.createElement('div');
      svgWrap.className='chzzk-chart-svg-wrap';
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); 
      svg.setAttribute('class','chzzk-chart-svg'); 
      svg.setAttribute('viewBox','0 0 960 320'); 
      svg.setAttribute('preserveAspectRatio','none'); 
      svg.id='chzzk_chart_svg';
      const tooltip = document.createElement('div'); 
      tooltip.id='chzzk_chart_tooltip'; 
      tooltip.className='chzzk-tooltip';
      svgWrap.appendChild(svg);
      svgWrap.appendChild(tooltip);

      const footer = document.createElement('div');
      footer.className='chzzk-chart-footer';
      
      const meta = document.createElement('div');
      meta.className='chzzk-chart-meta';
      meta.id='chzzk_chart_meta';
      meta.textContent='데이터 로딩 중...';
      
      const rangeContainer = document.createElement('div'); 
      rangeContainer.className='chzzk-range';
      RANGE_OPTIONS.forEach((opt)=>{
        const b=document.createElement('button'); 
        b.textContent=opt.label; 
        b.dataset.range=opt.key; 
        if(opt.key===DEFAULT_RANGE) b.classList.add('active'); 
        rangeContainer.appendChild(b);
      });
      footer.appendChild(meta);
      footer.appendChild(rangeContainer);

      box.appendChild(header);
      box.appendChild(svgWrap);
      box.appendChild(footer);
      host.appendChild(box);
      document.documentElement.appendChild(host);

      host.addEventListener('click',(e)=>{ if(e.target===host) host.style.display='none'; });
      close.addEventListener('click',()=>{ host.style.display='none'; });
      window.addEventListener('keydown',(e)=>{ if(e.key==='Escape') host.style.display='none'; });
      rangeContainer.addEventListener('click',(e)=>{ 
        const b=e.target.closest('button'); 
        if(!b) return; 
        Array.from(rangeContainer.querySelectorAll('button')).forEach(x=>x.classList.toggle('active', x===b)); 
        renderChart(); 
      });
      svg.addEventListener('mousemove', (e)=> handleHover(e));
      svg.addEventListener('mouseleave', ()=>{ 
        const tt=document.getElementById('chzzk_chart_tooltip'); 
        if(tt) tt.style.display='none'; 
        const cursor=document.getElementById('chzzk_chart_cursor'); 
        if(cursor) cursor.style.display='none';
      });
      return host;
    }
    function getActiveRangeMs(){
      const host = document.getElementById('chzzk_chart_host');
      const active = host?.querySelector('.chzzk-range button.active');
      const key = active?.dataset.range || DEFAULT_RANGE;
      const opt = RANGE_LOOKUP[key] || RANGE_LOOKUP[DEFAULT_RANGE];
      return opt ? opt.ms : RANGE_LOOKUP[DEFAULT_RANGE].ms;
    }
    function getMode(){ return '라인'; }
    function bucketSize(rangeMs){
      if (rangeMs <= 30*60*1000) return 60*1000;
      if (rangeMs <= 2*60*60*1000) return 5*60*1000;
      if (rangeMs <= 12*60*60*1000) return 15*60*1000;
      if (rangeMs <= 48*60*60*1000) return 30*60*1000;
      return 60*60*1000;
    }
    let tsCache = [];
    function buildCandles(data, rangeMs){
      if (!data.length) return [];
      const size = bucketSize(rangeMs);
      const buckets = new Map();
      data.forEach(p=>{
        const bKey = Math.floor(p.t/size)*size;
        let arr = buckets.get(bKey); if(!arr){ arr=[]; buckets.set(bKey, arr);} arr.push(p);
      });
      const candles = [];
      [...buckets.keys()].sort((a,b)=>a-b).forEach(k=>{
        const arr = buckets.get(k).sort((a,b)=>a.t-b.t);
        const open = arr[0].v; const close = arr[arr.length-1].v;
        let high = open, low = open;
        arr.forEach(p=>{ if(p.v>high) high=p.v; if(p.v<low) low=p.v; });
        candles.push({ t:k, open, high, low, close, count:arr.length, end:k+size });
      });
      return candles;
    }
    function renderChart(){
      const svg = document.getElementById('chzzk_chart_svg'); 
      const meta = document.getElementById('chzzk_chart_meta'); 
      const priceEl = document.getElementById('chzzk_chart_price');
      const changeEl = document.getElementById('chzzk_chart_change');
      const channelEl = document.getElementById('chzzk_chart_channel');
      if(!svg||!meta||!priceEl||!changeEl) return;

      if (channelEl) {
        const fallbackTitle = (() => {
          const raw = document.title || '';
          if (!raw) return '통나무 차트';
          return raw.replace(/\s*-\s*CHZZK.*$/i, '').trim() || '통나무 차트';
        })();
        channelEl.textContent = chartChannelInfo?.channelName || fallbackTitle;
      }

      const resetView = (message, metaMessage) => {
        svg.innerHTML = '';
        priceEl.textContent = '—';
        changeEl.textContent = message;
        changeEl.classList.remove('up','down');
        changeEl.classList.add('flat');
        meta.textContent = metaMessage || '데이터를 불러오는 중입니다...';
      };

      if(!tsCache || !tsCache.length){ 
        resetView('데이터 없음','데이터 수집 중입니다. 잠시만 기다려주세요.');
        return; 
      }

      const rangeMs = getActiveRangeMs(); 
      const now = Date.now();
      const filtered = tsCache.filter(p => {
        if (!p || typeof p.t !== 'number' || typeof p.v !== 'number') return false;
        return rangeMs === Infinity || (now - p.t <= rangeMs);
      });

      if(!filtered || !filtered.length){ 
        resetView('—', '선택한 기간의 데이터가 없습니다.');
        return; 
      }

      filtered.sort((a,b)=>a.t-b.t);
      const rawValues = filtered.map(p => p.v);
      const rawMin = Math.min(...rawValues);
      const rawMax = Math.max(...rawValues);
      const displayMin = Math.max(0, rawMin);
      const displayMax = Math.max(displayMin, rawMax);
      const firstPoint = filtered[0];
      const latestPoint = filtered[filtered.length - 1];
      const startVal = firstPoint.v;
      const endVal = latestPoint.v;
      const latestTs = latestPoint.t;
      
      const points = filtered.map(p => ({ x: p.t, y: p.v }));
      if (!points || points.length === 0) {
        resetView('오류', '유효한 데이터 포인트가 없습니다.');
        return;
      }
      
      // Simplify points for performance but keep enough for smooth curves
      const simplified = ChartDataProcessor.simplify(points, 400);
      
      let bounds = ChartDataProcessor.calculateBounds(simplified);
      bounds = ChartDataProcessor.addPadding(bounds, 0.1); // 10% padding
      if (!Number.isFinite(bounds.minY)) bounds.minY = 0;
      if (!Number.isFinite(bounds.maxY)) bounds.maxY = bounds.minY + 1;
      bounds.minY = Math.max(0, bounds.minY);
      if (bounds.maxY <= bounds.minY) bounds.maxY = bounds.minY + 1;
      
      const minV = bounds.minY;
      const maxV = bounds.maxY;
      const span = (maxV - minV) || 1;
      const minT = bounds.minX; 
      const maxT = bounds.maxX; 
      const tspan = (maxT - minT) || 1;
      const W = 960, H = 320;
      const padTop = 20, padBottom = 30, padLeft = 0, padRight = 0;
      
      const diff = endVal - startVal;
      const pct = startVal ? (diff / startVal * 100) : 0;
      const isUp = diff > 0;
      const isDown = diff < 0;
      
      // Modern colors
      const colorLine = isUp ? '#f87171' : isDown ? '#60a5fa' : '#9ca3af';
      const colorAreaStart = isUp ? 'rgba(248, 113, 113, 0.25)' : isDown ? 'rgba(96, 165, 250, 0.25)' : 'rgba(156, 163, 175, 0.25)';
      const colorAreaEnd = isUp ? 'rgba(248, 113, 113, 0)' : isDown ? 'rgba(96, 165, 250, 0)' : 'rgba(156, 163, 175, 0)';

      priceEl.textContent = `${endVal.toLocaleString()}`;
      const diffText = `${diff>0?'+':''}${diff.toLocaleString()} (${pct>=0?'+':''}${pct.toFixed(2)}%)`;
      changeEl.textContent = diff ? diffText : '변동 없음';
      changeEl.className = `chzzk-chart-change ${isUp ? 'up' : isDown ? 'down' : 'flat'}`;

      const host = document.getElementById('chzzk_chart_host');
      const activeBtn = host?.querySelector('.chzzk-range button.active');
      const rangeLabel = activeBtn?.textContent?.trim() || '';
      const fmtDetailTime = (ts) => {
        const d = new Date(ts);
        const mo = String(d.getMonth()+1).padStart(2,'0');
        const da = String(d.getDate()).padStart(2,'0');
        const hh = String(d.getHours()).padStart(2,'0');
        const mi = String(d.getMinutes()).padStart(2,'0');
        return `${mo}/${da} ${hh}:${mi}`;
      };
      meta.textContent = `${rangeLabel} 기준 · 시작 ${startVal.toLocaleString()} · 최고 ${displayMax.toLocaleString()} · 최저 ${displayMin.toLocaleString()} · ${fmtDetailTime(latestTs)} 기준`;
      
      // Coordinate mappers
      const xOf = (t) => padLeft + ((t - minT) / tspan) * (W - padLeft - padRight);
      const yOf = (v) => (H - padBottom) - ((v - minV) / span) * (H - padTop - padBottom);

      let body = '';

      // Gradients
      body += `<defs>
        <linearGradient id="chzzk_grad_area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${colorLine}" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="${colorLine}" stop-opacity="0"/>
        </linearGradient>
        <mask id="gridMask">
          <rect x="0" y="0" width="${W}" height="${H}" fill="white"/>
          <rect x="0" y="0" width="${W}" height="${H}" fill="url(#chzzk_grad_area)" fill-opacity="0.5"/> 
        </mask>
      </defs>`;
      
      // Y Grid Lines (Dotted)
      const ySteps = 5;
      for (let i = 0; i <= ySteps; i++){ 
        const ratio = i / ySteps; 
        const y = (H - padBottom) - (H - padTop - padBottom) * ratio;
        // Don't draw bottom line
        if (i === 0) continue; 
        body += `<line class='chzzk-grid-line' x1='${padLeft}' y1='${y.toFixed(2)}' x2='${W-padRight}' y2='${y.toFixed(2)}' />`;
      }
      
      // X Axis Labels
      const xTicks = 6;
      const fmtTime = (t) => {
        const d = new Date(t);
        const mo = d.getMonth()+1;
        const da = d.getDate();
        const h = String(d.getHours()).padStart(2,'0');
        const m = String(d.getMinutes()).padStart(2,'0');
        if (rangeMs > 24*60*60*1000) return `${mo}/${da}`;
        return `${h}:${m}`;
      };
      for (let i = 0; i <= xTicks; i++){
        const ratio = i / xTicks;
        const t = minT + tspan * ratio;
        const x = xOf(t);
        // Align text based on position
        let anchor = 'middle';
        if (i === 0) anchor = 'start';
        else if (i === xTicks) anchor = 'end';
        body += `<text class='chzzk-axis-label' x='${x.toFixed(2)}' y='${H-10}' text-anchor='${anchor}'>${fmtTime(t)}</text>`;
      }
      
      // Chart Path (Smooth Curve)
      if (simplified.length > 1) {
        const pathD = ChartDataProcessor.getSplinePath(simplified, xOf, yOf);
        if (pathD) {
          // Area
          const startX = xOf(simplified[0].x);
          const endX = xOf(simplified[simplified.length-1].x);
          const bottomY = H - padBottom;
          const areaD = `${pathD} L ${endX} ${bottomY} L ${startX} ${bottomY} Z`;
          
          body += `<path d='${areaD}' fill='url(#chzzk_grad_area)' stroke='none'/>`;
          body += `<path d='${pathD}' fill='none' stroke='${colorLine}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/>`;
        }
      }
      
      // Cursor elements
      body += `<g id='chzzk_chart_cursor' style='display:none;pointer-events:none'>
        <line id='chzzk_cursor_line' x1='0' y1='${padTop}' x2='0' y2='${H-padBottom}' stroke='rgba(255,255,255,0.3)' stroke-width='1' stroke-dasharray='4 4'/>
        <circle id='chzzk_cursor_dot' cx='0' cy='0' r='5' fill='${colorLine}' stroke='#fff' stroke-width='2'/>
      </g>`;
      
      svg.innerHTML = body;
      svg.dataset.minv = minV;
      svg.dataset.maxv = maxV;
      svg.dataset.mint = minT;
      svg.dataset.maxt = maxT;
    }
    function handleHover(e){
      const svg = document.getElementById('chzzk_chart_svg'); 
      const tt=document.getElementById('chzzk_chart_tooltip'); 
      const cursorGroup = document.getElementById('chzzk_chart_cursor');
      const cursorLine = document.getElementById('chzzk_cursor_line');
      const cursorDot = document.getElementById('chzzk_cursor_dot');

      if(!svg||!tt) return;
      if(!tsCache.length){ 
        tt.style.display='none'; 
        if(cursorGroup) cursorGroup.style.display='none';
        return; 
      }

      const box = svg.getBoundingClientRect();
      const x = e.clientX - box.left;
      // Get dimensions from viewBox or clientRect
      const view = svg.getAttribute('viewBox') || '0 0 960 320';
      const parts = view.split(/\s+/).map(Number);
      const W = parts[2] || 960;
      const H = parts[3] || 320;
      const padTop = 20, padBottom = 30, padLeft = 0, padRight = 0;

      const minT = Number(svg.dataset.mint);
      const maxT = Number(svg.dataset.maxt);
      const minV = Number(svg.dataset.minv);
      const maxV = Number(svg.dataset.maxv);
      
      const rangeMs = getActiveRangeMs(); const now=Date.now();
      // Use same filtering logic as render
      const filtered = tsCache.filter(p => rangeMs===Infinity || (now - p.t <= rangeMs)).sort((a,b)=>a.t-b.t);
      
      if(!filtered.length || isNaN(minT) || isNaN(maxT)){ 
        tt.style.display='none'; 
        if(cursorGroup) cursorGroup.style.display='none';
        return; 
      }

      const innerW = W - padLeft - padRight;
      const tspan = (maxT - minT) || 1;
      // Map mouse X to Time
      // x = padLeft + ((t - minT) / tspan) * innerW
      // => t = ((x - padLeft) / innerW) * tspan + minT
      const mouseT = ((x / box.width * W - padLeft) / innerW) * tspan + minT;
      
      // Find nearest point
      let nearest = filtered[0]; 
      let nd = Math.abs(nearest.t - mouseT);
      // Optimization: Binary search could be better, but linear scan is fine for < 1000 points
      for (let i=1;i<filtered.length;i++){ 
        const d = Math.abs(filtered[i].t - mouseT); 
        if (d < nd){ nd = d; nearest = filtered[i]; } 
      }
      
      // Update cursor positions
      if (cursorGroup && cursorLine && cursorDot && !isNaN(minV) && !isNaN(maxV)) {
        const span = (maxV - minV) || 1;
        // Recalculate exact SVG coordinates for the nearest point
        const cursorX = padLeft + ((nearest.t - minT) / tspan) * innerW;
        const cursorY = (H - padBottom) - ((nearest.v - minV) / span) * (H - padTop - padBottom);
        
        cursorLine.setAttribute('x1', cursorX.toFixed(2));
        cursorLine.setAttribute('x2', cursorX.toFixed(2));
        cursorDot.setAttribute('cx', cursorX.toFixed(2));
        cursorDot.setAttribute('cy', cursorY.toFixed(2));
        cursorGroup.style.display = 'block';
      }

      // Tooltip content
      const fmtTooltip = (ts) => {
        const d = new Date(ts);
        const mo = String(d.getMonth()+1).padStart(2,'0');
        const da = String(d.getDate()).padStart(2,'0');
        const hh = String(d.getHours()).padStart(2,'0');
        const mi = String(d.getMinutes()).padStart(2,'0');
        return `<div class="chzzk-tooltip-time">${mo}.${da} ${hh}:${mi}</div>`;
      };
      tt.innerHTML = `${fmtTooltip(nearest.t)}<div class="chzzk-tooltip-val">${nearest.v.toLocaleString()}</div>`;
      tt.style.display='block';
      
      // Tooltip position (follow mouse with offset)
      const wrapRect = svg.parentElement?.getBoundingClientRect();
      // Add offset to avoid covering cursor
      let left = (e.clientX - (wrapRect?.left || 0)) + 20;
      let top = (e.clientY - (wrapRect?.top || 0)) - 20;
      
      // Boundary check
      const maxLeft = (wrapRect?.width || window.innerWidth) - tt.offsetWidth - 10;
      const maxTop = (wrapRect?.height || window.innerHeight) - tt.offsetHeight - 10;
      
      if (left > maxLeft) left = e.clientX - (wrapRect?.left || 0) - tt.offsetWidth - 20; // Flip to left
      left = Math.max(10, Math.min(left, maxLeft));
      top = Math.max(10, Math.min(top, maxTop));
      
      tt.style.left = `${left}px`;
      tt.style.top = `${top}px`;
    }
    async function openChart(){
      const host = ensureHost();
      host.style.display='flex';
      chartChannelInfo = null;
      const channelId = getChannelIdFromUrl();
      if (!channelId) { 
        tsCache = []; 
        renderChart(); 
        return; 
      }
      const channelPromise = (async () => {
        try {
          const info = await getChannelInfo(channelId);
          chartChannelInfo = info;
          renderChart();
        } catch (err) {
          chartChannelInfo = null;
        }
      })();
      try {
        chrome.runtime.sendMessage({ type:'CHZZK_TS_GET', channelId }, (resp)=>{
          if (chrome.runtime.lastError) {
            console.warn('차트 데이터 로드 오류:', chrome.runtime.lastError);
            tsCache = [];
            renderChart();
            return;
          }
          tsCache = (resp && resp.ok && Array.isArray(resp.data)) ? resp.data : [];
          if (!tsCache || tsCache.length === 0) {
            const meta = document.getElementById('chzzk_chart_meta');
            const changeEl = document.getElementById('chzzk_chart_change');
            if (meta) meta.textContent = '데이터 수집 중입니다. 라이브 페이지에서 잠시 대기해주세요.';
            if (changeEl) {
              changeEl.textContent = '데이터 준비 중';
              changeEl.classList.remove('up','down');
              changeEl.classList.add('flat');
            }
          }
          renderChart();
        });
        await channelPromise;
      } catch (e) {
        console.warn('차트 열기 오류:', e);
        tsCache = [];
        renderChart();
      }
    }
    window.addEventListener('CHZZK_OPEN_CHART', openChart);
  })();
  // 초기 설정 로드 및 타이머 세팅
  loadSettings();
})();