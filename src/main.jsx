import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowDownRight, ArrowUpRight, Bell, CalendarDays, Check,
  ChevronDown, ChevronRight, CircleAlert, Coffee, FileSpreadsheet, Home,
  LayoutDashboard, LockKeyhole, LogOut, MoreHorizontal, PieChart, Plus,
  ReceiptText, RefreshCw, Search, Settings, ShieldCheck, Trash2, UploadCloud,
  Users, WalletCards, X
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie as ChartPie,
  PieChart as RePieChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import logoUrl from '../favicon.svg';
import './styles.css';

const navigation = [
  { key: 'dashboard', label: '대시보드', icon: LayoutDashboard },
  { key: 'transactions', label: '거래 내역', icon: ReceiptText },
  { key: 'analysis', label: '지출 분석', icon: PieChart },
  { key: 'households', label: '가계 관리', icon: Users },
  { key: 'import', label: '가져오기', icon: UploadCloud },
  { key: 'notifications', label: '알림', icon: Bell },
  { key: 'settings', label: '설정', icon: Settings },
];

const chartColors = ['#ff9b7b', '#ffc96b', '#72a7ff', '#78cfa9', '#b39ddb', '#e58db0', '#8db7a5'];

async function api(path, { method = 'GET', body, csrfToken, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (body && !(body instanceof FormData)) requestHeaders['Content-Type'] = 'application/json';
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) requestHeaders['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, {
    method,
    headers: requestHeaders,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (response.status === 204) return null;
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`앱 서버가 API 대신 웹 페이지를 반환했습니다 (${response.status}). start-internal.bat으로 실행했다면 http://localhost:4173을 열고, 개발 모드는 npm run dev로 실행하세요.`);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `요청에 실패했습니다 (${response.status}).`);
  return result;
}

function formatMoney(value) {
  return `₩${Math.abs(Number(value) || 0).toLocaleString('ko-KR')}`;
}

function formatAmount(value) {
  const amount = Number(value) || 0;
  return `${amount < 0 ? '-' : ''}${formatMoney(amount)}`;
}

function localDateTime() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function dateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function compareLabel(current, previous, lowerIsBetter = false) {
  if (!previous) return { text: '비교 데이터 없음', positive: null };
  const change = current - previous;
  const percentage = Math.round(Math.abs(change / previous) * 100);
  const increased = change > 0;
  return {
    text: `${increased ? '+' : change < 0 ? '-' : ''}${percentage}% 지난달 대비`,
    positive: change === 0 ? null : lowerIsBetter ? !increased : increased
  };
}

