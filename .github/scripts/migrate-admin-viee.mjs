const required = [
  'CF_TOKEN',
  'CF_ACCOUNT_ID',
  'D1_DATABASE_ID',
  'EXPECTED_ADMIN',
];

for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

if (process.env.GITHUB_REPOSITORY !== 'viellenz/cloud-mail') {
  throw new Error('Refusing to run outside viellenz/cloud-mail');
}

if (process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Refusing to run outside the main branch');
}

const accountId = process.env.CF_ACCOUNT_ID;
const databaseId = process.env.D1_DATABASE_ID;
const token = process.env.CF_TOKEN;
const apply = process.env.APPLY === 'true';

const OLD_EMAIL = 'admin@ipx-811.me';
const NEW_EMAIL = 'admin@viee.me';
const OLD_HOST = 'mail.ipx-811.me';
const NEW_HOST = 'mail.viee.me';

if (process.env.EXPECTED_ADMIN.toLowerCase() !== OLD_EMAIL) {
  throw new Error('GitHub ADMIN Secret no longer matches the expected old administrator');
}

if (!/^[0-9a-f-]{36}$/i.test(databaseId)) {
  throw new Error('D1_DATABASE_ID is not a UUID');
}

async function cloudflare(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`Cloudflare API request failed: ${response.status} ${JSON.stringify(body.errors || [])}`);
  }
  return body.result;
}

async function d1(body) {
  const result = await cloudflare(
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (!Array.isArray(result) || result.some((item) => item.success !== true)) {
    throw new Error('D1 returned an unsuccessful query result');
  }
  return result;
}

async function rows(sql, params = []) {
  const result = await d1({ sql, params });
  return result.flatMap((item) => item.results || []);
}

const workerSettings = await cloudflare(`/accounts/${accountId}/workers/scripts/cloud-mail/settings`);
const adminBinding = (workerSettings.bindings || []).find((binding) => binding.name === 'admin');
if (!adminBinding || String(adminBinding.text).toLowerCase() !== OLD_EMAIL) {
  throw new Error('Live Worker admin binding does not match the expected old administrator');
}

const [users, accounts, settingRows, indexes] = await Promise.all([
  rows(
    'SELECT user_id,email,type,status,is_del FROM user WHERE lower(email) IN (lower(?),lower(?)) ORDER BY user_id',
    [OLD_EMAIL, NEW_EMAIL],
  ),
  rows(
    'SELECT account_id,email,user_id,status,is_del,name FROM account WHERE lower(email) IN (lower(?),lower(?)) ORDER BY account_id',
    [OLD_EMAIL, NEW_EMAIL],
  ),
  rows('SELECT custom_domain FROM setting LIMIT 2'),
  rows(
    "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_user_email_nocase','idx_account_email_nocase') ORDER BY name",
  ),
]);

const oldUsers = users.filter((row) => row.email.toLowerCase() === OLD_EMAIL);
const newUsers = users.filter((row) => row.email.toLowerCase() === NEW_EMAIL);
const oldAccounts = accounts.filter((row) => row.email.toLowerCase() === OLD_EMAIL);
const newAccounts = accounts.filter((row) => row.email.toLowerCase() === NEW_EMAIL);

if (oldUsers.length !== 1 || oldAccounts.length !== 1) {
  throw new Error('Expected exactly one old administrator user and one old primary account');
}
if (newUsers.length !== 0 || newAccounts.length !== 0) {
  throw new Error('Target administrator email is already occupied');
}

const oldUser = oldUsers[0];
const oldAccount = oldAccounts[0];
if (oldUser.is_del !== 0 || oldUser.status !== 0 || oldAccount.is_del !== 0) {
  throw new Error('Old administrator user or account is not active');
}
if (oldAccount.user_id !== oldUser.user_id) {
  throw new Error('Old administrator user/account ownership mismatch');
}
if (settingRows.length !== 1) {
  throw new Error('Expected exactly one settings row');
}
if (indexes.length !== 2) {
  throw new Error('Required case-insensitive unique indexes are missing');
}

const beforeCounts = await rows(
  'SELECT COUNT(*) AS total, SUM(CASE WHEN account_id=? THEN 1 ELSE 0 END) AS primary_total FROM email WHERE user_id=?',
  [String(oldAccount.account_id), String(oldUser.user_id)],
);
const originalCustomDomain = settingRows[0].custom_domain || '';
const updateCustomDomain = originalCustomDomain === '' || originalCustomDomain === OLD_HOST;

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'preflight',
  oldUserId: oldUser.user_id,
  oldAccountId: oldAccount.account_id,
  targetOccupied: false,
  emailCount: beforeCounts[0]?.total ?? 0,
  primaryAccountEmailCount: beforeCounts[0]?.primary_total ?? 0,
  currentCustomDomain: originalCustomDomain || '(empty)',
  willUpdateCustomDomain: updateCustomDomain,
}, null, 2));

