import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AppProgress from './AppProgress.vue';

describe('AppProgress', () => {
    it('exposes determinate progress via aria-value* attributes', () => {
        const w = mount(AppProgress, { props: { value: 42, label: 'Uploading' } });
        const root = w.get('[role="progressbar"]');
        expect(root.attributes('aria-valuenow')).toBe('42');
        expect(root.attributes('aria-valuemin')).toBe('0');
        expect(root.attributes('aria-valuemax')).toBe('100');
        expect(root.attributes('aria-label')).toBe('Uploading');
        expect(w.get('.app-progress__bar').attributes('style')).toContain('width: 42%');
        expect(root.classes()).not.toContain('app-progress--indeterminate');
    });

    it('clamps out-of-range values', () => {
        const w = mount(AppProgress, { props: { value: 140 } });
        expect(w.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100');
        const low = mount(AppProgress, { props: { value: -5 } });
        expect(low.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0');
    });

    it('omits aria-value* when indeterminate', () => {
        const w = mount(AppProgress, { props: { label: 'Loading' } });
        const root = w.get('[role="progressbar"]');
        expect(root.attributes('aria-valuenow')).toBeUndefined();
        expect(root.attributes('aria-valuemin')).toBeUndefined();
        expect(root.attributes('aria-valuemax')).toBeUndefined();
        expect(root.classes()).toContain('app-progress--indeterminate');
    });

    it('applies size and tone classes and lets attrs fall through', () => {
        const w = mount(AppProgress, {
            props: { value: 10, size: 'sm', tone: 'danger' },
            attrs: { 'aria-labelledby': 'caption' }
        });
        const root = w.get('[role="progressbar"]');
        expect(root.classes()).toEqual(expect.arrayContaining(['app-progress--sm', 'app-progress--tone-danger']));
        expect(root.attributes('aria-labelledby')).toBe('caption');
    });
});
