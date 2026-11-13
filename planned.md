# План перехода: Universal-AI (монолит 0.2.xx) → @u2ai/measurer (0.3.xx)

> Актуальный статус: **шаги 1–14 завершены**, шаг 15 в работе.
> Рабочий дом переносимого кода: `submodules/u2ai-measurer/`.
> Репозиторий: <https://github.com/u2re-space/u2ai-measurer> (remote настроен, пуш не делаем).
>
> Наследник предыдущего шага: `submodules/u2ai-decomposer/` (`@u2ai/decomposer`, CLI
> `ai-decompose`) — из него берутся конфиг-система, openai-слой и агентный слой
> (tools/skills/MCP), чтобы три пакета не расходились по стилю.
> Второй родственник: `submodules/u2ai-images/` (`@u2ai/images`, CLI `ai-image`) — из него
> берётся слой `sharp`/`canvas` и мост вызова внешнего CLI.

---

## 0. Цели и рамки

**Цель:** выделить из монолитного CLI `ai` две роли/стадии — `measure` (замер референса)
и `design` (визуальное направление) — в самостоятельный CLI `ai-measure`
(`@u2ai/measurer`) с собственным конфигом `~/.ai-measure`.

**Рамки нового пакета:**

| Параметр | Значение |
|---|---|
| Имя пакета | `@u2ai/measurer` |
| Бинарь | `ai-measure` (`bin/ai-measure.{js,cmd,ps1,sh}`) |
| Репозиторий | <https://github.com/u2re-space/u2ai-measurer> |
| Версия | 0.3.0-alpha |
| Конфиг | `~/.ai-measure/` — каталог: `config.json`, `skills/` (оверрайд `AI_MEASURE_HOME`) |
| Префикс env | `AI_MEASURE_*` (совместимость с `OPENAI_*`, `AI_MODEL`) |
| Runtime | Node.js >= 26, ESM, без SDK (чистый `fetch`) |
| Зависимости | `sharp`, `canvas`, `@resvg/resvg-js`, `@modelcontextprotocol/node` |

**Что переносим, а что — нет:**

| Переносим | Не переносим |
|---|---|
| Роль `measurer`: промпт листа измерений, строгий JSON-лист, два прохода (обзорный + по кропам) | Генератор изображений — его нет в пакете, только вызов внешнего `ai-image` |
| Роль `designer`: визуальное направление, палитра, типографика, шкала отступов, HTML-скелет | Декомпозитор как внутренняя подсистема — только вызов внешнего `ai-decompose` |
| Локальные операции: обрезка, разбиение на плитки, сэмплирование цвета, палитра | Team/loop агента монолита, jobs, channels, serve |
| `sample_colors`: чтение пикселей, sRGB/HSL/OKLCH, WCAG-контраст, палитра по региону | Модельные профили картинок (`seedream`, `gpt-image`) — остаются в `@u2ai/images` |
| Схема листа измерений (`MEASUREMENT_SCHEMA`) и схема дизайн-направления (`DESIGN_SCHEMA`) | Схемы планировщика, архитектора, стилиза, ревьюера — не наша зона |
| Ветки `measure-source` (`auto`/`subrefs`/`original`), режимы `off\|auto\|always` | Команды монолита, кроме `--measure`/`--design` (они станут мостами) |
| Поддержка `DESIGN.md` (чтение, извлечение токенов, конфликты) | Пайплайн монолитного `ai` целиком |
| Скиллы (`~/.ai-measure/skills/*.md`) и документация стандартов (CSS units и прочие) | Скиллы монолита (`skills-lock.json`) |

**Карта источников монолита:**