if (!apply) {
  console.log('Preflight passed; no data was changed.');
  process.exit(0);
}

const batch = [
  {
    sql: 'UPDATE account SET email=?, name=? WHERE account_id=? AND user_id=? AND lower(email)=lower(?)',
    params: [NEW_EMAIL, 'admin', String(oldAccount.account_id), String(oldUser.user_id), OLD_EMAIL],
  },
  {
    sql: 'UPDATE user SET email=? WHERE user_id=? AND lower(email)=lower(?)',
    params: [NEW_EMAIL, String(oldUser.user_id), OLD_EMAIL],
  },
];

if (updateCustomDomain) {
  batch.push({
    sql: 'UPDATE setting SET custom_domain=? WHERE custom_domain=?',
    params: [NEW_HOST, originalCustomDomain],
  });
}

const writeResults = await d1({ batch });
if (writeResults[0].meta?.changes !== 1 || writeResults[1].meta?.changes !== 1) {
  throw new Error('Administrator update did not change exactly one user and one account');
}
if (updateCustomDomain && writeResults[2].meta?.changes !== 1) {
  throw new Error('Custom-domain update did not change exactly one settings row');
}

const [verifyUsers, verifyAccounts, verifySetting, afterCounts] = await Promise.all([
  rows(
    'SELECT user_id,email,type,status,is_del FROM user WHERE lower(email) IN (lower(?),lower(?)) ORDER BY user_id',
    [OLD_EMAIL, NEW_EMAIL],
  ),
  rows(
    'SELECT account_id,email,user_id,status,is_del,name FROM account WHERE lower(email) IN (lower(?),lower(?)) ORDER BY account_id',
    [OLD_EMAIL, NEW_EMAIL],
  ),
  rows('SELECT custom_domain FROM setting LIMIT 2'),
  rows(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN account_id=? THEN 1 ELSE 0 END) AS primary_total FROM email WHERE user_id=?',
    [String(oldAccount.account_id), String(oldUser.user_id)],
  ),
]);

if (
  verifyUsers.length !== 1 ||
  verifyUsers[0].email.toLowerCase() !== NEW_EMAIL ||
  verifyUsers[0].user_id !== oldUser.user_id ||
  verifyAccounts.length !== 1 ||
  verifyAccounts[0].email.toLowerCase() !== NEW_EMAIL ||
  verifyAccounts[0].account_id !== oldAccount.account_id ||
  verifyAccounts[0].user_id !== oldUser.user_id
) {
  throw new Error('Post-migration identity verification failed');
}

if (
  afterCounts[0]?.total !== beforeCounts[0]?.total ||
  afterCounts[0]?.primary_total !== beforeCounts[0]?.primary_total
) {
  throw new Error('Historical email counts changed unexpectedly');
}

if (updateCustomDomain && verifySetting[0]?.custom_domain !== NEW_HOST) {
  throw new Error('Post-migration custom domain verification failed');
}

console.log(JSON.stringify({
  migration: 'success',
  userIdPreserved: true,
  accountIdPreserved: true,
  historicalEmailCountsPreserved: true,
  customDomain: verifySetting[0]?.custom_domain || '(empty)',
}, null, 2));
