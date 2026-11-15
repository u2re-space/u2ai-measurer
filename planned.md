# План перехода: Universal-AI (монолит 0.2.xx) → @u2ai/measurer (0.3.xx)

> Актуальный статус: **все 15 шагов завершены**.
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
- [x] `README.md` — установка, команды, примеры, формат конфига
- [x] Чеклист релиза: `npm run check`, `npm test`, `npm pack --dry-run`, версия, репозиторий

### step-16 — Схема как канал ответа
- [x] `src/openai/responses.js` — `schemaChannel`: `tool` (функция), `format` (`text.format`) или
      `auto`; при наличии других инструментов схема едет только инструментом
- [x] `src/openai/responses.js` — `parseResponse(raw, { schemaName })` читает ответ из вызова
      схемы; `parseJsonText` вытаскивает JSON из текста с fences и прозой
- [x] `test/responses.test.js`

### step-17 — Fallback систем и моделей
- [x] `src/openai/fallback.js` — `fallbackWorthy`, `modelRefusal`, цепочка моделей, повтор всей
      роли на следующей модели
- [x] `src/roles/index.js` — `withModelFallback` вокруг цикла роли: следующая модель отвечает
      на всю роль с первого хода, с картинкой
- [x] `src/config/defaults.js` — цепочка моделей по умолчанию
- [x] `src/config/validate.js` — проверка `fallback.models` с русскими сообщениями
- [x] `test/fallback.test.js`

### step-18 — Ответ в две фазы
- [x] `src/roles/index.js` — цикл роли: исходное сообщение пользователя и картинка остаются
      в каждом ходе; бюджет ходов сообщается модели
- [x] `src/roles/index.js` — две фазы: сначала инструменты, потом ответ под схемой API
- [x] `src/roles/measurer.js` — промпт без требования ответа в прозе
- [x] `src/config/defaults.js` — `measurerMaxTurns: 16`, `stages.measure.maxTurns: 16`
- [x] `test/roles.test.js`, `test/stages.test.js`

### step-19 — Цвета: culori
- [x] `package.json` — зависимость `culori`
- [x] `src/image/color-space.js` — разбор любого CSS-цвета, все нотации (hex, rgb, hsl, hwb,
      oklab, oklch, lab, lch, Display-P3, XYZ), контраст WCAG, CIEDE2000, приведение к sRGB
- [x] `src/agent/tool-specs.js`, `src/agent/tools.js` — инструмент `parse_color`
- [x] `src/config/defaults.js` — выключатель `tools.color_parse`
- [x] `test/color-space.test.js`

### step-20 — Спецификации CSS
- [x] `src/agent/documentation.js` — `cssColors` (пространства цветов, alpha, `color-mix`,
      ΔE00) и `cssDisplay` (`display`, `position`, стек, box model, overflow)
- [x] `src/config/constants.js` — новые источники в `documentationSources`
- [x] `src/config/defaults.js` — `cssColors` и `cssDisplay` в ролях

### step-21 — Скиллы
- [x] `src/agent/skills.js` — папка-пак (`SKILL.md` + ссылки), frontmatter (`name`,
      `description`, `roles`), файлы и папки рядом
- [x] `src/shared/pipeline.js` — паки мерителя наследуются фрагментным проходом
- [x] `src/cli.js` — команда `skills` показывает состав пака
- [x] `test/skills.test.js`

### step-22 — MCP
- [x] `src/agent/mcp.js` — HTTP и stdio, `initialize`, `tools/list`, `tools/call` (было в
      step-7, проверено на живом сервере)
- [x] `src/shared/pipeline.js` — сервер, который не поднялся, попадает в предупреждения

### step-23 — Примеры и документация
- [x] `examples/` — картинка, лист замеров, нарезанные фрагменты, пример пака скиллов
- [x] `README.md` — fallback систем и моделей, скиллы, цвета, две фазы ответа, примеры
- [x] `planned.md` — эти шаги

