// Web 版登录闸门（纯 DOM，独立于上游 React 树）：
// - 未登录 -> 渲染登录/注册全屏卡片；
// - 已登录 -> 动态 import 上游入口（挂到 #root）并在右上角渲染当前用户 + 退出。
// 这样上游 main.tsx / App.tsx 完全不用改，且避免对 #root 二次 createRoot。
/* eslint-disable @typescript-eslint/no-explicit-any */

interface MeUser { username: string; display_name?: string }

let booted = false;

async function boot(user: MeUser) {
  if (booted) return;
  booted = true;
  renderBadge(user);
  await import('../main'); // 上游入口，挂载真正的应用到 #root
}

function injectStyle() {
  if (document.getElementById('yb-auth-style')) return;
  const css = `
  .yb-auth-mask{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;padding:20px;
    background:linear-gradient(135deg,#eef2ff 0%,#f6f7fb 45%,#eaf2ff 100%);
    font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .yb-auth-card{width:min(390px,94vw);background:#fff;border-radius:20px;box-shadow:0 24px 70px rgba(40,52,110,.18);padding:34px 30px 26px;color:#1f2430;animation:yb-auth-in .2s ease}
  @keyframes yb-auth-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  .yb-auth-logo{width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#5b74e6,#7c5be6);display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 14px;box-shadow:0 8px 20px rgba(91,116,230,.35)}
  .yb-auth-title{text-align:center;font-size:20px;font-weight:700;letter-spacing:.5px}
  .yb-auth-sub{text-align:center;font-size:12.5px;color:#8b92a3;margin-top:5px;margin-bottom:22px}
  .yb-auth-tabs{display:flex;background:#f1f3f8;border-radius:11px;padding:4px;margin-bottom:18px}
  .yb-auth-tab{flex:1;text-align:center;padding:8px 0;font-size:13.5px;font-weight:500;color:#7a8194;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
  .yb-auth-tab.on{background:#fff;color:#3a45e6;box-shadow:0 2px 6px rgba(0,0,0,.07)}
  .yb-auth-field{margin-bottom:13px}
  .yb-auth-field label{display:block;font-size:12px;color:#8b92a3;margin-bottom:5px}
  .yb-auth-field input{width:100%;height:42px;border:1px solid #d9dce4;border-radius:11px;padding:0 13px;font-size:14px;outline:none;color:#1f2430;background:#fff;box-sizing:border-box;transition:.15s}
  .yb-auth-field input:focus{border-color:#5b74e6;box-shadow:0 0 0 3px rgba(91,116,230,.15)}
  .yb-auth-submit{width:100%;height:44px;border:none;border-radius:12px;background:linear-gradient(135deg,#5b74e6,#6d5be6);color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:6px;transition:.15s}
  .yb-auth-submit:hover{filter:brightness(1.05)}
  .yb-auth-submit:disabled{opacity:.6;cursor:default}
  .yb-auth-err{color:#e5484d;font-size:12.5px;margin-top:12px;text-align:center;min-height:16px}
  .yb-auth-note{text-align:center;font-size:11.5px;color:#a9afbd;margin-top:16px;line-height:1.6}
  .yb-user-badge{position:fixed;top:12px;right:14px;z-index:2147481000;display:flex;align-items:center;gap:8px;
    background:rgba(255,255,255,.82);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(0,0,0,.06);
    border-radius:999px;padding:4px 6px 4px 12px;box-shadow:0 4px 14px rgba(0,0,0,.1);font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
  .yb-user-name{font-size:12.5px;color:#3a3f4b;font-weight:500;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .yb-user-logout{border:none;background:#eef0f5;color:#5a6270;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer}
  .yb-user-logout:hover{background:#e3e6ee;color:#e5484d}
  @media (prefers-color-scheme:dark){
    .yb-auth-mask{background:linear-gradient(135deg,#1a1f2e 0%,#161922 50%,#1a2030 100%)}
    .yb-auth-card{background:#20242e;color:#e6e8ee}
    .yb-auth-tabs{background:#191d26}.yb-auth-tab.on{background:#2a2f3b;color:#9fb0ff}
    .yb-auth-field input{background:#262b36;border-color:#3a4150;color:#e6e8ee}
    .yb-user-badge{background:rgba(32,36,46,.85);border-color:rgba(255,255,255,.08)}
    .yb-user-name{color:#d6d9e0}.yb-user-logout{background:#2c313c;color:#aab0be}
  }`;
  const el = document.createElement('style');
  el.id = 'yb-auth-style';
  el.textContent = css;
  document.head.appendChild(el);
}

