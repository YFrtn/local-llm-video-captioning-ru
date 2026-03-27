const STORAGE_KEY = 'video-captioning-history';

export function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSession(videoName, entries) {
  if (!entries.length) return;
  const history = loadHistory();
  const session = {
    id: crypto.randomUUID(),
    videoName: videoName || 'video',
    date: new Date().toISOString(),
    entries,
  };
  history.unshift(session);
  // Keep last 50 sessions
  if (history.length > 50) history.length = 50;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  return session;
}

export function deleteSession(sessionId) {
  const history = loadHistory();
  const filtered = history.filter((s) => s.id !== sessionId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  return filtered;
}

export function clearHistory() {
  localStorage.removeItem(STORAGE_KEY);
}