### step-24 — Фрагменты едут вместе с артефактами
- [x] `src/stages/resolve.js` — `collectCrops` копирует нарезки из рабочей папки в
      `<output.dir>/crops/`
- [x] `src/stages/resolve.js` — `repointCrops` переставляет пути нарезок в листе и в отчёте
      на копии; ненайденная нарезка сохраняет старый путь и попадает в предупреждения
- [x] `test/stages.test.js` — два теста: нарезка едет с артефактами, ненайденная нарезка
      сохраняет путь

### step-c6 — Копия библиотеки доступа: список файлов и копирование
- [x] `src/access/native.js` — копия из `u2ai-server`: операция `copy` и состояние пути
      свойствами (`isDirectory`, `isFile`, `isSymbolicLink`), а не методами Node.js
- [x] `src/access/memory.js` — копия из `u2ai-server`: копирование файла и поддерева
- [x] `src/access/fs.js` — копия из `u2ai-server`: `listFiles(relative, { depth, limit,
      includeHidden })` и `copy(source, destination, { overwrite })` с правилами путей
- [x] Правило: правки слоя доступа идут в `u2ai-server` первыми, остальные пакеты получают
      копию `src/access/*`
- [x] README (EN), planned.md (RU)
- [x] Проверка: `npm test` — 145 тестов, все проходят

### step-c7 — Поиск: имена, маска, регулярное выражение
- [x] `src/agent/tools.js` — `globMatcher()`: маска имени (`*`, `**`, `?`); маска без слэша —
      имя файла, со слэшем — путь от корня
- [x] `src/agent/tools.js` — `search_files`: `inContent=0` ищет по путям и отдаёт сами пути,
      `inContent=1` грепает текст; `glob` отсекает файлы до чтения, `regex` читает запрос
      как регулярное выражение
- [x] `src/agent/tool-specs.js` — параметры `regex` и `glob` в каталоге инструментов
- [x] README (EN), planned.md (RU)
- [x] Проверка: `test/tools.test.js` (имена, маска, регулярное выражение), `npm test` —
      146 тестов, все проходят

### step-c8 — Тишина больше не значит зависание
- [x] `src/openai/client.js` — пульс `request.wait` каждые 20 с, пока ответ не пришёл
- [x] `src/cli.js` — события клиента уходят в рендерер
- [x] `src/cli/renderer.js` — строки `thinking (Ns)`, `retry`, `request failed`, `tool:`
- [x] `src/roles/index.js` — вызовы инструментов объявляются
- [x] `src/config/defaults.js` — `timeoutMs` 900 с вместо 120 с: thinking-модель думает минутами
- [x] `src/config/validate.js`, `src/config/env.js` — диапазон `timeoutMs` до 1 800 с
- [x] README (EN), planned.md (RU)
- [x] Проверка: `npm test` — 146 тестов, все проходят

### step-c9 — Лог говорит, что читается, что пишется и какие цвета сняты
- [x] `src/shared/pipeline.js` — событие `references`: картинки, которые читает прогон
- [x] `src/roles/index.js` — события `tool.call` (с аргументами) и `tool.result` (с ответом)
- [x] `src/stages/measure.js` — события `measure.sheet` (элементы, регионы, правила, цвета)
      и `measure.crops` (нарезанные фрагменты)
- [x] `src/stages/resolve.js` — событие `artifact`: каждый записанный файл и его размер
- [x] `src/cli/renderer.js` — строки по всем этим событиям; `--verbose` печатает ответ целиком
- [x] `test/renderer.test.js` — 7 тестов на строки рендерера
- [x] README (EN), planned.md (RU)
- [x] Проверка: `npm test` — 153 теста, все проходят

### step-c10 — Смерть прогона не должна быть тихой
- [x] `src/cli.js` — `unhandledRejection` и `uncaughtException` печатаются: пустой терминал и
      код возврата больше не единственные свидетели
- [x] README (EN), planned.md (RU)
- [x] Проверка: `npm test` — 153 теста, все проходят

