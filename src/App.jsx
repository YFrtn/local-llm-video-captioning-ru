import { useEffect, useRef, useState } from 'react';
import { exportMarkdown, exportPdf } from './export.js';
import { loadHistory, saveSession, deleteSession } from './history.js';

const SYSTEM_PROMPT =
  'Опиши текущий кадр видео как краткую живую стенограмму на русском языке. Сосредоточься на видимых действиях, изменениях в кадре, тексте на экране, людях, объектах и движении. Избегай домыслов.';

const INITIAL_STATUS = {
  state: 'checking',
  detail: 'Проверка MLX VLM',
};

const INITIAL_SYSTEM_INFO = {
  chip: '',
  memory: '',
};

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) {
    return '00:00.0';
  }

  const totalSeconds = Math.max(0, seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds - minutes * 60;
  const paddedMinutes = String(minutes).padStart(2, '0');
  const paddedSeconds = remainder.toFixed(1).padStart(4, '0');
  return `${paddedMinutes}:${paddedSeconds}`;
}

function captureFrame(video, canvas) {
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) {
    throw new Error('Video frame is not ready yet.');
  }

  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / width);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(video, 0, 0, targetWidth, targetHeight);

  return canvas.toDataURL('image/jpeg', 0.88);
}

async function streamDescription(payload, { signal, onToken, onStart }) {
  const response = await fetch('/api/describe/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text();
    throw new Error(detail || 'Description request failed.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  const consumeEvent = (rawEvent) => {
    let eventName = 'message';
    const dataLines = [];

    rawEvent.split('\n').forEach((line) => {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    });

    if (!dataLines.length) {
      return null;
    }

    const data = JSON.parse(dataLines.join('\n'));

    if (eventName === 'start') {
      onStart?.(data);
      return null;
    }

    if (eventName === 'token') {
      fullText += data.text ?? '';
      onToken(data.text ?? '', fullText);
      return null;
    }

    if (eventName === 'error') {
      throw new Error(data.message || 'Streaming failed.');
    }

    if (eventName === 'done') {
      return data.text ?? fullText;
    }

    return null;
  };

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    while (true) {
      const boundary = buffer.indexOf('\n\n');

      if (boundary === -1) {
        break;
      }

      const eventBlock = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);

      if (!eventBlock) {
        continue;
      }

      const maybeText = consumeEvent(eventBlock);

      if (typeof maybeText === 'string') {
        return maybeText;
      }
    }
  }

  if (buffer.trim()) {
    const maybeText = consumeEvent(buffer.trim());
    if (typeof maybeText === 'string') {
      return maybeText;
    }
  }

  return fullText;
}