| Файл монолита | Файл нового пакета | Что забираем |
|---|---|---|
| `src/roles/measurer.js` | `src/roles/measurer.js` | промпт листа измерений, правила цветов/юнитов/элементов |
| `src/roles/designer.js` | `src/roles/designer.js` | промпт визуального направления |
| `src/agent/schemas.js` (`MEASURER_SCHEMA`, `DESIGNER_SCHEMA`) | `src/agent/schemas.js` | строгие JSON-схемы ответов |
| `src/shared/image-colors.js` | `src/image/colors.js` | sRGB→OKLCH, HSL, WCAG-контраст, `sampleColors` |
| `src/shared/kmeans.js` | `src/image/quantizer.js` | k-means палитра, `toHex` |
| `src/agent/measure-crops.js` | `src/stages/crop.js`, `src/stages/measure.js` | нарезка кропов по боксам листа, `measure-source` |
| `src/agent/team.js` (ветки design/measure) | `src/stages/design.js`, `src/stages/measure.js` | сбор контекста, чтение `DESIGN.md`, кэш, `measurements.json` |
| `src/agent/team-text.js` (`renderMeasurements`, `renderDesign`) | `src/stages/resolve.js` | отчёты и сводки |
| `src/core/config-defaults.js` (`agent.measure*`, `roles.measurer`, `roles.designer`, `documentation.roles`) | `src/config/defaults.js` | ключи конфига и их значения |
| `src/cli-help.js` (`--measure`, `--design`) | `src/help.js` | тексты справки (на английском) |
| `src/commands/image.js` | `src/agent/tools.js` (мостик `ai-image`) | порядок поиска бинаря, проброс кода возврата |

**Поверхность CLI `ai-measure`:**

| Команда | Что делает |
|---|---|
| `ai-measure measure <ref…>` | полный замер референса: кропы → лист измерений → `measurements.json`, `DESIGN.md`, токены |
| `ai-measure design "<task>"` | визуальное направление по референсам и/или тексту задачи |
| `ai-measure palette <image>` | локальная палитра из пикселей (без сети) |
| `ai-measure crop <image> --box x,y,w,h` | локальная обрезка (без сети) |
| `ai-measure split <image> --rows N --cols N` | локальное разбиение на плитки (без сети) |
| `ai-measure tokens <sheet.json>` | CSS-юниты и токены из готового листа измерений |
| `ai-measure docs` | документация формата листа, CSS units и стандартов |
| `ai-measure config [show\|path]` | показать/проверить конфиг |
| `ai-measure skills` | список скилл-паков |

---

## 1. Шаги

### step-1 — Каркас пакета и лаунчеры
- [x] `package.json` (`@u2ai/measurer`, бинарь `ai-measure`, Node >= 26, ESM, зависимости)
- [x] `bin/ai-measure.{js,cmd,ps1,sh}`
- [x] `index.js` — публичный точечный вход
- [x] `scripts/check-syntax.mjs` — разбор всех файлов пакета
- [x] `.gitignore` (без `package-lock.json`)
- [x] Каркас каталогов `src/{cli,help,index}.js`, `src/agent`, `src/cli`, `src/config`,
      `src/image`, `src/model`, `src/openai`, `src/roles`, `src/shared`, `src/stages`

### step-2 — Система конфигурации `~/.ai-measure`
- [x] `src/config/constants.js` — enum'ы (стадии, режимы замера, движки растра, уровни контекста)
- [x] `src/config/defaults.js` — дефолты: API, лимиты, инструменты, стадии, роли, вывод
- [x] `src/config/env.js` — `AI_MEASURE_*` → поля конфига
- [x] `src/config/paths.js` — `~/.ai-measure`, `config.json`, `skills/`
- [x] `src/config/merge.js`, `src/config/parser.js` — merge, JSON, `{{env:}}`/`{{file:}}`
- [x] `src/config/validate.js` — проверки с русскими сообщениями
- [x] `src/config/index.js`, `src/config.js` — загрузка, `ensureConfigFile`, `redactConfig`

### step-3 — OpenAI-слой
- [x] `src/openai/{errors,http,sse,stream}.js` — транспорт, SSE, редуктор потока
- [x] `src/openai/responses.js` — тело Responses-запроса, `imagePart` (vision), строгий JSON
- [x] `src/openai/chat.js` — запасной транспорт Chat Completions
- [x] `src/openai/{completions,fallback}.js` — алиасы и цепочка моделей
- [x] `src/openai/client.js` — клиент: ротация бэкендов, ретраи, `responses.create`
- [x] `src/model/profiles.js` — профили моделей, усилие reasoning, лимиты контекста

### step-4 — Локальный растровый слой
- [x] `src/image/sharp.js` — декод, метаданные, ресайз под модель, RGBA-кадр
- [x] `src/image/canvas.js` — запасной декод и рендер аннотаций
- [x] `src/image/crop.js` — геометрия боксов, `clampRect`
- [x] `src/image/magick.js` — опциональный ImageMagick как ускорение/запасной путь