### step-c11 — Журнал запросов и ответов: цепочка читается, а не угадывается
- [x] Проблема: прогон, который упал, говорил только «failed». Не было видно, какой хост
      спрашивали, что ушло, что пришло, сколько модель думала и где цепочка оборвалась
- [x] `src/openai/log.js` — `createApiLogger()` пишет по JSON-записи на запрос,
      `redactBody()` заменяет base64-картинки на note о размере
- [x] `src/openai/client.js` — запись собирает тело запроса, цепочку хостов, попытки,
      время и ответ; ошибка записи не ломает запрос
- [x] `src/config/defaults.js` — секция `logging` (`enabled`, `dir`)
- [x] `src/config/validate.js`, `src/config/env.js` — проверки и `AI_MEASURE_LOG_DIR`
- [x] `test/log.test.js` — 4 теста: запись, отключение, редакция картинок
- [x] README (EN), planned.md (RU)
- [x] Проверка: `npm test` — 157 тестов, все проходят

### step-c12 — Мёртвые поля уходят, конфиг говорит о стадиях
- [x] Проблема: конфиг описывал стадии, которых больше нет, и прятал живые настройки в
      мёртвых полях — `agent.measure`, `agent.measureSource`, `agent.measurerPasses`
- [x] `src/config/defaults.js` — секция `stages` со всеми стадиями, в `agent` остались только
      `design` и `designerMaxTurns`
- [x] `src/config/constants.js` — `ENUMS.measureSources` и `ENUMS.measurePasses` удалены
- [x] `src/config/validate.js` — неизвестные поля конфига отвергаются
- [x] `~/.ai-measure/config.json` — переписан под новую схему

### step-c13 — Сегментация: зоны и боксы
- [x] `src/stages/segmentate.js` — стадия `segmentate`: модель называет зоны и их боксы
- [x] `src/stages/artifacts.js` — контракт стадий: `<out>/stages/*.json`, чтение с диска
- [x] `src/stages/references.js` — картинка прикрепляется с масштабом (`image.maxSide` 1536),
      боксы приводятся к пикселям файла
- [x] `src/roles/segmentator.js` — промпт сегментатора

### step-c14 — Геометрия и тексты
- [x] `src/stages/cropper.js` — стадия `crop`: два режима (`local` режет по зонам,
      `ai` — роль `cropper` с `CROP_PLAN_SCHEMA`), кропы в `<out>/crops/`
- [x] `src/stages/measure.js` — стадия `measure`: display, ширина, бордюры, padding, margin
- [x] `src/stages/recognize.js` — стадия `recognize`: тексты и шрифты
- [x] `src/roles/measurer.js`, `src/roles/recognizer.js` — промпты ролей

### step-c15 — Цвета и сборка
- [x] `src/stages/sample.js` — стадия `sample`: два режима (`local` — харнесс читает пиксели,
      модель только называет; `ai` — модель сэмплирует сама), файл `stages/palette.json`
- [x] `src/stages/resolve.js` — стадия `resolve`: `buildSheet`, `buildPalette`, `buildTokens`,
      `buildDesignMd`, `buildReport`; legacy-форма `measurements.json` сохранена
- [x] `src/model/profiles.js` — `capEffort(stageEffort, ceiling)`: нижний из двух уровней
- [x] `src/stages/index.js` — реестр стадий

### step-c16 — Стадии запускаются по одной
- [x] `src/cli.js` — `--stages` выбирает стадии; картинка нужна только стадиям, которые её
      читают; ключ — только стадиям, которые спрашивают модель
- [x] `src/shared/pipeline.js` — явно названная стадия выполняется всегда, даже при
      `agent.design: off`; `stages.<id>.enabled: false` — жёсткий выключатель
- [x] `src/roles/index.js` — `resolveRole(config, role, {effort, ceiling})`: приоритет
      `roles.<role>.effort` > усилие стадии > `reasoning.effort`; потолки роли и прогона понижают
- [x] `src/config/defaults.js` — у каждой стадии своё `effort`; `src/config/validate.js` —
      проверка значения
