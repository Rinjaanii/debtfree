# Развёртывание DebtFree на своём VPS

Классическая схема без туннелей: сервис работает на VPS, nginx или Caddy отдаёт его
по HTTPS, Telegram открывает мини-аппу по настоящему домену. Бот при этом опрашивает
Telegram сам (длинные запросы) — вебхук и публичный адрес ему не нужны.

Проверенные условия: Ubuntu/Debian, домен, A-запись которого уже ведёт на IP вашего VPS.

---

## 1. Домен → VPS

В панели DNS пропишите запись (если ещё нет):

```
A  debtfree  →  IP-адрес-VPS
```

Проверка: `dig +short debtfree.example.com` должен показать IP.

## 2. Node.js на VPS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # должно быть v20 или v22
```

## 3. Выложить проект

Любым удобным способом — git, scp, rsync. Пример:

```bash
# с вашего компьютера (если проект в git):
ssh user@vps 'mkdir -p /opt/debtfree'
scp -r debtfree/src debtfree/public debtfree/templates debtfree/tools debtfree/package.json debtfree/.gitignore user@vps:/opt/debtfree/
```

Важно: **`.env` пересылать не обязательно** — его заполним прямо на VPS (см. шаг 4).

## 4. Настройки на VPS

```bash
cd /opt/debtfree
cp .env.example .env
nano .env
```

Минимум для боевого режима:

```ini
TELEGRAM_BOT_TOKEN=123456:AA...          # токен от @BotFather (/newbot)
TELEGRAM_BOT_USERNAME=my_debtfree_bot    # имя бота без @
PUBLIC_URL=https://debtfree.example.com  # ваш домен — сюда Telegram и вернёт при входе
PORT=8080
```

## 5. Запустить как службу

```bash
# отдельный пользователь без прав root
sudo useradd --system --create-home debtfree
sudo chown -R debtfree:debtfree /opt/debtfree

sudo cp /opt/debtfree/systemd/debtfree.service /etc/systemd/system/debtfree.service
sudo systemctl daemon-reload
sudo systemctl enable --now debtfree
sudo systemctl status debtfree
```

Проверить локально на VPS:

```bash
curl -s http://127.0.0.1:8080/api/health
# → {"ok":true,"mode":"telegram",...}
```

Если `mode:"dev"` — сервер не увидел токен: проверьте `.env` (он должен лежать в
`/opt/debtfree/.env`) и права на файл.

## 6. HTTPS-прокси

### Вариант A — Caddy (проще всего, сертификат сам)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Положите `deploy/Caddyfile` в `/etc/caddy/Caddyfile` (поправив домен) и:

```bash
sudo systemctl reload caddy
```

### Вариант B — nginx + certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp /opt/debtfree/deploy/nginx.conf /etc/nginx/sites-available/debtfree
sudo ln -s /etc/nginx/sites-available/debtfree /etc/nginx/sites-enabled/
sudo nginx -t
sudo certbot --nginx -d debtfree.example.com   # выдаст и пропишет сертификат
sudo systemctl reload nginx
```

## 7. Указать адрес боту

Один раз:

```bash
cd /opt/debtfree
node tools/setup-bot.js https://debtfree.example.com
```

Скрипт снимет вебхук, поставит кнопку меню и обновит описание. Альтернатива — руками
в @BotFather: `/setmenubutton` → выберите бота → вставьте `https://debtfree.example.com`.

Для кнопки «Запустить» в профиле бота и прямой ссылки `t.me/<бот>/app` в @BotFather
выполните `/newapp`, выберите бота, задайте имя и URL `https://debtfree.example.com`.

## 8. Проверка

1. Откройте бота в Telegram → кнопка меню слева внизу → должно открыться приложение.
2. В браузере откройте `https://debtfree.example.com/web-login` — вход по коду.
3. Если что-то не так, смотрите логи:

```bash
journalctl -u debtfree -f
```

## Обновление

Выложили новые файлы — перезапустите службу (страницы пересоберутся сами, если исходники новее):

```bash
sudo systemctl restart debtfree
```

## Резервные копии

Все данные — в одном файле `/opt/debtfree/data/store.json`. Копируйте его регулярно,
например cron раз в сутки:

```cron
20 3 * * * cp /opt/debtfree/data/store.json /backup/debtfree-$(date +\%F).json
```

## Снять с обслуживания

```bash
sudo systemctl disable --now debtfree
node tools/setup-bot.js --clear   # убрать кнопку меню из бота
```
