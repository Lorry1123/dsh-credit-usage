window.__ModuleLoader__.load({
  id: '@local/dsh-credit-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ns = 'dsh-credit-usage';
    const providers = [['codex', 'Codex'], ['claude', 'Claude'], ['deepseek', 'DeepSeek']];
    const translations = {
      zh: {
        title: '额度与余额', weekly: '周剩余', balance: '余额', loading: '查询中…',
        'not-installed': '未安装 CLI', 'sign-in': '需登录', setup: '终端需初始化',
        'no-data': '无数据', error: '查询失败', api: 'API 余额', account: '账号余额',
        accountHint: 'DSH 登录账号，含充值与赠金', apiHint: '官方 DeepSeek API Key 所属账号',
        claudeError: 'Claude Code 未能读取 /usage 中的周额度',
        claudeSetup: '请先在 Claude Code 终端完成设置或确认工作目录',
      },
      en: {
        title: 'Credits and limits', weekly: 'Weekly left', balance: 'Balance', loading: 'Checking…',
        'not-installed': 'CLI not installed', 'sign-in': 'Sign in required', setup: 'Set up terminal',
        'no-data': 'No data', error: 'Check failed', api: 'API balance', account: 'Account balance',
        accountHint: 'Signed-in DSH account, including topped-up and bonus balances', apiHint: 'Account of the official DeepSeek API key',
        claudeError: 'Claude Code could not read the weekly limit from /usage',
        claudeSetup: 'Finish setup or confirm the working directory in the Claude Code terminal first',
      },
    };
    const css = `
      /* The footer slot's display: contents anchor exposes its entries as flex items. */
      div:has(> [data-slot="sidebar.footer.action"] > .dsh-credit-usage) {
        flex-wrap: wrap;
      }
      .dsh-credit-usage {
        box-sizing: border-box; flex: 0 0 calc(100% - 16px); min-width: 0; margin: 0 8px 8px;
        border: 1px solid var(--dsw-alias-border-l3); border-radius: 10px;
        color: var(--dsw-alias-label-primary); padding: 8px 10px; font-size: 12px; line-height: 18px;
      }
      .dsh-credit-usage__title { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
      .dsh-credit-usage__list { margin: 0; display: grid; gap: 2px; }
      .dsh-credit-usage__row {
        display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, max-content);
        align-items: baseline; column-gap: 6px;
      }
      .dsh-credit-usage__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-credit-usage__note { margin-inline-start: 5px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
      .dsh-credit-usage__value {
        min-width: 0; max-width: 8em; margin: 0; text-align: end;
        font-variant-numeric: tabular-nums; font-weight: 600;
      }
      .dsh-credit-usage__value, .dsh-credit-usage__inline {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dsh-credit-usage__value[data-inactive] { color: var(--dsw-alias-label-secondary); font-weight: 400; }
      .dsh-credit-usage__inline { display: block; }
    `;

    function formatAmount({ currency, amount }, language) {
      const formatter = new Intl.NumberFormat(language, { style: 'currency', currency });
      if (/^-?0\.0{2}[0-9]*[1-9][0-9]*$/.test(amount)) {
        return `${amount.startsWith('-') ? '>' : '<'}${formatter.format(amount.startsWith('-') ? -0.01 : 0.01)}`;
      }
      return formatter.format(amount);
    }

    function UsageCard({ t }) {
      const [data, setData] = React.useState({});
      React.useEffect(() => {
        const lifetime = new AbortController();
        const inFlight = new Set();
        function refresh() {
          if (document.hidden) return;
          const locale = document.documentElement.lang.toLowerCase().split('-')[0];
          const tz = -new Date().getTimezoneOffset() * 60;
          for (const [provider] of providers) {
            if (inFlight.has(provider)) continue;
            inFlight.add(provider);
            const query = new URLSearchParams({ provider, locale, tz });
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(36_000)]);
            fetch(`api/dsh-credit-usage?${query}`, { signal, cache: 'no-store' })
              .then(response => response.ok ? response.json() : { status: response.status === 401 ? 'sign-in' : 'error' })
              .catch(() => ({ status: 'error' }))
              .then(result => {
                if (!lifetime.signal.aborted) setData(previous => ({ ...previous, [provider]: result }));
              }).finally(() => inFlight.delete(provider));
          }
        }
        refresh();
        const timer = setInterval(refresh, 5 * 60_000);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          lifetime.abort();
          clearInterval(timer);
          document.removeEventListener('visibilitychange', refresh);
        };
      }, []);

      const language = document.documentElement.lang || 'en';
      const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 });
      return h('section', { className: 'dsh-credit-usage', 'aria-label': t('title') },
        h('style', null, css),
        h('h2', { className: 'dsh-credit-usage__title' }, t('title')),
        h('dl', { className: 'dsh-credit-usage__list', 'aria-live': 'polite' }, providers.map(([key, name]) => {
          const result = data[key];
          const isBalance = key === 'deepseek';
          const label = isBalance ? (result?.source ?? 'balance') : 'weekly';
          const note = t(label);
          let ready = false;
          let hint;
          let value;
          if (result?.status === 'ready' && isBalance && Array.isArray(result.amounts)) {
            ready = true;
            hint = t(result.source === 'api' ? 'apiHint' : 'accountHint');
            value = result.amounts.map(money => h('span', {
              key: money.currency, title: `${hint} · ${money.amount} ${money.currency}`, className: 'dsh-credit-usage__inline',
            }, formatAmount(money, language)));
          } else if (result?.status === 'ready' && Number.isFinite(result.remainingPercent)) {
            ready = true;
            value = percent.format(result.remainingPercent / 100);
          } else {
            const status = result?.status;
            value = t(status === undefined ? 'loading' : Object.hasOwn(translations.en, status) && status !== 'ready' ? status : 'error');
            hint = key === 'claude' && status === 'error' ? t('claudeError')
              : key === 'claude' && status === 'setup' ? t('claudeSetup') : undefined;
          }
          return h('div', { key, className: 'dsh-credit-usage__row' },
            h('dt', { className: 'dsh-credit-usage__name', title: `${name} · ${note}` }, name,
              h('span', { className: 'dsh-credit-usage__note' }, note)),
            h('dd', { className: 'dsh-credit-usage__value', 'data-inactive': ready ? undefined : '', title: hint }, value));
        })),
      );
    }

    function Footer({ wide, t }) {
      return wide ? h(UsageCard, { t }) : null;
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(ns, translations), 'Credit usage: dictionary');
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'dsh-credit-usage', order: 5, locale: ns,
        }, Footer));
      },
    };
  },
});