### step-5 — Цвет и палитра
- [x] `src/image/quantizer.js` — k-means палитра, `toHex`
- [x] `src/image/colors.js` — sRGB→OKLCH/HSL, WCAG-контраст, `sampleColors`, `paletteOf`

### step-6 — Агентный слой: инструменты
- [x] `src/agent/paths.js` — пути внутри рабочего каталога, запрет секретов
- [x] `src/agent/tool-specs.js` — каталог инструментов и их схемы
- [x] `src/agent/tools.js` — исполнитель: `view_image`, `crop_image`, `split_image`,
      `sample_colors`, `list_files`, `read_file`, `write_file`, `search_files`,
      `call_ai_image`, `call_ai_decompose`

### step-7 — Скиллы, документация и MCP
- [x] `src/agent/skills.js` — чтение скилл-паков из `~/.ai-measure/skills` и `skills.dir`
- [x] `src/agent/documentation.js` — тексты стандартов (CSS units, CSS shapes, WCAG colors, …)
- [x] `src/agent/mcp.js` — подключение MCP-серверов из конфига, доступ к их инструментам

### step-8 — Схемы ответов ролей
- [x] `src/agent/schemas.js` — `MEASUREMENT_SCHEMA`, `DESIGN_SCHEMA`, `CROP_PLAN_SCHEMA`
- [x] Проверка схем на строгость (все поля обязательны, лишние запрещены)

### step-9 — Роли
- [x] `src/roles/untrusted.js` — общая директива о недоверенных данных
- [x] `src/roles/measurer.js` — промпт замера (элементы, регионы, правила, цвета, юниты)
- [x] `src/roles/cropper.js` — промпт плана нарезки
- [x] `src/roles/designer.js` — промпт визуального направления
- [x] `src/roles/index.js` — резолв ролей и цикл вызовов с инструментами и скиллами

### step-10 — Стадии `crop` и `measure`
- [x] `src/stages/crop.js` — нарезка кропов по боксам листа, режимы `auto|subrefs|original`
- [x] `src/stages/measure.js` — обзорный проход + второй проход по кропам, сбор листа

### step-11 — Стадия `design`
- [x] `src/stages/design.js` — контекст задачи, референсы, `DESIGN.md`, кэш, HTML-скелет

### step-12 — Стадия `resolve` и артефакты
- [x] `src/stages/resolve.js` — `measurements.json`, `palette.json`, `tokens.css`,
      `DESIGN.md`, markdown-отчёт
- [x] `src/shared/pipeline.js` — оркестратор стадий
- [x] `src/stages/index.js` — реестр стадий и их подписи

### step-13 — CLI
- [x] `src/cli/colors.js`, `src/cli/compatibility.js` — цвета и проверка версии Node
- [x] `src/cli/renderer.js` — рендер событий (план, стадии, файлы, предупреждения)
- [x] `src/cli.js` — разбор argv, диспетчер команд, коды возврата
- [x] `src/help.js` — справка на английском языке

### step-14 — Тесты
- [x] `test/config.test.js` — конфиг, валидация, русские сообщения
- [x] `test/colors.test.js` — OKLCH/HSL/контраст/палитра
- [x] `test/image.test.js` — crop/split/метаданные
- [x] `test/tools.test.js` — инструменты агента, запись только в разрешённые каталоги
- [x] `test/roles.test.js` — резолв ролей, схемы, цикл вызовов
- [x] `test/cli.test.js` — разбор argv, коды возврата, локальные команды
- [x] `test/stages.test.js` — стадии на мокк-хосте

### step-15 — README и релиз-чеклист
- [ ] `README.md` — установка, команды, примеры, формат конфига
- [ ] Чеклист релиза: `npm run check`, `npm test`, `npm pack --dry-run`, версия, репозиторий

---

## 2. Правила работы

1. Каждый шаг — отдельный коммит с сообщением `step-N: <что сделано>`; в этом же коммите
   галочки соответствующего шага в `planned.md` отмечаются.
2. Пуш не делаем: remote настроен, но репозиторий остаётся локальным.
3. Тексты CLI и README — на английском; сообщения валидации конфига — на русском
   (как в `u2ai-decomposer` и `u2ai-images`).
4. Файлы, портированные из монолита, помечаются тегом `@ai.hint legacy-0.2`.
5. Внешние CLI (`ai-image`, `ai-decompose`) вызываются как подпроцессы; генерации картинок
   и декомпозиции внутри пакета нет.
