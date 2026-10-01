# GEGI Proofreader — Tampermonkey

Неинвазивный мост для редактора статей Freshdesk.

## Что делает

Скрипт активируется только на страницах редактирования статей Freshdesk:

`https://*.freshdesk.com/a/solutions/articles/<article-id>/edit`

Он добавляет только:

- кнопку **В GEGI Proofreader**;
- кнопки **Предыдущая / Следующая**;
- левый gutter с кружками ошибок;
- синхронизацию активной ошибки и прокрутки с локальным GEGI AI Proofreader.

## Строгая гарантия неинвазивности

Скрипт **никогда не изменяет содержимое редактора Freshdesk**.

В коде моста отсутствуют операции записи в редактор: нет присваиваний `innerHTML`, `textContent`, `innerText`, `value`, `insertAdjacentHTML`, `appendChild`, `removeChild`, `replaceChildren`, `execCommand`, `Range.insertNode()` или `Range.deleteContents()` над редактором.

Из редактора только читаются:

- `innerHTML` для передачи копии статьи в Proofreader;
- текст для расчёта позиций;
- геометрия и `Range` для определения положения ошибок.

`Range` используется только как объект для измерения координат. Прокрутка изменяет только положение прокрутки, а не содержимое.

Исправление текста существует только как функция самого GEGI AI Proofreader. Tampermonkey не получает и не выполняет команды на замену текста Freshdesk.

## Установка

1. Установите расширение Tampermonkey для Firefox.
2. Откройте Raw-файл скрипта:

`https://raw.githubusercontent.com/zvukoper/tpm_gpf_script/main/gegi-proofread.user.js`

3. Tampermonkey предложит установить скрипт. Нажмите **Install**.
4. Запустите локальный GEGI AI Proofreader на `http://127.0.0.1:37891/`.
5. Откройте статью Freshdesk именно в режиме редактирования `/a/solutions/articles/<id>/edit`.
6. Рядом с `Cancel / Save` появятся кнопки моста.

`@updateURL` и `@downloadURL` уже указывают на этот public repository, поэтому Tampermonkey сможет получать новые версии без ручного копирования.

## Важно

На страницах просмотра, списка статей и других разделах Freshdesk скрипт ничего не добавляет.

Он использует localhost-сервер только для передачи **копии** текста/HTML в Proofreader и обмена позициями ошибок.

Сам редактор Freshdesk изменяется только штатными действиями пользователя.