function renderBadge(user: MeUser) {
  injectStyle();
  const badge = document.createElement('div');
  badge.className = 'yb-user-badge';
  const name = document.createElement('span');
  name.className = 'yb-user-name';
  name.textContent = user.display_name || user.username;
  const logout = document.createElement('button');
  logout.className = 'yb-user-logout';
  logout.textContent = '退出';
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* ignore */ }
    window.location.reload();
  });
  badge.appendChild(name);
  badge.appendChild(logout);
  document.body.appendChild(badge);
}

function renderAuth(allowRegister: boolean) {
  injectStyle();
  const mask = document.createElement('div');
  mask.className = 'yb-auth-mask';
  mask.innerHTML = `
    <div class="yb-auth-card" role="dialog" aria-modal="true">
      <div class="yb-auth-logo">📝</div>
      <div class="yb-auth-title">投标工具箱</div>
      <div class="yb-auth-sub">AI 招投标文件智能撰写 · 登录后使用</div>
      <div class="yb-auth-tabs">
        <div class="yb-auth-tab on" data-mode="login">登录</div>
        <div class="yb-auth-tab" data-mode="register" ${allowRegister ? '' : 'style="display:none"'}>注册</div>
      </div>
      <form class="yb-auth-form" autocomplete="on">
        <div class="yb-auth-field">
          <label>用户名</label>
          <input name="username" type="text" autocomplete="username" placeholder="2-32 位，字母/数字/中文" />
        </div>
        <div class="yb-auth-field">
          <label>密码</label>
          <input name="password" type="password" autocomplete="current-password" placeholder="至少 6 位" />
        </div>
        <button type="submit" class="yb-auth-submit">登 录</button>
        <div class="yb-auth-err"></div>
      </form>
      <div class="yb-auth-note">公开演示站 · 每个账号拥有独立的方案与知识库空间<br/>请勿上传涉密招标文件</div>
    </div>`;
  document.body.appendChild(mask);

  const tabs = Array.from(mask.querySelectorAll('.yb-auth-tab')) as HTMLElement[];
  const form = mask.querySelector('.yb-auth-form') as HTMLFormElement;
  const submit = mask.querySelector('.yb-auth-submit') as HTMLButtonElement;
  const errBox = mask.querySelector('.yb-auth-err') as HTMLElement;
  const usernameInput = form.querySelector('input[name=username]') as HTMLInputElement;
  const passwordInput = form.querySelector('input[name=password]') as HTMLInputElement;
  let mode: 'login' | 'register' = 'login';

  const setMode = (m: 'login' | 'register') => {
    mode = m;
    tabs.forEach((t) => t.classList.toggle('on', t.dataset.mode === m));
    submit.textContent = m === 'login' ? '登 录' : '注 册';
    passwordInput.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
    errBox.textContent = '';
  };
  tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode as any)));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) { errBox.textContent = '请输入用户名和密码'; return; }
    submit.disabled = true;
    const prev = submit.textContent;
    submit.textContent = '处理中…';
    errBox.textContent = '';
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) { errBox.textContent = data.error || '操作失败，请重试'; submit.disabled = false; submit.textContent = prev; return; }
      mask.remove();
      await boot(data.user);
    } catch (err: any) {
      errBox.textContent = err?.message || '网络错误';
      submit.disabled = false;
      submit.textContent = prev;
    }
  });

  setTimeout(() => usernameInput.focus(), 40);
}

export async function mountAuthGate() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.user) { await boot(data.user); return; }
    }
    let allowRegister = true;
    try { const d = await res.json(); if (typeof d.allowRegister === 'boolean') allowRegister = d.allowRegister; } catch { /* ignore */ }
    renderAuth(allowRegister);
  } catch {
    renderAuth(true);
  }
}
