const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const CURRENCIES = ['CNY', 'USD'];
const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d{1,3}))?$/i;

function decimal(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = DECIMAL.exec(value);
  if (!match || !(match[2] || match[3])) return null;
  const digits = match[2] + (match[3] ?? '');
  if (digits.length > 48) return null;
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (Math.abs(scale) > 64) return null;
  const coefficient = BigInt((match[1] === '-' ? '-' : '') + digits);
  return { n: coefficient * 10n ** BigInt(Math.max(-scale, 0)), scale: Math.max(scale, 0) };
}

function toDecimalString(n, scale) {
  const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  const magnitude = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return (n < 0n ? '-' : '') + magnitude;
}

export function parseBalances(wallets, amountField) {
  if (!Array.isArray(wallets)) return null;
  const totals = new Map();
  for (const wallet of wallets) {
    if (!CURRENCIES.includes(wallet?.currency)) return null;
    const value = decimal(wallet[amountField]);
    if (!value) return null;
    const previous = totals.get(wallet.currency);
    const scale = Math.max(previous?.scale ?? 0, value.scale);
    const n = value.n * 10n ** BigInt(scale - value.scale)
      + (previous ? previous.n * 10n ** BigInt(scale - previous.scale) : 0n);
    totals.set(wallet.currency, { n, scale });
  }
  return CURRENCIES.flatMap(currency => {
    const total = totals.get(currency);
    return total ? [{ currency, amount: toDecimalString(total.n, total.scale) }] : [];
  });
}

export async function readDeepSeek(account, credentials, client, signal, doFetch = fetch) {
  const state = await account?.getState();
  signal.throwIfAborted();
  if (state?.status === 'credential-stored') {
    const balance = await account.getBalance(client);
    if (balance === null) return { status: 'sign-in' };
    if (balance.status !== 'ready' || !Array.isArray(balance.value) || !Array.isArray(balance.bonusWallets)) {
      return { status: 'error' };
    }
    const amounts = parseBalances([...balance.value, ...balance.bonusWallets], 'balance');
    return amounts?.length ? { status: 'ready', source: 'account', amounts }
      : { status: amounts ? 'no-data' : 'error' };
  }

  const key = credentials ? (await credentials.resolve('DEEPSEEK_API_KEY'))?.value : process.env.DEEPSEEK_API_KEY;
  if (!key) return { status: 'sign-in' };
  signal.throwIfAborted();
  const response = await doFetch(BALANCE_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error',
    signal,
  });
  if (!response.ok) return { status: response.status === 401 ? 'sign-in' : 'error' };
  const body = await response.json();
  const amounts = parseBalances(body?.balance_infos, 'total_balance');
  return amounts?.length ? { status: 'ready', source: 'api', amounts }
    : { status: amounts ? 'no-data' : 'error' };
}
