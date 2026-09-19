/**
 * ユーザー認証モジュール (Transrate Auth)
 * サーバー側 /api/auth.php と連携し、ログイン・セッション維持・ログアウトを行う。
 */

const AUTH_API = `${import.meta.env.BASE_URL}api/auth.php`;
const TOKEN_KEY = 'transrate_token';
const USER_KEY = 'transrate_user';

let currentToken = localStorage.getItem(TOKEN_KEY) || null;
let currentUser = localStorage.getItem(USER_KEY) || null;
const authListeners = new Set();

function notifyListeners(isAuth, user) {
  for (const listener of authListeners) {
    try {
      listener(isAuth, user);
    } catch (e) {
      console.error('Auth listener error:', e);
    }
  }
}

export const auth = {
  /**
   * 認証状態リスナーの登録
   * @param {function(boolean, string?): void} fn
   */
  onChange(fn) {
    authListeners.add(fn);
    return () => authListeners.delete(fn);
  },

  /**
   * 現在ログインしているかどうか
   */
  isLoggedIn() {
    return !!currentToken && !!currentUser;
  },

  /**
   * ログイン中ユーザー名
   */
  getUser() {
    return currentUser;
  },

  /**
   * 現在のセッショントークン
   */
  getToken() {
    return currentToken;
  },

  /**
   * サーバーへログイン状態を確認 (ページ起動時や復帰時に呼び出す)
   */
  async check() {
    try {
      const res = await fetch(AUTH_API, {
        method: 'POST',
        credentials: 'include', // HttpOnly Cookie を送受信
        headers: {
          'Content-Type': 'application/json',
          ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
        },
        body: JSON.stringify({ action: 'check', token: currentToken }),
      });

      if (!res.ok) {
        this.clearSession();
        return false;
      }

      const data = await res.json();
      if (data?.ok && data.user) {
        currentUser = data.user;
        if (data.token) {
          currentToken = data.token;
          localStorage.setItem(TOKEN_KEY, currentToken);
        }
        localStorage.setItem(USER_KEY, currentUser);
        notifyListeners(true, currentUser);
        return true;
      } else {
        this.clearSession();
        return false;
      }
    } catch (e) {
      console.warn('認証チェック失敗 (オフラインまたは通信エラー):', e);
      // オフライン時はローカルに保存されたセッション情報を信じる
      if (currentToken && currentUser) {
        notifyListeners(true, currentUser);
        return true;
      }
      return false;
    }
  },

  /**
   * ID/パスワードでログイン
   * @param {string} username
   * @param {string} password
   */
  async login(username, password) {
    const res = await fetch(AUTH_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', username, password }),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || 'IDまたはパスワードが正しくありません');
    }

    currentToken = data.token;
    currentUser = data.user;
    localStorage.setItem(TOKEN_KEY, currentToken);
    localStorage.setItem(USER_KEY, currentUser);

    notifyListeners(true, currentUser);
    return data;
  },

  /**
   * ログアウト
   */
  async logout() {
    try {
      await fetch(AUTH_API, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
        },
        body: JSON.stringify({ action: 'logout', token: currentToken }),
      });
    } catch (e) {
      console.warn('ログアウト通信エラー:', e);
    } finally {
      this.clearSession();
      notifyListeners(false, null);
    }
  },

  /**
   * ローカルセッションを消去
   */
  clearSession() {
    currentToken = null;
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    notifyListeners(false, null);
  },
};
