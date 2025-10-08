// 치지직 자동 수집 + 채팅 영역 아래 배지 표시
(() => {
  const SCAN_INTERVAL_MS = 4000;
  let scanning = false;
  let lastPayloadHash = '';
  let lastChatBadgeEl = null;
  let isChannelInactive = false;
  let powerCountInterval = null;
  // 설정(배지/자동)
  const DEFAULT_SETTINGS = { badge: true, auto: true, best: false };
  // 임시: 화질 자동 최적화 비활성화 플래그 (트러블슈팅용)
  const DISABLE_BEST_QUALITY = false;
  let settings = { ...DEFAULT_SETTINGS };
  // 타이머 핸들
  let scanTimer = null;
  let initialKickTimer = null;
  let bestInterval = null;
  // 변경 중복 전송 방지
  let lastSentDomCount = null;
  let lastApiAmount = null;

  function parsePower(text) {
    if (!text) return 0;
    const digits = text.replace(/[^0-9]/g, '');
    return Number(digits || 0);
  }

  function getChannelIdFromUrl() {
    try {
      const u = new URL(location.href);
      const parts = u.pathname.split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        if (['live', 'channel', 'video'].includes(parts[i]) && parts[i + 1]) {
          return parts[i + 1];
        }
      }
      return '';
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
    if (!settings.badge) {
      if (lastChatBadgeEl && lastChatBadgeEl.parentNode) lastChatBadgeEl.parentNode.removeChild(lastChatBadgeEl);
      lastChatBadgeEl = null;
      return;
    }
    const root = findChatToolsRoot();
    if (!root) return;
    if (lastChatBadgeEl && lastChatBadgeEl.parentNode) lastChatBadgeEl.parentNode.removeChild(lastChatBadgeEl);
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.justifyContent = 'center';
    badge.style.height = '24px';
    badge.style.minWidth = '24px';
    badge.style.background = 'none';
    badge.style.border = 'none';
    badge.style.padding = '0 4px';
    badge.style.marginLeft = '4px';
    badge.style.fontWeight = '700';
    badge.style.fontSize = '12px';
    badge.style.color = inactive ? '#aaa' : '#fff';
    badge.style.cursor = 'pointer';
    badge.className = 'chzzk_power_badge_custom';
    badge.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:middle">
        <path d="M6.8 2.4a.9.9 0 0 1 .8.5l1.3 2.7H5.98l-.9-1.83A.9.9 0 0 1 5.9 2.4h.9Z"/>
        <path d="M12.15 4.43c.86 0 1.5.63 1.91 1.37.41.76.65 1.78.65 2.87 0 1.08-.24 2.1-.65 2.86-.4.74-1.05 1.37-1.91 1.37H4c-.86 0-1.5-.63-1.91-1.37-.42-.76-.66-1.78-.66-2.86 0-1.09.24-2.1.66-2.87C2.5 5.06 3.14 4.43 4 4.43h8.15Z"/>
      </svg>
      <span style="margin-left:4px;vertical-align:middle">${amount != null ? Number(amount).toLocaleString() : '?'}</span>
    `;
    // 배지 클릭 시 전체 보유 현황 팝업 열기
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('CHZZK_OPEN_BALANCES'));
    });
    const tools = findChatToolsRoot();
    if (tools) tools.appendChild(badge);
    lastChatBadgeEl = badge;
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
    renderChatBadge(amount, isChannelInactive);
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

  function clearTimers() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (powerCountInterval) { clearInterval(powerCountInterval); powerCountInterval = null; }
    if (initialKickTimer) { clearTimeout(initialKickTimer); initialKickTimer = null; }
  }

  async function loadSettings() {
    try {
      const { chzzkSettings } = await chrome.storage.local.get('chzzkSettings');
      settings = { ...DEFAULT_SETTINGS, ...(chzzkSettings || {}) };
      ensureTimers();
      ensureBestTimer();
      if (!settings.badge && lastChatBadgeEl && lastChatBadgeEl.parentNode) {
        lastChatBadgeEl.parentNode.removeChild(lastChatBadgeEl);
        lastChatBadgeEl = null;
      }
    } catch {}
  }

  function ensureTimers() {
    clearTimers();
    if (!settings.auto) return;
    // 즉시 1회 수행 + 주기 실행 (가시성일 때만 동작)
    initialKickTimer = setTimeout(() => { scanOnce(); updateBadge(); fetchAndUpdatePowerAmount(); if (!DISABLE_BEST_QUALITY) trySetBestQuality(true); }, 200);
    scanTimer = setInterval(scanOnce, SCAN_INTERVAL_MS);
    powerCountInterval = setInterval(fetchAndUpdatePowerAmount, 60 * 1000);
  }

  function ensureBestTimer() {
    if (bestInterval) { clearInterval(bestInterval); bestInterval = null; }
    if (DISABLE_BEST_QUALITY) return;
    if (!settings.best) return;
    if (alreadyAttemptedBest()) return;
    setTimeout(() => { if (!alreadyAttemptedBest()) trySetBestQuality(true); }, 150);
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
    }
  });

  document.addEventListener('visibilitychange', () => {
    // 가시성 변경 시 즉시 한 번 동작하고 타이머 재평가
    if (document.visibilityState === 'visible') {
      scanOnce();
      fetchAndUpdatePowerAmount();
      trySetBestQuality(true);
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
        host.style.background = 'rgba(0,0,0,0.4)';
        const box = document.createElement('div');
        box.style.background = '#141517';
        box.style.border = '1px solid #0008';
        box.style.borderRadius = '12px';
        box.style.width = '94%';
        box.style.maxWidth = '520px';
        box.style.maxHeight = '70vh';
        box.style.overflow = 'auto';
        box.style.padding = '12px 12px 16px';
        const total = list.reduce((s, x) => s + (x.amount || 0), 0);
        const defaultImg = 'https://ssl.pstatic.net/cmstatic/nng/img/img_anonymous_square_gray_opacity2x.png?type=f120_120_na';
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.innerHTML = `<div style="font-weight:700;font-size:18px">누적 파워: ${Number(total).toLocaleString()}</div>`;
        const close = document.createElement('button');
        close.textContent = '닫기';
        close.style.background = 'transparent';
        close.style.border = '1px solid rgba(255,255,255,0.2)';
        close.style.color = '#fff';
        close.style.borderRadius = '6px';
        close.style.padding = '6px 10px';
        function removeHost() {
          if (escHandler) window.removeEventListener('keydown', escHandler);
          host.remove();
        }
        close.addEventListener('click', removeHost);
        header.appendChild(close);
        const listEl = document.createElement('div');
        listEl.style.display = 'flex';
        listEl.style.flexDirection = 'column';
        listEl.style.gap = '10px';
        listEl.style.marginTop = '8px';
        listEl.innerHTML = list.map((x, i) => {
          const cid = x.channelId || x.channelIdHash || '';
          const displayName = cleanName(x.channelName || '');
          return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
            <div style="display:flex;align-items:center;gap:12px;min-width:0;">
              <span style="font-weight:bold;width:24px;text-align:right;color:#2a6aff;font-size:16px;">${i+1}</span>
              <img src="${x.channelImageUrl ? x.channelImageUrl : defaultImg}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;background:#222;" />
              <span class="chzzk-row-name" data-channel-id="${cid}" data-channel-name="${(displayName||'').replace(/"/g,'&quot;') }" style="font-weight:bold;font-size:14px;white-space:normal;word-break:break-all;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;cursor:pointer;">${displayName}${x.verifiedMark ? ` <img src='https://ssl.pstatic.net/static/nng/glive/resource/p/static/media/icon_official.a53d1555f8f4796d7862.png' style='width:14px;height:14px;vertical-align:middle;margin-left:2px;'>` : ''}</span>
            </div>
            <span style="font-weight:bold;font-size:16px;letter-spacing:0.5px;">${Number(x.amount || 0).toLocaleString()}</span>
          </div>`;
        }).join('');
        // 닉네임 클릭 → 채널 이동 (채널ID 없으면 검색으로)
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
  // 초기 설정 로드 및 타이머 세팅
  loadSettings();
})();