function TranscriptRow({ item, active = false }) {
  return (
    <article
      className={`rounded-3xl border p-4 backdrop-blur-xl ${
        active
          ? 'border-tide/45 bg-white/8 shadow-[0_0_0_1px_rgba(116,198,221,0.08)]'
          : 'border-white/10 bg-white/5'
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.22em] text-mist/55">
        <span>{active ? 'Идёт запись' : `Кадр ${item.index}`}</span>
        <span>{formatClock(item.timeSeconds)}</span>
      </div>
      <p className="text-sm leading-7 text-mist/90">{item.text}</p>
      {active ? (
        <div className="mt-4 h-px w-full animate-pulseLine bg-gradient-to-r from-transparent via-tide to-transparent" />
      ) : null}
    </article>
  );
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const transcriptEndRef = useRef(null);
  const activeRequestRef = useRef(null);
  const isStreamingRef = useRef(false);
  const currentObjectUrlRef = useRef('');

  const [videoSource, setVideoSource] = useState('');
  const [videoName, setVideoName] = useState('');
  const [entries, setEntries] = useState([]);
  const [liveText, setLiveText] = useState('');
  const [liveTime, setLiveTime] = useState(0);
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [systemInfo, setSystemInfo] = useState(INITIAL_SYSTEM_INFO);
  const [isStreaming, setIsStreaming] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [requestCount, setRequestCount] = useState(0);
  const [history, setHistory] = useState(() => loadHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [viewingSession, setViewingSession] = useState(null);
  const savedRef = useRef(false);

  const stats = [
    { label: 'Кадры', value: String(entries.length + (isStreaming ? 1 : 0)).padStart(2, '0') },
    { label: 'Запросы', value: String(requestCount).padStart(2, '0') },
    { label: 'Режим', value: isStreaming ? 'Запись' : 'Ожидание' },
  ];

  useEffect(() => {
    let cancelled = false;

    const loadSystemInfo = async () => {
      try {
        const response = await fetch('/api/system-info');
        const payload = await response.json();

        if (!cancelled && response.ok) {
          setSystemInfo({
            chip: payload.chip || '',
            memory: payload.memory || '',
          });
        }
      } catch {
        // Ignore system info failures. The app remains usable without it.
      }
    };

    void loadSystemInfo();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId;

    const checkHealth = async () => {
      try {
        const response = await fetch('/api/health');
        const payload = await response.json();

        const nextState =
          response.ok && payload.ready
            ? 'online'
            : payload.upstream === 'warming'
              ? 'warming'
              : 'offline';

        if (!cancelled) {
          setStatus({
            state: nextState,
            detail:
              nextState === 'online'
                ? payload.detail || `Bridge ready: ${payload.model}`
                : nextState === 'warming'
                  ? payload.detail || 'Прогрев MLX модели'
                  : 'Запустите API и MLX сервер',
          });

          if (nextState !== 'online') {
            timeoutId = window.setTimeout(checkHealth, 3000);
          }
        }
      } catch {
        if (!cancelled) {
          setStatus({
            state: 'offline',
            detail: 'Запустите API и MLX сервер',
          });
          timeoutId = window.setTimeout(checkHealth, 3000);
        }
      }
    };

    void checkHealth();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    return () => {
      activeRequestRef.current?.abort();
      if (currentObjectUrlRef.current) {
        URL.revokeObjectURL(currentObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, liveText]);

  const saveCurrentSession = () => {
    setEntries((current) => {
      if (current.length > 0 && !savedRef.current) {
        const session = saveSession(videoName, current);
        if (session) {
          setHistory(loadHistory());
          savedRef.current = true;
        }
      }
      return current;
    });
  };

  const resetSession = () => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    isStreamingRef.current = false;
    savedRef.current = false;
    setEntries([]);
    setLiveText('');
    setLiveTime(0);
    setIsStreaming(false);
    setVideoReady(false);
    setErrorMessage('');
    setRequestCount(0);
  };

  const handleVideoSelect = (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!file.type.startsWith('video/')) {
      setErrorMessage('Пожалуйста, выберите видеофайл.');
      event.target.value = '';
      return;
    }

    saveCurrentSession();
    resetSession();

    if (currentObjectUrlRef.current) {
      URL.revokeObjectURL(currentObjectUrlRef.current);
    }

    const objectUrl = URL.createObjectURL(file);
    currentObjectUrlRef.current = objectUrl;
    setVideoSource(objectUrl);
    setVideoName(file.name);
    event.target.value = '';
  };

  const describeCurrentFrame = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || isStreamingRef.current) {
      return;
    }

    if (video.paused || video.ended || video.readyState < 2) {
      return;
    }

    const frameTimeSeconds = video.currentTime;
    let imageDataUrl = '';

    try {
      imageDataUrl = captureFrame(video, canvas);
    } catch (error) {
      setErrorMessage(error.message);
      return;
    }

    const controller = new AbortController();
    activeRequestRef.current?.abort();
    activeRequestRef.current = controller;
    isStreamingRef.current = true;
    setIsStreaming(true);
    setLiveText('');
    setLiveTime(frameTimeSeconds);
    setErrorMessage('');
    setRequestCount((count) => count + 1);

    try {
      const text = await streamDescription(
        {
          imageDataUrl,
          frameTimeSeconds,
          systemPrompt: SYSTEM_PROMPT,
        },
        {
          signal: controller.signal,
          onStart: () => {
            setStatus((current) =>
              current.state === 'online'
                ? current
                : {
                    state: 'online',
                    detail: 'Соединение установлено',
                  },
            );
          },
          onToken: (_token, aggregate) => {
            setLiveText(aggregate);
          },
        },
      );

      const trimmedText = text.trim();

      if (trimmedText) {
        setEntries((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            index: current.length + 1,
            timeSeconds: frameTimeSeconds,
            text: trimmedText,
          },
        ]);
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        setErrorMessage(error.message);
        setStatus({
          state: 'offline',
          detail: 'Соединение потеряно',
        });
      }
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
      }

      isStreamingRef.current = false;
      setIsStreaming(false);
      setLiveText('');

      if (videoRef.current && !videoRef.current.paused && !videoRef.current.ended) {
        window.requestAnimationFrame(() => {
          void describeCurrentFrame();
        });
      }
    }
  };

  const transcriptItems = [...entries];
  const currentStreamItem =
    isStreaming && liveText
      ? {
          id: 'live',
          index: entries.length + 1,
          timeSeconds: liveTime,
          text: liveText,
        }
      : null;
  const systemInfoLabel = [systemInfo.chip, systemInfo.memory].filter(Boolean).join(' • ');
  const showUnavailableState = status.state === 'offline';
  const modelStatusLabel =
    status.state === 'online'
      ? 'Модель готова'
      : status.state === 'warming'
        ? 'Модель прогревается'
        : status.state === 'checking'
          ? 'Проверка модели'
          : 'Модель недоступна';
  const modelStatusClassName =
    status.state === 'online'
      ? 'border-leaf/35 bg-leaf/10 text-leaf'
      : status.state === 'warming' || status.state === 'checking'
        ? 'border-ember/35 bg-ember/10 text-ember'
        : 'border-white/12 bg-white/6 text-mist/70';

  return (
    <main className="min-h-screen bg-mesh-gradient px-5 py-6 text-mist md:px-8 lg:px-10">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-5">
        <header className="flex flex-col gap-4 rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-panel backdrop-blur-2xl lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full text-center">
            <h1 className="font-display text-3xl leading-tight text-white">
              Описание видео по кадрам
            </h1>
            {!showUnavailableState ? (
              <div className="mt-4 flex flex-col items-center gap-3">
                <div
                  className={`rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] ${modelStatusClassName}`}
                >
                  {modelStatusLabel}
                </div>
                <p className="text-sm leading-7 text-mist/68">{status.detail}</p>
              </div>
            ) : null}
            {systemInfoLabel ? (
              <p className="mt-3 text-sm leading-7 text-mist/68">{systemInfoLabel}</p>
            ) : null}
          </div>
        </header>

        {showUnavailableState ? (
          <section className="rounded-[2rem] border border-white/10 bg-ink/70 p-6 shadow-panel backdrop-blur-2xl">
            <div className="flex min-h-[760px] items-center justify-center rounded-[1.7rem] border border-dashed border-white/12 bg-black/20 p-8 text-center">
              <div className="max-w-xl">
                <div
                  className={`mx-auto inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] ${modelStatusClassName}`}
                >
                  {modelStatusLabel}
                </div>
                <p className="mt-6 text-2xl font-semibold text-white">{status.detail}</p>
                <p className="mt-4 text-sm leading-7 text-mist/65">
                  Запустите локальные сервисы, после чего интерфейс переключится на видео и транскрипцию.
                </p>
                <div className="mt-6 overflow-hidden rounded-[1.5rem] border border-white/10 bg-black/35 text-left">
                  <div className="border-b border-white/10 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-mist/55">
                    Команды запуска
                  </div>
                  <pre className="overflow-x-auto px-4 py-4 font-mono text-sm leading-7 text-mist/82">
{`./scripts/start-mlx-server.sh
npm run api`}
                  </pre>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
            <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-ink/70 shadow-panel backdrop-blur-2xl">
              <div className="border-b border-white/10 px-6 py-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-1 gap-2">
                    {stats.map((item) => (
                      <div key={item.label} className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-right">
                        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-mist/50">{item.label}</div>
                        <div className="mt-2 text-lg font-semibold text-white">{item.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="relative p-4 md:p-6">
                <input
                  ref={fileInputRef}
                  className="hidden"
                  type="file"
                  accept="video/*"
                  onChange={handleVideoSelect}
                />
                <div className="relative min-h-[620px] overflow-hidden rounded-[1.7rem] border border-white/10 bg-black/40">
                  {videoSource ? (
                    <video
                      ref={videoRef}
                      className="h-full min-h-[620px] w-full bg-black object-contain"
                      controls
                      playsInline
                      src={videoSource}
                      onCanPlay={() => setVideoReady(true)}
                      onPause={() => saveCurrentSession()}
                      onEnded={() => saveCurrentSession()}
                      onPlay={() => {
                        if (status.state !== 'online') {
                          videoRef.current?.pause();
                          setErrorMessage(
                            status.state === 'warming'
                              ? 'Модель ещё прогревается. Подождите.'
                              : 'Сначала запустите API и MLX сервер.',
                          );
                          return;
                        }

                        if (!isStreamingRef.current) {
                          setErrorMessage('');
                          void describeCurrentFrame();
                        }
                      }}
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center bg-[radial-gradient(circle_at_top,rgba(116,198,221,0.22),transparent_35%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))] p-8">
                      <div className="max-w-md text-center">
                        <h3 className="font-display text-3xl text-white">Выберите видеофайл</h3>
                        <p className="mt-3 text-sm leading-7 text-mist/65">
                          Приложение захватывает кадры из видео и отправляет их на локальный MLX бэкенд для описания.
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="absolute right-4 top-4 z-10">
                    <button
                      type="button"
                      className="rounded-full border border-tide/40 bg-black/45 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white backdrop-blur transition hover:border-tide/60 hover:bg-black/60"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Выбрать видео
                    </button>
                  </div>

                  <div className="pointer-events-none absolute left-4 top-4 flex flex-wrap gap-2 pr-32">
                    <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1 text-xs uppercase tracking-[0.22em] text-mist/70">
                      {videoReady ? 'Видео готово' : 'Ожидание видео'}
                    </span>
                    <span className="max-w-[320px] truncate rounded-full border border-white/10 bg-black/35 px-3 py-1 text-xs uppercase tracking-[0.18em] text-mist/60">
                      {videoName || 'Файл не выбран'}
                    </span>
                  </div>
                </div>

                {errorMessage ? (
                  <div className="mt-4 rounded-[1.5rem] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-mist/72">
                    <p className="text-ember">{errorMessage}</p>
                  </div>
                ) : null}
              </div>
            </div>

            <aside className="overflow-hidden rounded-[2rem] border border-white/10 bg-white/6 shadow-panel backdrop-blur-2xl">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                <button
                  onClick={() => { setShowHistory(!showHistory); setViewingSession(null); }}
                  className={`rounded-xl border px-3 py-1.5 font-mono text-xs transition ${
                    showHistory
                      ? 'border-tide/40 bg-tide/15 text-tide'
                      : 'border-white/15 bg-white/8 text-mist/80 hover:bg-white/15'
                  }`}
                >
                  История {history.length > 0 ? `(${history.length})` : ''}
                </button>
                <div className="flex gap-2">
                  {(viewingSession || entries.length > 0) && (
                    <>
                      <button
                        onClick={() => exportMarkdown(viewingSession?.entries || entries, viewingSession?.videoName || videoName)}
                        className="rounded-xl border border-white/15 bg-white/8 px-3 py-1.5 font-mono text-xs text-mist/80 transition hover:bg-white/15"
                      >
                        Скачать MD
                      </button>
                      <button
                        onClick={() => exportPdf(viewingSession?.entries || entries, viewingSession?.videoName || videoName)}
                        className="rounded-xl border border-white/15 bg-white/8 px-3 py-1.5 font-mono text-xs text-mist/80 transition hover:bg-white/15"
                      >
                        Скачать PDF
                      </button>
                    </>
                  )}
                </div>
              </div>

              {showHistory && !viewingSession ? (
                <div className="flex max-h-[760px] min-h-[760px] flex-col gap-3 overflow-y-auto p-5">
                  {history.length > 0 ? (
                    history.map((session) => (
                      <div
                        key={session.id}
                        className="group flex items-start justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 transition hover:bg-white/10"
                      >
                        <button
                          onClick={() => setViewingSession(session)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="break-all text-sm font-semibold text-white">{session.videoName}</p>
                          <p className="mt-1 font-mono text-xs text-mist/50">
                            {new Date(session.date).toLocaleString('ru-RU')} · {session.entries.length} кадров
                          </p>
                        </button>
                        <button
                          onClick={() => {
                            const updated = deleteSession(session.id);
                            setHistory(updated);
                          }}
                          className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono text-xs text-mist/40 transition hover:border-ember/30 hover:text-ember"
                        >
                          Удалить
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="flex h-full min-h-[320px] items-center justify-center rounded-[1.8rem] border border-dashed border-white/12 bg-black/10 p-8 text-center">
                      <div className="max-w-sm">
                        <p className="text-sm leading-7 text-mist/65">История пуста.</p>
                      </div>
                    </div>
                  )}
                </div>
              ) : showHistory && viewingSession ? (
                <div className="flex max-h-[760px] min-h-[760px] flex-col overflow-y-auto">
                  <div className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
                    <button
                      onClick={() => setViewingSession(null)}
                      className="rounded-lg border border-white/15 bg-white/8 px-2 py-1 font-mono text-xs text-mist/80 transition hover:bg-white/15"
                    >
                      ← Назад
                    </button>
                    <div>
                      <p className="text-sm font-semibold text-white">{viewingSession.videoName}</p>
                      <p className="font-mono text-xs text-mist/50">
                        {new Date(viewingSession.date).toLocaleString('ru-RU')} · {viewingSession.entries.length} кадров
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-4 p-5">
                    {viewingSession.entries.map((item) => (
                      <TranscriptRow key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex max-h-[760px] min-h-[760px] flex-col gap-4 overflow-y-auto p-5">
                  {transcriptItems.length ? (
                    transcriptItems.map((item) => <TranscriptRow key={item.id} item={item} />)
                  ) : (
                    <div className="flex h-full min-h-[320px] items-center justify-center rounded-[1.8rem] border border-dashed border-white/12 bg-black/10 p-8 text-center">
                      <div className="max-w-sm">
                        <p className="text-sm leading-7 text-mist/65">Нажмите play.</p>
                      </div>
                    </div>
                  )}
                  {currentStreamItem ? <TranscriptRow item={currentStreamItem} active /> : null}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </aside>
          </section>
        )}

        <canvas ref={canvasRef} className="hidden" />
      </div>
    </main>
  );
}
