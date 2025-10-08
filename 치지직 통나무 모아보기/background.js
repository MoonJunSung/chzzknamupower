// 백그라운드: 설치 시 초기화 메시지
chrome.runtime.onInstalled.addListener(() => {
  console.log('wa sans');
  try { chrome.action.setBadgeText({ text: '' }); } catch {}
});

// 브라우저 시작 시 배지 숫자 제거
try {
  chrome.runtime.onStartup.addListener(() => {
    try { chrome.action.setBadgeText({ text: '' }); } catch {}
  });
} catch {}

// 서비스워커가 깨어날 때도 한 번 정리
try { chrome.action.setBadgeText({ text: '' }); } catch {}

// 집계 저장소 키
const AGG_KEY = 'chzzkAgg';

async function readAgg() {
  const data = await chrome.storage.local.get(AGG_KEY);
  return data[AGG_KEY] || { channels: {}, updatedAt: 0 };
}

async function writeAgg(agg) {
  await chrome.storage.local.set({ [AGG_KEY]: agg });
}

// 콘텐츠 스크립트가 보낸 파싱 결과 수신 → 합산/저장
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CHZZK_LOG_BATCH') {
    (async () => {
      const agg = await readAgg();
      const channels = agg.channels || {};
      for (const item of message.items || []) {
        const key = item.channelId || item.name;
        if (!key) continue;
        const prev = channels[key] || { name: item.name, channelId: item.channelId, power: 0, lastSeen: 0, avatar: '' };
        channels[key] = {
          ...prev,
          name: item.name || prev.name,
          channelId: item.channelId || prev.channelId,
          avatar: item.avatar || prev.avatar,
          power: (prev.power || 0) + (item.power || 0),
          lastSeen: Date.now(),
        };
      }
      agg.channels = channels;
      agg.updatedAt = Date.now();
      await writeAgg(agg);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === 'CHZZK_CHANNEL_COUNT') {
    (async () => {
      const { channelId, name, count, avatar } = message;
      if (!channelId) { sendResponse({ ok: false, reason: 'no-channel' }); return; }
      const agg = await readAgg();
      const channels = agg.channels || {};
      const prev = channels[channelId] || { name, channelId, power: 0, lastSeen: 0, avatar: '' };
      channels[channelId] = {
        ...prev,
        name: name || prev.name,
        avatar: avatar || prev.avatar,
        power: Number(count || 0), // 채널 배지 숫자는 누적 수로 간주 → 그대로 저장
        lastSeen: Date.now(),
      };
      agg.channels = channels;
      agg.updatedAt = Date.now();
      await writeAgg(agg);
      sendResponse({ ok: true });
    })();
    return true;
  }
});

