/**
 * The one-time login JWT arrives as ?token= in the URL. AuthPage must strip
 * it from the address bar / history BEFORE the async exchange round-trip, so
 * it doesn't linger where Referer headers or third-party scripts could read
 * it — while still using the captured value to perform the exchange.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

const replaceMock = vi.fn();
const exchangeMock = vi.fn();

vi.mock('vue-router', () => ({
    useRoute: () => ({ query: { token: 'secret-login-jwt' } }),
    useRouter: () => ({ replace: replaceMock }),
}));
vi.mock('../../../api/client', () => ({
    ApiError: class ApiError extends Error {
        status = 0;
    },
    exchangeOneTimeToken: (...args: unknown[]) => exchangeMock(...args),
}));
vi.mock('../../../auth', () => ({
    isAuthenticated: { value: false },
    setTokens: vi.fn(),
}));

import AuthPage from './AuthPage.vue';

const i18n = createI18n({
    legacy: false,
    locale: 'en',
    missingWarn: false,
    fallbackWarn: false,
    messages: { en: {} },
});

beforeEach(() => {
    replaceMock.mockReset();
    exchangeMock.mockReset();
    exchangeMock.mockResolvedValue({
        accessToken: 'a',
        refreshToken: 'r',
        accessTokenExpiresAt: 0,
    });
    window.history.replaceState({}, '', '/admin/auth?token=secret-login-jwt');
});

describe('AuthPage one-time token handling', () => {
    it('strips the token from the URL before exchanging, but still exchanges it', async () => {
        expect(window.location.search).toContain('secret-login-jwt');
        mount(AuthPage, { global: { plugins: [i18n] } });
        await flushPromises();

        // The captured token was still used for the exchange...
        expect(exchangeMock).toHaveBeenCalledWith('secret-login-jwt');
        // ...but the URL no longer carries it (stripped before the round-trip).
        expect(window.location.search).not.toContain('secret-login-jwt');
        expect(window.location.pathname).toBe('/admin/auth');
    });
});
