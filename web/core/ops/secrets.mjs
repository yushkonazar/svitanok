// Code-derived inventory, never provider expiry. Actual per-location dates
// live in credential_metadata; old rotation facts are reference-only.
/** @typedef {{name:string,where:string,recommendedRotationDays:number|null,note?:string}} SecretDef */
export const ROTATED_KEY_PREFIX = 'secret_rotated_';
/** Recommendations do not enable reminders; the owner must select a policy.
 * @type {SecretDef[]} */
export const SECRETS = [
  {
    name: 'OPENAI_BILLING_ADMIN_KEY',
    where: 'CF',
    recommendedRotationDays: null,
    note: 'опційне ручне читання білінгу; окремий доступ',
  },
  {
    name: 'DEEPGRAM_BILLING_API_KEY',
    where: 'CF',
    recommendedRotationDays: null,
    note: 'опційне ручне читання білінгу; окремий доступ',
  },
  {
    name: 'TELEGRAM_BOT_TOKEN',
    where: 'CF',
    recommendedRotationDays: null,
    note: 'за подією (BotFather)',
  },
  { name: 'TELEGRAM_WEBHOOK_SECRET', where: 'CF', recommendedRotationDays: 365 },
  { name: 'GOOGLE_CLIENT_SECRET', where: 'CF', recommendedRotationDays: 365 },
  {
    name: 'GOOGLE_REFRESH_TOKEN',
    where: 'CF',
    recommendedRotationDays: null,
    note: 'може втратити чинність; дату завершення не вгадуємо',
  },
  { name: 'MAPS_API_KEY', where: 'CF', recommendedRotationDays: 365 },
  { name: 'WEATHER_API_KEY', where: 'CF + GitHub Secrets', recommendedRotationDays: null },
  {
    name: 'NEWSDATA_API_KEY',
    where: 'GitHub Secrets',
    recommendedRotationDays: null,
    note: 'legacy; новини використовують RSS',
  },
  { name: 'GOOGLE_TRANSLATE_API_KEY', where: 'CF + GitHub Secrets', recommendedRotationDays: null },
  { name: 'GEMINI_API_KEY', where: 'CF', recommendedRotationDays: 365 },
  { name: 'DEEPGRAM_API_KEY', where: 'CF', recommendedRotationDays: 365 },
  { name: 'ITAD_API_KEY', where: 'CF', recommendedRotationDays: 365 },
  {
    name: 'MONO_TOKEN',
    where: 'CF',
    recommendedRotationDays: null,
    note: 'за подією (кабінет Mono)',
  },
  { name: 'MONO_WEBHOOK_SECRET', where: 'CF', recommendedRotationDays: 365 },
  { name: 'BRAIN_ACCESS_CLIENT_SECRET', where: 'CF', recommendedRotationDays: 365 },
  { name: 'INTERNAL_HMAC_KEY', where: 'CF + brain/.env', recommendedRotationDays: 365 },
  {
    name: 'INTERNAL_HMAC_KEY_NEXT',
    where: 'CF',
    recommendedRotationDays: null,
    note: 'лише під час переходу ротації',
  },
  { name: 'LLM_HOST_SECRET', where: 'CF', recommendedRotationDays: null, note: 'legacy-хост' },
  {
    name: 'OPENAI_API_KEY',
    where: 'CF + brain.env + GitHub Secrets',
    recommendedRotationDays: 365,
    note: 'окремі ключі CF (публічні новини), VPS і Actions; значення не зберігати в D1/Mini App',
  },
  {
    name: 'BACKUP_ENC_KEY',
    where: 'CF + офлайн-копія',
    recommendedRotationDays: null,
    note: 'не ротується без перешифрування бекапів; втрата = бекапи нечитабельні',
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN',
    where: 'brain/.env + GitHub Secrets',
    recommendedRotationDays: 365,
    note: 'legacy runtime; не видаляти до погодженого cleanup і restore drill',
  },
  { name: 'REPO_READ_PAT', where: 'GitHub Secrets', recommendedRotationDays: 365 },
  { name: 'CF_API_TOKEN', where: 'GitHub Secrets', recommendedRotationDays: 365 },
  {
    name: 'VPS_DEPLOY_KEY',
    where: 'GitHub Secrets',
    recommendedRotationDays: null,
    note: 'за подією',
  },
  { name: 'GH_DISPATCH_TOKEN', where: 'CF', recommendedRotationDays: 365 },
];
