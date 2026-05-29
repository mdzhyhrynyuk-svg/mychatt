# ERMI

ERMI - минимальная, но оформленная платформа для случайных видеозвонков:
главная страница, переход в интерфейс звонка, WebRTC, Socket.IO signaling, Next,
report, текстовый чат и подбор по темам.

## Локальный запуск

```bash
npm install
npm start
```

Открыть:

```txt
http://localhost:3000
```

## Деплой сервера на Render

Если сервис Render уже создан и работает, после обновления GitHub нажми:

```txt
Manual Deploy -> Deploy latest commit
```

Если создаешь заново:

1. В Render создай `New Web Service`.
2. Выбери GitHub репозиторий с этими файлами.
3. Настройки:
   - Name: `army-chat-server`
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: `Free`
4. После деплоя адрес должен быть:

```txt
https://army-chat-server.onrender.com
```

Если Render даст другой адрес, поменяй его в `public/config.js`.

## Деплой сайта на Netlify

1. В Netlify открой сайт, подключенный к этому GitHub репозиторию.
2. Настройки:
   - Build command: оставить пустым
   - Publish directory: `public`
3. После обновления GitHub нажми `Trigger deploy`.

Пользователь открывает Netlify-ссылку, нажимает `Начать разговор` или
`Подключиться`, разрешает камеру и попадает в очередь ERMI.
