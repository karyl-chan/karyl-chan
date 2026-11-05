/**
 * #146 — without a token, the login page tells the user how to ask the bot
 * for a link: the System Behavior's CURRENT trigger (a DM message, or a
 * command), read from the public GET /api/auth/login-trigger — never a
 * hard-coded `login`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import en from '../../../i18n/locales/en.json';

const hintMock = vi.fn();
let query: Record<string, string> = {};

vi.mock('vue-router', () => ({
    useRoute: () => ({ query }),
    useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('../../../api/client', () => ({
    ApiError: class ApiError extends Error {
        status = 0;
    },
    exchangeOneTimeToken: vi.fn(async () => {
        throw new Error('Invalid or expired token');
    }),
    fetchLoginTrigger: () => hintMock(),
}));
vi.mock('../../../auth', () => ({
    isAuthenticated: { value: false },
    setTokens: vi.fn(),
}));

import AuthPage from './AuthPage.vue';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

beforeEach(() => {
    hintMock.mockReset();
    query = {};
    window.history.replaceState({}, '', '/admin/auth');
});

async function page() {
    const wrapper = mount(AuthPage, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

describe('AuthPage login trigger hint', () => {
    it('shows the DM message the login answers', async () => {
        hintMock.mockResolvedValue({ kind: 'message', match: 'startswith', text: '!login' });
        const wrapper = await page();
        expect(wrapper.find('[data-test="login-trigger"]').text()).toBe('!login');
        expect(wrapper.text()).toContain(en.auth.noTokenLead);
    });

    it('shows the command when the login is one', async () => {
        hintMock.mockResolvedValue({ kind: 'command', text: '/signin' });
        const wrapper = await page();
        expect(wrapper.find('[data-test="login-trigger"]').text()).toBe('/signin');
        expect(wrapper.text()).toContain(en.auth.noTokenLeadCommand);
    });

    it('says what kind of match a pattern is', async () => {
        hintMock.mockResolvedValue({ kind: 'message', match: 'endswith', text: 'please' });
        const wrapper = await page();
        expect(wrapper.find('[data-test="login-trigger"]').text()).toBe('please');
        expect(wrapper.text()).toContain(en.auth.match.endswith);
    });

    it('falls back to a generic hint when the trigger cannot be read', async () => {
        hintMock.mockRejectedValue(new Error('HTTP 429'));
        const wrapper = await page();
        expect(wrapper.find('[data-test="login-trigger"]').exists()).toBe(false);
        expect(wrapper.text()).toContain(en.auth.noTokenLeadUnknown);
    });

    it('names the current trigger after a failed exchange', async () => {
        query = { token: 'stale' };
        hintMock.mockResolvedValue({ kind: 'command', text: '/login' });
        const wrapper = await page();
        expect(wrapper.find('[data-test="login-trigger"]').text()).toBe('/login');
    });
});
