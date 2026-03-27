# Local LLM Video Captioning — Русская версия

![Preview](./preview.jpg)

Локальное описание видео по кадрам на **русском языке** с помощью vision-модели, работающей полностью на вашем Mac. Никакие данные не отправляются в облако.

Форк [stevibe/local-llm-video-captioning](https://github.com/stevibe/local-llm-video-captioning) с русскоязычными промптами.

## Что внутри

- **React + Tailwind** — интерфейс для загрузки и воспроизведения видео
- **Express API** — прокси-сервер со стримингом ответов
- **mlx_vlm** — локальный бэкенд для vision-инференса на Apple Silicon

## Требования

- **Apple Silicon Mac** (M1/M2/M3/M4) — проект использует MLX, который работает только на чипах Apple
- **Node.js** 18+
- **Python** 3.10+ (рекомендуется 3.11)
- **uv** — менеджер Python-пакетов

Если `uv` не установлен:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Установка

### 1. Клонируйте репозиторий

```bash
git clone https://github.com/YFrtn/local-llm-video-captioning-ru.git
cd local-llm-video-captioning-ru
```

### 2. Установите JavaScript-зависимости

```bash
npm install
```

### 3. Установите Python-окружение

```bash
uv sync --python 3.11
```

При первом запуске будет создано виртуальное окружение и установлены все Python-зависимости (~200 МБ).

### 4. Создайте файл конфигурации

```bash
cp .env.example .env
```

Настройки по умолчанию:

| Переменная | Значение | Описание |
|---|---|---|
| `API_PORT` | `8787` | Порт Express API |
| `MLX_VLM_BASE_URL` | `http://127.0.0.1:8081` | Адрес MLX-сервера |
| `MLX_MODEL_ID` | `mlx-community/Qwen3.5-0.8B-MLX-8bit` | Модель (Qwen 3.5, поддерживает русский) |
| `MLX_MAX_TOKENS` | `180` | Максимум токенов на кадр |

## Запуск

Нужно запустить **3 процесса** (каждый в отдельном терминале):

**Терминал 1** — MLX бэкенд:
```bash
./scripts/start-mlx-server.sh
```

**Терминал 2** — API:
```bash
npm run api
```

**Терминал 3** — UI:
```bash
npm run dev
```

Или API + UI одной командой:
```bash
npm run dev:all
```

> При первом запуске модель скачивается с Hugging Face (~1 ГБ). Последующие запуски будут быстрыми.

## Использование

1. Откройте браузер: **http://localhost:5173**
2. Нажмите **Select Video** и выберите видеофайл
3. Нажмите **Play**
4. Описания кадров на русском языке появятся в панели справа в реальном времени

## Что изменено относительно оригинала

- Системный промпт переведён на русский (`src/App.jsx`)
- User-промпт переведён на русский с явной инструкцией отвечать на русском (`server/api.js`)

## Благодарности

Основано на [stevibe/local-llm-video-captioning](https://github.com/stevibe/local-llm-video-captioning).

## Лицензия

MIT. См. [LICENSE](./LICENSE).
