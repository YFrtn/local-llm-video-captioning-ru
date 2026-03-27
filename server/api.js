import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const app = express();
const port = Number(process.env.API_PORT || 8787);
const upstreamBaseUrl = process.env.MLX_VLM_BASE_URL || 'http://127.0.0.1:8081';
const defaultModel = process.env.MLX_MODEL_ID || 'mlx-community/Qwen3.5-0.8B-MLX-8bit';
const maxTokens = Number(process.env.MLX_MAX_TOKENS || 180);
const warmupTimeoutMs = Number(process.env.MLX_WARMUP_TIMEOUT_MS || 900000);
const warmupImageDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9d7ysAAAAASUVORK5CYII=';
const execFileAsync = promisify(execFile);

let readyState = 'unknown';
let readyDetail = 'Ожидание прогрева модели.';
let warmupPromise = null;
let systemInfoPromise = null;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }

      if (item?.type === 'text' && typeof item.text === 'string') {
        return item.text;
      }

      return '';
    })
    .join('');
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildMessages(imageDataUrl, frameTimeSeconds, systemPrompt) {
  const frameTimeLabel = Number.isFinite(frameTimeSeconds)
    ? `${frameTimeSeconds.toFixed(2)}s`
    : 'unknown time';

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Опиши текущий кадр видео на отметке ${frameTimeLabel}. Укажи видимые действия, людей, объекты, текст на экране и основные изменения в сцене. Будь кратким и точным. Отвечай только на русском языке.`,
        },
        {
          type: 'image_url',
          image_url: {
            url: imageDataUrl,
          },
        },
      ],
    },
  ];
}

function buildWarmupMessages() {
  return [
    {
      role: 'system',
      content: 'Warm up the model and reply briefly.',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Reply with the single word ready.',
        },
        {
          type: 'image_url',
          image_url: {
            url: warmupImageDataUrl,
          },
        },
      ],
    },
  ];
}

function formatMemoryLabel(totalMemoryBytes) {
  const gibibytes = totalMemoryBytes / 1024 ** 3;
  const rounded = Math.round(gibibytes);
  return `${rounded} GB RAM`;
}

async function detectSystemInfo() {
  const totalMemoryBytes = os.totalmem();
  const isAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  let chip = null;

  if (isAppleSilicon) {
    try {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'machdep.cpu.brand_string']);
      chip = stdout.trim() || 'Apple Silicon';
    } catch {
      chip = 'Apple Silicon';
    }
  }

  return {
    chip,
    memory: formatMemoryLabel(totalMemoryBytes),
    platform: process.platform,
    arch: process.arch,
    isAppleSilicon,
  };
}

function getSystemInfo() {
  if (!systemInfoPromise) {
    systemInfoPromise = detectSystemInfo();
  }

  return systemInfoPromise;
}

async function fetchUpstreamHealth() {
  const upstream = await fetch(`${upstreamBaseUrl}/health`);
  const payload = upstream.ok ? await upstream.json() : null;

  return {
    ok: upstream.ok,
    payload,
  };
}

async function warmupModel() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), warmupTimeoutMs);

  try {
    const response = await fetch(`${upstreamBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: defaultModel,
        stream: false,
        temperature: 0,
        max_tokens: 12,
        messages: buildWarmupMessages(),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `Warm-up failed with status ${response.status}.`);
    }

    await response.json();
    readyState = 'ready';
    readyDetail = `Модель готова: ${defaultModel}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureModelReady() {
  if (readyState === 'ready') {
    return;
  }

  if (!warmupPromise) {
    readyState = 'warming';
    readyDetail = `Прогрев модели: ${defaultModel}`;
    warmupPromise = warmupModel()
      .catch((error) => {
        readyState = 'offline';
        readyDetail = error.message || 'Ошибка прогрева модели.';
        throw error;
      })
      .finally(() => {
        warmupPromise = null;
      });
  }

  return warmupPromise;
}

app.get('/api/health', async (_req, res) => {
  try {
    const { ok, payload } = await fetchUpstreamHealth();

    if (!ok) {
      readyState = 'offline';
      readyDetail = 'MLX сервер не отвечает.';
      return res.status(503).json({
        upstream: 'offline',
        ready: false,
        model: defaultModel,
        baseUrl: upstreamBaseUrl,
        detail: payload,
      });
    }

    await ensureModelReady();

    res.json({
      upstream: 'online',
      ready: true,
      model: defaultModel,
      baseUrl: upstreamBaseUrl,
      detail: readyDetail,
      upstreamDetail: payload,
    });
  } catch (error) {
    const isAbort = error.name === 'AbortError';
    const warming = readyState === 'warming';
    res.status(503).json({
      upstream: warming ? 'warming' : 'offline',
      ready: false,
      model: defaultModel,
      baseUrl: upstreamBaseUrl,
      detail: warming ? readyDetail : 'Ошибка прогрева модели.',
      error: isAbort ? 'Warm-up timed out.' : error.message,
    });
  }
});

app.get('/api/system-info', async (_req, res) => {
  try {
    const systemInfo = await getSystemInfo();
    res.json(systemInfo);
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Unable to determine system information.',
    });
  }
});

app.post('/api/describe/stream', async (req, res) => {
  const { imageDataUrl, frameTimeSeconds, systemPrompt } = req.body ?? {};

  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'imageDataUrl must be a data URL.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const controller = new AbortController();
  let streamCompleted = false;

  req.on('aborted', () => controller.abort());
  res.on('close', () => {
    if (!streamCompleted) {
      controller.abort();
    }
  });

  writeSse(res, 'start', {
    model: defaultModel,
    frameTimeSeconds,
  });

  let upstreamResponse;

  try {
    await ensureModelReady();
    upstreamResponse = await fetch(`${upstreamBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: defaultModel,
        stream: true,
        temperature: 0.1,
        max_tokens: maxTokens,
        messages: buildMessages(imageDataUrl, frameTimeSeconds, systemPrompt),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    writeSse(res, 'error', {
      message: `Unable to reach mlx_vlm.server at ${upstreamBaseUrl}. ${error.message}`,
    });
    return res.end();
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const detail = await upstreamResponse.text();
    writeSse(res, 'error', {
      message: detail || `Upstream request failed with status ${upstreamResponse.status}.`,
    });
    return res.end();
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  const processEventBlock = (rawBlock) => {
    const dataLines = rawBlock
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    if (!dataLines.length) {
      return false;
    }

    const payload = dataLines.join('\n');

    if (payload === '[DONE]') {
      return true;
    }

    let parsed;

    try {
      parsed = JSON.parse(payload);
    } catch {
      return false;
    }

    const content = extractContentText(parsed?.choices?.[0]?.delta?.content);

    if (content) {
      fullText += content;
      writeSse(res, 'token', { text: content });
    }

    return parsed?.choices?.[0]?.finish_reason != null;
  };

  try {
    for await (const chunk of upstreamResponse.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');

      while (true) {
        const boundary = buffer.indexOf('\n\n');

        if (boundary === -1) {
          break;
        }

        const rawBlock = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);

        if (!rawBlock) {
          continue;
        }

        const finished = processEventBlock(rawBlock);

        if (finished) {
          streamCompleted = true;
          writeSse(res, 'done', { text: fullText.trim() });
          return res.end();
        }
      }
    }

    if (buffer.trim()) {
      processEventBlock(buffer.trim());
    }

    streamCompleted = true;
    writeSse(res, 'done', { text: fullText.trim() });
    return res.end();
  } catch (error) {
    if (!controller.signal.aborted) {
      writeSse(res, 'error', { message: error.message || 'Streaming interrupted.' });
    }
    return res.end();
  }
});

app.listen(port, () => {
  console.log(`Streaming API listening on http://127.0.0.1:${port}`);
  console.log(`Proxying requests to ${upstreamBaseUrl} using model ${defaultModel}`);
});
