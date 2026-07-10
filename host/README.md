# svitanok-llm-host

Тонкий HTTP-реле на `claude` CLI — дозволяє Cloudflare Worker'у робити
real-time LLM-виклики **на твоїй Claude Pro/Max підписці**, без платного
`ANTHROPIC_API_KEY`. Worker не може запустити CLI сам (він — V8-ізолят, без
підпроцесів/файлової системи), тому цей маленький always-on сервер — єдиний
міст між вебхуком і підпискою.

Детальніше про архітектурне рішення — у памʼяті проєкту
(`project_roadmap_v2.md`, розділ «LLM-архітектура переглянута»).

---

## Крок 1 — сервер на Hetzner

1. Зареєструйся на [hetzner.com](https://www.hetzner.com/cloud/) (потрібна картка, але
   найдешевший тариф — кілька євро/міс, спишеться лише за фактичне використання).
2. **Create Server**:
   - **Location**: Falkenstein або Nuremberg (Німеччина) — найближче до України.
   - **Image**: Ubuntu 24.04.
   - **Type**: найдешевший (Cost-Optimized / Shared vCPU, 2 vCPU / ~4GB RAM —
     навантаження тут мізерне, кілька spawn'ів `claude -p` на день).
   - **SSH Key**: додай свій публічний ключ (або згенеруй новий локально:
     `ssh-keygen -t ed25519`) — **не вмикай пароль-логін**.
3. Запиши IP-адресу сервера.

## Крок 2 — базовий hardening

```bash
ssh root@<IP>
apt update && apt upgrade -y

# Некореневий юзер під сервіс
adduser svitanok
usermod -aG sudo svitanok

# SSH: лише ключ, без пароля, без root
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd

# Firewall: лише SSH + HTTPS (443 — під Caddy, крок 8). Порт хоста (8787)
# НАЗОВНІ НЕ відкриваємо — Caddy проксі локально на 127.0.0.1.
ufw allow OpenSSH
ufw allow 443/tcp
ufw allow 80/tcp   # тимчасово, для Let's Encrypt HTTP-01 (крок 8)
ufw --force enable

# fail2ban — базовий захист SSH від брутфорсу
apt install -y fail2ban
systemctl enable --now fail2ban
```

Далі підключайся вже як `svitanok` (`ssh svitanok@<IP>`), не root.

## Крок 3 — Node.js + claude CLI

```bash
# Node.js LTS через NodeSource
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # мусить бути >=20

# Claude Code CLI (та сама версія, що й у brief.yml — пін для стабільності)
sudo npm install -g @anthropic-ai/claude-code@2.1.195
claude --version
```

## Крок 4 — активувати підписку

```bash
claude setup-token
```

Пройди OAuth-авторизацію в браузері (посилання виведе термінал). Токен, який
покаже команда, **не зберігається автоматично** — скопіюй його, знадобиться
у кроці 6 (`CLAUDE_CODE_OAUTH_TOKEN`).

Одразу перевір, що CLI сам живий і non-interactive-режим не спіткнеться на
первинному onboarding:

```bash
claude -p "скажи одне слово: ок" --tools ""
```

Має вивести `ок` (чи щось подібне) без жодних діалогів/запитів.

## Крок 5 — розгорнути код

Репо приватне, тож найпростіше — скопіювати саме `host/` зі своєї машини
(жодних git-credentials на сервері заводити не треба; залежностей немає,
`package.json` без `dependencies`, тому й `npm install` не потрібен):

```bash
# На СВОЇЙ машині (не на сервері):
scp -r host/ svitanok@<IP>:/tmp/svitanok-llm-host-src
```

```bash
# На сервері:
sudo mkdir -p /opt/svitanok-llm-host
sudo chown svitanok:svitanok /opt/svitanok-llm-host
cp -r /tmp/svitanok-llm-host-src/* /opt/svitanok-llm-host/
rm -rf /tmp/svitanok-llm-host-src
cd /opt/svitanok-llm-host
```

## Крок 6 — секрети

```bash
cp .env.example .env
```

Заповни `.env`:

- `LLM_HOST_SECRET` — згенеруй: `openssl rand -hex 32` (той самий спосіб, що
  й `TELEGRAM_WEBHOOK_SECRET` у головному проєкті). Це пароль між Worker'ом і
  хостом — **збережи копію**, знадобиться при налаштуванні Worker-секретів.
- `CLAUDE_CODE_OAUTH_TOKEN` — з кроку 4.

```bash
chmod 600 .env   # лише власник читає (є секрети)
```

## Крок 7 — systemd

```bash
sudo cp svitanok-llm-host.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now svitanok-llm-host

# Перевірка
sudo systemctl status svitanok-llm-host
sudo journalctl -u svitanok-llm-host -f   # живі логи
```

Локальний smoke-тест (з самого сервера, ще без TLS):

```bash
curl -s -X POST http://127.0.0.1:8787/llm \
  -H "content-type: application/json" \
  -H "x-llm-host-secret: <значення LLM_HOST_SECRET>" \
  -d '{"prompt":"скажи одне слово: ок"}'
```

Очікуй `{"ok":true,"result":"ок", ...}`.

## Крок 8 — HTTPS (Caddy) — ОБОВ'ЯЗКОВО перед підключенням до Worker'а

⚠️ **Без цього кроку `LLM_HOST_SECRET` летить відкритим текстом через
інтернет** — будь-хто між Cloudflare і твоїм сервером його побачить. Не
пропускай.

Потрібен домен (навіть найдешевший, ~$1-10/рік) або безкоштовний варіант
(наприклад [DuckDNS](https://www.duckdns.org/)), що вказує A-записом на IP
сервера. Якщо в тебе вже є домен у Cloudflare — додай туди піддомен, напр.
`llm.твійдомен.com`, DNS-запис A → IP сервера (proxy status: **DNS only**,
не proxied — Caddy сам зробить TLS напряму).

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
llm.твійдомен.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

Caddy сам отримає й оновлюватиме Let's Encrypt сертифікат. Порт 80 (крок 2)
потрібен саме для цього — після першого випуску сертифіката можна лишити
відкритим (Caddy оновлює автоматично, потребує 80 періодично).

Тест ззовні (зі свого ПК):

```bash
curl -s -X POST https://llm.твійдомен.com/llm \
  -H "content-type: application/json" \
  -H "x-llm-host-secret: <значення LLM_HOST_SECRET>" \
  -d '{"prompt":"скажи одне слово: ок"}'
```

## Крок 9 — передати мені для підключення Worker'а

Дай два значення:

- `LLM_HOST_URL` = `https://llm.твійдомен.com/llm`
- `LLM_HOST_SECRET` = те саме значення з `.env`

Додаси їх як секрети Worker'а (`wrangler secret put`, той самий спосіб, що
`TELEGRAM_WEBHOOK_SECRET`) — я вкажу точні команди, коли підключатиму Worker.

---

## Оновлення коду хоста

```bash
# На своїй машині:
scp host/server.mjs host/llm-host-core.mjs svitanok@<IP>:/opt/svitanok-llm-host/
```

```bash
# На сервері (.env і .service НЕ чіпаємо):
sudo systemctl restart svitanok-llm-host
```

## Діагностика

- `sudo journalctl -u svitanok-llm-host -n 100` — останні логи (кожен запит
  логується з часом/статусом/вартістю; вміст prompt лише перші 200 символів).
- `sudo systemctl status svitanok-llm-host` — чи живий процес, чи не в
  restart-циклі (якщо падає одразу — найчастіше `LLM_HOST_SECRET` не задано
  або `claude` не резолвиться на PATH systemd-юзера — перевір `CLAUDE_BIN` у
  `.env`, встанови абсолютний шлях: `which claude` під юзером `svitanok`).
- Автономний тест CLI без сервера: `claude -p "тест" --tools ""` — якщо це
  саме по собі не працює (наприклад, токен протух), сервер теж не запрацює.