- [x] `src/stages/index.js` — каждая стадия называет свой файл в артефактах прогона
- [x] `src/help.js`, README (EN), planned.md (RU) — шесть стадий, артефакты, `--stages`
- [x] Проверка: `npm test` — 181 тест, все проходят

### step-c17 — Падение не остаётся без следа
- [x] `src/cli.js` — `unhandledRejection` и `uncaughtException` печатаются и оставляют код
      возврата ошибки
- [x] `bin/ai-measure.js` — код возврата падения не затирается кодом команды
- [x] Проверка: `npm test` — 181 тест, все проходят

### step-c18 — Gemini 4 Hydrogen вместо kimi, kimi — как fallback
- [x] Повод: карточка модели `google/gemini-4-hydrogen` на RouterAI (ноябрь 2026) — 1M токенов
      контекста, до 1M токенов выхода с продолжением, уровни усилия `low|medium|high|xhigh`.
      Kimi становится моделью-фолбэком
- [x] Живые пробы шлюза (2026-11-15): `POST /v1/responses` с `text.format` (json_schema) → 200 и
      ответ по схеме; с инструментом → 200 и `function_call`; с `reasoning.effort=xhigh` → 200 и
      305 reasoning-токенов; `POST /v1/chat/completions` с `response_format` → 200 и ответ по
      схеме ⇒ Gemini работает и в Responses, и в Chat Completions
- [x] `src/model/profiles.js` — профиль `google/gemini-4-hydrogen`: окно 4 194 304 байта
      (1M токенов), выход 1 048 576, потолок `xhigh`, лестница `low|medium|high|xhigh`;
      профиль kimi приведён к реальному (потолок `medium`, лестница `none|low|medium` — под
      скорость ответа); окно и выход minimax исправлены по карточке (4 MiB и 524K)
- [x] `src/config/defaults.js` — модель по умолчанию `google/gemini-4-hydrogen`; цепочка
      фолбэков: у Gemini первым идёт kimi, у прочих моделей kimi — первый в общей цепочке
- [x] `test/profiles.test.js` — профили и срез усилия; `test/fallback.test.js` — цепочка дома;
      `test/roles.test.js` — потолки роли и прогона на Gemini, отдельная проверка kimi;
      `test/config.test.js` — модель по умолчанию
- [x] README (EN): стартовый файл, таблица моделей, цепочка фолбэков
- [x] Проверка: `npm test` — 207 тестов, все проходят

### step-c19 — Стадии, которые не доверяют Gemini
- [x] Повод: две стадии режут картинку на части — `segmentate` (зоны референса) и `crop` в
      режиме `ai` (фрагменты, которые стоит вырезать). Им нужен острый глаз и быстрый ответ, а
      не долгое размышление, поэтому Gemini 4 Hydrogen им не доверяют: стадии уходят на
      `moonshotai/kimi-k3.1-pro` с reasoning `medium`
- [x] `src/model/trust.js` — таблица доверия: модель → роли, которым ей не доверяют
      (`google/gemini-4-hydrogen` → `segmentator`, `cropper`); безопасная модель дома
      `moonshotai/kimi-k3.1-pro`, безопасное усилие `medium`; `isTrusted(role, model)`
- [x] `src/roles/index.js` — `resolveRole()`: роль уходит на безопасную модель, когда модель
      прогона ей не доверена; усилие такой роли — `medium` (уровни выше у kimi стоят тех же
      секунд). Пин роли в конфиге (`roles.<role>.model`) не двигается никогда; потолок прогона
      по-прежнему понижает усилие
- [x] `test/trust.test.js` — таблица доверия, переход двух стадий на kimi с `medium`, остальные
      роли остаются на Gemini, другая модель не двигается, пин роли и её усилия уважаются,
      потолок прогона понижает усилие и на перенесённой стадии
- [x] README (EN): раздел «The stages that do not trust the Gemini», сноска в разделе о деньгах
- [x] Проверка: `npm test` — 215 тестов, все проходят

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
