import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';

const rotateMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock('../../../api/behavior', () => ({
    rotateWebhookSecret: (...args: unknown[]) => rotateMock(...args),
}));
vi.mock('@karyl-chan/ui', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@karyl-chan/ui')>()),
    useConfirm: () => ({ confirm: confirmMock }),
}));

import SecretField from './SecretField.vue';

const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } });

function mountField(props: Record<string, unknown> = {}) {
    return mount(SecretField, {
        props: { behaviorId: 7, secretSet: true, previousSecretExpiresAt: null, issued: null, ...props },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    rotateMock.mockReset();
    confirmMock.mockReset();
});

describe('SecretField', () => {
    it('says whether a secret is set and never shows one by itself', () => {
        const set = mountField();
        expect(set.text()).toContain('behaviors.secret.set');
        expect(set.find('[data-test="secret-value"]').exists()).toBe(false);

        const unset = mountField({ secretSet: false });
        expect(unset.text()).toContain('behaviors.secret.unset');
        expect(unset.find('[data-test="rotate"]').exists()).toBe(false);
    });

    it('rotating shows the new secret once, with the old one’s grace end', async () => {
        confirmMock.mockResolvedValue(true);
        rotateMock.mockResolvedValue({ secret: 'n3w-s3cret', previousSecretExpiresAt: '2026-10-28T00:00:00.000Z' });
        const wrapper = mountField();

        await wrapper.find('[data-test="rotate"]').trigger('click');
        await flushPromises();

        expect(rotateMock).toHaveBeenCalledWith(7);
        expect(wrapper.find('[data-test="secret-value"]').text()).toBe('n3w-s3cret');
        expect(wrapper.find('[data-test="grace"]').exists()).toBe(true);
        expect(wrapper.emitted('rotated')).toHaveLength(1);

        await wrapper.find('[data-test="secret-dismiss"]').trigger('click');
        expect(wrapper.find('[data-test="secret-value"]').exists()).toBe(false);
        expect(wrapper.html()).not.toContain('n3w-s3cret');
    });

    it('does nothing when the rotation is not confirmed', async () => {
        confirmMock.mockResolvedValue(false);
        const wrapper = mountField();
        await wrapper.find('[data-test="rotate"]').trigger('click');
        await flushPromises();
        expect(rotateMock).not.toHaveBeenCalled();
    });

    it('shows a secret the parent was just issued (create / turning auth on)', () => {
        const wrapper = mountField({ issued: 'fresh' });
        expect(wrapper.find('[data-test="secret-value"]').text()).toBe('fresh');
    });

    it('shows a grace period still running after an earlier rotation', () => {
        const wrapper = mountField({ previousSecretExpiresAt: '2026-10-28T00:00:00.000Z' });
        expect(wrapper.find('[data-test="grace"]').exists()).toBe(true);
    });
});