function App() {
  const [auth, setAuth] = useState(null);
  const [csrfToken, setCsrfToken] = useState(null);
  const [booting, setBooting] = useState(true);
  const [serverError, setServerError] = useState('');
  const [active, setActive] = useState('dashboard');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [dashboard, setDashboard] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [household, setHousehold] = useState(null);
  const [totalTransactions, setTotalTransactions] = useState(0);
  const [categories, setCategories] = useState([]);
  const [imports, setImports] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [kakaoStatus, setKakaoStatus] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterAccount, setFilterAccount] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authUsername, setAuthUsername] = useState('owner');
  const [authMode, setAuthMode] = useState('login');
  const [invitationToken, setInvitationToken] = useState(
    () => new URLSearchParams(window.location.search).get('invite') || ''
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('kakao');
    if (!result) return;
    const messages = {
      linked: '카카오 계정을 연결했습니다.',
      login: '카카오 계정으로 로그인했습니다.',
      'not-linked': '연결된 카카오 계정을 찾을 수 없습니다. 기존 비밀번호로 로그인한 뒤 설정에서 계정을 연결하세요.',
      'not-configured': '카카오 로그인이 설정되지 않았습니다. 서버 환경 변수를 확인해 주세요.',
      'setup-required': '먼저 이 컴퓨터에서 개인 계정을 만들어 주세요.',
      'invalid-state': '카카오 인증 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.',
      'session-expired': '연결 중 세션이 만료되었습니다. 다시 로그인한 뒤 연결해 주세요.',
      'already-linked': '이 카카오 계정은 다른 빙크샐러드 계정에 이미 연결되어 있습니다.',
      cancelled: '카카오 인증을 취소했습니다.',
      failed: '카카오 인증에 실패했습니다. 앱 설정과 리다이렉트 URI를 확인해 주세요.'
    };
    const message = messages[result];
    if (message) {
      if (result === 'linked' || result === 'login') setNotice(message);
      else setError(message);
    }
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  }, []);

  useEffect(() => {
    let activeEffect = true;
    api('/api/auth/session')
      .then(result => {
        if (activeEffect) {
          setAuth(result);
          setCsrfToken(result.csrfToken);
        }
      })
      .catch(() => {
        if (activeEffect) setServerError('앱 API에 연결할 수 없습니다. start-internal.bat을 실행했다면 http://localhost:4173을 열고, 개발 모드는 npm run dev로 실행하세요.');
      })
      .finally(() => activeEffect && setBooting(false));
    return () => { activeEffect = false; };
  }, []);

  useEffect(() => {
    if (!auth?.authenticated) return undefined;
    let activeEffect = true;
    const query = new URLSearchParams({ month, limit: '100' });
    if (active === 'transactions') {
      if (search.trim()) query.set('search', search.trim());
      if (filterType) query.set('type', filterType);
      if (filterCategory) query.set('categoryId', filterCategory);
      if (filterAccount) query.set('accountId', filterAccount);
    }

    Promise.all([
      api(`/api/dashboard?month=${encodeURIComponent(month)}`),
      api(`/api/transactions?${query}`),
      api('/api/categories'),
      api('/api/accounts'),
      api('/api/household'),
      api('/api/imports'),
      api('/api/notifications'),
      api('/api/credentials'),
      api('/api/auth/kakao/status')
    ]).then(([nextDashboard, transactionResult, nextCategories, nextAccounts, nextHousehold, nextImports, nextNotifications, credential, nextKakaoStatus]) => {
      if (!activeEffect) return;
      setDashboard(nextDashboard);
      setTransactions(transactionResult.transactions);
      setTotalTransactions(transactionResult.total);
      setCategories(nextCategories);
      setAccounts(nextAccounts);
      setHousehold(nextHousehold);
      setImports(nextImports);
      setNotifications(nextNotifications);
      setCredentialSaved(credential.saved);
      setKakaoStatus(nextKakaoStatus);
      setError('');
    }).catch(loadError => {
      if (!activeEffect) return;
      if (loadError.message === '로그인이 필요합니다.') {
        setAuth(current => current ? { ...current, authenticated: false } : current);
        setCsrfToken(null);
      } else {
        setError(loadError.message);
      }
    });
    return () => { activeEffect = false; };
  }, [auth?.authenticated, month, active, search, filterType, filterCategory, filterAccount, refresh]);

  async function submitAuthentication(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const registering = authMode === 'register' && !invitationToken;
      const path = invitationToken
        ? '/api/invitations/register'
        : registering
          ? '/api/auth/register'
          : auth?.initialized ? '/api/auth/login' : '/api/auth/setup';
      const body = invitationToken
        ? { token: invitationToken, username: authUsername, password: authPassword }
        : registering || auth?.initialized
          ? { username: authUsername, password: authPassword }
          : { password: authPassword };
      const result = await api(path, { method: 'POST', body });
      setCsrfToken(result.csrfToken);
      setAuth({ initialized: true, authenticated: true, csrfToken: result.csrfToken, user: result.user });
      setAuthPassword('');
      setAuthUsername(result.user.username || authUsername);
      if (invitationToken) {
        setInvitationToken('');
        const url = new URL(window.location.href);
        url.searchParams.delete('invite');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
      setNotice(invitationToken
        ? '초대된 공용 가계부에 가입했습니다.'
        : registering ? '회원가입했습니다. 개인 가계부를 시작합니다.'
          : auth?.initialized ? '로그인했습니다.' : '개인 가계부를 만들었습니다.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST', csrfToken });
      setAuth(current => ({ ...current, authenticated: false }));
      setCsrfToken(null);
      setDashboard(null);
      setNotice('로그아웃했습니다.');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function markNotificationRead(id) {
    try {
      await api(`/api/notifications/${id}/read`, { method: 'PATCH', csrfToken });
      setRefresh(value => value + 1);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  if (booting) return <div className="app-state">빙크샐러드를 불러오는 중…</div>;
  if (serverError) return <div className="app-state error-state"><CircleAlert/><strong>서버에 연결할 수 없습니다</strong><span>{serverError}</span></div>;
  if (!auth?.authenticated) {
    return (
      <AuthScreen
        setup={!auth?.initialized}
        password={authPassword}
        setPassword={setAuthPassword}
        username={authUsername}
        setUsername={setAuthUsername}
        invitationToken={invitationToken}
        registering={authMode === 'register'}
        onAuthModeChange={mode => {
          setAuthMode(mode);
          setAuthUsername(mode === 'register' ? '' : 'owner');
          setAuthPassword('');
          setError('');
        }}
        onSubmit={submitAuthentication}
        busy={busy}
        error={error}
        kakaoConfigured={auth?.kakaoConfigured}
      />
    );
  }

  const unreadCount = notifications.filter(notification => !notification.isRead).length;
  const refreshData = () => setRefresh(value => value + 1);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={logoUrl} alt=""/>
          <span>빙크샐러드</span>
        </div>
        <nav>
          {navigation.map(item => (
            <button key={item.key} className={active === item.key ? 'nav-item active' : 'nav-item'} onClick={() => setActive(item.key)}>
              <item.icon size={18} strokeWidth={1.8}/>
              <span>{item.label}</span>
              {item.key === 'notifications' && unreadCount > 0 && <b className="nav-badge">{unreadCount}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">나</div>
            <div><strong>내 가계부</strong><small>이 기기에 저장</small></div>
            <button className="profile-logout" onClick={logout} aria-label="로그아웃"><LogOut size={16}/></button>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="household-switch">
            <div className="house-icon"><Home size={17}/></div>
            <div><small>현재 가계부</small><strong>{household?.name || '가계부'}</strong></div>
            <ChevronDown size={16}/>
          </div>
          <div className="top-actions">
            <span className="local-badge"><ShieldCheck size={14}/> 내 서버에 저장</span>
            <button className="import-button" onClick={() => setActive('import')}><UploadCloud size={17}/> 거래 가져오기</button>
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{month.replace('-', '년 ')}월</p>
              <h1>{active === 'dashboard' ? '가계 현황' : navigation.find(item => item.key === active)?.label}</h1>
            </div>
            <label className="month-picker"><CalendarDays size={15}/><input aria-label="조회 월" type="month" value={month} onChange={event => setMonth(event.target.value)}/></label>
          </div>

          {notice && <div className="notice success-notice"><Check size={16}/>{notice}<button onClick={() => setNotice('')} aria-label="알림 닫기"><X size={15}/></button></div>}
          {error && <div className="notice error-notice"><CircleAlert size={16}/>{error}<button onClick={() => setError('')} aria-label="오류 닫기"><X size={15}/></button></div>}

          {active === 'dashboard' && (
            <DashboardView
              dashboard={dashboard}
              month={month}
              transactions={transactions.slice(0, 6)}
              onViewTransactions={() => setActive('transactions')}
              onViewAnalysis={() => setActive('analysis')}
              onViewImports={() => setActive('import')}
            />
          )}
          {active === 'transactions' && (
            <TransactionsView
              transactions={transactions}
              total={totalTransactions}
              categories={categories}
              search={search}
              setSearch={setSearch}
              filterType={filterType}
              setFilterType={setFilterType}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterAccount={filterAccount}
              setFilterAccount={setFilterAccount}
              accounts={accounts}
              csrfToken={csrfToken}
              onRefresh={refreshData}
              onError={setError}
              onNotice={setNotice}
            />
          )}
          {active === 'analysis' && <AnalysisView dashboard={dashboard} onImport={() => setActive('import')}/>}
          {active === 'households' && (
            <HouseholdView
              csrfToken={csrfToken}
              onRefresh={refreshData}
              onError={setError}
              onNotice={setNotice}
            />
          )}
          {active === 'import' && (
            <ImportView
              categories={categories}
              accounts={accounts}
              imports={imports}
              csrfToken={csrfToken}
              onManageAccounts={() => setActive('households')}
              onImported={refreshData}
              onError={setError}
              onNotice={setNotice}
            />
          )}
          {active === 'notifications' && (
            <NotificationsView notifications={notifications} onRead={markNotificationRead}/>
          )}
          {active === 'settings' && (
            <SettingsView
              credentialSaved={credentialSaved}
              kakaoStatus={kakaoStatus}
              csrfToken={csrfToken}
              onRefresh={refreshData}
              onError={setError}
              onNotice={setNotice}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function AuthScreen({ setup, password, setPassword, username, setUsername, invitationToken, registering, onAuthModeChange, onSubmit, busy, error, kakaoConfigured }) {
  const [invitation, setInvitation] = useState(null);
  const [invitationError, setInvitationError] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (!invitationToken) return undefined;
    let activeEffect = true;
    api(`/api/invitations/${encodeURIComponent(invitationToken)}`)
      .then(result => activeEffect && setInvitation(result))
      .catch(loadError => activeEffect && setInvitationError(loadError.message));
    return () => { activeEffect = false; };
  }, [invitationToken]);

  const joining = Boolean(invitationToken);
  function submitForm(event) {
    if (registering && password !== passwordConfirmation) {
      event.preventDefault();
      setValidationError('비밀번호가 서로 다릅니다.');
      return;
    }
    setValidationError('');
    onSubmit(event);
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submitForm}>
        <div className="brand auth-brand"><img className="brand-logo" src={logoUrl} alt=""/><span>빙크샐러드</span></div>
        <span className="auth-icon"><LockKeyhole size={21}/></span>
        <h1>{joining ? '공용 가계부 초대' : registering ? '회원가입' : setup ? '내 가계부 시작하기' : '다시 오셨네요'}</h1>
        <p>{joining
          ? invitation
            ? `${invitation.inviterName}님이 초대한 ${invitation.householdName}에 가입합니다. 권한: ${invitation.permission === 'edit' ? '거래 수정 가능' : '조회 전용'}.`
            : invitationError || '초대 정보를 확인하고 있습니다.'
          : registering
            ? '사용자 이름과 비밀번호를 만들면 나만 사용하는 개인 가계부가 생성됩니다.'
            : setup
          ? '이 서버의 개인 가계부를 보호할 비밀번호를 설정하세요. 초기 설정은 실행 중인 컴퓨터에서만 가능합니다.'
          : '비밀번호를 입력해 가계부에 로그인하세요.'}</p>
        {error && <div className="notice error-notice">{error}</div>}
        {validationError && <div className="notice error-notice">{validationError}</div>}
        {invitationError && <div className="notice error-notice">{invitationError}</div>}
        {(joining || !setup) && (
          <>
            <label htmlFor="auth-username">사용자 이름</label>
            <input
              id="auth-username"
              type="text"
              value={username}
              onChange={event => setUsername(event.target.value)}
              minLength={3}
              maxLength={32}
              autoComplete="username"
              required
            />
          </>
        )}
        <label htmlFor="owner-password">비밀번호</label>
        <input
          id="owner-password"
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          minLength={setup || joining || registering ? 12 : undefined}
          maxLength={256}
          autoComplete={setup || joining || registering ? 'new-password' : 'current-password'}
          required
        />
        {registering && <>
          <label htmlFor="password-confirmation">비밀번호 확인</label>
          <input
            id="password-confirmation"
            type="password"
            value={passwordConfirmation}
            onChange={event => setPasswordConfirmation(event.target.value)}
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            required
          />
        </>}
        {(setup || joining || registering) && <small className="field-help">최소 12자. 비밀번호는 해시 처리되어 데이터베이스에 저장됩니다.</small>}
        <button className="modal-primary" disabled={busy || (joining && !invitation)}>{busy ? '처리 중…' : joining ? '초대 수락하고 가입' : registering ? '회원가입' : setup ? '가계부 만들기' : '로그인'}</button>
        {!setup && !joining && !registering && <button type="button" className="auth-switch" onClick={() => onAuthModeChange('register')}>회원가입</button>}
        {!setup && !joining && registering && <button type="button" className="auth-switch" onClick={() => onAuthModeChange('login')}>이미 계정이 있나요? 로그인</button>}
        {!setup && !joining && !registering && kakaoConfigured && <a className="kakao-login-button" href="/api/auth/kakao/login"><span>K</span> 카카오 계정으로 로그인</a>}
        <div className="auth-footnote"><ShieldCheck size={14}/> 로그인 정보와 거래 내역은 이 서버에 저장됩니다.</div>
      </form>
    </div>
  );
}

function DashboardView({ dashboard, month, transactions, onViewTransactions, onViewAnalysis, onViewImports }) {
  if (!dashboard) return <LoadingCard/>;
  const { totals, categories, trends, topMerchants, recurring, insights, latestImport } = dashboard;
  const incomeCompare = compareLabel(totals.income, totals.previousIncome);
  const expenseCompare = compareLabel(totals.expenses, totals.previousExpenses, true);
  const savingsCompare = compareLabel(totals.netSavings, totals.previousNetSavings);
  const chartData = trends.map(item => ({ ...item, label: `${Number(item.month.slice(5, 7))}월` }));

  return (
    <>
      <section className="summary-grid">
        <SummaryCard title="이번 달 수입" amount={totals.income} compare={incomeCompare} icon={ArrowDownRight} tone="green"/>
        <SummaryCard title="이번 달 지출" amount={totals.expenses} compare={expenseCompare} icon={ArrowUpRight} tone="orange"/>
        <SummaryCard title="순저축" amount={totals.netSavings} compare={savingsCompare} icon={WalletCards} tone="blue"/>
        <SummaryCard
          title="저축률"
          amountText={totals.savingsRate == null ? '—' : `${totals.savingsRate}%`}
          compare={{ text: `${totals.transactionCount}건의 거래`, positive: null }}
          icon={PieChart}
          tone="purple"
          isText
        />
      </section>

      <section className="analytics-grid">
        <div className="card trend-card">
          <div className="card-header"><div><h2>수입 · 지출 추이</h2><p>저장된 거래 내역 기준 · 최근 6개월</p></div></div>
          <div className="legend"><span><i className="income-dot"/>수입</span><span><i className="expense-dot"/>지출</span></div>
          {chartData.some(item => item.income || item.expense) ? (
            <div className="chart">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#69bdad" stopOpacity={0.25}/><stop offset="100%" stopColor="#69bdad" stopOpacity={0}/></linearGradient>
                    <linearGradient id="expenseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff9b7b" stopOpacity={0.25}/><stop offset="100%" stopColor="#ff9b7b" stopOpacity={0}/></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#edf0ed"/>
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#92998f', fontSize: 12 }}/>
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#92998f', fontSize: 11 }} tickFormatter={value => `${Math.round(value / 10000)}만`}/>
                  <Tooltip formatter={value => formatMoney(value)}/>
                  <Area type="monotone" dataKey="income" stroke="#69bdad" strokeWidth={2.5} fill="url(#incomeFill)" name="수입"/>
                  <Area type="monotone" dataKey="expense" stroke="#ff9b7b" strokeWidth={2.5} fill="url(#expenseFill)" name="지출"/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState text="아직 분석할 거래가 없습니다. 거래 내역을 가져오면 월별 추이를 보여드립니다."/ >}
        </div>

        <div className="card category-card">
          <div className="card-header">
            <div><h2>카테고리별 지출</h2><p>{month.replace('-', '년 ')}월</p></div>
            <button className="text-button" onClick={onViewAnalysis}>분석 보기 <ChevronRight size={14}/></button>
          </div>
          {categories.length ? (
            <>
              <div className="donut-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <RePieChart>
                    <ChartPie data={categories} dataKey="amount" innerRadius={56} outerRadius={73} paddingAngle={3} stroke="none">
                      {categories.map((category, index) => <Cell key={category.id} fill={chartColors[index % chartColors.length]}/>)}
                    </ChartPie>
                    <Tooltip formatter={formatMoney}/>
                  </RePieChart>
                </ResponsiveContainer>
                <div className="donut-center"><strong>{formatMoney(totals.expenses)}</strong><small>총 지출</small></div>
              </div>
              <div className="category-list">
                {categories.slice(0, 6).map((category, index) => (
                  <div className="category-row" key={category.id}>
                    <span><i style={{ background: chartColors[index % chartColors.length] }}/>{category.name}</span>
                    <strong>{formatMoney(category.amount)}</strong>
                  </div>
                ))}
              </div>
            </>
          ) : <EmptyState text="지출 데이터가 없어요."/ >}
        </div>
      </section>

      <section className="bottom-grid">
        <div className="card transaction-card">
          <div className="card-header">
            <div><h2>최근 거래</h2><p>{totals.transactionCount}건 · 최신순</p></div>
            <button className="text-button" onClick={onViewTransactions}>거래 관리 <ChevronRight size={14}/></button>
          </div>
          {transactions.length ? <TransactionList transactions={transactions} compact/> : <EmptyState text="거래가 없습니다. 엑셀을 가져오거나 직접 추가하세요." action="거래 가져오기" onAction={onViewImports}/>}
        </div>
        <div className="card insight-card">
          <div className="card-header"><div><h2>거래 기반 분석</h2><p>실제 저장된 내역에서 계산</p></div><Activity size={18} className="muted-icon"/></div>
          {insights.length || recurring.length ? (
            <div className="insight-list">
              {insights.slice(0, 3).map((insight, index) => (
                <div className="insight-item" key={`${insight.category}-${index}`}>
                  <div className="insight-icon amber"><ArrowUpRight size={17}/></div>
                  <div><strong>{insight.category} 지출 증가</strong><p>{insight.message} ({formatMoney(insight.previousAmount)} → {formatMoney(insight.amount)})</p></div>
                </div>
              ))}
              {recurring.slice(0, 2).map(item => (
                <div className="insight-item" key={item.merchant}>
                  <div className="insight-icon green"><RefreshCw size={17}/></div>
                  <div><strong>반복 지출 후보</strong><p>{item.merchant} · {item.months}개월 기록, 월평균 {formatMoney(item.averageAmount)}</p></div>
                </div>
              ))}
            </div>
          ) : <EmptyState text="비교할 과거 거래가 쌓이면 지출 변화와 반복 결제를 표시합니다."/ >}
          <div className="sync-summary">
            <span><FileSpreadsheet size={14}/> 최근 가져오기</span>
            {latestImport ? <strong>{dateLabel(latestImport.importedAt)} · {latestImport.transactionCount}건 추가</strong> : <button onClick={onViewImports}>아직 가져온 파일이 없습니다</button>}
          </div>
          {topMerchants.length > 0 && <div className="top-merchants"><span>이번 달 상위 지출</span>{topMerchants.slice(0, 2).map(item => <b key={item.merchant}>{item.merchant} {formatMoney(item.amount)}</b>)}</div>}
        </div>
      </section>
    </>
  );
}

function SummaryCard({ title, amount, amountText, compare, icon: Icon, tone, isText }) {
  const toneClass = compare?.positive == null ? '' : compare.positive ? 'positive' : 'negative';
  return (
    <div className="summary-card">
      <div className="summary-top"><span className={`summary-icon ${tone}`}><Icon size={18}/></span><MoreHorizontal size={17} className="muted-icon"/></div>
      <p>{title}</p>
      <h3>{isText ? amountText : formatMoney(amount)}</h3>
      <div className="summary-change"><span className={toneClass}>{compare?.text || ' '}</span></div>
    </div>
  );
}

function TransactionList({ transactions, compact = false, categories = [], csrfToken, onRefresh, onError, onNotice }) {
  const [editingId, setEditingId] = useState(null);
  const [editDescription, setEditDescription] = useState('');
  const [editCategory, setEditCategory] = useState('');

  async function saveEdit(transaction) {
    try {
      await api(`/api/transactions/${transaction.id}`, {
        method: 'PATCH',
        csrfToken,
        body: { description: editDescription, category: editCategory }
      });
      setEditingId(null);
      onRefresh?.();
      onNotice?.('거래 내용을 저장했습니다.');
    } catch (requestError) {
      onError?.(requestError.message);
    }
  }

  async function deleteTransaction(transaction) {
    if (!window.confirm(`"${transaction.description}" 거래를 삭제할까요?`)) return;
    try {
      await api(`/api/transactions/${transaction.id}`, { method: 'DELETE', csrfToken });
      onRefresh?.();
      onNotice?.('거래를 삭제했습니다.');
    } catch (requestError) {
      onError?.(requestError.message);
    }
  }

  return (
    <div className={compact ? 'transaction-list compact-list' : 'transaction-list'}>
      {transactions.map(transaction => (
        <div className="transaction-row" key={transaction.id}>
          <div className={`merchant-icon ${transaction.transactionType === 'income' ? 'income-icon' : ''}`}>
            {transaction.transactionType === 'income' ? <ArrowDownRight size={17}/> : <ReceiptText size={17}/>}
          </div>
          <div className="merchant">
            {editingId === transaction.id
              ? <input value={editDescription} onChange={event => setEditDescription(event.target.value)} aria-label="거래 내용 수정"/>
              : <strong>{transaction.description}</strong>}
            <span>{dateLabel(transaction.transactionDate)}{transaction.accountName ? ` · ${transaction.accountName}` : ''}</span>
          </div>
          {editingId === transaction.id
            ? <select value={editCategory} onChange={event => setEditCategory(event.target.value)} aria-label="카테고리 수정">
                {categories.filter(category => category.type === transaction.transactionType).map(category => <option key={category.id} value={category.name}>{category.name}</option>)}
                {!categories.some(category => category.name === editCategory) && <option value={editCategory}>{editCategory}</option>}
              </select>
            : <span className="category-pill">{transaction.category || '미분류'}</span>}
          <div className="tx-amount">
            <strong className={transaction.amount < 0 ? 'expense' : 'income'}>{formatAmount(transaction.amount)}</strong>
            {!compact && <small>{transaction.balance == null ? `출처 ${transaction.source}` : `잔액 ${formatMoney(transaction.balance)}`}</small>}
          </div>
          {!compact && <div className="transaction-actions">
            {editingId === transaction.id ? (
              <>
                <button onClick={() => saveEdit(transaction)} title="저장"><Check size={15}/></button>
                <button onClick={() => setEditingId(null)} title="취소"><X size={15}/></button>
              </>
            ) : (
              <>
                <button onClick={() => { setEditingId(transaction.id); setEditDescription(transaction.description); setEditCategory(transaction.category || '미분류'); }} title="수정"><Settings size={15}/></button>
                <button onClick={() => deleteTransaction(transaction)} title="삭제"><Trash2 size={15}/></button>
              </>
            )}
          </div>}
        </div>
      ))}
    </div>
  );
}

function TransactionsView({ transactions, total, categories, accounts, search, setSearch, filterType, setFilterType, filterCategory, setFilterCategory, filterAccount, setFilterAccount, csrfToken, onRefresh, onError, onNotice }) {
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState('expense');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [transactionDate, setTransactionDate] = useState(localDateTime());
  const [category, setCategory] = useState('미분류');
  const [accountId, setAccountId] = useState('');

  async function createTransaction(event) {
    event.preventDefault();
    try {
      await api('/api/transactions', {
        method: 'POST',
        csrfToken,
        body: {
          transactionDate,
          description,
          amount: Number(amount) * (type === 'income' ? 1 : -1),
          category,
          accountId: accountId || null
        }
      });
      setDescription('');
      setAmount('');
      setShowForm(false);
      onRefresh();
      onNotice('거래를 추가했습니다.');
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  const typeCategories = categories.filter(item => item.type === type);
  return (
    <div className="card full-card">
      <div className="card-header">
        <div><h2>거래 내역</h2><p>{total.toLocaleString('ko-KR')}건</p></div>
        <button className="import-button" onClick={() => setShowForm(value => !value)}><Plus size={16}/> 직접 추가</button>
      </div>
      <div className="filter-toolbar">
        <label className="search-field"><Search size={16}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="거래 내용 검색"/></label>
        <select value={filterType} onChange={event => setFilterType(event.target.value)} aria-label="거래 유형">
          <option value="">전체 유형</option><option value="income">수입</option><option value="expense">지출</option>
        </select>
        <select value={filterCategory} onChange={event => setFilterCategory(event.target.value)} aria-label="카테고리">
          <option value="">전체 카테고리</option>
          {categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select value={filterAccount} onChange={event => setFilterAccount(event.target.value)} aria-label="계좌">
          <option value="">전체 계좌</option>
          {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select>
      </div>
      {showForm && (
        <form className="manual-form" onSubmit={createTransaction}>
          <label>유형<select value={type} onChange={event => { setType(event.target.value); setCategory('미분류'); }}><option value="expense">지출</option><option value="income">수입</option></select></label>
          <label>날짜<input type="datetime-local" value={transactionDate} onChange={event => setTransactionDate(event.target.value)} required/></label>
          <label>내용<input value={description} onChange={event => setDescription(event.target.value)} maxLength={200} required/></label>
          <label>금액<input type="number" min="1" step="1" value={amount} onChange={event => setAmount(event.target.value)} required/></label>
          {accounts.length > 0 && <label>계좌<select value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">미지정</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <label>카테고리<select value={category} onChange={event => setCategory(event.target.value)}>{typeCategories.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
          <button className="modal-primary">거래 추가</button>
        </form>
      )}
      {transactions.length
        ? <TransactionList transactions={transactions} categories={categories} csrfToken={csrfToken} onRefresh={onRefresh} onError={onError} onNotice={onNotice}/>
        : <EmptyState text="조건에 맞는 거래가 없습니다. 엑셀을 가져오거나 직접 추가하세요."/>}
    </div>
  );
}

function AnalysisView({ dashboard, onImport }) {
  if (!dashboard) return <LoadingCard/>;
  const chartData = dashboard.trends.map(item => ({ ...item, label: `${Number(item.month.slice(5, 7))}월` }));
  return (
    <>
      <div className="analysis-summary">
        <div><small>수입</small><strong>{formatMoney(dashboard.totals.income)}</strong></div>
        <div><small>지출</small><strong>{formatMoney(dashboard.totals.expenses)}</strong></div>
        <div><small>순저축</small><strong>{formatMoney(dashboard.totals.netSavings)}</strong></div>
        <div><small>저축률</small><strong>{dashboard.totals.savingsRate == null ? '—' : `${dashboard.totals.savingsRate}%`}</strong></div>
      </div>
      <section className="analytics-grid">
        <div className="card trend-card">
          <div className="card-header"><div><h2>월별 수입과 지출</h2><p>거래 데이터 기준</p></div></div>
          {chartData.some(item => item.income || item.expense) ? (
            <div className="chart"><ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#edf0ed"/>
                <XAxis dataKey="label" axisLine={false} tickLine={false}/>
                <YAxis axisLine={false} tickLine={false} tickFormatter={value => `${Math.round(value / 10000)}만`}/>
                <Tooltip formatter={formatMoney}/>
                <Bar dataKey="income" name="수입" fill="#69bdad" radius={[4, 4, 0, 0]}/>
                <Bar dataKey="expense" name="지출" fill="#ff9b7b" radius={[4, 4, 0, 0]}/>
              </BarChart>
            </ResponsiveContainer></div>
          ) : <EmptyState text="분석할 거래 내역이 없습니다." action="거래 가져오기" onAction={onImport}/>}
        </div>
        <div className="card full-card">
          <div className="card-header"><div><h2>카테고리 지출</h2><p>선택한 달의 실제 지출 합계</p></div></div>
          {dashboard.categories.length ? dashboard.categories.map((category, index) => (
            <div className="analysis-category" key={category.id}>
              <span><i style={{ background: chartColors[index % chartColors.length] }}/>{category.name}</span>
              <div><div className="analysis-track"><i style={{ width: `${Math.min(100, category.amount / (dashboard.totals.expenses || 1) * 100)}%`, background: chartColors[index % chartColors.length] }}/></div><strong>{formatMoney(category.amount)}</strong></div>
            </div>
          )) : <EmptyState text="카테고리별 지출이 아직 없습니다."/>}
        </div>
      </section>
      <section className="bottom-grid">
        <InsightCard title="월별 지출 변화" subtitle="전월 대비 15% 이상 증가한 카테고리">
          {dashboard.insights.length ? dashboard.insights.map(item => <p className="analysis-insight" key={item.category}>{item.message} ({formatMoney(item.previousAmount)} → {formatMoney(item.amount)})</p>) : <EmptyState text="현재 기준에서 크게 증가한 카테고리가 없습니다."/>}
        </InsightCard>
        <InsightCard title="반복 지출 후보" subtitle="서로 다른 3개월 이상 반복된 동일 거래명">
          {dashboard.recurring.length ? dashboard.recurring.map(item => <p className="analysis-insight" key={item.merchant}>{item.merchant} · {item.months}개월 · 월평균 {formatMoney(item.averageAmount)}</p>) : <EmptyState text="반복 지출을 판별할 만큼의 과거 데이터가 없습니다."/>}
        </InsightCard>
      </section>
    </>
  );
}

function InsightCard({ title, subtitle, children }) {
  return <div className="card full-card"><div className="card-header"><div><h2>{title}</h2><p>{subtitle}</p></div></div><div className="insight-content">{children}</div></div>;
}

function ImportView({ categories, accounts, imports, csrfToken, onImported, onManageAccounts, onError, onNotice }) {
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState('');

  useEffect(() => {
    if (!accounts.some(account => account.id === accountId)) {
      setAccountId(accounts[0]?.id || '');
    }
  }, [accounts, accountId]);

  async function createPreview(event) {
    event.preventDefault();
    if (!file) return onError('가져올 .xlsx 파일을 선택해 주세요.');
    setBusy(true);
    onError('');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('password', password);
    formData.append('rememberPassword', String(rememberPassword));
    formData.append('accountId', accountId);
    try {
      const result = await api('/api/import/preview', { method: 'POST', body: formData, csrfToken });
      setPreview(result);
      setPassword('');
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setBusy(true);
    try {
      const edits = preview.transactions.filter(row => !row.duplicate).map(row => ({
        index: row.index,
        description: row.description,
        category: row.category
      }));
      const result = await api('/api/import/confirm', {
        method: 'POST',
        csrfToken,
        body: { previewId: preview.previewId, edits }
      });
      setPreview(null);
      setFile(null);
      setRememberPassword(false);
      onNotice(`가져오기 완료: ${result.imported}건 추가, ${result.duplicates}건 중복 제외`);
      onImported();
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function updatePreview(index, field, value) {
    setPreview(current => ({
      ...current,
      transactions: current.transactions.map(row => row.index === index ? { ...row, [field]: value } : row)
    }));
  }

  return (
    <>
      <section className="card full-card import-panel">
        <div className="card-header"><div><h2>카카오뱅크 거래내역 가져오기</h2><p>.xlsx 파일을 서버에서 읽고 미리보기 후 저장합니다.</p></div><FileSpreadsheet size={20} className="muted-icon"/></div>
        {!preview ? (
          accounts.length === 0 ? (
            <div className="account-required">
              <p>거래를 가져오기 전에 가계 관리에서 카카오뱅크 계좌 별칭을 추가해 주세요.</p>
              <button type="button" className="secondary-button" onClick={onManageAccounts}>계좌 추가하기</button>
            </div>
          ) : (
          <form onSubmit={createPreview} className="import-form">
            <label className="import-password">가져올 계좌<select value={accountId} onChange={event => setAccountId(event.target.value)} required>
              {accounts.map(account => <option key={account.id} value={account.id}>{account.name}{account.accountNumberSuffix ? ` · 끝 ${account.accountNumberSuffix}` : ''}</option>)}
            </select></label>
            <label className="file-picker">
              <UploadCloud size={22}/>
              <strong>{file ? file.name : '엑셀 파일 선택'}</strong>
              <span>{file ? '선택한 파일을 미리보기로 확인합니다.' : '.xlsx 형식 · 최대 10MB'}</span>
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => setFile(event.target.files?.[0] || null)}/>
            </label>
            <label className="import-password">엑셀 비밀번호<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="암호가 있는 파일만 입력"/></label>
            <label className="remember-option"><input type="checkbox" checked={rememberPassword} onChange={event => setRememberPassword(event.target.checked)}/><span><Check size={12}/></span>이 가계부에서 다음 가져오기에도 비밀번호 사용 (AES-256-GCM 암호화)</label>
            <button className="modal-primary" disabled={busy || !file}>{busy ? '파일을 읽는 중…' : '미리보기 만들기'}</button>
            <p className="privacy-note"><LockKeyhole size={14}/> 파일은 서버에서 처리 후 임시 파일을 삭제합니다. 비밀번호는 응답이나 로그에 포함하지 않습니다.</p>
          </form>
          )
        ) : (
          <div className="preview-panel">
            <div className="preview-title">
              <div><strong>{preview.fileName}</strong><p>{preview.accountName} · {preview.counts.parsed}건 인식 · {preview.counts.duplicates}건 중복 · {preview.counts.invalid}건 검증 오류</p></div>
              <button className="icon-button" onClick={() => setPreview(null)} aria-label="미리보기 닫기"><X size={17}/></button>
            </div>
            {preview.usedSavedPassword && <p className="success-text"><Check size={14}/> 저장된 비밀번호로 복호화했습니다.</p>}
            {preview.errors.length > 0 && <div className="import-errors">{preview.errors.slice(0, 10).map((item, index) => <p key={index}>{item.sheet} · {item.row}행: {item.message}</p>)}</div>}
            <div className="preview-table">
              <div className="preview-table-head"><span>거래 일시</span><span>내용</span><span>카테고리</span><span>금액</span></div>
              {preview.transactions.map(row => (
                <div className={row.duplicate ? 'preview-row duplicate-row' : 'preview-row'} key={row.index}>
                  <span>{dateLabel(row.transactionDate)}{row.duplicate && <b>중복</b>}</span>
                  <input value={row.description} onChange={event => updatePreview(row.index, 'description', event.target.value)} aria-label="거래 내용"/>
                  <select value={row.category || '미분류'} onChange={event => updatePreview(row.index, 'category', event.target.value)} aria-label="카테고리">
                    {categories.filter(item => item.type === row.transactionType).map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
                    {!categories.some(item => item.name === row.category && item.type === row.transactionType) && <option value={row.category}>{row.category}</option>}
                  </select>
                  <strong className={row.amount < 0 ? 'expense' : 'income'}>{formatAmount(row.amount)}</strong>
                </div>
              ))}
            </div>
            <div className="preview-actions"><button className="secondary-button" onClick={() => setPreview(null)}>취소</button><button className="modal-primary" onClick={confirmImport} disabled={busy || preview.counts.parsed <= preview.counts.duplicates}>{busy ? '저장 중…' : '중복 제외 후 가져오기'}</button></div>
          </div>
        )}
      </section>

      <section className="card full-card import-history">
        <div className="card-header"><div><h2>가져오기 이력</h2><p>최근 파일 처리 내역</p></div><button className="text-button" onClick={() => onImported()}><RefreshCw size={14}/> 새로고침</button></div>
        {imports.length ? imports.map(item => (
          <div className="history-row" key={item.id}>
            <FileSpreadsheet size={17}/>
            <div><strong>{item.fileName}</strong><small>{item.accountName ? `${item.accountName} · ` : ''}{dateLabel(item.importedAt)}</small></div>
            <span>{item.transactionCount}건 추가 · {item.duplicateCount}건 중복</span>
            <b className={item.status === 'completed' ? 'status-done' : 'status-failed'}>{item.status === 'completed' ? '완료' : '실패'}</b>
          </div>
        )) : <EmptyState text="아직 가져오기 이력이 없습니다."/>}
      </section>
    </>
  );
}

function HouseholdView({ csrfToken, onRefresh, onError, onNotice }) {
  const [household, setHousehold] = useState(null);
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [invitationPermission, setInvitationPermission] = useState('view');
  const [accountName, setAccountName] = useState('');
  const [accountSuffix, setAccountSuffix] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let activeEffect = true;
    async function loadHousehold() {
      try {
        const [nextHousehold, nextMembers, nextAccounts] = await Promise.all([
          api('/api/household'),
          api('/api/household/members'),
          api('/api/accounts')
        ]);
        const nextInvitations = ['owner', 'administrator'].includes(nextHousehold.role)
          ? await api('/api/household/invitations')
          : [];
        if (activeEffect) {
          setHousehold(nextHousehold);
          setMembers(nextMembers);
          setAccounts(nextAccounts);
          setInvitations(nextInvitations);
        }
      } catch (loadError) {
        if (activeEffect) onError(loadError.message);
      }
    }
    loadHousehold();
    return () => { activeEffect = false; };
  }, [reload]);

  async function createInvitation(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const invitation = await api('/api/household/invitations', {
        method: 'POST',
        csrfToken,
        body: { permission: invitationPermission }
      });
      setInviteUrl(new URL(invitation.inviteUrl, window.location.origin).toString());
      setReload(value => value + 1);
      onRefresh();
      onNotice('초대 링크를 만들었습니다. 만료 전에 구성원에게 안전하게 전달하세요.');
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvitation(invitationId) {
    try {
      await api(`/api/household/invitations/${invitationId}`, { method: 'DELETE', csrfToken });
      setReload(value => value + 1);
      onNotice('초대를 취소했습니다.');
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  async function removeMember(member) {
    if (!window.confirm(`${member.username} 구성원을 이 가계부에서 제외할까요?`)) return;
    try {
      await api(`/api/household/members/${member.id}`, { method: 'DELETE', csrfToken });
      setReload(value => value + 1);
      onNotice('구성원을 제외했습니다. 해당 사용자의 로그인 세션도 종료했습니다.');
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  async function createAccount(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/api/accounts', {
        method: 'POST',
        csrfToken,
        body: { name: accountName, accountNumberSuffix: accountSuffix }
      });
      setAccountName('');
      setAccountSuffix('');
      setReload(value => value + 1);
      onRefresh();
      onNotice('계좌 별칭을 추가했습니다.');
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(account) {
    if (!window.confirm(`${account.name} 계좌 별칭을 삭제할까요?`)) return;
    try {
      await api(`/api/accounts/${account.id}`, { method: 'DELETE', csrfToken });
      setReload(value => value + 1);
      onRefresh();
      onNotice('계좌 별칭을 삭제했습니다.');
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  const canManage = ['owner', 'administrator'].includes(household?.role);
  return (
    <div className="household-page">
      <section className="card full-card">
        <div className="card-header"><div><h2>{household?.name || '가계부'}</h2><p>{household?.type === 'shared' ? '여러 구성원이 함께 사용하는 공용 가계부' : '현재 저장 공간'}</p></div><Home size={18} className="muted-icon"/></div>
        <div className="household-info">
          <ShieldCheck size={22}/>
          <div><strong>{household?.permission === 'view' ? '조회 전용 구성원' : '공용 가계부 구성원'}</strong><p>초대 링크는 7일 후 만료됩니다. 조회 권한 구성원은 거래를 추가하거나 수정할 수 없습니다.</p></div>
        </div>
      </section>

      <section className="card full-card household-section">
        <div className="card-header"><div><h2>카카오뱅크 계좌 별칭</h2><p>은행 로그인 없이, 내려받은 XLSX 거래내역을 계좌별로 분류합니다.</p></div><WalletCards size={18} className="muted-icon"/></div>
        {canManage && <form className="household-form" onSubmit={createAccount}>
          <label>계좌 별칭<input value={accountName} onChange={event => setAccountName(event.target.value)} maxLength={50} placeholder="예: 공용 생활비 통장" required/></label>
          <label>계좌번호 끝 4자리 (선택)<input inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={accountSuffix} onChange={event => setAccountSuffix(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="1234"/></label>
          <button className="secondary-button" disabled={busy}>계좌 추가</button>
        </form>}
        {accounts.length ? <div className="household-list">
          {accounts.map(account => <div className="member-row" key={account.id}>
            <WalletCards size={17}/><div><strong>{account.name}</strong><small>{account.bankName}{account.accountNumberSuffix ? ` · 끝 ${account.accountNumberSuffix}` : ''}</small></div>
            {canManage && <button className="text-button danger-text" onClick={() => deleteAccount(account)}>삭제</button>}
          </div>)}
        </div> : <EmptyState text="등록된 계좌가 없습니다. XLSX 가져오기 전에 계좌 별칭을 추가하세요."/>}
        <p className="privacy-note"><LockKeyhole size={14}/> 이 기능은 카카오뱅크에서 계좌를 자동 조회하지 않습니다. 앱은 전체 계좌번호나 은행 비밀번호를 저장하지 않습니다.</p>
      </section>

      <section className="card full-card household-section">
        <div className="card-header"><div><h2>가계부 구성원</h2><p>{members.length}명 · {household?.type === 'shared' ? '함께 거래를 확인할 수 있습니다.' : '초대하면 공용 가계부로 전환됩니다.'}</p></div><Users size={18} className="muted-icon"/></div>
        {members.map(member => <div className="member-row" key={member.id}>
          <div className="avatar">{member.username.slice(0, 1).toUpperCase()}</div>
          <div><strong>{member.username}</strong><small>{member.role === 'owner' ? '소유자' : member.permission === 'view' ? '조회 전용' : '거래 편집 가능'}</small></div>
          {household?.role === 'owner' && member.role !== 'owner' && <button className="text-button danger-text" onClick={() => removeMember(member)}>제외</button>}
        </div>)}
      </section>

      {canManage && <section className="card full-card household-section">
        <div className="card-header"><div><h2>구성원 초대</h2><p>초대된 사용자는 계정을 만들고 같은 거래 내역을 봅니다.</p></div><Plus size={18} className="muted-icon"/></div>
        <form className="household-form invite-form" onSubmit={createInvitation}>
          <label>권한<select value={invitationPermission} onChange={event => setInvitationPermission(event.target.value)}><option value="view">조회 전용</option><option value="edit">거래 편집</option></select></label>
          <button className="modal-primary" disabled={busy}>초대 링크 만들기</button>
        </form>
        {inviteUrl && <label className="invite-link-field">새 초대 링크<input readOnly value={inviteUrl} onFocus={event => event.target.select()}/><small>링크를 복사해 초대할 사람에게 안전하게 전달하세요. 한 번 가입하면 재사용할 수 없습니다.</small></label>}
        {invitations.map(invitation => <div className="member-row" key={invitation.id}>
          <Users size={17}/><div><strong>{invitation.permission === 'view' ? '조회 전용 초대' : '편집 가능 초대'}</strong><small>만료: {dateLabel(invitation.expiresAt)}</small></div>
          <button className="text-button danger-text" onClick={() => revokeInvitation(invitation.id)}>취소</button>
        </div>)}
      </section>}

      <p className="privacy-note"><LockKeyhole size={14}/> 외부 접속을 켜기 전 초기 비밀번호를 이 컴퓨터에서 설정하세요. URL만 아는 방문자는 로그인 화면만 볼 수 있습니다.</p>
    </div>
  );
}

function NotificationsView({ notifications, onRead }) {
  return (
    <div className="card full-card">
      <div className="card-header"><div><h2>알림</h2><p>{notifications.filter(item => !item.isRead).length}개의 읽지 않은 알림</p></div></div>
      {notifications.length ? notifications.map(item => (
        <div className={item.isRead ? 'notification-row read' : 'notification-row'} key={item.id}>
          <Bell size={17}/>
          <div><strong>{item.title}</strong><p>{item.message}</p><small>{dateLabel(item.createdAt)}</small></div>
          {!item.isRead && <button className="text-button" onClick={() => onRead(item.id)}>읽음 처리</button>}
        </div>
      )) : <EmptyState text="아직 알림이 없습니다."/>}
    </div>
  );
}

function SettingsView({ credentialSaved, kakaoStatus, csrfToken, onRefresh, onError, onNotice }) {
  async function connectKakao() {
    try {
      const result = await api('/api/auth/kakao/link', { method: 'POST', csrfToken });
      const authorizationUrl = new URL(result.authorizationUrl);
      if (authorizationUrl.origin !== 'https://kauth.kakao.com') {
        throw new Error('카카오 인증 주소가 올바르지 않습니다.');
      }
      window.location.assign(authorizationUrl.toString());
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  async function disconnectKakao() {
    if (!window.confirm('빙크샐러드에서 카카오 계정 연결을 해제할까요?')) return;
    try {
      await api('/api/auth/kakao/link', { method: 'DELETE', csrfToken });
      onRefresh();
      onNotice('카카오 계정 연결을 해제했습니다.');
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  async function deleteCredential() {
    if (!window.confirm('저장된 엑셀 비밀번호를 삭제할까요?')) return;
    try {
      await api('/api/credentials', { method: 'DELETE', csrfToken });
      onRefresh();
      onNotice('저장된 엑셀 비밀번호를 삭제했습니다.');
    } catch (requestError) {
      onError(requestError.message);
    }
  }
  return (
    <div className="card full-card settings-panel">
      <div className="card-header"><div><h2>보안 및 설정</h2><p>현재 개인 가계부 서버 설정</p></div><Settings size={18} className="muted-icon"/></div>
      <div className="setting-row"><div><strong>카카오뱅크 엑셀 비밀번호</strong><p>{credentialSaved ? '이 계정의 비밀번호가 암호화되어 저장되어 있습니다.' : '저장된 비밀번호가 없습니다.'}</p></div>{credentialSaved && <button className="secondary-button danger-button" onClick={deleteCredential}>삭제</button>}</div>
      <div className="setting-row">
        <div><strong>카카오톡 계정 연결</strong><p>{!kakaoStatus
          ? '연결 설정을 확인하고 있습니다.'
          : !kakaoStatus.configured
            ? '서버에 카카오 REST API 키, 클라이언트 시크릿, 리다이렉트 URI가 설정되지 않았습니다.'
            : kakaoStatus.connected
              ? `${kakaoStatus.nickname || '카카오 계정'}이(가) 연결되어 있습니다.`
              : '연결하면 다음부터 카카오 계정으로 로그인할 수 있습니다.'}</p></div>
        {kakaoStatus?.configured
          ? kakaoStatus.connected
            ? <button className="secondary-button danger-button" onClick={disconnectKakao}>연결 해제</button>
            : <button className="secondary-button kakao-connect-button" onClick={connectKakao}>카카오 계정 연결</button>
          : <span className="settings-badge">{kakaoStatus ? '설정 필요' : '확인 중'}</span>}
      </div>
      <div className="setting-row"><div><strong>암호화 키</strong><p>엑셀 비밀번호 키는 데이터베이스와 분리된 `.secrets/credentials.key` 파일에 보관합니다.</p></div><ShieldCheck size={17} className="muted-icon"/></div>
      <div className="setting-row"><div><strong>거래 내역 백업</strong><p>데이터베이스 백업 파일과 암호화 키를 별도로 안전한 위치에 백업하세요.</p></div></div>
    </div>
  );
}

function EmptyState({ text, action, onAction }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><WalletCards size={20}/></div>
      <p>{text}</p>
      {action && <button className="text-button" onClick={onAction}>{action} <ChevronRight size={14}/></button>}
    </div>
  );
}

function LoadingCard() {
  return <div className="card loading-card"><RefreshCw size={18}/> 실제 거래 데이터를 불러오는 중…</div>;
}

createRoot(document.getElementById('root')).render(<App/>);
